/**
 * engine/goal.ts 测试 — Goal 状态机 + createGoalState
 *
 * transitionStatus 完备性用 fast-check 覆盖 GoalStatus×GoalStatus 全 36 组合
 * （不 throw ⟺ to ∈ VALID_TRANSITIONS[from]），替代手写合法 9 + 非法 25 = 34 条枚举。
 */
import { describe, expect } from "vitest";
import { it, fc } from "@fast-check/vitest";

import { createGoalState, isActiveStatus, isTerminalStatus, transitionStatus } from "../goal";
import { VALID_TRANSITIONS } from "../types";
import type { GoalStatus } from "../types";

const STATUS_VALUES: GoalStatus[] = ["active", "paused", "blocked", "complete", "budget_limited", "cancelled"];
const statusArb = fc.constantFrom(...STATUS_VALUES);
// 独立于实现的终态集合（交叉校验，非循环）
const TERMINAL: ReadonlySet<GoalStatus> = new Set(["complete", "budget_limited", "cancelled"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("isTerminalStatus", () => {
	it.prop([statusArb])("⟺ 在 {complete, budget_limited, cancelled} 内", (s) => isTerminalStatus(s) === TERMINAL.has(s));
});

describe("isActiveStatus", () => {
	it.prop([statusArb])("⟺ status === active", (s) => isActiveStatus(s) === (s === "active"));
});

describe("transitionStatus", () => {
	// ⭐ 完备性：自动枚举全 36 组合，不 throw ⟺ to ∈ VALID_TRANSITIONS[from]
	it.prop([statusArb, statusArb])("完备性：不 throw ⟺ to ∈ VALID_TRANSITIONS[from]", (from, to) => {
		const inTable = VALID_TRANSITIONS[from].includes(to);
		let threw = false;
		try {
			transitionStatus(from, to);
		} catch {
			threw = true;
		}
		return threw === !inTable;
	});

	it("smoke：active → paused 合法，返回 to", () => {
		expect(transitionStatus("active", "paused")).toBe("paused");
	});
	it("smoke：终态 complete → active 非法 throw（不可逆）", () => {
		expect(() => transitionStatus("complete", "active")).toThrow();
	});
});

describe("createGoalState", () => {
	it("默认值：status active + 计数器清零 + 预警 flag false", () => {
		expect(createGoalState("my obj")).toMatchObject({
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			currentTurnIndex: 0,
			lastProgressTurn: 0,
			lastTurnTokensUsed: 0,
			budgetLimitSteeringSent: false,
			tokenWarning70Sent: false,
			tokenWarning90Sent: false,
		});
		// completedAtTurnIndex 是 optional：createGoalState 省略该键（访问得 undefined）
		expect(createGoalState("my obj").completedAtTurnIndex).toBeUndefined();
	});

	it("objective 透传", () => {
		expect(createGoalState("my obj").objective).toBe("my obj");
	});

	it("goalId 符合 UUID v4 格式", () => {
		expect(createGoalState("obj").goalId).toMatch(UUID_RE);
	});

	it("两次调用生成不同 goalId（唯一性）", () => {
		expect(createGoalState("obj").goalId).not.toBe(createGoalState("obj").goalId);
	});

	describe("budget 合并", () => {
		it("无 overrides → DEFAULT_BUDGET（{}）", () => {
			expect(createGoalState("obj").budget).toEqual({});
		});
		it("tokenBudget override 生效", () => {
			expect(createGoalState("obj", { tokenBudget: 10000 }).budget.tokenBudget).toBe(10000);
		});
	});
});
