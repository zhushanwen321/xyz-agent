/**
 * goal_control tool — agent 控制入口（create / complete / report_blocked）
 *
 * #3：替代已删除的 goal_manager tool。
 *
 * 职责分层：
 * - execute 层（adapter 职责）：signal 守卫
 * - handler 层（goal 业务，契约对齐 code-architecture §3 handleCreate/handleComplete/handleReportBlocked）：
 *   active 守卫 + evidence/reason 空串校验 + 状态转换
 *
 * 全解耦：goal 不再读 todo/plan 状态。complete 不做 todo 完成前置硬检查——
 * todo 是否全完成由 AI 自行判断，goal 仅通过 prompt 软建议（见 prompts.ts）。
 *
 * 复用 engine/service 既有函数，不重写：
 * - create: service.createGoal（FR-3.1 唯一创建入口；非终态旧 goal 拒绝，对齐 D25 / Codex create_goal）
 * - complete: finalizeAndPersist(state, "complete", ...)（内部已含 tickState → finalizeGoal → persist）
 * - report_blocked: 手动 tickState（status 仍 active 才累加当前运行段）→ transitionStatus(active→blocked) → persistState
 *
 * create 不调 sendUserMessage：toolcall 时 AI 已在 turn 中，返回结果后自行续跑
 * （与 /goal set 的 followUp 触发区分；对齐 Codex create_goal 不自动续跑）。
 *
 * schema：discriminated union（C3）——Type.Union 无 discriminator keyword，各分支以
 * action literal 区分 + additionalProperties:false。pi 生产校验器为 typebox/compile
 * 的 Compile(schema).Check(args)，缺失必填字段在 schema 层即被拒绝；execute 内仅保留
 * .trim() 空字符串校验（LLM 可能传空串穿透 schema）。
 *
 * executionMode: "sequential"——状态变更 tool，不可与同批其他 tool 并行执行。
 *
 * 错误处理：用 throw new Error（CLAUDE.md Tool 设计规范），不返回错误成功模式。
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type GuiComponent, guiComponent, type GuiRenderResult, guiResult } from "@xyz-agent/extension-protocol";
import { type Static, Type } from "typebox";

import { BUDGET_RATIO_HIGH, BUDGET_RATIO_LOW, OBJECTIVE_DISPLAY_LIMIT, SHORT_ID_LENGTH } from "../constants";
import { isActiveStatus, isTerminalStatus, transitionStatus } from "../engine/goal";
import type { BudgetConfig, GoalRuntimeState, GoalStatus } from "../engine/types";
import { toSingleLine, updateWidget } from "../projection/widget";
import { createGoal, finalizeAndPersist, persistState, type ServicePorts, tickState } from "../service";
import type { GoalSession } from "../session";
import { buildPorts } from "./ports";

// ── Params schema（discriminated union，C3）────────────

/**
 * goal_control 参数 schema。三分支以 action literal 区分（无 discriminator keyword），
 * 各分支 additionalProperties:false，缺失必填在 schema 层拒绝。
 */
const CreateParams = Type.Object(
	{
		action: Type.Literal("create"),
		slug: Type.Optional(
			Type.String({
				description: "可选。状态栏标题用的短 kebab-case 标识，仅用于显示，不注入 prompt。",
			}),
		),
		objective: Type.String({
			description:
				"必填。用你自己的话重述真实目标——用户实际想要达成什么，而非字面复述请求。模糊时推断最可能的意图并明确陈述。",
		}),
		successCriteria: Type.String({
			description:
				"必填。可检查的完成条件（如「测试通过」「文件 X 存在且含内容 Y」「命令 Z 输出 W」），不是愿景或「能用就行」。这是 complete 前必须逐条满足的门槛。",
		}),
		tokenBudget: Type.Optional(
			Type.Number({
				description: "可选。新目标的 token 预算（正数）。除非用户指定，否则省略。",
			}),
		),
		completedTasks: Type.Optional(
			Type.Number({
				description: "可选。已完成任务数，写入 goal history。默认 0。",
			}),
		),
	},
	{ additionalProperties: false },
);

const CompleteParams = Type.Object(
	{
		action: Type.Literal("complete"),
		evidence: Type.String({
			description:
				"必填。具体完成证据（改动/新建的文件、通过的测试、运行的命令）。不要基于假设、意图或部分进度标记完成。",
		}),
		completedTasks: Type.Optional(
			Type.Number({
				description: "可选。已完成任务数，写入 goal history。默认 0。",
			}),
		),
	},
	{ additionalProperties: false },
);

