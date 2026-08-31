/**
 * Workflow List Injector（B2 / P1；C5① 渲染改接 core）
 *
 * 发现所有可用 workflow（.js/.mjs）并通过 before_agent_start 每 turn 注入
 * `<available_workflows>` 段（name + description），与 subagent 注入段对称。
 *
 * 背景：此前只有 `<available_subagents>`，自定义 workflow 只能靠 list 发现，
 * 与 subagent 不对称。补全后模型可直接 `run` 已列出的 workflow，无需先 list。
 *
 * 实现要点：
 * - 发现走同包 ADR-031 统一发现 discoverResources({kind:"workflows", includeTmp:true})
 *   （includeTmp 覆盖 .pi/workflows/.tmp/，即 workflow-script generate 的产物）
 * - 解析每个 workflow 的 meta 提取 name+description（IF1 parseResourceMeta）
 * - description 截断为 prompt 友好的摘要（builtin 的 review-fix-loop 描述超长，全量
 *   注入每 turn 会膨胀 prompt）——summarizeDescription C5① 起改用 core barrel
 *   （算法逐字同本地旧实现）
 * - C5①（convergence D-3）：formatWorkflowList 下沉 core，本文件改调 core barrel
 *   （渲染骨架与条目模板逐字节同 pi 旧本地实现——CA2 快照验收前提）；guide 文案
 *   是 pi 宿主注入（core 不内嵌平台文案）
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
// C5①/C5⑦/C5b：发现与渲染统一走 core barrel——发现链辅助
// （resource-discovery/meta-parser 面：findWorkspaceRoot/getCachedParsed/
// parseResourceMeta）深路径 import 已归零。上方 getHostServices 深路径刻意
// 保留：core 服务定位器（core 内模块统一经它取用宿主端口），barrel 刻意不
// 导出（D5 exports 面即 semver 契约、逐名列出，未列名的内部件不经 barrel——
// 见 subagent-core src/index.ts 头注），壳侧深路径消费经包 `./*` -> src 通配豁免。
import {
	discoverResources,
	findWorkspaceRoot,
	formatWorkflowList,
	getCachedParsed,
	parseResourceMeta,
	summarizeDescription,
	type WorkflowEntry,
} from "@zhushanwen/subagent-core";
// U11（sink 设计）：注入清单排序码点序单源——深路径消费 core sortByCodepoint
// （与 barrel 版同一实现，深路径遵循任务指定消费形态；`./*` -> src 通配豁免）。
import { sortByCodepoint } from "@zhushanwen/subagent-core/shared/injection-render.ts";

const logger = getLogger("injector");

/**
 * Session 级 workflow 列表缓存（per-process = per-session），与 agentCache 对称。
 * 见 subagent-list-injector.ts 的 agentCache 注释。
 */
let workflowCache: WorkflowEntry[] | null = null;

/**
 * 注入块渲染缓存（与 workflowCache 同步更新）：before_agent_start 每个 turn 都要注入，
 * formatWorkflowList 在数据不变时输出完全相同——渲染一次随缓存复用。
 */
let workflowInjectionCache: string | null = null;

/** workflowCache 唯一写点：数据与渲染缓存同步更新（null 清空两者）。 */
function setWorkflowCache(entries: WorkflowEntry[] | null): void {
	workflowCache = entries;
	workflowInjectionCache =
		entries !== null ? formatWorkflowList(entries, { guide: WORKFLOW_LIST_GUIDE }) : null;
}

/**
 * pi 版注入引导文案（C5① guide 参数化——core 渲染函数不内嵌平台文案，宿主注入；
 * 文案与改造前本地实现逐字一致——workflow 段 guide 无过期问题）。
 *
 * 引导语与具体 workflow 解耦：不写死内置名（列表本身已含全部 workflow，名字/描述
 * 每 turn 由 @pi-meta 动态注入），只给通用路由指引 + read location 参数指针。
 */
export const WORKFLOW_LIST_GUIDE =
	"The following workflows are available. Do NOT call list to discover available workflows — they are listed below; use list only for running state. All listed workflows run directly via action:run — do NOT use workflow-script generate for any listed workflow. For parameter details, read the <location> script file (script header has @pi-meta parameters + usage).";

