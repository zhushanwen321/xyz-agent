/**
 * goal_control prompt guidance — successCriteria 结构化约束测试
 *
 * W1：goal_control 工具引导文本（参数 description / 工具 description / promptGuidelines）
 * 加入粒度约束（3~8 条高层终态条件、细粒度清单放 todo/plan 只引用不复制、禁止倾倒规格）。
 *
 * 源码断言（读 .ts 文件文本），避免 mock 链。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER_SRC = readFileSync(
	join(__dirname, "../adapters/goal-control-adapter.ts"),
	"utf-8",
);

describe("goal_control schema — successCriteria 参数引导文本", () => {
	it("successCriteria 参数 description 含 string[] 约束（数组、条件条数）", () => {
		// schema description 应包含 string[] 语义和条数约束
		expect(ADAPTER_SRC).toMatch(/successCriteria[\s\S]*?string\[\]/);
	});

	it("successCriteria 参数 description 含粒度引导（高层终态条件 / 禁止倾倒完整规格）", () => {
		expect(ADAPTER_SRC).toContain("高层终态条件");
		expect(ADAPTER_SRC).toContain("禁止倾倒完整规格");
	});
});

describe("goal_control description — 结构化 successCriteria 约束", () => {
	it("description 含 successCriteria 条数约束（3~8 条）", () => {
		// description 应提到 successCriteria 需要 3~8 条
		expect(ADAPTER_SRC).toContain("successCriteria");
		expect(ADAPTER_SRC).toMatch(/3.*8/);
	});
});

describe("goal_control promptGuidelines — 结构化引导", () => {
	it("create promptGuidelines 含结构化 successCriteria 约束", () => {
		expect(ADAPTER_SRC).toContain("promptGuidelines");
		// promptGuidelines 中应提到 successCriteria 是数组
		expect(ADAPTER_SRC).toMatch(/promptGuidelines[\s\S]*?successCriteria/);
	});
});
