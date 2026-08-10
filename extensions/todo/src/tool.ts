/**
 * Todo tool 注册 + execute dispatcher + 4 个 action handler。
 *
 * Schema 设计（T4）：TodoParams 为 discriminated union（按 action 区分），每个分支
 * 只声明自己的参数且 additionalProperties:false。这样缺失必填（如 {action:'add'} 缺
 * texts）在 schema 层就被拒绝，不依赖运行时 handler throw。实测 typebox Value.Check
 * 与 ajv（plain，不开 discriminator 选项）均正确拒绝；故不使用 discriminator keyword
 * （typebox 输出 anyOf，ajv discriminator 选项要求 oneOf 会编译失败）。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import {
	addTodos,
	buildGui,
	formatTodoList,
	type Todo,
	type TodoDetails,
	updateTodos,
	VALID_STATUSES,
} from "./model";
import { renderTodoResult } from "./render";
import type { TodoSessionState } from "./state";

// ── Action 参数类型（运行时）──────────────────────────
// 刻意保持为宽松 interface（全部字段可选）而非 strict discriminated union：
// handler 需要检测「双形陷阱」（add 同时传 text+texts 等错误输入），schema 层虽已用
// additionalProperties:false 拒绝，但 handler 作为 defense-in-depth 仍需能访问/判断
// 这些字段。类型严格性由 TodoParams schema（discriminated union）承担。

export interface TodoActionParams {
	action: string;
	text?: string;
	id?: number;
	texts?: string[];
	ids?: number[];
	status?: string;
	updates?: Array<{ id: number; status?: string; text?: string }>;
}

// ── TodoParams schema（discriminated union by action）──────────

const StatusSchema = StringEnum(VALID_STATUSES);

const ListParams = Type.Object(
	{ action: Type.Literal("list") },
	{ additionalProperties: false },
);
const AddParams = Type.Object(
	{
		action: Type.Literal("add"),
		texts: Type.Array(Type.String(), { description: "待添加的 todo 文本数组" }),
	},
	{ additionalProperties: false },
);
const UpdateSingleParams = Type.Object(
	{
		action: Type.Literal("update"),
		id: Type.Number({ description: "要更新的 todo id" }),
		status: Type.Optional(StatusSchema),
		text: Type.Optional(Type.String({ description: "新文本（trim 后不可为空）" })),
	},
	{ additionalProperties: false },
);
const UpdateBatchParams = Type.Object(
	{
		action: Type.Literal("update"),
		updates: Type.Array(
			Type.Object({
				id: Type.Number({ description: "要更新的 todo id" }),
				status: Type.Optional(StatusSchema),
				text: Type.Optional(Type.String({ description: "新文本（trim 后不可为空）" })),
			}),
			{ description: "批量更新数组（优先于单条 id/status/text）" },
		),
	},
	{ additionalProperties: false },
);
const DeleteParams = Type.Object(
	{
		action: Type.Literal("delete"),
		ids: Type.Array(Type.Number(), { description: "要删除的 todo id 数组" }),
	},
	{ additionalProperties: false },
);

export const TodoParams = Type.Union([
	ListParams,
	AddParams,
	UpdateSingleParams,
	UpdateBatchParams,
	DeleteParams,
]);

// ── 4 个 action handler ──────────────────────────────
// 错误处理约定（见 CLAUDE.md「Tool 设计」）：handler 失败直接 throw，
// 不返回「错误成功模式」。model 层纯函数（updateTodos）返回 Result 对象（合法），
// 由 dispatcher 在拿到 error 时 throw，把友好文案交给 Pi 框架展示。
// addTodos 的校验失败直接 throw（C1：不再静默 filter）。

/** list action — 返回完整格式化列表 */
function handleList(state: TodoSessionState): string {
	return state.todos.length ? formatTodoList(state.todos) : "No todos";
}

