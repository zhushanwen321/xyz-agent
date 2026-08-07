/**
 * cw-tool extension — 把 `cw` CLI 包成 4 个 role-restricted pi 工具。
 *
 * 背景（v4 递归编排方案 §1.4/§3）：cw 命令包成 pi 自定义工具，按 role 限制可调 action。
 * 层主（planning/wave）的 cw-tool 不含 design-review/exec-review → 物理上调不了审查 →
 * 必须派独立 review-agent（独立 review 从 prompt 软约束变成工具白名单硬约束）。
 * dev 含 execute/test；review 只含审查命令。
 *
 * 本文件只做工具注册（白名单 + schema + execute 适配）；核心逻辑在 cw-runner.ts，
 * spawn 抽象在 cw-spawn.ts。cw 引擎改动不在此处理。
 */
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

import { type CwSpawner, defaultCwSpawner } from "./cw-spawn.ts";
import { type CwDetails, type CwToolOptions, executeCwAction } from "./cw-runner.ts";

// ── action 白名单（与方案表格逐字一致）──────────────────────────

/** cw_planning：epic/feature/slice 层主。可 execute 下沉，但不含审查命令。 */
const PLANNING_ALLOWED = [
	"design",
	"execute",
	"replan",
	"retrospect",
	"closeout",
	"status",
	"handoff",
	"list",
	"tree",
	"frontier",
] as const;

/** cw_wave：wave 层主。无 execute/test/design-review/exec-review（不亲自写码/测试/审查）。 */
const WAVE_ALLOWED = [
	"design",
	"replan",
	"retrospect",
	"closeout",
	"status",
	"handoff",
	"list",
	"tree",
	"frontier",
] as const;

/** cw_dev：wave 内 dev。写码 + 测试。 */
const DEV_ALLOWED = ["execute", "test", "status", "handoff"] as const;

/** cw_review：审 design/exec 结果。只含审查命令 + status（不改被审物）。 */
const REVIEW_ALLOWED = ["design-review", "exec-review", "status"] as const;

// ── 工具元信息 ──────────────────────────────────────────────────

interface ToolMeta {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly promptSnippet: string;
}

const PLANNING_META: ToolMeta = {
	name: "cw_planning",
	label: "CW Planning",
	description: `运行 cw 编码流程 action（planning 层主：epic/feature/slice）。

允许的 action：design / execute / replan / retrospect / closeout + 只读 status / handoff / list / tree / frontier。
不含 design-review / exec-review —— 审查必须派独立 review-agent（cw_review），不可自审。

参数：
- action：要执行的 cw action（受限于此工具白名单）。
- unitId：目标 cw unit id（大多数 action 必传）。
- input：cw action 的 JSON 输入内容（字符串），经 stdin 传给 cw。
- inputFile：输入文件路径，直接传 cw（与 input 互斥）。
- commitHash：execute 关联的 commit sha（wave 层）。

返回 details.ok 区分成功/失败；成功时 details.data 为 cw stdout 解析出的 JSON（若可解析），details.stdout 为原始输出。`,
	promptSnippet:
		"用 cw_planning 推进编码流程（design/execute/replan/retrospect/closeout + 只读查询）。审查须派独立 review-agent，本工具不含审查命令。",
};

const WAVE_META: ToolMeta = {
	name: "cw_wave",
	label: "CW Wave",
	description: `运行 cw 编码流程 action（wave 层主）。

允许的 action：design / replan / retrospect / closeout + 只读 status / handoff / list / tree / frontier。
**不含** execute / test / design-review / exec-review —— wave 层主不亲自写码/测试/审查：写码派 dev-agent（cw_dev），审查派 review-agent（cw_review）。

参数同 cw_planning（action / unitId / input / inputFile / commitHash）。`,
	promptSnippet:
		"用 cw_wave 推进 wave 层流程（design/replan/retrospect/closeout + 只读查询）。写码派 dev、审查派 review，本工具不含 execute/test/审查。",
};

const DEV_META: ToolMeta = {
	name: "cw_dev",
	label: "CW Dev",
	description: `运行 cw 编码流程 action（wave 内 dev：写码 + 测试）。

允许的 action：execute / test + 只读 status / handoff。
不含审查命令 —— exec-review 必须派独立 review-agent（cw_review）。

参数：action / unitId / input / inputFile / commitHash（execute 关联 commit）。`,
	promptSnippet: "用 cw_dev 写码（execute）和测试（test）+ 只读 status/handoff。exec-review 须派独立 review-agent。",
};

