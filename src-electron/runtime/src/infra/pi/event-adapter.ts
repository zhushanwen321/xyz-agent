/**
 * EventAdapter — 纯翻译器：pi subprocess RPC 事件 → PiTranslatedEvent[]。
 *
 * [R1 重构] 本文件是 infra 层，只做「翻译」，不做任何业务编排副作用：
 *   ✗ 不调 plugin hook（onBeforeToolCall/onAfterToolResult）
 *   ✗ 不做 file_changes baseline diff（snapshotGitStatus/diffSnapshots）
 *   ✗ 不回写 session 状态（context.update / thinkingLevel 缓存）
 *   ✗ 不路由 status/bridge/extension-ui 到 server
 *   ✗ 不持有可变态（statusBaseline/writeContents/currentMessageId）
 *   ✓ 只产出结构化中间事件（PiTranslatedEvent[]），交由 service 层 EventInterpreter 编排。
 *
 * pi RPC events have this structure:
 * - `message_update` with nested `assistantMessageEvent` containing `type`, `delta`, `contentIndex`
 *   - sub-types: text_start, text_delta, text_end, thinking_start, thinking_delta, thinking_end
 * - `message_start` / `message_end` with `message` containing role, content, usage, stopReason
 * - `agent_start` / `turn_start` / `turn_end` / `agent_end` for lifecycle
 * - `extension_ui_request` for tool approvals etc.
 *
 * Each session gets its own adapter instance. translate() is stateless（一个 pi 事件
 * 产出一组中间事件），可变态由 EventInterpreter 持有。
 */
import type { ServerMessage, ServerMessageType } from '@xyz-agent/shared'
import { EXTENSION_EVENTS } from '@xyz-agent/shared'
import type { PiEventListener } from '../../services/ports/pi-engine.js'
import type { PiTranslatedEvent } from '../../services/session/types.js'
import { randomUUID } from 'node:crypto'

// ── Sub-handler types ──────────────────────────────────────────────
//
// [ADR-0003] translate() 入参故意用宽类型 Record<string, unknown>（而非 pi-protocol.ts
// 的 Pi* 联合类型）：pi 实际发送的数据比类型声明更宽（见 handleToolExecutionEnd 的
// result 多形态、handleToolExecutionStart 的 args??input 双读），且未知事件类型不能崩。
// 下面的防御式 `?? ''` / `as` fallback 不是冗余——它们处理 pi 实际行为的非规范面。
// 升级 pi 后若字段稳定，可逐 handler 引入 pi-protocol 类型做窄化（保留 default 容错）。
type PiEvent = Record<string, unknown>

/** Strip ANSI escape sequences from text (pi RPC mode sends raw escape codes for themed output) */
const ANSI_REGEX = /\x1b\[[0-9;]*m/g
function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '')
}

const STOP_REASON_MAP: Record<string, string> = {
  stop: 'end_turn',
  end_turn: 'end_turn',
  length: 'max_tokens',
  max_tokens: 'max_tokens',
  toolUse: 'tool_use',
  tool_use: 'tool_use',
  error: 'error',
  aborted: 'aborted',
  cancelled: 'aborted',
  content_filter: 'content_filter',
}

/** Interactive extension UI methods that produce extension.ui_request WS events */
const INTERACTIVE_UI_METHODS = new Set(['confirm', 'select', 'input', 'notify', 'editor'])

/** Extension method constant for the editor UI */
const METHOD_EDITOR = 'editor' as const

/** 取工具参数 path（pi 契约权威参数名；file_path 作防御性 fallback，ADR-0024 D2） */
function extractPath(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined
  const p = args.path
  if (typeof p === 'string' && p) return p
  const fp = args.file_path
  return typeof fp === 'string' && fp ? fp : undefined
}

// ── Sub-handlers（纯函数：PiEvent → PiTranslatedEvent[]，无副作用）────────

