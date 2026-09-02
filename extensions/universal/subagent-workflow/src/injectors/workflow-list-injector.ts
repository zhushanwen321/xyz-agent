/**
 * Workflow List Injector（B2 / P1）
 *
 * 发现所有可用 workflow（.js/.mjs）并通过 before_agent_start 每 turn 注入
 * `<available_workflows>` 段（name + description），与 subagent 注入段对称。
 *
 * 背景：此前只有 `<available_subagents>`，自定义 workflow 只能靠 list 发现，
 * 与 subagent 不对称。补全后模型可直接 `run` 已列出的 workflow，无需先 list。
 *
 * D7-②（dual-track convergence）：同构骨架（缓存对/唯一写点/发现/三 handler）收敛到
 * 同目录 resource-list-injector.ts 工厂，本文件只保留 workflow 侧真差异：
 * - summarizeDescription：description 截断为 prompt 友好摘要（builtin 的
 *   review-fix-loop 描述超长，全量注入每 turn 会膨胀 prompt）
 * - parseWorkflowMeta：.js @pi-meta 块 → WorkflowEntry（m2 收敛改调 shared/meta-parser
 *   parseResourceMeta，仅认 @pi-meta 新格式）
 * - formatWorkflowList：注入段渲染（引导语通用化：不写死内置名）
 * - includeTmp：发现覆盖 .pi/workflows/.tmp/（workflow-script generate 的产物）
 */



import { parseResourceMeta } from "@zhushanwen/subagent-core/shared/meta-parser.ts";
import { escapeXml, renderXmlSection } from "@zhushanwen/subagent-core/shared/xml-injection.ts";

import { createResourceListInjector } from "./resource-list-injector.ts";

/** 注入段中单个 workflow 的最大描述长度（控制每 turn prompt 体积） */
const MAX_DESC_LEN = 160;

/** 断句阈值比例：句末标点位置须 >= maxLen 的 40% 才采用，否则硬截断保留更多信息 */
const DESC_BOUNDARY_MIN_RATIO = 0.4;

/** 解析后的 workflow 条目（name + 截断后的 description + agentRef 路径） */
export interface WorkflowEntry {
	name: string;
	description: string;
	/** workflowRef：脚本 .js 文件的绝对路径（注入段 <location>，模型直接引用） */
	path: string;
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
 * 解析 workflow .js 文件的 meta（name + description），经 IF1 parseResourceMeta。
 * 投影到 WorkflowEntry {name, description(summarized)} 注入用。
 */
export function parseWorkflowMeta(content: string): WorkflowEntry | null {
	const meta = parseResourceMeta(content, "workflow");
	if (!meta || meta.kind !== "workflow") return null;
	// path 由工厂 discover 从 DiscoveredResource.path 填充
	return { name: meta.name, description: summarizeDescription(meta.description), path: "" };
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

	const items = workflows.map((wf) =>
		`  <workflow><name>${escapeXml(wf.name)}</name><description>${escapeXml(wf.description)}</description><location>${escapeXml(wf.path)}</location></workflow>`,
	);
	return renderXmlSection({
		tag: "available_workflows",
		// 引导语与具体 workflow 解耦：不写死内置名（列表本身已含全部 workflow，
		// 名字/描述每 turn 由 @pi-meta 动态注入），只给通用路由指引 + read location 参数指针。
		guide: "The following workflows are available. Do NOT call list to discover available workflows — they are listed below; use list only for running state. All listed workflows run directly via action:run — do NOT use workflow-script generate for any listed workflow. For parameter details, read the <location> script file (script header has @pi-meta parameters + usage).",
		items,
	});
}

/** workflow 清单实例：缓存生命周期 / 发现 / 三 handler 全部经工厂骨架。 */
const injector = createResourceListInjector<WorkflowEntry>({
	kind: "workflows",
	logTag: "[workflow-list-injector]",
	parse: parseWorkflowMeta,
	format: formatWorkflowList,
	includeTmp: true,
});

/** 用统一资源发现发现所有可用 workflow（includeTmp 覆盖 generate 产物；骨架与排序契约见工厂）。 */
export const discoverAllWorkflows = injector.discover;

/** 注册 session 生命周期 handler，注入 `<available_workflows>` 段（与 subagent 注入 handler 链式）。 */
export const setupWorkflowListInjector = injector.setup;
