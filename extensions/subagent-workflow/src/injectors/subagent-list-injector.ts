/**
 * Subagent List Injector（迁移自 unified-hooks + P3/P4 改造）
 *
 * 发现所有可用 subagent（builtin + user + project 各源）并通过 before_agent_start
 * 每 turn 注入 `<available_subagents>` 段（name + description），让模型能选对 agent
 * 名字而非臆造。注入格式对齐 pi 内置 skill 注入（XML 标签）。
 *
 * 改造点：
 * - P4：发现路径由自实现扫 4 目录改为同包 ADR-031 统一发现 discoverResources
 *   （覆盖 7 源：user-pi/user-agents/npm/npm-dev/project-pi/project-agents + manifest
 *   模式 + 优先级合并）。discoverResources 只返回 DiscoveredResource（path/source/
 *   available），不含 name/description——保留 parseAgentFrontmatter 解析每个 .md 的
 *   frontmatter 提取 name+description。
 * - P3：formatAgentList 开头补正向触发引导（何时该 delegate），保留原有「ONLY use
 *   agent names from this list」名字约束。
 *
 * 归位原因：injector 是 subagent-workflow 的内聚功能（让 LLM 知道有哪些 agent 可用），
 * 与同包 resource-discovery 同包后可直接 import，消除跨包依赖。
 */



import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import {
	discoverResources,
	findWorkspaceRoot,
	getCachedFileContent,
} from "../shared/resource-discovery.ts";
import { parseResourceMeta } from "../shared/meta-parser.ts";

const logger = getLogger("injector");

/** 从 .md frontmatter 提取的最小 agent 信息（m5：+ when/examples 路由样本） */
export interface AgentEntry {
	name: string;
	description: string;
	when?: string;
	examples?: Array<{ match: string; action: string; positive: boolean }>;
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
	};
}

/**
 * 用统一资源发现（ADR-031）发现所有可用 agent。
 *
 * discoverResources 返回按文件名 stem 去重、优先级合并后的 DiscoveredResource[]
 * （project > user > builtin）。此处逐个解析 frontmatter 提取 name+description，
 * 再按 agent name 去重（discoverResources 返回顺序为低→高优先级，高优先级靠后，
 * Map.set 后者覆盖前者，故最终保留最高优先级同名 agent）。
 *
 * 永不抛错——发现本身 fail-safe，单个文件读失败仅记日志。
 */
export async function discoverAllAgents(
	workspaceRoot: string,
	agentDir: string,
): Promise<AgentEntry[]> {
	const resources = await discoverResources({
		kind: "agents",
		workspaceRoot,
		agentDir,
	});

	const agentMap = new Map<string, AgentEntry>();
	for (const resource of resources) {
		if (!resource.available) continue;
		try {
			const content = getCachedFileContent(resource.path) ?? "";
			const agent = parseAgentFrontmatter(content);
			if (agent) {
				agentMap.set(agent.name, agent);
			} else {
				// m5（评审 M3/F2）：IF1 解析失败（缺 name/description/examples 单条非法
				// 致整体 reject）→ agent 不注入——显式 warn 带文件路径，不静默消失。
				logger.warn(
					`[subagent-list-injector] ${resource.path}: agent frontmatter 解析失败（IF1 校验不通过）——agent 未注入`,
				);
			}
		} catch (err) {
			// 单个文件读失败不阻断整条 agent 列表注入
			logger.error(
				`[subagent-list-injector] skip unreadable agent file ${resource.path}`,
				{ reason: err instanceof Error ? err.message : String(err) },
			);
		}
	}
	return [...agentMap.values()];
}

/** 转义 XML 特殊字符 */
function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * 将 agent 列表格式化为 XML 注入段。
 *
 * P3：引导语开头补正向触发条件（何时该 delegate），再保留原「ONLY use agent names
 * from this list」名字约束。空列表返回空串（不注入）。
 */
export function formatAgentList(agents: AgentEntry[]): string {
	if (agents.length === 0) return "";

	const lines = [
		"\n\n<available_subagents>",
		"The following subagents are available. PRIORITY: when a task involves reading 3+ files, writing 100+ lines, parallel research, or specialized review, delegate to a matching subagent FIRST instead of doing it yourself — this keeps your context focused on orchestration. Do NOT call list to discover available subagents; use list only for running state. When using the subagent tool, ONLY use agent names from this list. If no agent matches your task, pass systemPrompt alongside the agent name to create a dynamic agent.",
	];
	for (const agent of agents) {
		let block = `  <agent><name>${escapeXml(agent.name)}</name><description>${escapeXml(agent.description)}</description>`;
		// m5：路由样本（when + examples 正反原样渲染——negative 的 action 由作者写
		// 「不调用（原因）」，渲染器不硬编码；全部内容 escapeXml 防 XML 注入段破坏）
		if (agent.when) {
			block += `<when>${escapeXml(agent.when)}</when>`;
		}
		if (agent.examples && agent.examples.length > 0) {
			const exampleLines = agent.examples.map(
				(e) =>
					`      - "${escapeXml(e.match)}" → ${escapeXml(e.action)}${e.positive ? "" : "（不调用）"}`,
			);
			block += `\n    <examples>\n${exampleLines.join("\n")}\n    </examples>`;
		}
		block += "</agent>";
		lines.push(block);
	}
	lines.push("</available_subagents>");
	return lines.join("\n");
}

/**
 * 注册 before_agent_start handler，注入 `<available_subagents>` 段。
 *
 * pi 支持 async handler，且同一 event 多 handler 链式（前者返回的 systemPrompt 作
 * 后者输入）。本 handler 异步发现 + 注入；任何异常被吞掉（记日志），不阻断 agent turn。
 */
export function setupSubagentListInjector(pi: ExtensionAPI): void {
	pi.on(
		"before_agent_start",
		async (
			event: BeforeAgentStartEvent,
			ctx: ExtensionContext,
		): Promise<BeforeAgentStartEventResult | void> => {
			try {
				const agents = await discoverAllAgents(
					findWorkspaceRoot(ctx.cwd),
					getAgentDir(),
				);
				const injection = formatAgentList(agents);
				if (!injection) return;
				return { systemPrompt: event.systemPrompt + injection };
			} catch (err) {
				logger.error("[subagent-list-injector] before_agent_start failed", {
					reason: err instanceof Error ? err.message : String(err),
				});
			}
		},
	);
}
