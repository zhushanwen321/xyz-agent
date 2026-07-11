/**
 * pi RPC protocol type definitions.
 *
 * pi communicates via JSONL over stdin/stdout in --mode rpc.
 * Each line is a JSON object with an `id` (for request/response correlation)
 * or no `id` (for unsolicited events).
 *
 * 🔒 **归属（R1，三层架构）**：这是 pi 外部系统的协议类型，只允许在
 * `infra/` 层内部使用。services/transport 不得 import 此文件——它们只见
 * 翻译后的内部类型。从根级 `types.ts` 迁入（原 444 行拆分）。
 *
 * GOTCHAS (field naming inconsistencies with common conventions):
 * - prompt command uses `message` field, NOT `content`
 * - get_messages response puts history in `data` field, NOT `payload`
 * - tool_execution_start uses `args` field, NOT `input`
 * - tool_execution_end uses `result` field, NOT `output`
 * - message_update.toolcall_* events are incomplete; prefer tool_execution_* instead
 */

// ── Base types ─────────────────────────────────────────────────────

/** Every RPC message has at least a `type` discriminator. */
export interface PiBaseMessage {
  /** Correlation id — present on request/response pairs, absent on events. */
  id?: string
  type: string
}

// ── Input messages (client → pi via stdin) ─────────────────────────

export interface PiPromptCommand extends PiBaseMessage {
  id: string
  type: 'prompt'
  /** pi uses "message" here, NOT "content". */
  message: string
}

export interface PiAbortCommand extends PiBaseMessage {
  id: string
  type: 'abort'
}

export interface PiSetModelCommand extends PiBaseMessage {
  id: string
  type: 'set_model'
  provider: string
  modelId: string
}

export interface PiGetAvailableModelsCommand extends PiBaseMessage {
  id: string
  type: 'get_available_models'
}

export interface PiGetMessagesCommand extends PiBaseMessage {
  id: string
  type: 'get_messages'
}

export interface PiNewSessionCommand extends PiBaseMessage {
  id: string
  type: 'new_session'
}

export interface PiSwitchSessionCommand extends PiBaseMessage {
  id: string
  type: 'switch_session'
  sessionPath: string
}

export type PiInputMessage =
  | PiPromptCommand
  | PiAbortCommand
  | PiSetModelCommand
  | PiGetAvailableModelsCommand
  | PiGetMessagesCommand
  | PiNewSessionCommand
  | PiSwitchSessionCommand

// ── Response messages (pi → client) ────────────────────────────────

export interface PiResponse extends PiBaseMessage {
  id: string
  type: 'response'
  /** The original command type that triggered this response. */
  command: string
  success: boolean
  error?: string
  /** Response payload. For get_messages, the history lives here under `data.messages`. */
  data?: unknown
}

// ── Event messages: agent lifecycle ────────────────────────────────

export interface PiAgentStartEvent extends PiBaseMessage {
  type: 'agent_start'
}

export interface PiAgentEndEvent extends PiBaseMessage {
  type: 'agent_end'
  /** All messages accumulated during this agent run. */
  messages: PiAgentEndMessage[]
}

/** A message object within agent_end — mirrors the shape from message_end. */
export interface PiAgentEndMessage {
  role: string
  content: unknown
  stopReason?: string
  usage?: PiUsage
}

export interface PiTurnStartEvent extends PiBaseMessage {
  type: 'turn_start'
}

export interface PiTurnEndEvent extends PiBaseMessage {
  type: 'turn_end'
}

// ── Event messages: message lifecycle ──────────────────────────────

export interface PiMessageStartEvent extends PiBaseMessage {
  type: 'message_start'
  message: {
    role: string
    content: unknown
    usage?: PiUsage
    stopReason?: string
  }
}

export interface PiMessageEndEvent extends PiBaseMessage {
  type: 'message_end'
  message: {
    role: string
    content: unknown
    usage?: PiUsage
    stopReason?: string
  }
}

// ── Event messages: streaming content (message_update) ─────────────

/**
 * message_update wraps an inner assistantMessageEvent.
 *
 * IMPORTANT: toolcall_start/toolcall_delta/toolcall_end sub-types carry
 * INCOMPLETE data (missing full arguments). Always use tool_execution_*
 * events instead for tool call information.
 */
export interface PiMessageUpdateEvent extends PiBaseMessage {
  type: 'message_update'
  assistantMessageEvent: PiAssistantMessageSubEvent
}

export type PiAssistantMessageSubEvent =
  | PiTextStartSubEvent
  | PiTextDeltaSubEvent
  | PiTextEndSubEvent
  | PiThinkingStartSubEvent
  | PiThinkingDeltaSubEvent
  | PiThinkingEndSubEvent
  | PiToolcallStartSubEvent
  | PiToolcallDeltaSubEvent
  | PiToolcallEndSubEvent

export interface PiTextStartSubEvent {
  type: 'text_start'
  contentIndex?: number
}

export interface PiTextDeltaSubEvent {
  type: 'text_delta'
  delta: string
  contentIndex?: number
}

export interface PiTextEndSubEvent {
  type: 'text_end'
  contentIndex?: number
}

export interface PiThinkingStartSubEvent {
  type: 'thinking_start'
  contentIndex?: number
}

export interface PiThinkingDeltaSubEvent {
  type: 'thinking_delta'
  delta: string
  contentIndex?: number
}

export interface PiThinkingEndSubEvent {
  type: 'thinking_end'
  contentIndex?: number
}

/**
 * INCOMPLETE: use tool_execution_start/end instead.
 * These events stream incremental tool call info but may lack full arguments.
 */
export interface PiToolcallStartSubEvent {
  type: 'toolcall_start'
  contentIndex?: number
}