/**
 * 解析 workflow .js 文件的 meta（name + description），经 IF1 parseResourceMeta。
 *
 * m2 收敛：删 extractMetaBlock/extractMetaField（本地 brace-match parser），
 * 改调 shared/meta-parser.ts parseResourceMeta（统一 parser）。仅认 @pi-meta 新格式。
 * 投影到 WorkflowEntry {name, description(summarized)} 注入用。
 */
export function parseWorkflowMeta(content: string): WorkflowEntry | null {
	const meta = parseResourceMeta(content, "workflow");
	if (!meta || meta.kind !== "workflow") return null;
	// path 由 discoverAllWorkflows 从 DiscoveredResource.path 填充
	return { name: meta.name, description: summarizeDescription(meta.description), path: "" };
}

/**
 * 用统一资源发现发现所有可用 workflow（includeTmp 覆盖 generate 产物）。
 * 解析经 getCachedParsed mtime 级缓存；输出按 name 码点序排序（KV-cache 契约，
 * 见 subagent-list-injector.ts discoverAllAgents 注释）。
 * 永不抛错——单文件读失败仅记日志。
 */
export async function discoverAllWorkflows(
	workspaceRoot: string,
): Promise<WorkflowEntry[]> {
	const resources = await discoverResources({
		kind: "workflows",
		workspaceRoot,
		// 宿主注入根现取（pi 壳 discoveryRoots 每次现取 getAgentDir，实例隔离）；
		// agentDir 形参已删——其唯一用途就是喂 ScanConfig（u0-data-discovery 偏差 #7）
		hostRoots: getHostServices().discoveryRoots?.()?.workflows ?? [],
		includeTmp: true,
	});

	const map = new Map<string, WorkflowEntry>();
	for (const resource of resources) {
		if (!resource.available) continue;
		try {
			const wf = getCachedParsed(resource.path, parseWorkflowMeta);
			if (wf) map.set(wf.name, { ...wf, path: resource.path });
		} catch (err) {
			logger.error(
				`[workflow-list-injector] skip unreadable workflow file ${resource.path}`,
				{ reason: err instanceof Error ? err.message : String(err) },
			);
		}
	}
	// U11：内联码点序 sort 折叠为 core sortByCodepoint（实现逐字等价——同比较器
	// 语义：ka < kb ? -1 : ka > kb ? 1 : 0，非变异副本排序）
	return sortByCodepoint([...map.values()], (a) => a.name);
}

/**
 * 注册 session 生命周期 handler，注入 `<available_workflows>` 段。
 *
 * 与 setupSubagentListInjector 对称：session_start 发现+缓存，before_agent_start
 * 读缓存（miss fallback）渲染注入，session_shutdown 清缓存。与 subagent 注入
 * handler 链式（pi 串联多 handler 的 systemPrompt 返回值）。
 */
export function setupWorkflowListInjector(pi: ExtensionAPI): void {
	pi.on(
		"session_start",
		async (_event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
			try {
				setWorkflowCache(
					await discoverAllWorkflows(
						findWorkspaceRoot(ctx.cwd),
					),
				);
			} catch (err) {
				// fail-safe：发现异常不阻断 session，缓存保持 null（before_agent_start 会 fallback）
				logger.error("[workflow-list-injector] session_start discover failed", {
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
				if (workflowCache === null) {
					setWorkflowCache(
						await discoverAllWorkflows(
							findWorkspaceRoot(ctx.cwd),
						),
					);
				}
				// workflowInjectionCache 与 workflowCache 不变量同步（setWorkflowCache 保证），直接复用
				const injection = workflowInjectionCache;
				if (!injection) return;
				return { systemPrompt: event.systemPrompt + injection };
			} catch (err) {
				logger.error("[workflow-list-injector] before_agent_start failed", {
					reason: err instanceof Error ? err.message : String(err),
				});
			}
		},
	);

	pi.on(
		"session_shutdown",
		(_event: SessionShutdownEvent, _ctx: ExtensionContext): void => {
			setWorkflowCache(null);
		},
	);
}