/** message_update — streaming text/thinking deltas and stream errors */
function handleMessageUpdate(event: PiEvent, sid: string): PiTranslatedEvent[] {
  const sub = event.assistantMessageEvent as
    { type: string; delta?: string; content?: string; contentIndex?: number } | undefined
  if (!sub) return [{ kind: 'noop' }]

  switch (sub.type) {
    case 'text_delta':
      return [{ kind: 'message', message: { type: 'message.text_delta', payload: { sessionId: sid, delta: sub.delta ?? '' } } }]
    case 'thinking_start':
      return [{ kind: 'message', message: { type: 'message.thinking_start', payload: { sessionId: sid } } }]
    case 'thinking_delta':
      return [{ kind: 'message', message: { type: 'message.thinking_delta', payload: { sessionId: sid, delta: sub.delta ?? '' } } }]
    case 'thinking_end':
      return [{ kind: 'message', message: { type: 'message.thinking_end', payload: { sessionId: sid } } }]
    case 'toolcall_start': case 'toolcall_delta': case 'toolcall_end':
    case 'text_start': case 'text_end':
      return [{ kind: 'noop' }]
    // FR-5: streaming error — surface as message.stream_error
    case 'error':
      return [{ kind: 'message', message: { type: 'message.stream_error', payload: { sessionId: sid, reason: 'error', content: sub.content ?? '' } } }]
    default:
      console.warn('[EventAdapter] Unhandled message_update sub-type:', sub.type)
      return [{ kind: 'noop' }]
  }
}

/**
 * tool_execution_start — 产出 tool-call-start 中间事件（携带原始 input）。
 * EventInterpreter 据此跑 onBeforeToolCall hook（可阻断 / 改写 input）后产出 tool_call_start WS 帧。
 */
function handleToolExecutionStart(event: PiEvent, _sid: string): PiTranslatedEvent[] {
  // pi-protocol.PiToolExecutionStartEvent 声明 toolName: string（必有），但 pi 实际可能缺省——保留 fallback
  const toolName = String(event.toolName ?? '')
  // pi-protocol 声明 args（规范），但 pi 历史版本用 input——双读覆盖协议漂移（见 pi-protocol.ts TODO）
  const input = event.args ?? event.input
  return [{
    kind: 'tool-call-start',
    toolCallId: String(event.toolCallId ?? ''),
    toolName,
    input,
  }]
}

/**
 * tool_execution_end — 产出 tool-call-end 中间事件（携带原始 output/details/images）。
 * EventInterpreter 据此跑 onAfterToolResult hook（改写 output）+ 触发 file_changes baseline diff。
 */
function handleToolExecutionEnd(event: PiEvent, _sid: string): PiTranslatedEvent[] {
  let output: string
  let images: Array<{ data: string; mimeType: string }> | undefined
  // pi-protocol.PiToolExecutionEndEvent 声明 result: PiToolExecutionResult（固定 content 数组），
  // 但 pi 实际 result 可能是 string | object-with-content | 其他——双读 + 多形态判定覆盖协议漂移
  // （见 pi-protocol.ts 的 TODO(pi-协议漂移) 注释）
  const raw = event.result ?? event.output
  if (typeof raw === 'string') {
    output = raw
  } else if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).content)) {
    const contentArr = (raw as Record<string, unknown>).content as Array<Record<string, unknown>>
    output = contentArr
      .filter((c) => c.type === 'text')
      .map((c) => (c.text as string) ?? '')
      .join('\n')
    const imageBlocks = contentArr
      .filter((c) => c.type === 'image')
      .map((c) => ({ data: String(c.data ?? ''), mimeType: String(c.mimeType ?? '') }))
      .filter((img) => img.data !== '' || img.mimeType !== '')
    if (imageBlocks.length > 0) images = imageBlocks
  } else if (raw != null) {
    output = JSON.stringify(raw)
  } else {
    output = ''
  }

  let details: Record<string, unknown> | undefined
  if (raw && typeof raw === 'object') {
    const d = (raw as Record<string, unknown>).details
    if (d && typeof d === 'object' && !Array.isArray(d)) details = d as Record<string, unknown>
  }

  const toolCallId = String(event.toolCallId ?? '')
  const toolName = String(event.toolName ?? '')
  const isError = Boolean(event.isError)

  // write 工具写入的 content（供 EventInterpreter 累积，untracked 行数回退用）。
  let writeContent: { filePath: string; content: string } | undefined
  if (!isError && toolName === 'write') {
    const args = (event.args ?? event.input) as Record<string, unknown> | undefined
    const filePath = extractPath(args)
    if (filePath && typeof args?.content === 'string') {
      writeContent = { filePath, content: args.content }
    }
  }

  return [{
    kind: 'tool-call-end',
    toolCallId,
    output,
    details,
    images,
    toolName,
    isError,
    writeContent,
  }]
}