/** INCOMPLETE: use tool_execution_* instead. */
export interface PiToolcallDeltaSubEvent {
  type: 'toolcall_delta'
  delta: string
  contentIndex?: number
}

/**
 * INCOMPLETE: use tool_execution_end instead.
 * The toolCall object here may not have complete arguments.
 */
export interface PiToolcallEndSubEvent {
  type: 'toolcall_end'
  contentIndex?: number
  toolCall?: {
    id: string
    name: string
    arguments: Record<string, unknown>
  }
}

// ── Event messages: tool execution ─────────────────────────────────

/**
 * Tool execution start — provides the canonical tool call info.
 * pi uses `args` field, NOT `input`.
 */
export interface PiToolExecutionStartEvent extends PiBaseMessage {
  type: 'tool_execution_start'
  toolCallId: string
  toolName: string
  // TODO(pi-协议漂移): event-adapter 同时读 `args ?? input`——pi 历史版本用 input，
  // 现版本用 args。ADR-0003 决定 translate() 入参保持 Record<string,unknown> 容错，
  // 此处类型声明的是规范（args），但实际 pi 可能仍发 input。窄化时勿删 input fallback。
  /** pi uses "args", NOT "input". */
  args: Record<string, unknown>
}

export interface PiToolExecutionUpdateEvent extends PiBaseMessage {
  type: 'tool_execution_update'
  toolCallId: string
  toolName: string
  partialResult: string
}

/**
 * Tool execution end — provides the canonical tool result.
 * pi uses `result` field, NOT `output`.
 *
 * TODO(pi-协议漂移): event-adapter 的 handleToolExecutionEnd 同时读 `result ?? output`
 * 且 result 可能是 string | object-with-content-array | 其他——比此处的
 * `PiToolExecutionResult`（固定 {content: Array<{type,text}>}）声明更宽。
 * ADR-0003 决定 translate() 入参保持 Record<string,unknown> 容错以覆盖实际数据形状。
 * 升级 pi 后若确认 result 已稳定为 PiToolExecutionResult 形状，可收紧此类型并移除 fallback。
 */
export interface PiToolExecutionEndEvent extends PiBaseMessage {
  type: 'tool_execution_end'
  toolCallId: string
  toolName: string
  /** pi uses "result", NOT "output". */
  result: PiToolExecutionResult
  isError?: boolean
}

/** pi's tool result shape: an array of content blocks. */
export interface PiToolExecutionResult {
  content: Array<{
    type: string
    text: string
  }>
}

// ── Event messages: extension UI ───────────────────────────────────

/**
 * Extension UI request — used for tool approvals, confirmations, etc.
 * Sent by pi when a tool needs user approval or interactive input.
 */
export interface PiExtensionUiRequestEvent extends PiBaseMessage {
  type: 'extension_ui_request'
  /** Request method — determines the UI interaction type. */
  method: 'confirm' | 'select' | 'input' | 'notify' | 'setStatus' | 'setWidget'
  /** Unique id for correlating the response back. */
  id?: string
  /** Display title (often used as tool name). */
  title?: string
  /** Message body shown to the user. */
  message?: string
  /** Options for 'select' method. */
  options?: Array<{ label: string; value: string; description?: string }>
  /** The original tool call context (forwarded to frontend for approval UI). */
  [key: string]: unknown
}

// ── Event messages: status / error ─────────────────────────────────

export interface PiStatusEvent extends PiBaseMessage {
  type: 'status'
  status: string
  detail?: string
}

export interface PiErrorEvent extends PiBaseMessage {
  type: 'error'
  message: string
}

// ── get_messages response data ─────────────────────────────────────

/**
 * Shape of the `data` field in a get_messages response.
 *
 * GOTCHA: pi puts the messages array under `data.messages`,
 * NOT under `payload.messages`. The top-level response has
 * type: 'response' and the history is nested in `data`.
 */
export interface PiGetMessagesData {
  messages: PiHistoryMessage[]
}

/** A single message in pi's conversation history. */
export interface PiHistoryMessage {
  role: 'user' | 'assistant' | 'toolResult'
  content: PiHistoryContentPart[]
  timestamp?: number
  stopReason?: string
}

/** Content parts within a pi history message. */
export type PiHistoryContentPart =
  | PiHistoryTextPart
  | PiHistoryThinkingPart
  | PiHistoryToolCallPart

export interface PiHistoryTextPart {
  type: 'text'
  text: string
}

export interface PiHistoryThinkingPart {
  type: 'thinking'
  thinking: string
}

export interface PiHistoryToolCallPart {
  type: 'toolCall' | 'tool_use'
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** toolResult messages represent tool execution outcomes in history. */
export interface PiHistoryToolResult extends PiHistoryMessage {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  isError?: boolean
  /** pi 持久化了 details（ToolResultMessage.details），含 __gui__ 结构化渲染数据。
   *  类型声明补齐——pi JSONL 和 get_messages 都返回此字段。 */
  details?: Record<string, unknown>
}

// ── Shared types ───────────────────────────────────────────────────

export interface PiUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

// ── Union types for the adapter layer ──────────────────────────────

/** Union of all unsolicited event types from pi. */
export type PiEvent =
  | PiAgentStartEvent
  | PiAgentEndEvent
  | PiTurnStartEvent
  | PiTurnEndEvent
  | PiMessageStartEvent
  | PiMessageEndEvent
  | PiMessageUpdateEvent
  | PiToolExecutionStartEvent
  | PiToolExecutionUpdateEvent
  | PiToolExecutionEndEvent
  | PiExtensionUiRequestEvent
  | PiStatusEvent
  | PiErrorEvent

/** Any message that can arrive from pi (response or event). */
export type PiAnyIncomingMessage =
  | PiResponse
  | PiEvent
