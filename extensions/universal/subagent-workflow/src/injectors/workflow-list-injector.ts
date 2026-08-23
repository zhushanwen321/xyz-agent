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



import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
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
	workflowInjectionCache = entries !== null ? formatWorkflowList(entries) : null;
}

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
 * 永不抛错——单文件读失败仅记日志。
 */
export async function discoverAllWorkflows(
	workspaceRoot: string,
	agentDir: string,
): Promise<WorkflowEntry[]> {
	const resources = await discoverResources({
		kind: "workflows",
		workspaceRoot,
		agentDir,
		includeTmp: true,
	});

	const map = new Map<string, WorkflowEntry>();
	for (const resource of resources) {
		if (!resource.available) continue;
		try {
			const content = getCachedFileContent(resource.path) ?? "";
			const wf = parseWorkflowMeta(content);
			if (wf) map.set(wf.name, { ...wf, path: resource.path });
		} catch (err) {
			logger.error(
				`[workflow-list-injector] skip unreadable workflow file ${resource.path}`,
				{ reason: err instanceof Error ? err.message : String(err) },
			);
		}
	}
	return [...map.values()];
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
		// 引导语与具体 workflow 解耦：不写死内置名（列表本身已含全部 workflow，
		// 名字/描述每 turn 由 @pi-meta 动态注入），只给通用路由指引 + read location 参数指针。
		'The following workflows are available. Do NOT call list to discover available workflows — they are listed below; use list only for running state. All listed workflows run directly via action:run — do NOT use workflow-script generate for any listed workflow. For parameter details, read the <location> script file (script header has @pi-meta parameters + usage).',
	];
	for (const wf of workflows) {
		lines.push(
			`  <workflow><name>${escapeXml(wf.name)}</name><description>${escapeXml(wf.description)}</description><location>${escapeXml(wf.path)}</location></workflow>`,
		);
	}
	lines.push("</available_workflows>");
	return lines.join("\n");
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
						getAgentDir(),
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
							getAgentDir(),
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
