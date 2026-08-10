// Schema 强约束回归（T4/TC3/TC4）：TodoParams 为 discriminated union（按 action），
// 每个分支只声明自己的参数且 additionalProperties:false。用 typebox 的 Value.Check
// 验证：缺失必填、多余字段、已删除的 action 都在 schema 层被拒绝，不依赖运行时 throw。
//
// 选 Value.Check 而非 ajv：typebox 自带 Value 校验器与其 schema 语义一致；
// spike 确认 Value.Check 与 plain ajv 对本 schema 的拒绝结论一致（ajv 的
// discriminator:true 选项会编译失败，故不依赖该选项）。

import { describe, expect, it } from "vitest";

import { Value } from "typebox/value";

import { TodoParams } from "../tool";

describe("TodoParams discriminated union schema", () => {
	describe("合法 payload 通过", () => {
		it("list（无参）", () => {
			expect(Value.Check(TodoParams, { action: "list" })).toBe(true);
		});
		it("add + texts", () => {
			expect(Value.Check(TodoParams, { action: "add", texts: ["write spec"] })).toBe(true);
		});
		it("update 单条 + id + status", () => {
			expect(Value.Check(TodoParams, { action: "update", id: 1, status: "in_progress" })).toBe(true);
		});
		it("update 批量 + updates", () => {
			expect(Value.Check(TodoParams, { action: "update", updates: [{ id: 1, status: "completed" }] })).toBe(true);
		});
		it("delete + ids", () => {
			expect(Value.Check(TodoParams, { action: "delete", ids: [1, 2] })).toBe(true);
		});
	});

	describe("TC4: 缺失必填被 schema 拒绝", () => {
		it("add 缺 texts", () => {
			expect(Value.Check(TodoParams, { action: "add" })).toBe(false);
		});
		it("update 缺 id 且缺 updates", () => {
			expect(Value.Check(TodoParams, { action: "update" })).toBe(false);
		});
		it("delete 缺 ids", () => {
			expect(Value.Check(TodoParams, { action: "delete" })).toBe(false);
		});
	});

	describe("TC3: 已删除的 clear action 被拒绝", () => {
		it("clear 不在 action 枚举内", () => {
			expect(Value.Check(TodoParams, { action: "clear" })).toBe(false);
		});
	});

	describe("额外属性被拒绝（additionalProperties:false）", () => {
		it("TC7: add 同时传 text+texts（text 是多余字段）→ 拒绝", () => {
			// schema 层拒绝双形陷阱；handler 层另有 defense-in-depth throw（见 tool-detectors）
			expect(Value.Check(TodoParams, { action: "add", texts: ["y"], text: "x" })).toBe(false);
		});
		it("list 携带多余 texts → 拒绝", () => {
			expect(Value.Check(TodoParams, { action: "list", texts: ["x"] })).toBe(false);
		});
		it("update 单条携带多余 ids → 拒绝", () => {
			expect(Value.Check(TodoParams, { action: "update", id: 1, ids: [1] })).toBe(false);
		});
	});

	describe("status 枚举强约束", () => {
		it("合法三态 status 通过", () => {
			expect(Value.Check(TodoParams, { action: "update", id: 1, status: "completed" })).toBe(true);
		});
		it("TC2: cancelled 不再合法", () => {
			expect(Value.Check(TodoParams, { action: "update", id: 1, status: "cancelled" })).toBe(false);
		});
		it("非法 status 被拒绝", () => {
			expect(Value.Check(TodoParams, { action: "update", id: 1, status: "banana" })).toBe(false);
		});
	});
});
