// subagent-list-injector 单测
//
// 覆盖纯函数：parseAgentFrontmatter（frontmatter 解析）+ formatAgentList（P3 正向
// 触发引导语 + 名字约束 + XML 结构 + 转义）。discoverAllAgents 依赖文件系统 +
// resource-discovery，属集成层，此处聚焦可快速回归的格式化契约。

import { describe, expect, it } from "vitest";

import {
	formatAgentList,
	parseAgentFrontmatter,
} from "../subagent-list-injector";

describe("parseAgentFrontmatter", () => {
	it("解析双引号包裹的 name + description", () => {
		const md = `---
name: worker
description: "编码执行者"
---
body`;
		expect(parseAgentFrontmatter(md)).toEqual({
			name: "worker",
			description: "编码执行者",
			path: "",
		});
	});

	it("解析单引号包裹的 name + description", () => {
		const md = `---
name: 'reviewer'
description: '代码审查'
---`;
		expect(parseAgentFrontmatter(md)).toEqual({
			name: "reviewer",
			description: "代码审查",
			path: "",
		});
	});

	it("缺 name 或 description 时返回 null", () => {
		expect(parseAgentFrontmatter("---\nname: worker\n---")).toBeNull();
		expect(parseAgentFrontmatter("---\ndescription: x\n---")).toBeNull();
	});

	it("无 frontmatter（不以 --- 开头）返回 null", () => {
		expect(parseAgentFrontmatter("just markdown")).toBeNull();
	});

	it("frontmatter 未闭合（无结束 ---）返回 null", () => {
		expect(parseAgentFrontmatter("---\nname: worker\ndescription: x")).toBeNull();
	});
});

describe("formatAgentList", () => {
	it("空列表返回空串（不注入）", () => {
		expect(formatAgentList([])).toBe("");
	});

	it("TC1: when + examples 注入（原样渲染 + escapeXml + 缺省兼容）", () => {
		const out = formatAgentList([
			{
				name: "reviewer",
				description: "代码审查",
				path: "/agents/reviewer.md",
				when: "用户要求 review 代码",
				examples: [
					{ match: "帮我 review 这段代码", action: "调用 reviewer 对抗式审查", positive: true },
					{ match: "帮我 review 设计文档", action: "不调用（文档审查应选 doc-reviewer）", positive: false },
				],
			},
			{ name: "legacy", description: "未迁移 agent", path: "/agents/legacy.md" },
		]);
		expect(out).toContain("<when>用户要求 review 代码</when>");
		// 正反原样渲染——negative action 含原因文本（评审 M5：渲染器不硬编码）
		expect(out).toContain('"帮我 review 这段代码" → 调用 reviewer 对抗式审查');
		expect(out).toContain('"帮我 review 设计文档" → 不调用（文档审查应选 doc-reviewer）');
		// escapeXml：match 含 < > 被转义
		const xmlOut = formatAgentList([
			{
				name: "x",
				description: "d",
				path: "/agents/x.md",
				examples: [{ match: "处理 <task> 的 diff", action: "调用 x", positive: true }],
			},
		]);
		expect(xmlOut).toContain("&lt;task&gt;");
		// 缺省兼容：无 when/examples 的 agent 不渲染该段
		const legacyOut = formatAgentList([{ name: "legacy", description: "未迁移 agent", path: "/agents/legacy.md" }]);
		expect(legacyOut).not.toContain("<when>");
		expect(legacyOut).not.toContain("<examples>");
	});

	it("包含 P3 正向触发引导语（何时该 delegate）", () => {
		const out = formatAgentList([{ name: "worker", description: "d", path: "/agents/worker.md" }]);
		expect(out).toContain("PRIORITY");
		expect(out).toContain("3+ files");
		expect(out).toContain("delegate");
		expect(out).toContain("FIRST");
	});

	it("保留原 'ONLY use agent names from this list' 名字约束", () => {
		const out = formatAgentList([{ name: "worker", description: "d", path: "/agents/worker.md" }]);
		expect(out).toContain("ONLY use agent names from this list");
	});

	it("包含 'Do NOT call list to discover' 引导语", () => {
		const out = formatAgentList([{ name: "worker", description: "d", path: "/agents/worker.md" }]);
		expect(out).toContain("Do NOT call list to discover");
		expect(out).toContain("use list only for running state");
	});

	it("用 <available_subagents> 标签包裹并列出每个 agent", () => {
		const out = formatAgentList([
			{ name: "worker", description: "does work", path: "/agents/worker.md" },
			{ name: "reviewer", description: "reviews code", path: "/agents/reviewer.md" },
		]);
		expect(out).toContain("<available_subagents>");
		expect(out).toContain("</available_subagents>");
		expect(out).toContain("<name>worker</name>");
		expect(out).toContain("<description>does work</description>");
		expect(out).toContain("<name>reviewer</name>");
		expect(out).toContain("<description>reviews code</description>");
		// S1：每项含 <location> 完整路径（agentRef，模型直接引用）
		expect(out).toContain("<location>/agents/worker.md</location>");
		expect(out).toContain("<location>/agents/reviewer.md</location>");
	});

	it("转义 XML 特殊字符", () => {
		const out = formatAgentList([{ name: "a&b<c>", description: "\"q\"", path: "/agents/a&b<c>.md" }]);
		expect(out).toContain("<name>a&amp;b&lt;c&gt;</name>");
		expect(out).toContain("&quot;q&quot;");
	});
});