/** agent_end — extract stop reason, usage, responseModel, diagnostics, errorMessage */
function handleAgentEnd(event: PiEvent, sid: string): PiTranslatedEvent[] {
  const messages = event.messages as Array<Record<string, unknown>> | undefined
  const lastMsg = messages?.[messages.length - 1]
  const rawReason = (lastMsg?.stopReason as string) ?? 'stop'
  const usage = lastMsg?.usage as
    { input: number; output: number; totalTokens?: number; cacheRead?: number; cacheWrite?: number } | undefined
  const responseModel = lastMsg?.responseModel as string | undefined
  const diagnostics = lastMsg?.diagnostics as Record<string, unknown> | undefined
  const errorMessage = (rawReason === 'error' || rawReason === 'tool_use') ? lastMsg?.errorMessage as string | undefined : undefined

  const message: ServerMessage = {
    type: 'message.complete',
    payload: {
      sessionId: sid,
      stopReason: STOP_REASON_MAP[rawReason] ?? rawReason,
      usage: usage
        ? { inputTokens: usage.input ?? 0, outputTokens: usage.output ?? 0, totalTokens: usage.totalTokens ?? 0 }
        : undefined,
      responseModel,
      diagnostics,
      errorMessage,
    },
  }

  return [{
    kind: 'turn-end',
    message,
    inputTokens: usage?.input,
    totalTokens: usage?.totalTokens ?? 0,
    stopReason: STOP_REASON_MAP[rawReason] ?? rawReason,
    usage,
  }]
}

/** extension_ui_request — route by method (setStatus, setWidget, editor, etc.) */
function handleExtensionUIRequest(event: PiEvent, sid: string): PiTranslatedEvent[] {
  const method = event.method as string | undefined

  // setStatus → status-set（interpreter 路由 server）+ status-broadcast（WS 帧）
  if (method === 'setStatus') {
    const key = String(event.statusKey ?? '')
    const text = stripAnsi(String(event.statusText ?? ''))
    return [
      { kind: 'status-set', sessionId: sid, key, text },
      {
        kind: 'status-broadcast',
        message: {
          type: EXTENSION_EVENTS.STATUS as ServerMessageType,
          payload: { sessionId: sid, statusKey: key, text },
        },
      },
    ]
  }

  // setWidget → WS event
  if (method === 'setWidget') {
    const widgetPayload = {
      sessionId: sid,
      widgetKey: String(event.widgetKey ?? ''),
      lines: Array.isArray(event.widgetLines) ? (event.widgetLines as unknown[]).map(l => stripAnsi(String(l))) : [],
    }
    console.log('[EventAdapter] setWidget:', widgetPayload.widgetKey, 'lines:', widgetPayload.lines.length, 'sessionId:', sid)
    return [{ kind: 'message', message: { type: EXTENSION_EVENTS.WIDGET as ServerMessageType, payload: widgetPayload } }]
  }

  // setEditorText → extension:setEditorText
  if (method === 'set_editor_text') {
    return [{ kind: 'message', message: { type: 'extension:setEditorText', payload: { sessionId: sid, text: String(event.text ?? '') } } }]
  }

  // bridge:* → bridge-ui（interpreter 路由 server）
  if (method?.startsWith('bridge:')) {
    const requestId = String(event.id ?? '')
    const data = (event as Record<string, unknown>).data as Record<string, unknown> ?? {}
    return [{ kind: 'bridge-ui', requestId, sessionId: sid, method, data }]
  }

  // Interactive methods: confirm, select, input, notify, editor
  if (method && INTERACTIVE_UI_METHODS.has(method)) {
    const rawOptions = event.options as Array<{ label: string; value: string }> | undefined
    const requestId = String(event.id ?? '')
    return [
      { kind: 'extension-ui', requestId, sessionId: sid, method },
      {
        kind: 'message',
        message: {
          type: 'extension.ui_request',
          payload: {
            sessionId: sid,
            requestId,
            method,
            title: event.title,
            message: event.message,
            options: rawOptions ? rawOptions.map((o) => o.label) : undefined,
            default: event.default as string | undefined,
            level: event.level as 'info' | 'warn' | 'error' | undefined,
            prefill: method === METHOD_EDITOR ? (event.prefill as string | undefined) : undefined,
          },
        },
      },
    ]
  }

  return [{ kind: 'noop' }]
}

