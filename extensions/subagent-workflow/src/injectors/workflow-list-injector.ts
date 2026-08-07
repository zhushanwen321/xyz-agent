/**
 * Workflow List Injector（B2 / P1）
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
 * - 解析每个 workflow 的 `const meta = {name, description, ...}` 提取 name+description
 * - description 截断为 prompt 友好的摘要（builtin 的 review-fix-loop 描述超长，全量
 *   注入每 turn 会膨胀 prompt）
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
	dedupeByPriority,
	discoverAllResources,
	findWorkspaceRoot,
} from "../shared/resource-discovery.ts";
import {
	detectWorkflowShadows,
	formatShadowWarning,
	type WorkflowShadow,
} from "../shared/workflow-shadow-detector.ts";

const logger = getLogger("injector");

/** 注入段中单个 workflow 的最大描述长度（控制每 turn prompt 体积） */
const MAX_DESC_LEN = 160;

/** 断句阈值比例：句末标点位置须 >= maxLen 的 40% 才采用，否则硬截断保留更多信息 */
const DESC_BOUNDARY_MIN_RATIO = 0.4;

/** 解析后的 workflow 条目（name + 截断后的 description） */
export interface WorkflowEntry {
	name: string;
	description: string;
}

/**
 * 将 workflow description 截断为 prompt 友好的摘要。
 * 优先在 limit 内的最后一个句末标点处断句；无合适断点则硬截断 + 省略号。
 */
export function summarizeDescription(
	desc: string,
	maxLen = MAX_DESC_LEN,
): string {
	const trimmed = desc.trim();
	if (trimmed.length <= maxLen) return trimmed;
	const slice = trimmed.slice(0, maxLen);
	const boundary = Math.max(
		slice.lastIndexOf("。"),
		slice.lastIndexOf("；"),
		slice.lastIndexOf(";"),
		slice.lastIndexOf(". "),
	);
	// 断点过靠前（< 阈值比例）时不采用，改硬截断保留更多信息
	if (boundary > maxLen * DESC_BOUNDARY_MIN_RATIO) return slice.slice(0, boundary + 1);
	return `${slice}…`;
}

/**
 * 从源码中提取 `const meta = { ... }` 块（花括号配平）。
 * 无 meta 块返回 null。
 */