const ReportBlockedParams = Type.Object(
	{
		action: Type.Literal("report_blocked"),
		reason: Type.String({
			description:
				"必填。具体阻塞条件及已尝试的方案。不要用于不确定、困难、缓慢或未完成的工作——继续做。",
		}),
	},
	{ additionalProperties: false },
);

export const GoalControlParams = Type.Union([CreateParams, CompleteParams, ReportBlockedParams]);

export type CreateActionParams = Static<typeof CreateParams>;
export type CompleteActionParams = Static<typeof CompleteParams>;
export type ReportBlockedActionParams = Static<typeof ReportBlockedParams>;
export type GoalControlActionParams = Static<typeof GoalControlParams>;

// ── Details（renderResult 数据来源）──────────────────

export interface GoalControlDetails {
	action: "create" | "complete" | "report_blocked";
	goalId: string;
	status: GoalStatus;
	slug?: string;
	/** RPC 模式下的 GUI 渲染描述符（progress-bar 预算进度）。TUI 模式无此字段。 */
	__gui__?: GuiRenderResult;
}

// ── 业务 handler（契约对齐 §3，可测：fake ports）──────

/**
 * create 业务逻辑：objective + successCriteria 必填（schema 层已强制，此处仅校验空串）
 * + 非终态旧 goal 守卫 + service.createGoal。
 *
 * slug：AI 生成的短标识，仅 widget 标题 + history 用，不注入 prompt。真 optional。
 * objective：完整描述，注入每轮 context prompt（保证方向感）。
 *
 * 全解耦：不读 todo/plan。toolcall 时 AI 已在 turn 中，**不**调 sendUserMessage
 * （AI 返回后自行续跑，对齐 Codex create_goal）。
 *
 * 守卫用 D25 严格语义：非终态 active/paused/blocked 全挡，提示用 /goal resume 或
 * /goal clear——防 AI 静默覆盖含未完成工作的 goal。
 * 终态旧 goal 走 createGoal 快速路径覆盖（createGoal 内部 active 守卫，终态可覆盖）。
 */
export function handleCreate(
	params: CreateActionParams,
	session: GoalSession,
	ports: ServicePorts,
): GoalControlDetails {
	const objective = params.objective.trim();
	if (!objective) {
		// schema 已挡缺失，此处仅挡空串（LLM 可能传空串穿透 schema）
		throw new Error(
			"'objective' must not be empty. Describe the concrete objective to pursue. Correct: {\"action\":\"create\",\"slug\":\"<kebab-case>\",\"objective\":\"<concrete objective>\",\"successCriteria\":\"<checkable conditions>\"}",
		);
	}
	// slug 真 optional（TC11）：缺失时 fallback goalId 截断（与 buildGoalGui 口径一致），不强制必填
	const slugInput = params.slug?.trim();

	const successCriteria = params.successCriteria.trim();
	if (!successCriteria) {
		throw new Error(
			"'successCriteria' must not be empty. Define how you will verify the objective is achieved — concrete checkable conditions. Correct: {\"action\":\"create\",\"slug\":\"refactor-auth\",\"objective\":\"...\",\"successCriteria\":\"pnpm test passes; tsc --noEmit clean; src/auth.ts uses JWT\"}",
		);
	}

	// D25 严格守卫：非终态旧 goal（active/paused/blocked）→ 拒绝创建（防静默覆盖未完成工作）
	if (session.state && !isTerminalStatus(session.state.status)) {
		throw new Error(
			`Goal already active (status: ${session.state.status}). Use /goal resume to continue or /goal clear to reset before creating a new one.`,
		);
	}

	// budget 校验：非法预算直接拒绝，不静默截断
	const budget: Partial<BudgetConfig> = {};
	if (params.tokenBudget !== undefined) {
		if (params.tokenBudget <= 0) {
			throw new Error("'tokenBudget' must be greater than 0.");
		}
		budget.tokenBudget = params.tokenBudget;
	}

	// FR-3.1: 唯一创建入口（isExternalInit=false）。终态旧 goal 走覆盖快速路径。
	const created = createGoal(session, objective, budget, ports, false, slugInput, successCriteria);
	if (!created) {
		// createGoal 内部 active 守卫兜底（理论上上面守卫已挡；防御性）
		throw new Error("Goal already active. Cannot create a new one.");
	}
	updateWidget(session, ports.ui);

	const state = session.state!;
	// slug fallback：未提供时用 goalId 截断作标题（与 buildGoalGui 一致，避免 [undefined]）
	const slug = state.slug ?? state.goalId.slice(0, SHORT_ID_LENGTH);
	const budgetNotice: string[] = [];
	if (budget.tokenBudget) budgetNotice.push(`Token budget: ${budget.tokenBudget}`);
	ports.ui.notify([`Goal created [${slug}]: ${objective}`, ...budgetNotice].join("\n"), "info");

	return { action: "create", goalId: state.goalId, status: state.status, slug };
}

