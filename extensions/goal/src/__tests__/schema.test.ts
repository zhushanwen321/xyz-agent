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
	// valid：各分支完整 + optional 字段 → 通过
	it.each([
		["create 完整", { action: "create", objective: "x", successCriteria: "y" }],
		["create + slug", { action: "create", slug: "refactor-auth", objective: "x", successCriteria: "y" }],
		["create + tokenBudget", { action: "create", objective: "x", successCriteria: "y", tokenBudget: 8000 }],
		["complete 完整", { action: "complete", evidence: "tests green" }],
		["report_blocked 完整", { action: "report_blocked", reason: "stuck" }],
	])("valid: %s → 通过", (_name, params) => {
		expect(Value.Check(GoalControlParams, params)).toBe(true);
	});

	// invalid：缺必填 / 额外字段（additionalProperties:false 代表性用例）/ 分支隔离 / 未知 action
	it.each([
		["create 缺 objective", { action: "create", successCriteria: "y" }],
		["create 缺 successCriteria", { action: "create", objective: "x" }],
		["create 含额外字段（additionalProperties:false）", { action: "create", objective: "x", successCriteria: "y", foo: 1 }],
		["create 含 complete 分支字段 evidence（分支隔离）", { action: "create", objective: "x", successCriteria: "y", evidence: "leak" }],
		["complete 缺 evidence", { action: "complete" }],
		["report_blocked 缺 reason", { action: "report_blocked" }],
		["未知 action", { action: "unknown" }],
		["缺 action", { objective: "x" }],
	])("invalid: %s → 拒绝", (_name, params) => {
		expect(Value.Check(GoalControlParams, params)).toBe(false);
	});
});
