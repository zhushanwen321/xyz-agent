/**
 * FR-5/FR-7.3: deserializeState — 新格式严格解析（字段缺失 throw）
 *
 * round-trip property 覆盖全字段 serialize→deserialize 双向一致性，替代手写还原用例。
 * 保留：throw 路径（缺必填）+ 向后兼容（缺 optional）+ 旧 tasks 字段忽略。
 */
import { describe, expect } from "vitest";
import { it, fc } from "@fast-check/vitest";

import { deserializeState, serializeState } from "../persistence";
import { isTerminalStatus } from "../engine/goal";
import type { GoalRuntimeState, GoalStatus } from "../engine/types";

const STATUS_VALUES: GoalStatus[] = ["active", "paused", "blocked", "complete", "budget_limited", "cancelled"];

// GoalRuntimeState 全字段生成器（optional 字段用 fc.option 覆盖有/无两态）
const goalStateArb = fc.record({
	goalId: fc.uuid(),
	objective: fc.string({ minLength: 1 }),
	successCriteria: fc.oneof(fc.constant(undefined), fc.array(fc.string({ minLength: 1 }))),
	slug: fc.option(fc.string({ minLength: 1 })),
	status: fc.constantFrom(...STATUS_VALUES),
	tokensUsed: fc.nat(),
	timeStartedAt: fc.integer({ min: 0 }),
	timeUsedSeconds: fc.nat(),
	budget: fc.record({ tokenBudget: fc.option(fc.integer({ min: 0 })) }),
	lastProgressTurn: fc.nat(),
	budgetLimitSteeringSent: fc.boolean(),
	objectiveUpdatedAt: fc.integer({ min: 0 }),
	lastBlockerReason: fc.option(fc.string(), { nil: null }), // string | null
	tokenWarning70Sent: fc.boolean(),
	tokenWarning90Sent: fc.boolean(),
	lastTurnTokensUsed: fc.nat(),
	currentTurnIndex: fc.nat(),
	completedAtTurnIndex: fc.option(fc.nat()),
}) as unknown as fc.Arbitrary<GoalRuntimeState>;

// 旧 entry 模拟（含已废弃 tasks 字段，验证向后兼容忽略）
const FULL_DATA: Record<string, unknown> = {
	goalId: "g1",
	objective: "test",
	status: "active",
	tasks: [{ id: 1, description: "task 1", status: "completed", lastUpdatedTurn: 5 }],
	tokensUsed: 0,
	timeStartedAt: 1000,
	timeUsedSeconds: 0,
	budget: {},
	lastProgressTurn: 0,
	budgetLimitSteeringSent: false,
	objectiveUpdatedAt: 1000,
	lastBlockerReason: null,
	tokenWarning70Sent: false,
	tokenWarning90Sent: false,
	lastTurnTokensUsed: 0,
	currentTurnIndex: 0,
};

describe("deserializeState — round-trip", () => {
	// ⭐ serialize→deserialize 深相等：覆盖全 18 字段双向一致性（含 optional 有/无两态）
	it.prop([goalStateArb])("deserializeState(serializeState(s)) 深相等 s", (s) => {
		const rt = deserializeState(serializeState(s) as unknown as Record<string, unknown>);
		expect(rt).toEqual(s);
	});
});

describe("deserializeState — 严格解析（缺必填 throw）", () => {
	it("完整数据（含旧 tasks 字段）→ 正确还原，tasks 被忽略", () => {
		const state = deserializeState(FULL_DATA);
		expect(state.tokenWarning70Sent).toBe(false);
		expect(state.objective).toBe("test");
		expect((state as unknown as { tasks?: unknown }).tasks).toBeUndefined();
	});

	it("顶层缺 budget → throw", () => {
		expect(() => deserializeState({ goalId: "g1", objective: "test", status: "active" })).toThrow();
	});

	it("缺 tokenWarning70Sent → throw", () => {
		const data = { ...FULL_DATA };
		delete data.tokenWarning70Sent;
		expect(() => deserializeState(data)).toThrow();
	});
});

describe("deserializeState — optional 字段向后兼容（GAP-4 旧数据）", () => {
	it("缺 completedAtTurnIndex → undefined", () => {
		expect(deserializeState(FULL_DATA).completedAtTurnIndex).toBeUndefined();
	});
	it("缺 slug → undefined", () => {
		expect(deserializeState(FULL_DATA).slug).toBeUndefined();
	});
	it("缺 successCriteria → undefined", () => {
		expect(deserializeState(FULL_DATA).successCriteria).toBeUndefined();
	});
});

describe("deserializeState — 旧数据迁移（time_limited → budget_limited，MF-1）", () => {
	// npm pi-goal 0.7.x 持久化格式：status=time_limited + timeWarning* 遗留字段（时间预算维度已移除）
	const LEGACY_DATA: Record<string, unknown> = {
		...FULL_DATA,
		status: "time_limited",
		timeWarning70Sent: true,
		timeWarning90Sent: true,
	};

	it("旧 entry status=time_limited → 归一化 budget_limited，遗留字段被忽略", () => {
		const state = deserializeState(LEGACY_DATA);
		expect(state.status).toBe("budget_limited");
		expect((state as unknown as { timeWarning70Sent?: unknown }).timeWarning70Sent).toBeUndefined();
		expect((state as unknown as { timeWarning90Sent?: unknown }).timeWarning90Sent).toBeUndefined();
	});

	it("归一化后是合法终态：/goal clear 守卫（!isTerminalStatus）跳过 transitionStatus，不 throw", () => {
		const state = deserializeState(LEGACY_DATA);
		// handleClear（command-adapter.ts）的守卫：!isTerminalStatus 为 false → 直接 clearSession，
		// 不再走 finalizeAndPersist("cancelled") 的 transitionStatus 查表（旧值会 throw）。
		expect(isTerminalStatus(state.status)).toBe(true);
	});

	it("新格式 status 不受影响（time_limited 之外的六态原样透传）", () => {
		for (const status of STATUS_VALUES) {
			expect(deserializeState({ ...FULL_DATA, status }).status).toBe(status);
		}
	});
});