/** message_start — role-based routing for non-assistant messages */
function handleMessageStart(event: PiEvent, sid: string): PiTranslatedEvent[] {
  const msg = event.message as Record<string, unknown> | undefined
  if (!msg) {
    // assistant turn 开始（无 role）。生成 messageId 供 file_changes 挂载，并跟踪到 interpreter 态。
    const messageId = `a-${randomUUID()}`
    return [
      { kind: 'turn-start', messageId },
      { kind: 'message', message: { type: 'message.message_start', payload: { sessionId: sid, messageId } } },
    ]
  }

  const role = msg.role as string | undefined

  // [HISTORICAL] user role 的 message_start 必须忽略：pi 0.80.3 agent-loop 在每个 turn
  // 末尾 emit message_start{role:'user'} + message_end（见 agent-loop.ts:112-113）。
  // 若不过滤，前端会为 user prompt 再建一个空气泡（渲染撕裂、findLastAssistantIndex 错位）。
  // fork 0.75.5 不发此事件；切 upstream 0.80.3（ac83b578）后出现。与 toolResult 同属「内部记账」语义。
  if (role === 'user') return [{ kind: 'noop' }]

  // toolResult 是 pi agent-core 工具执行完毕的内部记账（agent-loop.js emitToolResultMessage：
  // executeToolCalls 后 emit message_start/end{role:'toolResult'}）。
  // 前端已通过 tool_execution_end 拿到 output，toolResult message_start 对前端是噪声——
  // 若转发，chat-chunk-processor 会建空 assistant message，干扰 findLastAssistantIndex
  // 导致后续 tool_call_end 匹配错位（toolCall 永久卡 running）。
  // 与历史路径 message-converter.ts:36（toolResult 合并进父 assistant，非独立消息）语义一致。
  if (role === 'toolResult') return [{ kind: 'noop' }]

  if (role === 'bashExecution') {
    return [{
      kind: 'message',
      message: {
        type: 'message.bashExecution',
        payload: {
          sessionId: sid,
          command: msg.command as string | undefined,
          output: msg.output as string | undefined,
          exitCode: msg.exitCode as number | undefined,
          cancelled: msg.cancelled as boolean | undefined,
          truncated: msg.truncated as boolean | undefined,
          fullOutputPath: msg.fullOutputPath as string | undefined,
          timestamp: msg.timestamp as number | undefined,
          excludeFromContext: msg.excludeFromContext as boolean | undefined,
        },
      },
    }]
  }
  if (role === 'compactionSummary') {
    return [{
      kind: 'message',
      message: {
        type: 'message.compactionSummary',
        payload: { sessionId: sid, summary: msg.summary as string | undefined, tokensBefore: msg.tokensBefore as number | undefined, timestamp: msg.timestamp as number | undefined },
      },
    }]
  }
  if (role === 'branchSummary') {
    return [{
      kind: 'message',
      message: {
        type: 'message.branchSummary',
        payload: { sessionId: sid, summary: msg.summary as string | undefined, fromId: msg.fromId as string | undefined, timestamp: msg.timestamp as number | undefined },
      },
    }]
  }
  // custom message from pi.sendMessage
  if (msg.customType) {
    return [{
      kind: 'message',
      message: {
        type: 'message.message_start',
        payload: {
          sessionId: sid,
          customType: msg.customType as string,
          content: msg.content as string | undefined,
          details: msg.details as Record<string, unknown> | undefined,
          display: msg.display as boolean | undefined,
        },
      },
    }]
  }
  // 兜底：assistant turn（有 msg 但无 role）—— 同样生成 messageId 供 file_changes 挂载 + 采 baseline。
  const fallbackId = `a-${randomUUID()}`
  return [
    { kind: 'turn-start', messageId: fallbackId },
    { kind: 'message', message: { type: 'message.message_start', payload: { sessionId: sid, messageId: fallbackId } } },
  ]
}