const REVIEW_META: ToolMeta = {
	name: "cw_review",
	label: "CW Review",
	description: `运行 cw 审查 action（design-review / exec-review）。

允许的 action：design-review / exec-review + 只读 status。
供独立 review-agent 提交审查 judgment（designReviewJudgment / execReviewJudgment 经 input 传入）。不含 execute/test/design 等 —— review 只审查，不改被审物。

参数：action / unitId / input（审查 judgment JSON）/ inputFile。`,
	promptSnippet: "用 cw_review 提交审查（design-review/exec-review）+ 只读 status。仅审查，不执行/不写码。",
};

// ── 工具构造（泛型保留 action 枚举的窄类型）────────────────────

/**
 * 构造单个 cw-tool。execute 内联闭包适配 SDK 全签名（toolCallId/params/signal/onUpdate/ctx），
 * 转调纯逻辑 executeCwAction（白名单 + spawn + 解析）。
 *
 * 错误经 execute 返回（details.ok=false + content 文本），不抛异常。
 */
function buildTool<A extends readonly string[]>(
	allowed: A,
	meta: ToolMeta,
	spawner: CwSpawner,
): ToolDefinition<typeof parameters, CwDetails> {
	const parameters = Type.Object({
		action: StringEnum(allowed, { description: "要执行的 cw action（受限于此工具的白名单）。" }),
		unitId: Type.Optional(
			Type.String({
				description:
					"目标 cw unit id。写 action（design/execute/replan/retrospect/closeout/test/design-review/exec-review）必传，缺失返回错误；只读 action（list/tree/frontier/status/handoff）可省略。",
			}),
		),
		input: Type.Optional(
			Type.String({
				description: "cw action 的 JSON 输入内容（字符串），经 stdin 传给 cw（cw --input -）。与 inputFile 互斥。",
			}),
		),
		inputFile: Type.Optional(
			Type.String({ description: "输入文件路径，直接传 cw --input <path>。与 input 互斥。" }),
		),
		commitHash: Type.Optional(
			Type.String({ description: "execute 关联的 commit sha（wave 层），传 cw --commitHash。" }),
		),
	});
	type Params = Static<typeof parameters>;

	return {
		name: meta.name,
		label: meta.label,
		description: meta.description,
		promptSnippet: meta.promptSnippet,
		parameters,
		executionMode: "sequential",
		async execute(
			_toolCallId: string,
			params: Params,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<CwDetails> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<CwDetails>> {
			if (signal?.aborted) {
				const aborted: CwDetails = {
					ok: false,
					action: params.action,
					unitId: params.unitId,
					error: "aborted by signal",
				};
				return { content: [{ type: "text", text: `[${meta.name}] aborted` }], details: aborted };
			}

			const opts: CwToolOptions = {
				input: params.input,
				inputFile: params.inputFile,
				commitHash: params.commitHash,
			};

			const details = await executeCwAction(
				params.action,
				allowed,
				meta.name,
				params.unitId,
				opts,
				spawner,
				ctx.cwd,
				signal,
			);

			const text = details.ok
				? details.stdout
				: `[${meta.name}] ${params.action} 失败: ${details.error}`;
			return { content: [{ type: "text", text }], details };
		},
	};
}

// ── 扩展入口 ────────────────────────────────────────────────────

/**
 * cw-tool extension 工厂。注册 4 个 role-restricted cw 工具。
 *
 * 无状态（cw 状态在 cw 引擎内，本扩展不持有 session 级状态），无需 session_start 重建。
 */
export default function cwToolExtension(pi: ExtensionAPI): void {
	pi.registerTool(buildTool(PLANNING_ALLOWED, PLANNING_META, defaultCwSpawner));
	pi.registerTool(buildTool(WAVE_ALLOWED, WAVE_META, defaultCwSpawner));
	pi.registerTool(buildTool(DEV_ALLOWED, DEV_META, defaultCwSpawner));
	pi.registerTool(buildTool(REVIEW_ALLOWED, REVIEW_META, defaultCwSpawner));
}

// ── 导出（供测试 + 跨扩展引用）──────────────────────────────────

export { executeCwAction, buildCwArgs, rejectDisallowedAction } from "./cw-runner.ts";
export type { CwAction, CwDetails, CwToolOptions } from "./cw-runner.ts";
export type { CwSpawner, CwSpawnResult } from "./cw-spawn.ts";
export { defaultCwSpawner } from "./cw-spawn.ts";
export { buildTool };
export { PLANNING_ALLOWED, WAVE_ALLOWED, DEV_ALLOWED, REVIEW_ALLOWED };
