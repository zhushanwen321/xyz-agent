/**
 * Subagent List Injector（迁移自 unified-hooks + P3/P4 改造；C5① 渲染改接 core）
 *
 * 发现所有可用 subagent（builtin + user + project 各源）并通过 before_agent_start
 * 每 turn 注入 `<available_subagents>` 段（name + description），让模型能选对 agent
 * 名字而非臆造。注入格式对齐 pi 内置 skill 注入（XML 标签）。
 *
 * 改造点：
 * - P4：发现路径由自实现扫 4 目录改为同包 ADR-031 统一发现 discoverResources
 *   （P4 时点覆盖 7 源；C2 扩源后为统一发现全源 9 值 ResourceSource，含
 *   user-extension-paths/project-pi-tmp/project-host——序见 resource-discovery.ts
 *   模块头注 + 优先级合并）。discoverResources 只返回 DiscoveredResource（path/source/
 *   available），不含 name/description——保留 parseAgentFrontmatter 解析每个 .md 的
 *   frontmatter 提取 name+description。
 * - P3：注入段引导语含正向触发引导（何时该 delegate）+ 名字约束（文案见
 *   SUBAGENT_LIST_GUIDE）。
 * - C5①（convergence D-3）：formatAgentList/sortByCodepoint 下沉 core，本文件改调
 *   core barrel（渲染骨架与条目模板逐字节同 pi 旧本地实现——CA2 快照验收前提）；
 *   guide 文案是 pi 宿主注入（core 不内嵌平台文案）。
 * - U11（sink 设计）：装配循环（发现→解析→去重→排序 + warn/error 口径）整体改
 *   消费 core discoverAgents（execution/agents-assembly，U2/A6）——壳侧收缩为
 *   「宿主注入根现取 + 委托」，语义等值口径见 agents-assembly.ts 头注（⛔1 探针
 *   对照注入 XML diff 为空验收）。
 *
 * 归位原因：injector 是 subagent-workflow 的内聚功能壳——事件接线与数据获取留
 * 在插件层（before_agent_start / modelRegistry），解析/渲染算法消费 core。
 */



import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { getHostServices } from "@zhushanwen/subagent-core/core/host-services.ts";
// U11（sink 设计）：agent 装配循环单源 core discoverAgents（U2/A6 装配函数，
// 深路径消费）；渲染（formatAgentList）与 workspace 根推导（findWorkspaceRoot）
// 走 barrel，parseResourceMeta 仍服务 parseAgentFrontmatter（严格注入投影语义锚）。
// 上方 getHostServices 深路径刻意保留：core 服务定位器（core 内模块统一经它取用
// 宿主端口），barrel 刻意不导出（D5 exports 面即 semver 契约、逐名列出，未列名
// 的内部件不经 barrel——见 subagent-core src/index.ts 头注），壳侧深路径消费经包
// `./*` -> src 通配豁免。
import {
	type AgentEntry,
	findWorkspaceRoot,
	formatAgentList,
	parseResourceMeta,
} from "@zhushanwen/subagent-core";
import { discoverAgents } from "@zhushanwen/subagent-core/execution/agents-assembly.ts";

const logger = getLogger("injector");

/**
 * pi 版注入引导文案（C5① guide 参数化——core 渲染函数不内嵌平台文案，宿主注入）。
 *
 * 2026-08 C5 重写依据（pi 现参数面，src/interface/subagent-tool-schema.ts）：
 * 旧句「pass systemPrompt alongside the agent name to create a dynamic agent」
 * 指向的 systemPrompt 参数已不在 subagent tool schema——现 agent 参数 = .md 绝对
 * 路径（<location>），缺省落 general-purpose（继承主 agent 模型与项目上下文），
 * 动态指引经 task 文本 / appendSystemPrompt 参数承载。
 */
export const SUBAGENT_LIST_GUIDE =
	"The following subagents are available. PRIORITY: when a task involves reading 3+ files, writing 100+ lines, parallel research, or specialized review, delegate to a matching subagent FIRST instead of doing it yourself — this keeps your context focused on orchestration. Do NOT call list to discover available subagents; use list only for running state. When using the subagent tool, ONLY use agents from this list — pass the <location> path (absolute .md path) as the agent param. If no agent matches your task, omit agent (a general-purpose agent is used) and put all role-specific instructions in the task text.";

/**
 * Session 级 agent 列表缓存（per-process = per-session）。
 *
 * xyz-agent session-pool 模型下每 pi 子进程 = 一 session = 独立扩展实例，模块级缓存
 * 天然 per-session 隔离（split mode 多 session 各自独立进程）。session_start（含
 * reload）触发发现覆盖缓存（刷新节奏对齐 pi skill）；session_shutdown 清空；
 * before_agent_start 读缓存，miss（session_start 未触发/缓存被清）则 fallback
 * 重新发现——保证鲁棒。
 */
let agentCache: AgentEntry[] | null = null;