/** tool_execution_update — forward detail (string or object) */
function handleToolExecutionUpdate(event: PiEvent, sid: string): PiTranslatedEvent[] {
  const partialResult = event.partialResult
  const detail: string | Record<string, unknown> | undefined =
    partialResult != null && typeof partialResult === 'object'
      ? (partialResult as Record<string, unknown>)
      : (partialResult as string | undefined)
  return [{
    kind: 'message',
    message: {
      type: 'message.tool_call_update',
      payload: { sessionId: sid, toolCallId: event.toolCallId ?? '', detail },
    },
  }]
}

/** extension_error — field rename extensionPath → extensionName + errorEvent */
function handleExtensionError(event: PiEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'extension.error',
      payload: {
        sessionId: sid,
        extensionName: (event.extensionPath as string) ?? '',
        error: event.error ?? 'Unknown extension error',
        errorEvent: event.event as string | undefined,
      },
    },
  }]
}

/** auto_retry_start → message.auto_retry_start */
function handleAutoRetryStart(event: PiEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'message.auto_retry_start',
      payload: {
        sessionId: sid,
        attempt: event.attempt as number | undefined,
        maxAttempts: event.maxAttempts as number | undefined,
        delayMs: event.delayMs as number | undefined,
        errorMessage: event.errorMessage as string | undefined,
      },
    },
  }]
}

/** auto_retry_end → message.auto_retry_end */
function handleAutoRetryEnd(event: PiEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'message.auto_retry_end',
      payload: {
        sessionId: sid,
        success: event.success as boolean | undefined,
        attempt: event.attempt as number | undefined,
        finalError: event.finalError as string | undefined,
      },
    },
  }]
}

/** queue_update → message.queue_update */
function handleQueueUpdate(event: PiEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'message.queue_update',
      payload: {
        sessionId: sid,
        steering: event.steering as string[] | undefined,
        followUp: event.followUp as string[] | undefined,
      },
    },
  }]
}

/** session_info_changed → session.renamed */
function handleSessionInfoChanged(event: PiEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'session.renamed',
      payload: { sessionId: sid, name: event.name as string | undefined },
    },
  }]
}

/** thinking_level_changed → session.thinkingLevelSet + 回写 session 缓存（interpreter 处理） */
function handleThinkingLevelChanged(event: PiEvent, sid: string): PiTranslatedEvent[] {
  const level = event.level as string | undefined
  return [
    // 回写 session.thinkingLevel 缓存（interpreter 调 sessionService）
    { kind: 'thinking-level', level },
    { kind: 'message', message: { type: 'session.thinkingLevelSet', payload: { sessionId: sid, level } } },
  ]
}

// ── Null-event types (lifecycle events not forwarded to frontend) ──
const NULL_EVENTS = new Set([
  'agent_start', 'turn_start', 'turn_end', 'message_end',
  'extension_config', 'extension_ui_response', 'response',
  'compaction_start', 'compaction_end',
])

