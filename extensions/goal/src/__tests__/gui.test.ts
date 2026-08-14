/**
 * buildGoalGui 测试 — goal 的 GUI 渲染描述符构造（经 guiSetWidget 推送 M17 对话流 widget 面板）
 *
 * 覆盖：
 * - 有/无 tokenBudget 统一 card 容器（差异只在 body 是否含 progress-bar）
 * - 预算消耗阈值（≥70% warn, ≥90% danger）+ 浮点 current 取整
 * - 状态→severity/variant 映射（card variant 与 goalStatusSeverity 同语义）
 * - successCriteria 逐行 list-tree（不压扁/不截断）
 * - token 展示走 formatTokens（无 budget 分支）
 */
import { describe, expect, it } from "vitest";

import { buildGoalGui } from "../projection/gui";
import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState, GoalStatus } from "../engine/types";

function makeState(overrides: Partial<GoalRuntimeState> = {}): GoalRuntimeState {
	return {
		...createGoalState("test"),
		...overrides,
	};
}

/** 从 card body 中按 type 取组件（buildGoalGui 的每个 body 组件类型至多一个）。 */
function findBodyComp(
	gui: ReturnType<typeof buildGoalGui>,
	type: string,
): { type: string; props: Record<string, unknown> } {
	const body = gui.component.props.body as { type: string; props: Record<string, unknown> }[];
	const found = body.find((c) => c.type === type);
	if (!found) throw new Error(`body 中无 ${type} 组件`);
	return found;
}

