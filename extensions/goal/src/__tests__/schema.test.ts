/**
 * goal_control schema — discriminated union 校验测试（TC6 / CT3）
 *
 * schema 为 Type.Union（无 discriminator keyword）+ 各分支 additionalProperties:false，
 * 以 action literal 区分分支。pi 生产校验器为 typebox/compile 的 Compile(schema).Check(args)，
 * 与此处 Value.Check 同源（同一 typebox schema 语义），故用 Value.Check 验证拒绝行为。
 */
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import { GoalControlParams } from "../adapters/goal-control-adapter";

describe("GoalControlParams — discriminated union（TC6）", () => {
	// ── create 分支 ──

	it("create 完整（objective + successCriteria）→ 通过", () => {
		expect(
			Value.Check(GoalControlParams, { action: "create", objective: "x", successCriteria: "y" }),
		).toBe(true);
	});

	it("create + slug（optional）→ 通过", () => {
		expect(
			Value.Check(GoalControlParams, {
				action: "create",
				slug: "refactor-auth",
				objective: "x",
				successCriteria: "y",
			}),
		).toBe(true);
	});

	it("create + tokenBudget（optional）→ 通过", () => {
		expect(
			Value.Check(GoalControlParams, {
				action: "create",
				objective: "x",
				successCriteria: "y",
				tokenBudget: 8000,
			}),
		).toBe(true);
	});

	it("create 缺 objective → 拒绝", () => {
		expect(Value.Check(GoalControlParams, { action: "create", successCriteria: "y" })).toBe(false);
	});

	it("create 缺 successCriteria → 拒绝", () => {
		expect(Value.Check(GoalControlParams, { action: "create", objective: "x" })).toBe(false);
	});

	it("create 含额外字段 → 拒绝（additionalProperties:false）", () => {
		expect(
			Value.Check(GoalControlParams, {
				action: "create",
				objective: "x",
				successCriteria: "y",
				foo: 1,
			}),
		).toBe(false);
	});

	it("create 含 complete 分支字段 evidence → 拒绝（分支隔离）", () => {
		expect(
			Value.Check(GoalControlParams, {
				action: "create",
				objective: "x",
				successCriteria: "y",
				evidence: "leak",
			}),
		).toBe(false);
	});

	// ── complete 分支 ──

	it("complete 完整（evidence）→ 通过", () => {
		expect(Value.Check(GoalControlParams, { action: "complete", evidence: "tests green" })).toBe(true);
	});

	it("complete 缺 evidence → 拒绝", () => {
		expect(Value.Check(GoalControlParams, { action: "complete" })).toBe(false);
	});

	it("complete 含额外字段 → 拒绝（additionalProperties:false）", () => {
		expect(
			Value.Check(GoalControlParams, { action: "complete", evidence: "x", reason: "leak" }),
		).toBe(false);
	});

	// ── report_blocked 分支 ──

	it("report_blocked 完整（reason）→ 通过", () => {
		expect(Value.Check(GoalControlParams, { action: "report_blocked", reason: "stuck" })).toBe(true);
	});

	it("report_blocked 缺 reason → 拒绝", () => {
		expect(Value.Check(GoalControlParams, { action: "report_blocked" })).toBe(false);
	});

	it("report_blocked 含额外字段 → 拒绝（additionalProperties:false）", () => {
		expect(
			Value.Check(GoalControlParams, { action: "report_blocked", reason: "x", evidence: "leak" }),
		).toBe(false);
	});

	// ── action 隔离 ──

	it("未知 action → 拒绝", () => {
		expect(Value.Check(GoalControlParams, { action: "unknown" })).toBe(false);
	});

	it("缺 action → 拒绝", () => {
		expect(Value.Check(GoalControlParams, { objective: "x" })).toBe(false);
	});
});
