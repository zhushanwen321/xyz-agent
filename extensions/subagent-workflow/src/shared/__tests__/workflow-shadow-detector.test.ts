// src/shared/__tests__/workflow-shadow-detector.test.ts
//
// Workflow shadow 检测测试。
// 覆盖：跨源同名检出、dev link 不告警、临时源忽略、unavailable 占位忽略、
// effective/shadowed 分类、多 workflow 排序、formatShadowWarning 格式化与转义。
import { describe, expect, it } from "vitest";

import type { DiscoveredResource } from "../resource-discovery.ts";
import {
	detectWorkflowShadows,
	formatShadowWarning,
	SOURCE_PRIORITY,
} from "../workflow-shadow-detector.ts";

// ============================================================
// helpers
// ============================================================

function makeResource(
	source: DiscoveredResource["source"],
	filePath: string,
	available = true,
): DiscoveredResource {
	return { path: filePath, source, available };
}

// ============================================================
// SOURCE_PRIORITY
// ============================================================

describe("SOURCE_PRIORITY", () => {
	it("数值大小反映 buildScanTargets 顺序（低→高）", () => {
		expect(SOURCE_PRIORITY["user-pi"]).toBeLessThan(SOURCE_PRIORITY["user-agents"]);
		expect(SOURCE_PRIORITY["user-agents"]).toBeLessThan(SOURCE_PRIORITY["npm"]);
		expect(SOURCE_PRIORITY["npm"]).toBeLessThan(SOURCE_PRIORITY["npm-dev"]);
		expect(SOURCE_PRIORITY["npm-dev"]).toBeLessThan(SOURCE_PRIORITY["project-pi"]);
		expect(SOURCE_PRIORITY["project-pi"]).toBeLessThan(SOURCE_PRIORITY["project-pi-tmp"]);
		expect(SOURCE_PRIORITY["project-pi-tmp"]).toBeLessThan(SOURCE_PRIORITY["project-agents"]);
	});
});

// ============================================================
// detectWorkflowShadows
// ============================================================

