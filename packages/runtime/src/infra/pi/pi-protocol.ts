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
 * GOTCHAS (field naming — these are pi's canonical field names, not drift):
 * - prompt command uses `message` field, NOT `content`
 * - get_messages response puts history in `data` field, NOT `payload`
 * - tool_execution_start uses `args` (pi 的规范字段名，非漂移——pi 从不发 input)
 * - tool_execution_end uses `result` (pi 的规范字段名，非漂移——pi 从不发 output)
 * - message_update.toolcall_* events are incomplete; prefer tool_execution_* instead
 *
 * 本文件是 pi 协议的真契约（ADR-0033）。PiEvent 联合覆盖 AgentSessionEvent 全部事件类型，
 * pi 升级时需同步维护（编译器 exhaustive check 会提示）。
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

/**
 * turn_end — 单个 turn 结束。pi 0.80.3 事件模型：1 agent 循环 = N 个 turn，
 * 每 turn_end 带 message.usage（本 turn 用量）+ toolResults（本 turn 的工具产出）。
 */
export interface PiTurnEndEvent extends PiBaseMessage {
  type: 'turn_end'
  /** 本 turn 的 assistant 消息（含 usage）。形状与 PiAgentEndMessage 一致。 */
  message: PiTurnEndMessage
  /** 本 turn 内执行完成的工具结果列表。 */
  toolResults: PiToolResultMessage[]
}

/** Assistant message carried by turn_end — mirrors PiAgentEndMessage shape. */
export interface PiTurnEndMessage {
  role: string
  content: unknown
  usage?: PiUsage
  stopReason?: string
}

/**
 * Tool result message carried by turn_end.toolResults — lightweight declaration.
 * content 用 unknown[] 逃生（xyz-agent 不消费 turn_end 的 toolResults 内容字段）。
 */
export interface PiToolResultMessage {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: unknown[]
  isError?: boolean
  details?: Record<string, unknown>
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
 * pi 用 `args` 是规范字段名（非漂移，ADR-0033）。
 */
export interface PiToolExecutionStartEvent extends PiBaseMessage {
  type: 'tool_execution_start'
  toolCallId: string
  toolName: string
  /** pi 的规范字段名（pi 从不发 input）。 */
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
 * pi 用 `result` 是规范字段名（非漂移，ADR-0033）。pi 从不发 output。
 */
export interface PiToolExecutionEndEvent extends PiBaseMessage {
  type: 'tool_execution_end'
  toolCallId: string
  toolName: string
  /** pi 的规范字段名（pi 从不发 output）。 */
  result: PiToolExecutionResult
  /** pi 必填字段（agent-session.ts 始终发送）。 */
  isError: boolean
  /**
   * 触发本次 tool_execution_end 的入参副本。pi 不保证发送此字段（仅 tool_execution_start
   * 必发 args），但 event-adapter:144 读 event.args 提取 write content——此处声明为可选容错。
   */
  args?: Record<string, unknown>
}

/**
 * pi's tool result shape — mirrors pi AgentToolResult<T>（types.ts:350-362）。
 * content 是 TextContent|ImageContent 块数组；details 是工具自定义结构（泛型 T 的实参，
 * xyz-agent 不消费其字段，故用 unknown）；addedToolNames/terminate 为可选控制字段。
 */
export interface PiToolExecutionResult {
  content: Array<PiTextContentBlock | PiImageContentBlock>
  /** 工具自定义结构化数据（对应 AgentToolResult.details: T）。 */
  details: unknown
  /** 工具动态注册的新工具名（对应 AgentToolResult.addedToolNames）。 */
  addedToolNames?: string[]
  /** 是否终止 agent 循环（对应 AgentToolResult.terminate）。 */
  terminate?: boolean
}

/** Text content block in a tool result. */
export interface PiTextContentBlock {
  type: 'text'
  text: string
}

/** Image content block in a tool result. */
export interface PiImageContentBlock {
  type: 'image'
  data: string
  mimeType: string
}

// ── Event messages: session / agent lifecycle (pi 0.80.3+) ─────────

/** Compaction 触发原因。 */
export type PiCompactionReason = 'manual' | 'threshold' | 'overflow'

/** Compaction 开始事件。 */
export interface PiCompactionStartEvent extends PiBaseMessage {
  type: 'compaction_start'
  reason: PiCompactionReason
}

/**
 * Compaction 结束事件。result 用 unknown——pi 内部用 CompactionResult 类型，
 * xyz-agent 不消费其字段，故不引入该类型的镜像。
 */
export interface PiCompactionEndEvent extends PiBaseMessage {
  type: 'compaction_end'
  reason: PiCompactionReason
  result?: unknown
  aborted: boolean
  willRetry: boolean
  errorMessage?: string
}

/** 自动重试开始事件。 */
export interface PiAutoRetryStartEvent extends PiBaseMessage {
  type: 'auto_retry_start'
  attempt: number
  maxAttempts: number
  delayMs: number
  errorMessage: string
}

/** 自动重试结束事件。 */
export interface PiAutoRetryEndEvent extends PiBaseMessage {
  type: 'auto_retry_end'
  success: boolean
  attempt: number
  finalError?: string
}

/** Thinking level 取值（pi thinking 配置）。 */
export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Thinking level 变更事件。 */
export interface PiThinkingLevelChangedEvent extends PiBaseMessage {
  type: 'thinking_level_changed'
  level: PiThinkingLevel
}

/** Steering/follow-up 队列变更事件。 */
export interface PiQueueUpdateEvent extends PiBaseMessage {
  type: 'queue_update'
  steering: readonly string[]
  followUp: readonly string[]
}

/** 会话条目追加事件（pi 内部 entry 结构，xyz-agent 不消费字段，故 Record）。 */
export interface PiEntryAppendedEvent extends PiBaseMessage {
  type: 'entry_appended'
  entry: Record<string, unknown>
}

/** 会话元信息变更事件（主要是 session name）。 */
export interface PiSessionInfoChangedEvent extends PiBaseMessage {
  type: 'session_info_changed'
  name: string | undefined
}

/** Agent 进入稳态（无待处理工具/消息）事件。 */
export interface PiAgentSettledEvent extends PiBaseMessage {
  type: 'agent_settled'
}

/**
 * Extension 报错事件。由 rpc-mode 发送，event-adapter:512 已处理但类型此前未声明。
 * 注意：event-adapter 转发时把 extensionPath 重命名为 extensionName（字段名映射，非 pi 协议字段）。
 */
export interface PiExtensionErrorEvent extends PiBaseMessage {
  type: 'extension_error'
  extensionPath: string
  event: string
  error: string
}

// ── Event messages: extension UI ───────────────────────────────────

/**
 * Extension UI request — used for tool approvals, confirmations, etc.
 * Sent by pi when a tool needs user approval or interactive input.
 */
export interface PiExtensionUiRequestEvent extends PiBaseMessage {
  type: 'extension_ui_request'
  /**
   * Request method — determines the UI interaction type.
   *
   * 交互式 dialog 方法（产生 extension.ui_request WS 帧，需前端回复）：confirm / select / input / editor
   * Fire-and-forget 方法（独立 WS 帧，不等回复）：notify / setStatus / setWidget / set_editor_text / bridge:*
   * notify 走 extension.notify WS 帧 + toast 渲染（非模态）；setStatus/setWidget 走各自独立帧。
   * event-adapter.ts INTERACTIVE_UI_METHODS 只含 dialog 子集，与此类型保持同步。
   */
  method: 'confirm' | 'select' | 'input' | 'notify' | 'editor' | 'setStatus' | 'setWidget'
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

/** Union of all unsolicited event types from pi (mirrors AgentSessionEvent, ADR-0033). */
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
  | PiCompactionStartEvent
  | PiCompactionEndEvent
  | PiAutoRetryStartEvent
  | PiAutoRetryEndEvent
  | PiThinkingLevelChangedEvent
  | PiQueueUpdateEvent
  | PiEntryAppendedEvent
  | PiSessionInfoChangedEvent
  | PiAgentSettledEvent
  | PiExtensionErrorEvent

/** Any message that can arrive from pi (response or event). */
export type PiAnyIncomingMessage =
  | PiResponse
  | PiEvent
