/**
 * successCriteria 结构化迁移测试 — string → string[]
 *
 * W1：successCriteria 从单条自由文本 string 结构化为条件数组 string[]
 *（1~8 条、每条单行短条件）。旧持久化数据兼容迁移（string → string[]）。
 */
import { describe, expect, it } from "vitest";

import { deserializeState, serializeState } from "../persistence";
import { createGoalState } from "../engine/goal";

// ── 类型断言辅助 ─────────────────────────────────────

describe("GoalRuntimeState.successCriteria — string[] 类型", () => {
	it("createGoalState 返回 string[] 类型的 successCriteria", () => {
		const state = createGoalState("obj", undefined, undefined, ["criterion 1", "criterion 2"]);
		expect(Array.isArray(state.successCriteria)).toBe(true);
		expect(state.successCriteria).toEqual(["criterion 1", "criterion 2"]);
	});

	it("createGoalState 无 successCriteria → undefined", () => {
		const state = createGoalState("obj");
		expect(state.successCriteria).toBeUndefined();
	});
});

// ── 持久化 round-trip（新格式 string[]）───────────────

describe("serializeState / deserializeState — string[] round-trip", () => {
	it("successCriteria string[] 正确 round-trip", () => {
		const state = createGoalState("obj", undefined, "slug", ["a", "b", "c"]);
		const serialized = serializeState(state);
		const deserialized = deserializeState(serialized as unknown as Record<string, unknown>);
		expect(deserialized.successCriteria).toEqual(["a", "b", "c"]);
	});

	it("successCriteria undefined 正确 round-trip", () => {
		const state = createGoalState("obj");
		const serialized = serializeState(state);
		const deserialized = deserializeState(serialized as unknown as Record<string, unknown>);
		expect(deserialized.successCriteria).toBeUndefined();
	});
});

// ── 旧持久化数据迁移（string → string[]）─────────────

describe("deserializeState — 旧数据迁移 string → string[]", () => {
	it("旧格式 successCriteria 为 string → 归一化为 string[]", () => {
		const oldData: Record<string, unknown> = {
			goalId: "g1",
			objective: "test",
			status: "active",
			successCriteria: "pnpm test passes; tsc clean; lint passes",
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

		const state = deserializeState(oldData);
		expect(Array.isArray(state.successCriteria)).toBe(true);
		// 旧 string 按分号拆分为 string[]
		expect(state.successCriteria).toEqual([
			"pnpm test passes",
			"tsc clean",
			"lint passes",
		]);
	});

	it("旧格式 successCriteria 含多余空格 → trim", () => {
		const oldData: Record<string, unknown> = {
			goalId: "g1",
			objective: "test",
			status: "active",
			successCriteria: "  criterion A  ;  criterion B  ",
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

		const state = deserializeState(oldData);
		expect(state.successCriteria).toEqual(["criterion A", "criterion B"]);
	});

	it("旧格式 successCriteria 为空 string → 空数组", () => {
		const oldData: Record<string, unknown> = {
			goalId: "g1",
			objective: "test",
			status: "active",
			successCriteria: "",
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

		const state = deserializeState(oldData);
		expect(state.successCriteria).toEqual([]);
	});

	it("新格式 successCriteria 为 string[] → 直接使用（不二次拆分）", () => {
		const newData: Record<string, unknown> = {
			goalId: "g1",
			objective: "test",
			status: "active",
			successCriteria: ["item a", "item b"],
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

		const state = deserializeState(newData);
		expect(state.successCriteria).toEqual(["item a", "item b"]);
	});

	it("旧格式 successCriteria 为 undefined → undefined", () => {
		const oldData: Record<string, unknown> = {
			goalId: "g1",
			objective: "test",
			status: "active",
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

		const state = deserializeState(oldData);
		expect(state.successCriteria).toBeUndefined();
	});
});
