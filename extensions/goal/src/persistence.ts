/**
 * 持久化层 — serialize/deserialize + history entry 构造
 *
 * FR-5: 移除旧格式兼容，字段缺失直接 throw（tasks 字段例外——向后兼容忽略）。
 * 零 Pi 依赖。
 */

import type { GoalRuntimeState, GoalStatus } from "./engine/types";
import type { GoalHistoryEntry } from "./ports";

// ── 常量 ──────────────────────────────────────────────

export const ENTRY_TYPE = "goal-state";
export const HISTORY_ENTRY_TYPE = "goal-history";

// ── serialize（深拷贝，纯函数）────────────────────────

export function serializeState(state: GoalRuntimeState): GoalRuntimeState {
	return {
		...state,
		budget: { ...state.budget },
	};
}

// ── deserialize（FR-5 严格解析，缺字段 throw）──────────

/**
 * 旧持久化状态归一化（唯一迁移点）。
 *
 * npm pi-goal 0.7.x（base 968b9d76）经 finalizeAndPersist 真实写入过 `time_limited`（时间预算
 * 维度，新状态机已删除该状态）。若不归一化，升级用户持有该状态的 goal 会功能死锁：
 * /goal clear 的 transitionStatus 查表 throw、goal_control create 误报 already active、
 * resume/update 被 isActiveStatus 守卫拒绝——唯一出口是手动删 session 文件。
 * 归一化为语义最接近的 `budget_limited`（预算耗尽终态），clear 走 isTerminalStatus 快速路径。
 * 其余值原样透传（不做值域校验，保持现状）。
 */
function normalizeStatus(status: string): GoalStatus {
	return status === "time_limited" ? "budget_limited" : (status as GoalStatus);
}

/**
 * 反序列化持久化 state。
 *
 * 向后兼容：旧 entry 可能含 `tasks` 字段（task CRUD 删除前的格式），此处忽略不 throw。
 * 其余必填字段缺失仍 throw（FR-5）。
 */
export function deserializeState(data: Record<string, unknown>): GoalRuntimeState {
	const req = <T>(key: string): T => {
		if (!(key in data) || data[key] === undefined) {
			throw new Error(`Missing required field: ${key}`);
		}
		return data[key] as T;
	};

	return {
		goalId: req("goalId"),
		objective: req("objective"),
		// successCriteria 用可选解析：旧持久化数据无此字段（与 slug 同模式，GAP-4），
		// 误用 req() 会丢旧数据整个 state
		successCriteria: data.successCriteria as string | undefined,
		// slug 用可选解析：旧持久化数据无此字段，不能误用 req()（否则旧数据 throw → state 全丢，GAP-4）
		slug: data.slug as string | undefined,
		// 旧数据迁移：0.7.x 的 time_limited → budget_limited（见 normalizeStatus）
		status: normalizeStatus(req<string>("status")),
		tokensUsed: req("tokensUsed"),
		timeStartedAt: req("timeStartedAt"),
		timeUsedSeconds: req("timeUsedSeconds"),
		budget: req("budget"),
		lastProgressTurn: req("lastProgressTurn"),
		budgetLimitSteeringSent: req("budgetLimitSteeringSent"),
		objectiveUpdatedAt: req("objectiveUpdatedAt"),
		lastBlockerReason: req("lastBlockerReason"),
		tokenWarning70Sent: req("tokenWarning70Sent"),
		tokenWarning90Sent: req("tokenWarning90Sent"),
		lastTurnTokensUsed: req("lastTurnTokensUsed"),
		currentTurnIndex: req("currentTurnIndex"),
		completedAtTurnIndex: data.completedAtTurnIndex as number | undefined,
	};
}

// ── makeHistoryEntry ─────────────────────────────────

/**
 * 从 state 构造 GoalHistoryEntry（纯函数）。
 */
export function makeHistoryEntry(state: GoalRuntimeState): GoalHistoryEntry {
	return {
		goalId: state.goalId,
		objective: state.objective,
		successCriteria: state.successCriteria,
		slug: state.slug,
		status: state.status,
		elapsedSeconds: Math.floor(state.timeUsedSeconds),
		timestamp: Date.now(),
	};
}