/** add action — 失败抛错。export 供 behavioral 测试（text/texts 双形陷阱检测）。 */
export function handleAdd(state: TodoSessionState, params: TodoActionParams): string {
	// 双形陷阱：同时传 text 和 texts → throw（TC7）
	if (params.text !== undefined && params.texts !== undefined) {
		throw new Error('add only accepts texts array; do not also pass singular "text"');
	}
	if (!params.texts || params.texts.length === 0) {
		// 双形陷阱：弱模型 add 时误用单数 text（那是 update 的字段）
		if (params.text !== undefined) {
			throw new Error(
				'add needs texts (array). You passed singular "text" — that field is for update. Correct: {"action":"add","texts":["<your text>"]}',
			);
		}
		throw new Error(
			'add requires texts parameter (non-empty array). Correct: {"action":"add","texts":["..."]}',
		);
	}
	// addTodos 内部对空项 trim+throw（C1）
	const r = addTodos(state.todos, state.nextId, params.texts);
	state.todos = r.newTodos;
	state.nextId = r.newNextId;
	return r.resultText;
}

/** update action: batch — 失败抛错 */
function handleBatchUpdate(state: TodoSessionState, params: TodoActionParams): string {
	const r = updateTodos(state.todos, params.updates ?? []);
	if (r.error) throw new Error(r.resultText);
	state.todos = r.updatedTodos;
	return r.resultText!;
}

/** update action: single — 失败抛错 */
export function handleSingleUpdate(state: TodoSessionState, params: TodoActionParams): string {
	if (params.id === undefined)
		throw new Error(
			'update requires id parameter. Correct: {"action":"update","id":<n>,"status":"in_progress"}',
		);
	if (params.status === undefined && params.text === undefined)
		throw new Error(
			'update requires at least status or text parameter. Correct: {"action":"update","id":<n>,"status":"in_progress"}',
		);
	// text 校验统一（CT5）：trim 后空串 throw（不只判 ===）
	if (params.text !== undefined && params.text.trim().length === 0)
		throw new Error("text cannot be empty or whitespace-only");
	if (
		params.status !== undefined &&
		!VALID_STATUSES.includes(params.status as (typeof VALID_STATUSES)[number])
	) {
		throw new Error(`status only accepts ${VALID_STATUSES.join(" / ")}`);
	}

	const todo = state.todos.find((t) => t.id === params.id);
	if (!todo) throw new Error(`Todo #${params.id} not found`);

	if (params.status !== undefined) todo.status = params.status as Todo["status"];
	if (params.text !== undefined) todo.text = params.text.trim();

	const parts: string[] = [`Updated todo #${todo.id}`];
	if (params.status !== undefined) parts.push(`status → ${params.status}`);
	if (params.text !== undefined) parts.push(`text → "${todo.text}"`);
	return parts.join(", ");
}

/** update action: dispatcher — batch 优先于 single */
function handleUpdate(state: TodoSessionState, params: TodoActionParams): string {
	if (params.updates && params.updates.length > 0) return handleBatchUpdate(state, params);
	return handleSingleUpdate(state, params);
}

/** delete action — 失败抛错；部分 id 缺失则整体拒绝（原子性）。
 * export 供 behavioral 测试（id/ids 双形陷阱检测）。 */
export function handleDelete(state: TodoSessionState, params: TodoActionParams): string {
	if (!params.ids || params.ids.length === 0) {
		// 双形陷阱：弱模型 delete 时误用单数 id（那是 update 的字段）
		if (params.id !== undefined) {
			throw new Error(
				'delete needs ids (array). You passed singular "id" — that field is for update. Correct: {"action":"delete","ids":[<your id>]}',
			);
		}
		throw new Error(
			'delete requires ids parameter (non-empty array). Correct: {"action":"delete","ids":[<n>]}',
		);
	}
	const uniqueIds = [...new Set(params.ids)];
	const missing = uniqueIds.filter((id) => !state.todos.some((t) => t.id === id));
	if (missing.length > 0) {
		throw new Error(`Todo #${missing.join(", #")} not found`);
	}
	const removedIds: number[] = [];
	for (const id of uniqueIds) {
		const idx = state.todos.findIndex((t) => t.id === id);
		if (idx !== -1) {
			state.todos.splice(idx, 1);
			removedIds.push(id);
		}
	}
	return `Deleted ${removedIds.length} items (#${removedIds.join(", #")}), ${state.todos.length} remaining`;
}