/**
 * 注入块渲染缓存（与 agentCache 同步更新）：before_agent_start 每个 turn 都要注入，
 * formatAgentList（escapeXml 多趟正则 × 全部字段）在数据不变时输出完全相同——渲染
 * 一次随缓存复用，turn 热路径零重复计算。
 */
let agentInjectionCache: string | null = null;

/** agentCache 唯一写点：数据与渲染缓存同步更新（null 清空两者）。 */
function setAgentCache(entries: AgentEntry[] | null): void {
	agentCache = entries;
	agentInjectionCache =
		entries !== null ? formatAgentList(entries, { guide: SUBAGENT_LIST_GUIDE }) : null;
}

/**
 * 解析 markdown 文件的 YAML frontmatter（name + description）。
 *
 * m2 收敛：删本地单行 key:value parser，改调 shared/meta-parser.ts parseResourceMeta
 * （IF1 统一 parser，支持 block scalar）。无有效 frontmatter 或缺 name/description 返 null。
 * 投影 {name, description} 注入用（examples 注入留 m5）。
 */
export function parseAgentFrontmatter(content: string): AgentEntry | null {
	const meta = parseResourceMeta(content, "agent");
	if (!meta || meta.kind !== "agent") return null;
	return {
		name: meta.name,
		description: meta.description,
		when: meta.when,
		examples: meta.examples,
		path: "", // 由 discoverAllAgents 从 DiscoveredResource.path 填充
	};
}

/**
 * 发现所有可用 agent（注入清单装配入口）。
 *
 * U11（sink 设计）：原手写装配循环（discoverResources 逐个 parseAgentFrontmatter
 * 解析 → agent name 去重（高优先级靠后 Map 后写胜）→ name 码点序排序 + warn/error
 * 口径）整体改消费 core `discoverAgents`（U2/A6 装配函数）——解析/去重/排序/warn
 * 口径单源 core，第三宿主免复刻（G3/S5）。等值口径（IF1 严格层可见性、warn 仅限
 * 「有 frontmatter 但解析失败」、KV-cache 码点序契约：注入段进每 turn system
 * prompt，顺序与 readdir 枚举序解耦，目录内容不变时任意重建渲染逐字节一致）登记见
 * core execution/agents-assembly.ts 头注。
 *
 * 壳侧保留职责：签名（workspaceRoot 单参）与宿主注入根现取（pi 壳 discoveryRoots
 * 每次现取 getAgentDir，实例隔离；agentDir 形参已删——其唯一用途就是喂 ScanConfig，
 * u0-data-discovery 偏差 #7）。
 *
 * 永不抛错——发现本身 fail-safe，单个文件读失败仅记日志。
 */
export async function discoverAllAgents(
	workspaceRoot: string,
): Promise<AgentEntry[]> {
	return discoverAgents(
		workspaceRoot,
		getHostServices().discoveryRoots?.()?.agents ?? [],
	);
}

/**
 * 注册 session 生命周期 handler，注入 `<available_subagents>` 段。
 *
 * 三 handler 自管缓存生命周期（不耦合 index.ts session 逻辑）：
 * - session_start：发现+缓存赋值（fail-safe，异常不阻断，缓存保持 null）
 * - before_agent_start：读缓存渲染注入；miss 则 fallback 发现+赋值；空列表/空注入不返回
 *   systemPrompt；任何异常被吞掉（记日志），不阻断 agent turn
 * - session_shutdown：清缓存
 *
 * pi 支持 async handler，且同一 event 多 handler 链式（前者返回的 systemPrompt 作
 * 后者输入）。
 */
export function setupSubagentListInjector(pi: ExtensionAPI): void {
	pi.on(
		"session_start",
		async (_event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
			try {
				setAgentCache(
					await discoverAllAgents(
						findWorkspaceRoot(ctx.cwd),
					),
				);
			} catch (err) {
				// fail-safe：发现异常不阻断 session，缓存保持 null（before_agent_start 会 fallback）
				logger.error("[subagent-list-injector] session_start discover failed", {
					reason: err instanceof Error ? err.message : String(err),
				});
			}
		},
	);

	pi.on(
		"before_agent_start",
		async (
			event: BeforeAgentStartEvent,
			ctx: ExtensionContext,
		): Promise<BeforeAgentStartEventResult | void> => {
			try {
				// 读缓存；miss（session_start 未触发/缓存被清）则 fallback 重新发现+赋值
				if (agentCache === null) {
					setAgentCache(
						await discoverAllAgents(
							findWorkspaceRoot(ctx.cwd),
						),
					);
				}
				// agentInjectionCache 与 agentCache 不变量同步（setAgentCache 保证），直接复用
				const injection = agentInjectionCache;
				if (!injection) return;
				return { systemPrompt: event.systemPrompt + injection };
			} catch (err) {
				logger.error("[subagent-list-injector] before_agent_start failed", {
					reason: err instanceof Error ? err.message : String(err),
				});
			}
		},
	);

	pi.on(
		"session_shutdown",
		(_event: SessionShutdownEvent, _ctx: ExtensionContext): void => {
			setAgentCache(null);
		},
	);
}
