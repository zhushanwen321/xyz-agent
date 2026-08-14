/**
 * Todo 数据模型 — 纯函数，不依赖 Pi 运行时。
 * 三态: pending → in_progress → completed
 */

import { guiComponent, type GuiRenderResult, guiResult, type TreeItem } from "@xyz-agent/extension-protocol";

// ── 数据模型 ─────────────────────────────────────────

export interface Todo {
	id: number;
	text: string;
	status: "pending" | "in_progress" | "completed";
}

export interface TodoDetails {
	action: "list" | "add" | "update" | "delete";
	todos: Todo[];
	nextId: number;
}

export const VALID_STATUSES = ["pending", "in_progress", "completed"] as const;

export type ValidStatus = (typeof VALID_STATUSES)[number];

// ── 迁移/兼容 ───────────────────────────────────────

/** 旧格式迁移：verifying → in_progress，failed → pending，cancelled → completed（历史三态化降级），done:boolean → status */
export function migrateTodo(raw: unknown): Todo {
	// raw 是任意旧格式数据（兼容 done:boolean 等历史结构），以 Record 方式安全访问字段
	// 守卫：null/原始类型（typeof null === 'object'，必须显式排除 null）→ 明确报错而非混淆的 TypeError
	if (raw === null || typeof raw !== "object") {
		throw new TypeError(
			`migrateTodo: expected object, got ${raw === null ? "null" : typeof raw}`,
		);
	}
	const record = raw as Record<string, unknown>;
	const hasValidStatus =
		typeof record.status === "string" &&
		VALID_STATUSES.includes(record.status as ValidStatus);

	let status: ValidStatus;
	if (hasValidStatus) {
		status = record.status as ValidStatus;
	} else {
		// 极旧格式 done: boolean
		const done = typeof record.done === "boolean" ? record.done : undefined;
		status = done === true ? "completed" : "pending";
	}

	// 历史状态映射（先转 string 避免类型收窄后无法比较）
	const rawStatus = record.status as string | undefined;
	if (rawStatus === "verifying") status = "in_progress";
	if (rawStatus === "failed") status = "pending";
	// 三态化降级：历史 cancelled 项映射为 completed（不丢数据，且解除 every(completed) 死锁）
	if (rawStatus === "cancelled") status = "completed";

	return {
		id: record.id as number,
		text: record.text as string,
		status,
	};
}

// ── GUI 渲染辅助 ─────────────────────────────────────

/**
 * 把 todos 映射为 list-tree GuiRenderResult（对齐 extension-protocol@0.2.0）。
 * status → icon/status 映射：
 *   pending      → dot      / 无 status
 *   in_progress  → circle   / running
 *   completed    → check    / done
 */
export function buildGui(todos: Todo[]): GuiRenderResult {
	const items: TreeItem[] = todos.map((t) => {
		const icon =
			t.status === "completed"
				? "check"
				: t.status === "in_progress"
					? "circle"
					: "dot"; // pending
		const status =
			t.status === "in_progress"
				? "running"
				: t.status === "completed"
					? "done"
					: undefined; // pending 无 status
		return {
			icon,
			label: `#${t.id}: ${t.text}`,
			status,
			depth: 0,
		};
	});
	return guiResult(guiComponent("list-tree", { items }));
}

export function getDisplayStatus(t: Todo): string {
	return migrateTodo(t).status;
}

// ── Add 逻辑 ─────────────────────────────────────────

export interface AddResult {
	newTodos: Todo[];
	newNextId: number;
	resultText: string;
}

/**
 * 批量新增 todo。
 * texts 整体 trim；任一项 trim 后为空串则 throw（不再静默 filter 丢弃——
 * 模型应学到传有效项，C1 决策）。
 */
export function addTodos(
	currentTodos: Todo[],
	currentNextId: number,
	texts: string[],
): AddResult {
	if (!texts || texts.length === 0) {
		throw new Error("add requires texts parameter (non-empty array)");
	}

	const trimmed = texts.map((t) => t.trim());
	// 任一项 trim 后空串 → throw（不静默 filter）
	if (trimmed.some((t) => t.length === 0)) {
		throw new Error("texts must not contain empty or whitespace-only items");
	}

	const startId = currentNextId;
	const newTodos = [...currentTodos];
	let nextId = currentNextId;
	for (let i = 0; i < trimmed.length; i++) {
		newTodos.push({
			id: nextId++,
			text: trimmed[i],
			status: "pending" as const,
		});
	}
	const endId = nextId - 1;

	return {
		newTodos,
		newNextId: nextId,
		resultText: `Added ${trimmed.length} todos (#${startId}-#${endId})`,
	};
}

// ── Update 逻辑 ──────────────────────────────────────

export interface UpdateResult {
	updatedTodos: Todo[];
	error?: string;
	resultText?: string;
}

export function updateTodos(
	currentTodos: Todo[],
	updates: Array<{ id: number; status?: string; text?: string }>,
): UpdateResult {
	// text 校验统一（CT5）：text 存在则 trim，空串 throw（不静默跳过）
	for (const u of updates) {
		if (u.text !== undefined && u.text.trim().length === 0) {
			throw new Error(`update item id ${u.id}: text cannot be empty or whitespace-only`);
		}
	}

	const ids = updates.map((u) => u.id);
	if (new Set(ids).size !== ids.length) {
		return {
			updatedTodos: currentTodos,
			error: "duplicate ids in updates",
			resultText: "Error: duplicate ids in updates",
		};
	}
	for (const u of updates) {
		const todo = currentTodos.find((t) => t.id === u.id);
		if (!todo) {
			return {
				updatedTodos: currentTodos,
				error: `id ${u.id} not found`,
				resultText: `Error: Todo #${u.id} not found`,
			};
		}
		if (!u.status && !u.text) {
			return {
				updatedTodos: currentTodos,
				error: `update item for id ${u.id} has neither status nor text`,
				resultText: `Error: update item for id ${u.id} has neither status nor text`,
			};
		}
		if (u.status && !VALID_STATUSES.includes(u.status as (typeof VALID_STATUSES)[number])) {
			return {
				updatedTodos: currentTodos,
				error: `invalid status: ${u.status}`,
				resultText: `Error: invalid status '${u.status}' for update item id ${u.id}`,
			};
		}
	}

	const updated = currentTodos.map((t) => {
		const u = updates.find((u) => u.id === t.id);
		if (!u) return t;
		const patch: Partial<Todo> = {};
		if (u.status) patch.status = u.status as Todo["status"];
		if (u.text !== undefined) patch.text = u.text.trim();
		return { ...t, ...patch };
	});
	return {
		updatedTodos: updated,
		resultText: `Updated ${updates.length} todo(s)`,
	};
}

// ── 格式化辅助 ───────────────────────────────────────

export function formatTodoLine(t: Todo): string {
	const mark =
		t.status === "completed"
			? "x"
			: t.status === "in_progress"
				? "~"
				: " "; // pending
	return `[${mark}] #${t.id}: ${t.text}`;
}

/** 把整张列表格式化为多行文本，每行复用 formatTodoLine（T3）。 */
export function formatTodoList(todos: Todo[]): string {
	return todos.map((t) => formatTodoLine(t)).join("\n");
}
