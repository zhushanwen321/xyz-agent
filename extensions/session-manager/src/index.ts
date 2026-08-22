// src/index.ts — @zhushanwen/pi-session-manager
// 6 个 session 管理工具，通过 ctx.ui.select(SESSION_MANAGER_MARKER) 通道与 runtime handler 通信。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SESSION_MANAGER_MARKER } from "@xyz-agent/extension-protocol";
import { Type, type Static } from "typebox";

// ── 参数 Schema ──

const CreateManagedSessionParams = Type.Object({
	cwd: Type.String({ description: "Working directory for the new session" }),
	label: Type.Optional(Type.String({ description: "Human-readable label for the session" })),
});

const SendToSessionParams = Type.Object({
	sessionId: Type.String({ description: "Target session ID" }),
	prompt: Type.String({ description: "Message to send to the session" }),
});

const ReadSessionHistoryParams = Type.Object({
	sessionId: Type.String({ description: "Target session ID" }),
	tailTurns: Type.Optional(Type.Number({ description: "Number of recent turns to return (default: all)" })),
});

const ListMySessionsParams = Type.Object({});

const GetSessionStatusParams = Type.Object({
	sessionId: Type.String({ description: "Target session ID" }),
});

const AbortSessionParams = Type.Object({
	sessionId: Type.String({ description: "Target session ID to abort" }),
});

// ── select 通道辅助 ──

/** select 超时（ms）：工具等待 runtime handler respond 的最大时间。 */
const SELECT_TIMEOUT_MS = 30_000;

/**
 * 通过 select 通道向 runtime handler 发送 session 管理请求。
 * 返回 handler respond 的 JSON 字符串，用户取消/超时返回 null。
 */
async function callSessionManager(
	ctx: ExtensionContext,
	action: string,
	params: Record<string, unknown>,
): Promise<string | null> {
	// 契约 SSOT：SessionManagerRequest = { action, params }（@xyz-agent/extension-protocol
	// extensions/session-manager/types.ts，嵌套 params）。runtime event-adapter 的 marker
	// 分支按 data.params 提取——若扁平化展开（{action, ...params}）params 会丢失变 {}。
	const payload = JSON.stringify({ action, params });
	try {
		const value = await ctx.ui.select(
			SESSION_MANAGER_MARKER,
			[payload],
			{ timeout: SELECT_TIMEOUT_MS },
		);
		return value ?? null;
	} catch {
		return null;
	}
}

/**
 * 统一的 execute 包装：调用 select 通道并解析结果。
 * 返回标准 AgentToolResult 形状（details 为原始 JSON 字符串或错误描述）。
 */
async function executeTool(
	ctx: ExtensionContext,
	action: string,
	params: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
	const raw = await callSessionManager(ctx, action, params);
	if (raw === null) {
		return {
			content: [{ type: "text" as const, text: `Session manager ${action}: cancelled or timed out.` }],
			details: { cancelled: true },
		};
	}
	return {
		content: [{ type: "text" as const, text: raw }],
		details: { raw },
	};
}

// ── Extension 入口 ──

export default function (pi: ExtensionAPI): void {
	// create_managed_session
	pi.registerTool({
		name: "create_managed_session",
		label: "Create Managed Session",
		description: "Create a new agent-managed session in the specified working directory. Returns a session ID and initial status.",
		parameters: CreateManagedSessionParams,
		async execute(
			_toolCallId: string,
			params: Static<typeof CreateManagedSessionParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			return executeTool(ctx, "create", { cwd: params.cwd, label: params.label });
		},
	});

	// send_to_session
	pi.registerTool({
		name: "send_to_session",
		label: "Send to Session",
		description: "Send a prompt/message to an existing managed session. The session will process the message asynchronously.",
		parameters: SendToSessionParams,
		async execute(
			_toolCallId: string,
			params: Static<typeof SendToSessionParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			return executeTool(ctx, "send", { sessionId: params.sessionId, prompt: params.prompt });
		},
	});

	// read_session_history
	pi.registerTool({
		name: "read_session_history",
		label: "Read Session History",
		description: "Read the conversation history of a managed session. Optionally limit to the last N turns.",
		parameters: ReadSessionHistoryParams,
		async execute(
			_toolCallId: string,
			params: Static<typeof ReadSessionHistoryParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			return executeTool(ctx, "history", {
				sessionId: params.sessionId,
				...(params.tailTurns !== undefined ? { tailTurns: params.tailTurns } : {}),
			});
		},
	});

	// list_my_sessions
	pi.registerTool({
		name: "list_my_sessions",
		label: "List My Sessions",
		description: "List all sessions managed by the current agent. Returns session IDs, labels, and statuses.",
		parameters: ListMySessionsParams,
		async execute(
			_toolCallId: string,
			_params: Static<typeof ListMySessionsParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			return executeTool(ctx, "list", {});
		},
	});

	// get_session_status
	pi.registerTool({
		name: "get_session_status",
		label: "Get Session Status",
		description: "Get the current status of a managed session (running, idle, error, etc.) and its model info.",
		parameters: GetSessionStatusParams,
		async execute(
			_toolCallId: string,
			params: Static<typeof GetSessionStatusParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			return executeTool(ctx, "status", { sessionId: params.sessionId });
		},
	});

	// abort_session
	pi.registerTool({
		name: "abort_session",
		label: "Abort Session",
		description: "Abort a running managed session. The session will stop processing and enter aborted state.",
		parameters: AbortSessionParams,
		async execute(
			_toolCallId: string,
			params: Static<typeof AbortSessionParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			return executeTool(ctx, "abort", { sessionId: params.sessionId });
		},
	});
}
