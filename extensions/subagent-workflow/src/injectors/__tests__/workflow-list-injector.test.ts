// workflow-list-injector 单测
//
// 覆盖纯函数：summarizeDescription（截断）+ parseWorkflowMeta（meta 块解析）+
// formatWorkflowList（B2 注入段格式 + 引导语）。discoverAllWorkflows 依赖文件系统
// + resource-discovery，属集成层，此处聚焦可快速回归的格式化契约。

import { describe, expect, it } from "vitest";

import {
	formatWorkflowList,
	parseWorkflowMeta,
	summarizeDescription,
} from "../workflow-list-injector";

describe("summarizeDescription", () => {
	it("短描述原样返回", () => {
		expect(summarizeDescription("短描述")).toBe("短描述");
	});

	it("超长描述在句末标点处断句", () => {
		// 每段约 15 字、含「。」，重复 20 次远超 160 字上限
		const long = "审查循环：多批串行。必填参数。继续。".repeat(20);
		const out = summarizeDescription(long, 160);
		expect(out.length).toBeLessThanOrEqual(161);
		expect(out).toContain("。");
	});

	it("无句末标点时硬截断 + 省略号", () => {
		const long = "x".repeat(300);
		const out = summarizeDescription(long, 160);
		expect(out.length).toBe(161); // 160 + 省略号
		expect(out.endsWith("…")).toBe(true);
	});
});

describe("parseWorkflowMeta", () => {
	it("从 @pi-meta 块解析 name + description", () => {
		const src = `// header comment
/* @pi-meta
name: chain
description: 通用编排：三步链
phases: [a, b]
*/
rest of code`;
		expect(parseWorkflowMeta(src)).toEqual({
			name: "chain",
			description: "通用编排：三步链",
		});
	});

	it("双引号包裹的值也能解析", () => {
		const src = `/* @pi-meta
name: "parallel"
description: "多视角并行"
phases: []
*/`;
		expect(parseWorkflowMeta(src)).toEqual({
			name: "parallel",
			description: "多视角并行",
		});
	});

	it("无 meta 块返回 null", () => {
		expect(parseWorkflowMeta("// no meta here")).toBeNull();
	});

	it("@pi-meta 缺 name 或 description 返回 null", () => {
		expect(parseWorkflowMeta("/* @pi-meta\ndescription: x\nphases: []\n*/")).toBeNull();
		expect(parseWorkflowMeta("/* @pi-meta\nname: x\nphases: []\n*/")).toBeNull();
	});

	it("超长 description 被截断为摘要", () => {
		const longDesc = "详".repeat(300);
		const src = `/* @pi-meta\nname: rfl\ndescription: ${longDesc}\nphases: []\n*/`;
		const r = parseWorkflowMeta(src);
		expect(r).not.toBeNull();
		expect(r!.name).toBe("rfl");
		expect(r!.description.length).toBeLessThanOrEqual(161);
	});

	it("review-fix-loop 风格的 meta（长 description 含关键 args）被合理截断", () => {
		const src = `/* @pi-meta
name: review-fix-loop
description: 审查-修复循环：多批串行（批内并行 review → aggregate → fix → 重审直到 clean）。必填 targetType（git-diff/file/dir/text）+ target。批次由必填参数 batch1..batchN 控制（无默认，至少传一个；agents 为单批简写；如 batch1=fallow-scan batch2=reviewer）。更多细节省略。
phases: [Review, Fix]
*/`;
		const r = parseWorkflowMeta(src);
		expect(r).not.toBeNull();
		expect(r!.name).toBe("review-fix-loop");
		expect(r!.description).toContain("targetType");
		expect(r!.description.length).toBeLessThanOrEqual(161);
	});
});

describe("formatWorkflowList", () => {
	it("空列表返回空串（不注入）", () => {
		expect(formatWorkflowList([])).toBe("");
	});

	it("用 <available_workflows> 标签包裹并列出每个 workflow", () => {
		const out = formatWorkflowList([
			{ name: "chain", description: "三步链" },
			{ name: "parallel", description: "并行分析" },
		]);
		expect(out).toContain("<available_workflows>");
		expect(out).toContain("</available_workflows>");
		expect(out).toContain("<name>chain</name>");
		expect(out).toContain("<description>三步链</description>");
		expect(out).toContain("<name>parallel</name>");
	});

	it("包含 'Do NOT call list to discover available workflows' 引导语", () => {
		const out = formatWorkflowList([{ name: "chain", description: "d" }]);
		expect(out).toContain("Do NOT call list to discover available workflows");
		expect(out).toContain("use list only for running state");
	});

	it("点名 builtin workflow 可直接 run", () => {
		const out = formatWorkflowList([{ name: "chain", description: "d" }]);
		expect(out).toContain("run directly");
		expect(out).toContain("review-fix-loop");
	});

	it("转义 XML 特殊字符", () => {
		const out = formatWorkflowList([{ name: "a&b", description: "<x>" }]);
		expect(out).toContain("<name>a&amp;b</name>");
		expect(out).toContain("&lt;x&gt;");
	});
});