/**
 * complete 业务逻辑：active 守卫 + evidence 空串校验 + finalizeAndPersist。
 *
 * 全解耦后不再做 todo 完成前置检查——todo 是否全完成由 AI 自行判断（prompt 软建议）。
 */
export function handleComplete(
	params: CompleteActionParams,
	session: GoalSession,
	ports: ServicePorts,
): GoalControlDetails {
	const state = session.state;
	if (!state) throw new Error("Goal mode not active.");
	if (!isActiveStatus(state.status)) {
		throw new Error(`Goal is not active (status: ${state.status}). Only an active goal can be completed.`);
	}
	const evidence = params.evidence.trim();
	if (!evidence) {
		throw new Error(
			"'evidence' must not be empty. Provide concrete completion evidence. Correct: {\"action\":\"complete\",\"evidence\":\"Modified src/auth.ts; pnpm test auth passed (12/12); tsc --noEmit clean.\"}",
		);
	}

	// FR-3.3: 唯一终态序列入口（内部：tickState → finalizeGoal(transition+history) → persist）
	finalizeAndPersist(state, "complete", params.completedTasks ?? 0, ports);
	updateWidget(session, ports.ui);
	ports.ui.notify(`Goal completed: ${state.objective}`, "info");

	return { action: "complete", goalId: state.goalId, status: state.status };
}

/**
 * report_blocked 业务逻辑：active 守卫 + reason 空串校验 + tickState + transitionStatus + persistState。
 *
 * 必须在 transitionStatus **之前** tickState，使 tick 看到 active 状态并累加当前运行段；
 * 否则转 blocked 后 persistState 内部的 tick 因 status≠active 不累加，丢失最后一段运行时间。
 */
export function handleReportBlocked(
	params: ReportBlockedActionParams,
	session: GoalSession,
	ports: ServicePorts,
): GoalControlDetails {
	const state = session.state;
	if (!state) throw new Error("Goal mode not active.");
	if (state.status !== "active") {
		throw new Error(`Goal is not active (status: ${state.status}). Only an active goal can report_blocked.`);
	}
	const reason = params.reason.trim();
	if (!reason) {
		throw new Error(
			"'reason' must not be empty. Describe the blocking condition and what you tried. Correct: {\"action\":\"report_blocked\",\"reason\":\"<blocker + what you tried>\"}",
		);
	}

	state.lastBlockerReason = reason;
	// 先 tickState 累加当前运行段（此时 status 仍为 active）
	tickState(state);
	state.status = transitionStatus(state.status, "blocked");

	persistState(session, ports);
	updateWidget(session, ports.ui);
	ports.ui.notify(`Goal blocked: ${reason}`, "warning");

	return { action: "report_blocked", goalId: state.goalId, status: state.status };
}

// ── GUI 渲染描述符构造 ───────────────────────────────

/**
 * 按 GoalStatus 映射 stats-line severity（S#2）。
 *
 *   active/complete → ok（正常运行/成功完成）
 *   paused          → warn（暂停可恢复）
 *   blocked         → danger（阻塞需干预）
 *   budget_limited/cancelled → danger（预算耗尽/取消，错误终态）
 */
function goalStatusSeverity(status: GoalStatus): "ok" | "warn" | "danger" {
	switch (status) {
		case "active":
		case "complete":
			return "ok";
		case "paused":
			return "warn";
		case "blocked":
		case "budget_limited":
		case "cancelled":
			return "danger";
	}
}

/** renderResult 的 result 是否含 details 字段（类型守卫，替代全可选结构断言 as {details?}）。
 * 收紧：除检查 "details" in r 外，还验证其值为 object 或 undefined（防 details 是 string/number
 * 时下游读 d.status 得到 undefined 却被类型系统当作 GoalControlDetails）。 */
function hasGoalDetails(r: unknown): r is { details?: GoalControlDetails } {
	if (typeof r !== "object" || r === null || !("details" in r)) return false;
	const d = (r as Record<string, unknown>).details;
	return d === undefined || typeof d === "object";
}

/**
 * 构造 goal 的 GUI 渲染描述符（RPC 模式下放进 details.__gui__）。
 *
 * 逻辑参考 projection/widget.ts 的 renderWidgetLines 预算计算，但此处只构造
 * 结构化数据（GuiComponent），不做 ANSI 渲染。
 *
 * - 有 tokenBudget → card(progress-bar + stats-line) 展示预算消耗
 * - 无 budget → stats-line 展示状态摘要
 */
