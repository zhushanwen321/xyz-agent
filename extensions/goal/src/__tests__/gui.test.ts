/**
 * buildGoalGui 测试 — goal 的 GUI 渲染描述符构造（经 guiSetWidget 推送 M17 对话流 widget 面板）
 *
 * 覆盖：
 * - 有 tokenBudget/timeBudget → card(progress-bar + stats-line)
 * - 预算消耗阈值（≥70% warn, ≥90% danger）
 * - 状态→severity/variant 映射
 * - 无 budget → stats-line 摘要
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

/** 从 card 分支的 body 中按 type 取组件（hasBudget 分支只有一个 progress-bar / 一个 stats-line 组合）。 */
function findBodyComp(
	gui: ReturnType<typeof buildGoalGui>,
	type: string,
): { type: string; props: Record<string, unknown> } {
	const body = gui.component.props.body as { type: string; props: Record<string, unknown> }[];
	return body.find((c) => c.type === type)!;
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

	it("无 budget → stats-line 摘要", () => {
		const gui = buildGoalGui(
			makeState({
				currentTurnIndex: 5,
				tokensUsed: 3000,
			}),
		);
		expect(gui.component.type).toBe("stats-line");
		const items = gui.component.props.items as { label?: string }[];
		const labels = items.map((i) => i.label);
		expect(labels).toContain("goal");
		expect(labels).toContain("status");
		expect(labels).toContain("turn");
		expect(labels).toContain("tokens");
	});

	it("blocked 状态 → card variant danger", () => {
		const gui = buildGoalGui(
			makeState({
				status: "blocked",
				budget: { tokenBudget: 10000 },
			}),
		);
		expect(gui.component.type).toBe("card");
		expect(gui.component.props.variant).toBe("danger");
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

	it("slug 缺省 → header 用 goalId 前 8 字符", () => {
		const state = makeState({ slug: undefined, budget: { tokenBudget: 10000 } });
		const gui = buildGoalGui(state);
		expect(gui.component.props.header).toBe(state.goalId.slice(0, 8));
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
		// tokenBudget=0 → hasBudget=false → 走无 budget 分支的 stats-line
		expect(gui.component.type).toBe("stats-line");
	});

	// ── 无 budget 分支的 status severity ──

	it("无 budget 时 status severity 正确（S#14）", () => {
		const gui = buildGoalGui(makeState({ status: "active" }));
		const items = gui.component.props.items as Array<{ label: string; severity?: string }>;
		const statusItem = items.find((i) => i.label === "status");
		expect(statusItem!.severity).toBe("ok");
	});

	// ── successCriteria 渲染（与 objective 成对，让用户看到「怎么算完成」）──

	it("card 分支（有 budget）+ successCriteria → body 含 stats-line {label:'done'}", () => {
		const gui = buildGoalGui(
			makeState({
				successCriteria: "all tests green",
				budget: { tokenBudget: 10000 },
			}),
		);
		expect(gui.component.type).toBe("card");
		const body = gui.component.props.body as {
			type: string;
			props: { items: Array<{ label: string; value: string }> };
		}[];
		const doneStats = body.find(
			(c) => c.type === "stats-line" && c.props.items.some((i) => i.label === "done"),
		)!;
		expect(doneStats.props.items).toContainEqual({ label: "done", value: "all tests green" });
	});

	it("无 budget 分支 + successCriteria → items 含 {label:'done'}", () => {
		const gui = buildGoalGui(makeState({ successCriteria: "all tests green" }));
		expect(gui.component.type).toBe("stats-line");
		const items = gui.component.props.items as Array<{ label: string; value: string }>;
		expect(items).toContainEqual({ label: "done", value: "all tests green" });
	});
});
