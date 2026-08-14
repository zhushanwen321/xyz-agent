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

import {
	type GuiComponent,
	guiComponent,
	type GuiRenderResult,
	guiResult,
	type TreeItem,
} from "@xyz-agent/extension-protocol";

import { SHORT_ID_LENGTH } from "../constants";
import { getBudgetSeverity } from "../engine/budget";
import type { GoalRuntimeState, GoalStatus } from "../engine/types";
import { formatTokens } from "./widget";

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
 * card variant 与 goalStatusSeverity 同语义（原实现只判 blocked，漏了
 * budget_limited/cancelled 两个 danger 级错误终态）：danger 级状态 → danger，
 * complete → success，其余（active/paused）→ default。
 */
function cardVariant(status: GoalStatus): "default" | "danger" | "success" {
	if (status === "complete") return "success";
	if (goalStatusSeverity(status) === "danger") return "danger";
	return "default";
}

/**
 * successCriteria 按行拆分为非空 trim 行。
 * 原实现用 toSingleLine 压扁 + 截断后塞进 stats-line 单行 value，多行验收标准
 * 变成一坨长串，是 goal widget 可读性问题的根因——多行数据应改用 list-tree 多行呈现。
 */
function splitCriteriaLines(criteria: string | undefined): string[] {
	return criteria
		? criteria
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
		: [];
}

/**
 * 构造 goal 的 GUI 渲染描述符（RPC 模式下经 guiSetWidget 推送给 M17 对话流 widget 面板）。
 *
 * 逻辑参考 projection/widget.ts 的 renderWidgetLines 预算计算，但此处只构造
 * 结构化数据（GuiComponent），不做 ANSI 渲染。
 *
 * 统一 card 容器（header=slug，variant 按 status 语义），body 组装共享、
 * 按 hasBudget 增减 progress-bar：
 * - 有 tokenBudget → [progress-bar(tokens), stats-line(status/turn), list-tree(criteria)]
 * - 无 budget     → [stats-line(status/turn/tokens), list-tree(criteria)]
 */
export function buildGoalGui(state: GoalRuntimeState): GuiRenderResult {
	const slug = state.slug ?? state.goalId.slice(0, SHORT_ID_LENGTH);
	// statusSeverity 按 GoalStatus 完整覆盖（S#2）：
	//   active/complete → ok；blocked → danger；paused → warn；
	//   budget_limited/cancelled → danger（预算耗尽/取消是错误终态）
	const statusSeverity = goalStatusSeverity(state.status);

	// hasBudget 与进度条判定统一口径：用 > 0 而非 truthy（I#1：tokenBudget=0 不应触发预算展示）
	const tokenBudget = state.budget.tokenBudget;
	const hasBudget = (tokenBudget ?? 0) > 0;

	const body: GuiComponent[] = [];

	if (hasBudget) {
		const tb = tokenBudget!;
		// tokensUsed 是累计加权浮点（如 1454.8400…1），取整后再进 UI
		body.push(
			guiComponent("progress-bar", {
				label: "tokens",
				current: Math.round(state.tokensUsed),
				total: tb,
				unit: "tok",
				// H4：阈值经 getBudgetSeverity 单源化（原内联 percent→severity 三元）
				severity: getBudgetSeverity(state.tokensUsed / tb),
			}),
		);
	}

	// 状态 + turn 统计行；无预算时补 token 绝对值（有预算时进度条已表达，不重复）。
	// token 走 formatTokens（12000 → "12k"），避免浮点原样泄漏到 UI
	body.push(
		guiComponent("stats-line", {
			items: [
				{ label: "status", value: state.status, severity: statusSeverity },
				{ label: "turn", value: String(state.currentTurnIndex) },
				...(hasBudget ? [] : [{ label: "tokens", value: formatTokens(state.tokensUsed) }]),
			],
		}),
	);

	// successCriteria 逐行 checklist（与 objective 成对，让用户看到「怎么算完成」）
	const criteriaLines = splitCriteriaLines(state.successCriteria);
	if (criteriaLines.length > 0) {
		body.push(
			guiComponent("list-tree", {
				items: criteriaLines.map((line): TreeItem => ({ icon: "check", label: line, depth: 0 })),
			}),
		);
	}

	return guiResult(
		guiComponent("card", {
			variant: cardVariant(state.status),
			header: slug,
			body,
		}),
	);
}