export function buildGoalGui(state: GoalRuntimeState): GuiRenderResult {
	const slug = state.slug ?? state.goalId.slice(0, SHORT_ID_LENGTH);
	// successCriteria 摘要（截断后进 stats-line；与 objective 成对展示）
	const criteriaSnippet = state.successCriteria
		? toSingleLine(state.successCriteria).slice(0, OBJECTIVE_DISPLAY_LIMIT)
		: undefined;
	// statusSeverity 按 GoalStatus 完整覆盖（S#2）：
	//   active/complete → ok；blocked → danger；paused → warn；
	//   budget_limited/cancelled → danger（预算耗尽/取消是错误终态）
	const statusSeverity = goalStatusSeverity(state.status);

	// hasBudget 与进度条判定统一口径：用 > 0 而非 truthy（I#1：tokenBudget=0 不应触发 card 容器）
	const hasBudget = (state.budget.tokenBudget ?? 0) > 0;

	if (hasBudget) {
		const body: GuiComponent[] = [];
		// token 进度条（>0 判定，与 hasBudget 口径一致）
		const tokenBudget = state.budget.tokenBudget;
		if ((tokenBudget ?? 0) > 0) {
			const tb = tokenBudget!;
			const tokenPct = state.tokensUsed / tb;
			body.push(
				guiComponent("progress-bar", {
					label: "tokens",
					current: state.tokensUsed,
					total: tb,
					unit: "tok",
					severity: tokenPct >= BUDGET_RATIO_HIGH ? "danger" : tokenPct >= BUDGET_RATIO_LOW ? "warn" : "ok",
				}),
			);
		}
		// 状态 + turn 统计行
		body.push(
			guiComponent("stats-line", {
				items: [
					{ label: "status", value: state.status, severity: statusSeverity },
					{ label: "turn", value: String(state.currentTurnIndex) },
				],
			}),
		);
		// successCriteria 摘要（与 objective 成对，让用户看到「怎么算完成」）
		if (criteriaSnippet) {
			body.push(
				guiComponent("stats-line", {
					items: [{ label: "done", value: criteriaSnippet }],
				}),
			);
		}
		return guiResult(
			guiComponent("card", {
				variant: state.status === "blocked" ? "danger" : state.status === "complete" ? "success" : "default",
				header: slug,
				body,
			}),
		);
	}

	// 无 budget：stats-line 摘要
	return guiResult(
		guiComponent("stats-line", {
			items: [
				{ label: "goal", value: slug },
				{ label: "status", value: state.status, severity: statusSeverity },
				{ label: "turn", value: String(state.currentTurnIndex) },
				{ label: "tokens", value: String(state.tokensUsed) },
				...(criteriaSnippet ? [{ label: "done", value: criteriaSnippet }] : []),
			],
		}),
	);
}

// ── Tool 注册 ────────────────────────────────────────

