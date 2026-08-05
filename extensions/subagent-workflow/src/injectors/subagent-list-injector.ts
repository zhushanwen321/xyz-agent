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

import * as fs from "node:fs";

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
} from "../shared/resource-discovery.ts";

const logger = getLogger("injector");

/** 从 .md frontmatter 提取的最小 agent 信息 */
export interface AgentEntry {
	name: string;
	description: string;
}

/**
 * 解析 markdown 文件的 YAML frontmatter。
 * 无有效 frontmatter 或缺 name/description 时返回 null。
 *
 * 沿用 unified-hooks 原实现：仅支持单行 key:value（builtin pi-subagents 用单行带引号
 * description）。block scalar（`>-` / `|`）不在支持范围——保持与原行为一致。
 */
export function parseAgentFrontmatter(content: string): AgentEntry | null {
	if (!content.startsWith("---")) return null;

	const FRONTMATTER_OPEN_LEN = 3;
	const endIndex = content.indexOf("\n---", FRONTMATTER_OPEN_LEN);
	if (endIndex === -1) return null;

	const block = content.slice(FRONTMATTER_OPEN_LEN, endIndex);
	let name = "";
	let description = "";

	for (const line of block.split("\n")) {
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (!match) continue;

		const key = match[1]!;
		let value = match[2]!.trim();
		// 去除包裹引号
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		if (key === "name") name = value;
		if (key === "description") description = value;
	}

	if (!name || !description) return null;
	return { name, description };
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
			const content = fs.readFileSync(resource.path, "utf8");
			const agent = parseAgentFrontmatter(content);
			if (agent) {
				agentMap.set(agent.name, agent);
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
		lines.push(
			`  <agent><name>${escapeXml(agent.name)}</name><description>${escapeXml(agent.description)}</description></agent>`,
		);
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