describe("detectWorkflowShadows", () => {
	it("空列表 → 空", () => {
		expect(detectWorkflowShadows([])).toEqual([]);
	});

	it("单源 → 无 shadow", () => {
		const r = [makeResource("npm", "/npm/review-fix-loop.js")];
		expect(detectWorkflowShadows(r)).toEqual([]);
	});

	it("project-pi shadow npm → 检出，effective=project-pi", () => {
		const r = [
			makeResource("npm", "/npm/review-fix-loop.js"),
			makeResource("project-pi", "/ws/.pi/workflows/review-fix-loop.js"),
		];
		const shadows = detectWorkflowShadows(r);
		expect(shadows).toHaveLength(1);
		expect(shadows[0]?.name).toBe("review-fix-loop");
		expect(shadows[0]?.effective.source).toBe("project-pi");
		expect(shadows[0]?.effective.path).toBe("/ws/.pi/workflows/review-fix-loop.js");
		expect(shadows[0]?.shadowed).toHaveLength(1);
		expect(shadows[0]?.shadowed[0]?.source).toBe("npm");
	});

	it("user-pi 与 npm 同名 → 检出，effective=npm（优先级高于 user-pi，user-pi 为冗余副本）", () => {
		// user-pi 优先级最低（1）< npm（3）：npm 覆盖 user-pi。
		// user-pi 旧副本不生效（无害冗余），但检出提醒清理仍有价值。
		const r = [
			makeResource("npm", "/npm/review-fix-loop.js"),
			makeResource("user-pi", "/home/.pi/agent/workflows/review-fix-loop.js"),
		];
		const shadows = detectWorkflowShadows(r);
		expect(shadows).toHaveLength(1);
		expect(shadows[0]?.effective.source).toBe("npm");
		expect(shadows[0]?.shadowed[0]?.source).toBe("user-pi");
	});

	it("三源（project-pi + user-pi + npm）→ effective=project-pi，shadowed 含另两个", () => {
		const r = [
			makeResource("npm", "/npm/review-fix-loop.js"),
			makeResource("user-pi", "/home/.pi/agent/workflows/review-fix-loop.js"),
			makeResource("project-pi", "/ws/.pi/workflows/review-fix-loop.js"),
		];
		const shadows = detectWorkflowShadows(r);
		expect(shadows).toHaveLength(1);
		expect(shadows[0]?.effective.source).toBe("project-pi");
		expect(shadows[0]?.shadowed.map((s) => s.source).sort()).toEqual(["npm", "user-pi"]);
		expect(shadows[0]?.resources).toHaveLength(3);
	});

	it("纯 npm + npm-dev（dev link 覆盖）→ 不检出", () => {
		const r = [
			makeResource("npm", "/npm/review-fix-loop.js"),
			makeResource("npm-dev", "/dev/review-fix-loop.js"),
		];
		expect(detectWorkflowShadows(r)).toEqual([]);
	});

	it("project-pi-tmp 被忽略（临时脚本不告警）", () => {
		const r = [
			makeResource("npm", "/npm/review-fix-loop.js"),
			makeResource("project-pi-tmp", "/ws/.pi/workflows/.tmp/review-fix-loop.js"),
		];
		expect(detectWorkflowShadows(r)).toEqual([]);
	});

	it("project-pi-tmp 与 project-pi 同名也不告警", () => {
		const r = [
			makeResource("project-pi", "/ws/.pi/workflows/build.js"),
			makeResource("project-pi-tmp", "/ws/.pi/workflows/.tmp/build.js"),
		];
		expect(detectWorkflowShadows(r)).toEqual([]);
	});

	it("available=false 占位不参与 shadow 判定（无实际文件不构成覆盖）", () => {
		// project-pi 声明但文件缺失（manifest 失败占位）+ npm 正常 → 只剩 npm 单源，无冲突
		const r = [
			makeResource("project-pi", "/ws/.pi/workflows/review-fix-loop.js", false),
			makeResource("npm", "/npm/review-fix-loop.js", true),
		];
		expect(detectWorkflowShadows(r)).toEqual([]);
	});

	it("多个不同 workflow 各自冲突 → 全检出，按 name 字典序", () => {
		const r = [
			makeResource("npm", "/npm/z-workflow.js"),
			makeResource("project-pi", "/ws/.pi/workflows/z-workflow.js"),
			makeResource("npm", "/npm/a-workflow.js"),
			makeResource("user-pi", "/home/.pi/agent/workflows/a-workflow.js"),
		];
		const shadows = detectWorkflowShadows(r);
		expect(shadows.map((s) => s.name)).toEqual(["a-workflow", "z-workflow"]);
	});

	it(".mjs 扩展名也被识别（stem 去扩展名）", () => {
		const r = [
			makeResource("npm", "/npm/build.mjs"),
			makeResource("project-pi", "/ws/.pi/workflows/build.mjs"),
		];
		const shadows = detectWorkflowShadows(r);
		expect(shadows).toHaveLength(1);
		expect(shadows[0]?.name).toBe("build");
	});
});

// ============================================================
// formatShadowWarning
// ============================================================

describe("formatShadowWarning", () => {
	it("空列表 → 空串", () => {
		expect(formatShadowWarning([])).toBe("");
	});

	it("非空 → 含 workflow_shadow_warning 段与各 shadow 条目", () => {
		const shadows = detectWorkflowShadows([
			makeResource("npm", "/npm/review-fix-loop.js"),
			makeResource("project-pi", "/ws/.pi/workflows/review-fix-loop.js"),
		]);
		const out = formatShadowWarning(shadows);
		expect(out).toContain("<workflow_shadow_warning>");
		expect(out).toContain("</workflow_shadow_warning>");
		expect(out).toContain('name="review-fix-loop"');
		expect(out).toContain('source="project-pi"');
		expect(out).toContain("/ws/.pi/workflows/review-fix-loop.js");
		expect(out).toContain('source="npm"');
		expect(out).toContain("/npm/review-fix-loop.js");
	});

	it("XML 特殊字符被转义", () => {
		// 构造含 < & " 的路径，验证 escapeXml
		const shadows = detectWorkflowShadows([
			makeResource("npm", "/npm/a<b>&c.js"),
			makeResource("project-pi", "/ws/.pi/workflows/a<b>&c.js"),
		]);
		const out = formatShadowWarning(shadows);
		expect(out).not.toContain('name="a<b>&c"');
		expect(out).toContain("a&lt;b&gt;&amp;c");
	});
});