function extractMetaBlock(src: string): string | null {
	const startMatch = src.match(/const\s+meta\s*=\s*\{/);
	if (!startMatch || startMatch.index === undefined) return null;
	const afterOpen = startMatch.index + startMatch[0].length;
	let depth = 1;
	let i = afterOpen;
	while (i < src.length && depth > 0) {
		const ch = src[i];
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		i++;
	}
	if (depth !== 0) return null;
	return src.slice(startMatch.index, i);
}

/** 从 meta 块中提取单行字符串字段值（双引号或单引号包裹）。 */
function extractMetaField(block: string, field: string): string | null {
	const re = new RegExp(`^[ \\t]*${field}:\\s*("([^"]*)"|'([^']*)')`, "m");
	const m = block.match(re);
	if (!m) return null;
	return m[2] ?? m[3] ?? null;
}

/**
 * 解析 workflow .js/.mjs 文件的 meta 对象（name + description）。
 *
 * 所有 builtin workflow 均声明 `const meta = { name, description, phases }`，
 * description 为单行字符串。缺 name 或 description 返回 null。
 */
export function parseWorkflowMeta(content: string): WorkflowEntry | null {
	const block = extractMetaBlock(content);
	if (!block) return null;
	const name = extractMetaField(block, "name");
	const description = extractMetaField(block, "description");
	if (!name || !description) return null;
	return { name, description: summarizeDescription(description) };
}

/**
 * 用统一资源发现发现所有可用 workflow（includeTmp 覆盖 generate 产物）。
 * 永不抛错——单文件读失败仅记日志。
 */
/** discoverAllWorkflows 的返回：去重后的 workflow 列表 + 跨源 shadow 检测结果 */
export interface DiscoveredWorkflows {
	workflows: WorkflowEntry[];
	shadows: WorkflowShadow[];
}

/**
 * 发现所有可用 workflow + 检测跨源同名 shadow。
 *
 * 一次扫描（discoverAllResources，未去重全量）后内存处理：
 * - shadow 检测在全量数据上做（去重会丢弃被覆盖项，无法检冲突）
 * - workflow 列表走 dedupeByPriority 去重 + 解析 meta
 *
 * 永不抛错——单文件读失败仅记日志。
 */
export async function discoverAllWorkflows(
	workspaceRoot: string,
	agentDir: string,
): Promise<DiscoveredWorkflows> {
	const resources = await discoverAllResources({
		kind: "workflows",
		workspaceRoot,
		agentDir,
		includeTmp: true,
	});

	// shadow 检测（全量未去重数据——去重会丢弃被覆盖项，检测不到冲突）
	const shadows = detectWorkflowShadows(resources);

	// 去重 + 解析 meta
	const deduped = dedupeByPriority(resources);
	const map = new Map<string, WorkflowEntry>();
	for (const resource of deduped) {
		if (!resource.available) continue;
		try {
			const content = fs.readFileSync(resource.path, "utf8");
			const wf = parseWorkflowMeta(content);
			if (wf) map.set(wf.name, wf);
		} catch (err) {
			logger.error(
				`[workflow-list-injector] skip unreadable workflow file ${resource.path}`,
				{ reason: err instanceof Error ? err.message : String(err) },
			);
		}
	}
	return { workflows: [...map.values()], shadows };
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
 * 将 workflow 列表格式化为 XML 注入段。
 *
 * 引导语对齐 subagent injector：workflow 已在下方列出，模型应直接 run；
 * list 仅用于查询运行态。builtin workflow 点名「run directly」。
 * 空列表返回空串（不注入）。
 */
export function formatWorkflowList(workflows: WorkflowEntry[]): string {
	if (workflows.length === 0) return "";

	const lines = [
		"\n\n<available_workflows>",
		'The following workflows are available. Do NOT call list to discover available workflows — they are listed below; use list only for running state. Built-in workflows (chain/parallel/scatter-gather/map-reduce/review-fix-loop) run directly.',
	];
	for (const wf of workflows) {
		lines.push(
			`  <workflow><name>${escapeXml(wf.name)}</name><description>${escapeXml(wf.description)}</description></workflow>`,
		);
	}
	lines.push("</available_workflows>");
	return lines.join("\n");
}

/**
 * 注册 before_agent_start handler，注入 `<available_workflows>` 段。
 * 与 setupSubagentListInjector 链式（pi 串联多 handler 的 systemPrompt 返回值）。
 */
export function setupWorkflowListInjector(pi: ExtensionAPI): void {
	pi.on(
		"before_agent_start",
		async (
			event: BeforeAgentStartEvent,
			ctx: ExtensionContext,
		): Promise<BeforeAgentStartEventResult | void> => {
			try {
				const { workflows, shadows } = await discoverAllWorkflows(
					findWorkspaceRoot(ctx.cwd),
					getAgentDir(),
				);
				// shadow 警告双通道：logger.warn 走 appendEntry 持久化审计（每条 shadow 一行），
				// formatShadowWarning 注入 systemPrompt 让 AI 感知并转告用户（warn 本身 TUI 不可见）
				for (const s of shadows) {
					logger.warn(
						`[workflow-shadow] "${s.name}" 生效源=${s.effective.source}，屏蔽了 [${s.shadowed.map((r) => r.source).join(", ")}]（删除被屏蔽的旧副本可恢复内置版本）`,
						{
							name: s.name,
							effective: s.effective.source,
							shadowed: s.shadowed.map((r) => ({ source: r.source, path: r.path })),
						},
					);
				}
				const injection =
					formatWorkflowList(workflows) + formatShadowWarning(shadows);
				if (!injection) return;
				return { systemPrompt: event.systemPrompt + injection };
			} catch (err) {
				logger.error("[workflow-list-injector] before_agent_start failed", {
					reason: err instanceof Error ? err.message : String(err),
				});
			}
		},
	);
}
