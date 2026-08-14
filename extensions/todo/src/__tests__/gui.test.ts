import { describe, expect, it } from "vitest";

import { buildGui, type Todo } from "../model";

/** 从 card body 中按 type 取第一个组件 props。 */
function findBodyProps(gui: ReturnType<typeof buildGui>, type: string): Record<string, unknown> {
	const body = gui.component.props.body as { type: string; props: Record<string, unknown> }[];
	const found = body.find((c) => c.type === type);
	if (!found) throw new Error(`body 中无 ${type} 组件`);
	return found.props;
}

describe("buildGui", () => {
	it("三态映射：card 内 list-tree 逐项 icon/status 正确，label 不带 TUI 冒号", () => {
		const todos: Todo[] = [
			{ id: 1, text: "pending task", status: "pending" },
			{ id: 2, text: "active task", status: "in_progress" },
			{ id: 3, text: "done task", status: "completed" },
		];
		const gui = buildGui(todos);
		expect(gui.v).toBe(1);
		expect(gui.component.type).toBe("card");
		expect(gui.component.props.header).toBe("Todo");
		// 1/3 完成 → 非 success variant
		expect(gui.component.props.variant).toBe("default");
		const items = findBodyProps(gui, "list-tree").items;
		expect(items).toHaveLength(3);
		// pending → dot, no status（guiResult 的 stripUndefined 删除 undefined 键）
		expect(items[0]).toMatchObject({ icon: "dot", label: "#1 pending task", depth: 0 });
		expect(items[0]).not.toHaveProperty("status");
		// in_progress → circle, running
		expect(items[1]).toMatchObject({ icon: "circle", label: "#2 active task", status: "running", depth: 0 });
		// completed → check, done
		expect(items[2]).toMatchObject({ icon: "check", label: "#3 done task", status: "done", depth: 0 });
	});

	it("progress-bar 承担跨项摘要（GUI 版此前缺失）：current=completed, severity 显式 ok", () => {
		const todos: Todo[] = [
			{ id: 1, text: "a", status: "completed" },
			{ id: 2, text: "b", status: "in_progress" },
			{ id: 3, text: "c", status: "pending" },
		];
		const bar = findBodyProps(buildGui(todos), "progress-bar");
		expect(bar).toMatchObject({ label: "tasks", current: 1, total: 3, unit: "done" });
		// 显式 ok 覆盖推断（ProgressBar 推断是预算消耗语义，对完成度不成立）
		expect(bar.severity).toBe("ok");
	});

	it("全部完成 → card variant success + progress-bar current=total", () => {
		const todos: Todo[] = [
			{ id: 1, text: "a", status: "completed" },
			{ id: 2, text: "b", status: "completed" },
		];
		const gui = buildGui(todos);
		expect(gui.component.props.variant).toBe("success");
		expect(findBodyProps(gui, "progress-bar")).toMatchObject({ current: 2, total: 2 });
	});

	it("empty todos → card 无 progress-bar，list-tree 为空", () => {
		const gui = buildGui([]);
		expect(gui.component.type).toBe("card");
		const types = (gui.component.props.body as { type: string }[]).map((c) => c.type);
		expect(types).not.toContain("progress-bar");
		expect(findBodyProps(gui, "list-tree").items).toEqual([]);
	});
});
