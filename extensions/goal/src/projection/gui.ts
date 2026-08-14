/**
 * GUI 渲染描述符构造（projection 层）— buildGoalGui + goalStatusSeverity
 *
 * H4 拆层：从 adapters/goal-control-adapter.ts 抽出。GUI 渲染描述符归 projection 层，
 * goal-control-adapter 回归纯 tool 注册（M17 后不再调用本模块）。
 *
 * 与 projection/widget.ts 的分工：
 * - widget.ts：TUI 模式渲染（ANSI 字符串，经 ctx.ui.setWidget）
 * - gui.ts：RPC 模式渲染（结构化 GuiComponent 描述符，经 guiSetWidget 推送给 M17 对话流 widget 面板）
 *
 * 预算阈值经 engine/budget.ts 的 getBudgetSeverity 单源化（H4）：
 * buildGoalGui（percent→severity）与 widget.getBudgetColor（percent→color）共用阈值。
 */

import { type GuiComponent, guiComponent, type GuiRenderResult, guiResult } from "@xyz-agent/extension-protocol";

import { OBJECTIVE_DISPLAY_LIMIT, SHORT_ID_LENGTH } from "../constants";
import { getBudgetSeverity } from "../engine/budget";
import type { GoalRuntimeState, GoalStatus } from "../engine/types";
import { toSingleLine } from "./widget";

/**
 * 按 GoalStatus 映射 stats-line severity（S#2）。
 *
 *   active/complete → ok（正常运行/成功完成）
 *   paused          → warn（暂停可恢复）
 *   blocked         → danger（阻塞需干预）
 *   budget_limited/cancelled → danger（预算耗尽/取消，错误终态）
 *
 * 维度说明：status→severity（本函数）与 percent→color（widget.getBudgetColor）输入输出
 * 双维度不同，不合并——本函数只管「状态语义」的严重度。
 */
export function goalStatusSeverity(status: GoalStatus): "ok" | "warn" | "danger" {
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

/**
 * 构造 goal 的 GUI 渲染描述符（RPC 模式下经 guiSetWidget 推送给 M17 对话流 widget 面板）。
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
					// H4：阈值经 getBudgetSeverity 单源化（原内联 percent→severity 三元）
					severity: getBudgetSeverity(tokenPct),
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