export function registerGoalControlTool(pi: ExtensionAPI, session: GoalSession): void {
	pi.registerTool({
		name: "goal_control",
		label: "Goal Control",
		description: `管理当前会话的目标（goal）。目标用于追踪需要完成验证的复杂工作。

动作：
- create：为复杂的多步骤工作（3+ 步骤、多文件改动、或需要完成验证的工作）主动创建目标。用自己的话重述真实目标，定义可检查的 successCriteria（完成条件）。琐碎的单步任务、普通提问、查找类任务不要创建目标。若已有 active/paused/blocked 目标会失败——请让用户运行 /goal resume 或 /goal clear 后再创建。
- complete：标记当前 active 目标完成。需要 evidence（具体证据：改动的文件、通过的测试、运行的命令），且必须满足每条 successCriteria 条件。若有预算，在总结里报告最终 token 用量。不要基于假设、意图或部分进度标记完成。
- report_blocked：标记当前 active 目标被真实阻碍阻塞。需要 reason 描述阻塞条件和已尝试的方案。仅在穷尽替代方案后使用——不要用于困难、缓慢或不确定的工作。

控制权归属：
- pause/resume 和 budget 变更由用户经 /goal 命令控制，你不能修改。
- 达到阻塞阈值后报告，不要反复报告同一阻塞。

完成验证标准由你在 create 时定义的 successCriteria 决定——complete 时必须逐条满足。`,
		promptSnippet:
			"用 goal_control 管理会话目标：为复杂多步骤工作主动 create（含 slug + objective + successCriteria），达成时 complete（含满足每条 successCriteria 的 evidence），穷尽方案后 report_blocked（含 reason）。",
		// promptGuidelines：进 system prompt guidelines 段（强信号位）。
		// 三个 action 的正向触发引导——create（复杂任务主动启动）、complete（对照 successCriteria 验证达成）、
		// report_blocked（穷尽替代方案后）。措辞主动，给 system prompt 层常驻强信号。
		promptGuidelines: [
			// create：主动用于复杂多步骤任务。翻转原「显式启动」策略——让 goal 真正可用。
			// 门槛：3+ 步骤 / 多文件 / 需完成验证，避免对琐碎任务滥建 goal 变噪音。
			"create: proactively start a goal for complex, multi-step work (3+ steps, multi-file, or needs completion verification) — restate the real objective and define checkable successCriteria. Do NOT create for trivial single-step tasks, ordinary lookups, or when a goal is already active. Test: 'is this worth tracking to completion with verification?' — if yes, create a goal.",
			// 全解耦下 todo 非硬前置——objective 实际达成才算（与 handleComplete「todo 由 AI 自判」一致）
			"complete: proactively call when the active goal's objective is actually achieved, not merely in progress. Evidence must be concrete artifacts (files changed, tests green, commands run) meeting every successCriteria condition. Finishing all todos (incl. verification todos) is the usual readiness signal, but the real bar is the objective being met — you decide.",
			// ≥3 distinct approaches 或同一 blocker 跨连续 turns（T7）；达到阈值后报告，不反复报告同一 blocker
			"report_blocked: proactively call when genuinely blocked after ≥3 distinct alternative approaches or when the same blocker persists across consecutive turns — not for hard/slow work or uncertainty. State the blocker and what you tried. Once the threshold is met, report — do not repeatedly report the same blocker. Do NOT silently stop or leave the goal hanging.",
		],
		executionMode: "sequential",
		parameters: GoalControlParams,

		async execute(
			_toolCallId: string,
			params: GoalControlActionParams,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: GoalControlDetails }> {
			if (signal?.aborted) {
				throw new Error("goal_control aborted by signal.");
			}
			const ports = buildPorts(pi, ctx);

			let details: GoalControlDetails;
			if (params.action === "create") {
				details = handleCreate(params, session, ports);
			} else if (params.action === "complete") {
				// 全解耦：不再做 todo 完成前置硬检查。AI 自行判断 todo 是否全完成（prompt 软建议）。
				details = handleComplete(params, session, ports);
			} else {
				details = handleReportBlocked(params, session, ports);
			}

			// 用 params.action 判断（TS 据此收窄 params 到对应分支，安全访问 objective/reason）
			const text =
				params.action === "create"
					? `Goal created.\nGoal ID: ${details.goalId}\nSlug: ${details.slug ?? ""}\nObjective: ${params.objective.trim()}`
					: params.action === "complete"
						? `Goal completed.\nGoal ID: ${details.goalId}`
						: `Goal reported blocked.\nGoal ID: ${details.goalId}\nReason: ${params.reason.trim()}`;

			// RPC 模式下附加 __gui__（用展开避免 details 来自 frozen 对象时加字段失败）
			if (ctx.mode === "rpc" && session.state) {
				return { content: [{ type: "text", text }], details: { ...details, __gui__: buildGoalGui(session.state) } };
			}
			return { content: [{ type: "text", text }], details };
		},

		renderCall(args: Record<string, unknown>, theme: Theme): Text {
			const action = args.action as string;
			const slug = typeof args.slug === "string" ? args.slug : "";
			const actionLabel =
				action === "create"
					? theme.fg("accent", "create") + (slug ? theme.fg("dim", ` ${slug}`) : "")
					: action === "complete"
						? theme.fg("success", "complete")
						: theme.fg("error", "report_blocked");
			return new Text(theme.fg("toolTitle", theme.bold("goal_control ")) + actionLabel, 0, 0);
		},

		renderResult(result: unknown, _options: { expanded: boolean }, theme: Theme): Text {
			const d = hasGoalDetails(result) ? result.details : undefined;
			if (!d) return new Text(theme.fg("dim", "goal_control"), 0, 0);
			const statusColor =
				d.status === "active"
					? "accent"
					: d.status === "complete"
						? "success"
						: d.status === "blocked"
							? "error"
							: "muted";
			const label = d.action === "create" ? "Created" : d.action === "complete" ? "Completed" : "Blocked";
			const slugSuffix = d.slug ? theme.fg("dim", ` ${d.slug}`) : "";
			return new Text(theme.fg(statusColor, `◆ Goal ${label}`) + slugSuffix, 0, 0);
		},
	});
}