// ── Dispatcher ───────────────────────────────────────

function executeTodoAction(
	params: TodoActionParams,
	state: TodoSessionState,
	ctx: ExtensionContext,
	refreshDisplay: (ctx: ExtensionContext) => void,
): {
	content: Array<{ type: "text"; text: string }>;
	details: TodoDetails;
} {
	const isMutation = params.action !== "list";

	let resultText: string;
	switch (params.action) {
		case "list":
			resultText = handleList(state);
			break;
		case "add":
			resultText = handleAdd(state, params);
			break;
		case "update":
			resultText = handleUpdate(state, params);
			break;
		case "delete":
			resultText = handleDelete(state, params);
			break;
		default:
			throw new Error(`Unknown action: ${params.action}`);
	}

	refreshDisplay(ctx);

	// content 组装（T3）：突变附带完整列表；list 已含列表
	let contentText: string;
	if (isMutation) {
		const listText = state.todos.length > 0 ? formatTodoList(state.todos) : "No todos";
		contentText = `${resultText}\n${listText}`;
	} else {
		contentText = resultText;
	}

	const details: TodoDetails = {
		action: params.action as TodoDetails["action"],
		todos: [...state.todos],
		nextId: state.nextId,
	};
	// RPC 模式（xyz-agent GUI）附加 __gui__，前端按 list-tree 渲染。
	// TUI/print/json 模式走原生文本渲染（contentText 已在 content 中）。
	if (ctx.mode === "rpc") {
		details.__gui__ = buildGui(state.todos);
	}
	return {
		content: [{ type: "text" as const, text: contentText }],
		details,
	};
}

// ── Tool 注册入口 ─────────────────────────────────────

export function registerTodoTool(
	pi: ExtensionAPI,
	state: TodoSessionState,
	refreshDisplay: (ctx: ExtensionContext) => void,
): void {
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"管理当前会话的 todo 列表。" +
			"\n\n动作：" +
			"\n- list: 查看全部 todo" +
			"\n- add: 批量添加 todo（texts 数组）" +
			"\n- update: 按 id 更新 todo——status 和/或 text；批量用 updates[]" +
			"\n- delete: 按 id 删除 todo（ids 数组）" +
			"\n\n规则：" +
			"\n- 同一时间只有一个 todo 处于 in_progress" +
			"\n- 完成一个 todo 立即标记 completed，不要攒到最后批量标记" +
			"\n- 未真正完成不得标记 completed：被阻塞或测试失败时保持 in_progress",
		promptSnippet: "用 todo 跟踪多步骤工作；记得为验证步骤（测试、类型检查）单独建 todo。",
		promptGuidelines: [
			"[Usage] 多步骤工作（3+步）时使用，AI 自发创建，无需用户触发",
			"[验证任务] 为测试 / 类型检查等验证步骤单独建 todo，完成前确保验证通过",
			"[批量优先] 完成多项任务时使用 updates[] 批量更新，减少工具调用次数",
			"[自动闭合] 全部完成后自动清理，无需手动 delete",
			"[Not for] 单步操作、简单对话",
		],
		executionMode: "sequential",
		parameters: TodoParams,

		async execute(_toolCallId: string, params: Static<typeof TodoParams>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			if (signal?.aborted) throw new Error("Todo call aborted by signal.");
			return executeTodoAction(params as TodoActionParams, state, ctx, refreshDisplay);
		},

		renderCall(args: Record<string, unknown>, theme: Theme, _context?: unknown) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action as string);
			const texts = args.texts as string[] | undefined;
			const ids = args.ids as number[] | undefined;
			if (texts && texts.length > 0) text += ` ${theme.fg("dim", `(${texts.length} items)`)}`;
			if (ids && ids.length > 0) text += ` ${theme.fg("accent", `#${ids.join(", #")}`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.status) text += ` ${theme.fg("warning", args.status as string)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result: unknown, options: { expanded: boolean }, theme: Theme, _context?: unknown) {
			return renderTodoResult(result, options, theme);
		},
	});
}