// ── Dispatcher map ─────────────────────────────────────────────────
const DISPATCHER = new Map<string, (event: PiEvent, sid: string) => PiTranslatedEvent[]>()
;(function registerHandlers() {
  DISPATCHER.set('message_update', handleMessageUpdate)
  DISPATCHER.set('tool_execution_start', handleToolExecutionStart)
  DISPATCHER.set('tool_execution_end', handleToolExecutionEnd)
  DISPATCHER.set('agent_end', handleAgentEnd)
  DISPATCHER.set('extension_ui_request', handleExtensionUIRequest)
  DISPATCHER.set('message_start', handleMessageStart)
  DISPATCHER.set('tool_execution_update', handleToolExecutionUpdate)
  DISPATCHER.set('extension_error', handleExtensionError)
  DISPATCHER.set('auto_retry_start', handleAutoRetryStart)
  DISPATCHER.set('auto_retry_end', handleAutoRetryEnd)
  DISPATCHER.set('queue_update', handleQueueUpdate)
  DISPATCHER.set('session_info_changed', handleSessionInfoChanged)
  DISPATCHER.set('thinking_level_changed', handleThinkingLevelChanged)
  // Simple passthrough handlers
  DISPATCHER.set('status', (event, sid) => [{
    kind: 'message',
    message: {
      type: 'message.status',
      payload: { sessionId: sid, status: event.status ?? '', detail: event.detail },
    },
  }])
  DISPATCHER.set('error', (event, sid) => [{
    kind: 'message',
    message: {
      type: 'message.error',
      payload: { sessionId: sid, message: event.message ?? 'Unknown error' },
    },
  }])
})()

/**
 * 纯翻译：把单个 pi 事件翻译为 0~N 个中间事件。
 *
 * 无副作用、无可变态、不 import services 域类型。组合根负责把 translate 的结果
 * 喂给 EventInterpreter 做业务编排。
 */
export function translate(event: PiEvent, sessionId: string): PiTranslatedEvent[] {
  const eventType = event.type as string

  // Lifecycle events that produce no output
  if (NULL_EVENTS.has(eventType)) return []

  // agent_start — 仅产 hook 事件（interpreter 触发 onPiEvent/agent_start hook）
  if (eventType === 'agent_start') {
    return [{ kind: 'hook', eventType: 'agent_start', data: {} }]
  }

  // Dispatch to registered handler
  const handler = DISPATCHER.get(eventType)
  if (handler) return handler(event, sessionId)

  console.warn('[EventAdapter] Unhandled pi event type:', eventType)
  return []
}

// ── EventAdapter class ─────────────────────────────────────────────

export type WsSender = (msg: ServerMessage) => void

/**
 * 绑定一个 pi session 的事件适配器：订阅事件 → 翻译 → 经 interpreter 回调消费。
 *
 * 纯订阅器：不持有业务态（statusBaseline/writeContents/currentMessageId 全部移到 interpreter），
 * 不直接 send —— 把翻译结果交给注入的 interpreter 回调（interpreter 决定副作用：转发/hook/diff/回写）。
 */
export class EventAdapter {
  private unsub: (() => void) | null = null

  constructor(
    private sessionId: string,
    private interpret: (events: PiTranslatedEvent[]) => void,
  ) {}

  /** Start listening to events from an RpcClient. */
  attach(client: { onEvent: (listener: PiEventListener) => (() => void) }): void {
    this.unsub = client.onEvent((event) => {
      const events = translate(event as unknown as Record<string, unknown>, this.sessionId)
      if (events.length === 0) return
      // interpret 同步执行（message/status WS 帧即时送出）；
      // 仅 tool-call-* 的 hook 改写异步（handler 内部 await），不阻塞本回调。
      try {
        this.interpret(events)
      } catch (err: unknown) {
        console.error('[EventAdapter] interpret error:', err)
      }
    })
  }

  /** Stop listening. */
  detach(): void {
    if (this.unsub) {
      this.unsub()
      this.unsub = null
    }
  }
}
