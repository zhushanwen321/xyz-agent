/**
 * Subagent List Injector（迁移自 unified-hooks + P3/P4 改造）
 *
 * 发现所有可用 subagent（builtin + user + project 各源）并通过 before_agent_start
 * 每 turn 注入 `<available_subagents>` 段（name + description），让模型能选对 agent
 * 名字而非臆造。注入格式对齐 pi 内置 skill 注入（XML 标签）。
 *
 * D7-②（dual-track convergence）：同构骨架（缓存对/唯一写点/发现/三 handler）收敛到
 * 同目录 resource-list-injector.ts 工厂，本文件只保留 agent 侧真差异：
 * - parseAgentFrontmatter：.md frontmatter → AgentEntry（name/description/when/examples）
 * - formatAgentList：注入段渲染（P3 正向触发引导 + 「ONLY use agent names from this
 *   list」名字约束）
 * - onParseNull：仅「有 frontmatter 但解析失败」才 warn（README 等无 frontmatter 的
 *   .md 不刷 warn——每 turn 扫描）
 *
 * 归位原因：injector 是 subagent-workflow 的内聚功能（让 LLM 知道有哪些 agent 可用），
 * 与同包 resource-discovery 同包后可直接 import，消除跨包依赖。
 */



import { getLogger } from "@zhushanwen/pi-extension-logger";

import { getCachedFileContent } from "@zhushanwen/subagent-core";
import { parseResourceMeta } from "@zhushanwen/subagent-core";
import { escapeXml, renderXmlSection } from "@zhushanwen/subagent-core";

import { createResourceListInjector } from "./resource-list-injector.ts";

const logger = getLogger("injector");

/** 从 .md frontmatter 提取的最小 agent 信息（m5：+ when/examples 路由样本；S1：+ path） */
export interface AgentEntry {
	name: string;
	description: string;
	when?: string;
	examples?: Array<{ match: string; action: string; positive: boolean }>;
	/** agentRef：agent .md 文件的绝对路径（注入段 <location>，模型直接引用） */
	path: string;
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
		path: "", // 由工厂 discover 从 DiscoveredResource.path 填充
	};
}

/** 内容以 frontmatter 分隔符开头（解析失败才值得 warn 的判据）。 */
function startsWithFrontmatter(filePath: string): boolean {
	return (getCachedFileContent(filePath) ?? "").trimStart().startsWith("---");
}

/**
 * 将 agent 列表格式化为 XML 注入段。
 *
 * P3：引导语开头补正向触发条件（何时该 delegate），再保留原「ONLY use agent names
 * from this list」名字约束。空列表返回空串（不注入）。
 */
export function formatAgentList(agents: AgentEntry[]): string {
	if (agents.length === 0) return "";

	const items = agents.map((agent) => {
		let block = `  <agent><name>${escapeXml(agent.name)}</name><description>${escapeXml(agent.description)}</description>`;
		// m5：路由样本（when + examples 正反原样渲染——negative 的 action 由作者写
		// 「不调用（原因）」，渲染器不硬编码；全部内容 escapeXml 防 XML 注入段破坏）
		if (agent.when) {
			block += `<when>${escapeXml(agent.when)}</when>`;
		}
		if (agent.examples && agent.examples.length > 0) {
			// 两极性原样渲染——negative 的 action 由作者写「不调用（原因）」，
			// 渲染器不硬编码后缀（exec-review major-1：曾追加「（不调用）」致双后缀）
			const exampleLines = agent.examples.map(
				(e) => `      - "${escapeXml(e.match)}" → ${escapeXml(e.action)}`,
			);
			block += `\n    <examples>\n${exampleLines.join("\n")}\n    </examples>`;
		}
		block += `<location>${escapeXml(agent.path)}</location></agent>`;
		return block;
	});
	return renderXmlSection({
		tag: "available_subagents",
		guide: "The following subagents are available. PRIORITY: when a task involves reading 3+ files, writing 100+ lines, parallel research, or specialized review, delegate to a matching subagent FIRST instead of doing it yourself — this keeps your context focused on orchestration. Do NOT call list to discover available subagents; use list only for running state. When using the subagent tool, ONLY use agent names from this list. If no agent matches your task, pass systemPrompt alongside the agent name to create a dynamic agent.",
		items,
	});
}

/** agent 清单实例：缓存生命周期 / 发现 / 三 handler 全部经工厂骨架。 */
const injector = createResourceListInjector<AgentEntry>({
	kind: "agents",
	logTag: "[subagent-list-injector]",
	parse: parseAgentFrontmatter,
	format: formatAgentList,
	onParseNull: (filePath) => {
		// m5（评审 M3/F2 + minor-5）：仅「有 frontmatter 但解析失败」才 warn
		// （缺 name/description/examples 单条非法致整体 reject）
		if (!startsWithFrontmatter(filePath)) return;
		logger.warn(
			`[subagent-list-injector] ${filePath}: agent frontmatter 解析失败（IF1 校验不通过）——agent 未注入`,
		);
	},
});

/** 用统一资源发现（ADR-031）发现所有可用 agent（骨架与排序契约见工厂 discover 注释）。 */
export const discoverAllAgents = injector.discover;

/** 注册 session 生命周期 handler，注入 `<available_subagents>` 段（三 handler 语义见工厂）。 */
export const setupSubagentListInjector = injector.setup;
