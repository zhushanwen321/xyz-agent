/**
 * event-handlers 共享辅助（adapters/event-handlers 层）。
 *
 * - makeStaleChecker：FR-8.2 G-020 goalId snapshot，agent_end 入口构造、每个副作用前 checkStale
 *
 * handleAgentEnd 直接操纵 session.isProcessing（历史实现），无需 acquire/release 封装。
 */

import type { GoalSession } from "../../session";

/**
 * 构造 stale-check 闭包：入口快照 goalId，后续判断是否被新 goal 覆盖。
 *
 * 用法（agent_end）：
 * ```ts
 * const checkStale = makeStaleChecker(session);
 * // ... 长流程 ...
 * if (checkStale()) return; // goal 被覆盖，本次 agent_end 作废
 * ```
 *
 * 语义：snapshot 时 session.state 可能为 null（首次启动），此时 snapshotGoalId
 * 为 undefined；后续若有新 goal（goalId !== undefined）即视为 stale。
 */
export function makeStaleChecker(session: GoalSession): () => boolean {
	const snapshotGoalId = session.state?.goalId;
	return () => !session.state || session.state.goalId !== snapshotGoalId;
}