describe("buildGoalGui", () => {
	it("有 tokenBudget → card 含 progress-bar + stats-line", () => {
		const gui = buildGoalGui(
			makeState({
				tokensUsed: 4200,
				budget: { tokenBudget: 10000 },
				currentTurnIndex: 3,
			}),
		);
		expect(gui.v).toBe(1);
		expect(gui.component.type).toBe("card");
		const tokenBar = findBodyComp(gui, "progress-bar");
		expect(tokenBar.props).toMatchObject({ current: 4200, total: 10000, severity: "ok" });
		const stats = findBodyComp(gui, "stats-line");
		expect(stats.props.items).toContainEqual(expect.objectContaining({ label: "status", value: "active" }));
	});

	it("tokensUsed 浮点 → progress-bar current 取整（1454.84…1 不进 UI）", () => {
		const gui = buildGoalGui(
			makeState({ tokensUsed: 1454.8400000000001, budget: { tokenBudget: 5000 } }),
		);
		expect(findBodyComp(gui, "progress-bar").props.current).toBe(1455);
	});

	it.each([
		["9500/10000 ≥90%", 9500, "danger"],
		["9000/10000 =90%", 9000, "danger"],
		["7500/10000 ≥70%", 7500, "warn"],
		["7000/10000 =70%", 7000, "warn"],
	])("token 消耗 %s → severity %s（S#14 边界 ≥）", (_label, used, severity) => {
		const gui = buildGoalGui(makeState({ tokensUsed: used, budget: { tokenBudget: 10000 } }));
		const tokenBar = findBodyComp(gui, "progress-bar");
		expect(tokenBar.props.severity).toBe(severity);
	});

	it("无 budget → 同样是 card 容器，body 无 progress-bar，stats-line 含 tokens（formatTokens）", () => {
		const gui = buildGoalGui(
			makeState({
				currentTurnIndex: 5,
				tokensUsed: 3000,
			}),
		);
		expect(gui.component.type).toBe("card");
		const types = (gui.component.props.body as { type: string }[]).map((c) => c.type);
		expect(types).not.toContain("progress-bar");
		const stats = findBodyComp(gui, "stats-line");
		const items = stats.props.items as { label?: string; value?: string }[];
		const labels = items.map((i) => i.label);
		expect(labels).toContain("status");
		expect(labels).toContain("turn");
		expect(items.find((i) => i.label === "tokens")).toMatchObject({ value: "3k" });
	});

	it("有 budget 时 stats-line 不重复 tokens（进度条已表达）", () => {
		const gui = buildGoalGui(makeState({ tokensUsed: 3000, budget: { tokenBudget: 10000 } }));
		const stats = findBodyComp(gui, "stats-line");
		const labels = (stats.props.items as { label?: string }[]).map((i) => i.label);
		expect(labels).not.toContain("tokens");
	});

	// ── card variant 与 goalStatusSeverity 同语义 ──

	it.each([
		["blocked", "danger"],
		["budget_limited", "danger"],
		["cancelled", "danger"],
	])("status %s → card variant danger（原实现漏了后两个错误终态）", (status, variant) => {
		const gui = buildGoalGui(
			makeState({ status: status as GoalStatus, budget: { tokenBudget: 10000 } }),
		);
		expect(gui.component.type).toBe("card");
		expect(gui.component.props.variant).toBe(variant);
	});

	it("complete 状态 → card variant success", () => {
		const gui = buildGoalGui(
			makeState({
				status: "complete",
				budget: { tokenBudget: 10000 },
			}),
		);
		expect(gui.component.type).toBe("card");
		expect(gui.component.props.variant).toBe("success");
	});

	it("slug 缺省 → header 用 goalId 前 8 字符（两分支一致）", () => {
		const withBudget = makeState({ slug: undefined, budget: { tokenBudget: 10000 } });
		expect(buildGoalGui(withBudget).component.props.header).toBe(withBudget.goalId.slice(0, 8));
		const noBudget = makeState({ slug: undefined });
		expect(buildGoalGui(noBudget).component.props.header).toBe(noBudget.goalId.slice(0, 8));
	});

	// ── S#2: statusSeverity 完整覆盖 ──

	it.each([
		["budget_limited", "danger"],
		["cancelled", "danger"],
		["paused", "warn"],
	])("status %s → stats-line status severity %s（S#2）", (status, severity) => {
		const gui = buildGoalGui(makeState({ status: status as GoalStatus, budget: { tokenBudget: 10000 } }));
		const stats = findBodyComp(gui, "stats-line");
		const items = stats.props.items as Array<{ label: string; severity?: string }>;
		const statusItem = items.find((i) => i.label === "status")!;
		expect(statusItem.severity).toBe(severity);
	});

	// ── I#1: tokenBudget=0 口径统一 ──

	it("tokenBudget=0 → 无 progress-bar（口径 >0，I#1）", () => {
		const gui = buildGoalGui(makeState({ tokensUsed: 0, budget: { tokenBudget: 0 } }));
		// tokenBudget=0 → hasBudget=false → 走无 budget 形态：card 但 body 无 progress-bar
		expect(gui.component.type).toBe("card");
		const types = (gui.component.props.body as { type: string }[]).map((c) => c.type);
		expect(types).not.toContain("progress-bar");
	});

	// ── 无 budget 分支的 status severity ──

	it("无 budget 时 status severity 正确（S#14）", () => {
		const gui = buildGoalGui(makeState({ status: "active" }));
		const stats = findBodyComp(gui, "stats-line");
		const items = stats.props.items as Array<{ label: string; severity?: string }>;
		const statusItem = items.find((i) => i.label === "status");
		expect(statusItem!.severity).toBe("ok");
	});

	// ── successCriteria 逐行 list-tree（多行不再压扁/截断）──

	it("多行 successCriteria → list-tree 每行一条 check item（用户报障场景）", () => {
		const gui = buildGoalGui(
			makeState({
				successCriteria: "1. 输出 Node.js 版本号；\n2. 输出 extensions 目录下的子目录列表",
				budget: { tokenBudget: 10000 },
			}),
		);
		expect(gui.component.type).toBe("card");
		const tree = findBodyComp(gui, "list-tree");
		expect(tree.props.items).toEqual([
			{ icon: "check", label: "1. 输出 Node.js 版本号；", depth: 0 },
			{ icon: "check", label: "2. 输出 extensions 目录下的子目录列表", depth: 0 },
		]);
		// stats-line 不再承载 criteria（原 {label:'done'} 压扁塞法已移除）
		const stats = findBodyComp(gui, "stats-line");
		const labels = (stats.props.items as { label?: string }[]).map((i) => i.label);
		expect(labels).not.toContain("done");
	});

	it("无 budget 分支 + successCriteria → body 同样含 list-tree", () => {
		const gui = buildGoalGui(makeState({ successCriteria: "all tests green" }));
		expect(gui.component.type).toBe("card");
		const tree = findBodyComp(gui, "list-tree");
		expect(tree.props.items).toEqual([{ icon: "check", label: "all tests green", depth: 0 }]);
	});

	it("超 80 字符的 criteria 行不截断（list-tree 单行自然换行）", () => {
		const longLine = "x".repeat(120);
		const gui = buildGoalGui(makeState({ successCriteria: longLine }));
		const tree = findBodyComp(gui, "list-tree");
		expect(tree.props.items).toEqual([{ icon: "check", label: longLine, depth: 0 }]);
	});

	it("successCriteria 空行/空白行过滤", () => {
		const gui = buildGoalGui(makeState({ successCriteria: "a\n\n  \nb" }));
		const tree = findBodyComp(gui, "list-tree");
		expect(tree.props.items).toHaveLength(2);
	});

	it("无 successCriteria → body 无 list-tree", () => {
		const gui = buildGoalGui(makeState({ successCriteria: undefined, budget: { tokenBudget: 10000 } }));
		const types = (gui.component.props.body as { type: string }[]).map((c) => c.type);
		expect(types).not.toContain("list-tree");
	});
});
