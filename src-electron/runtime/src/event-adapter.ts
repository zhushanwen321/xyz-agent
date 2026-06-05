import type { ServerMessage, ServerMessageType } from '@xyz-agent/shared'
import { EXTENSION_EVENTS } from '@xyz-agent/shared'
import type { PiEventListener } from './rpc-client.js'

export type WsSender = (msg: ServerMessage) => void

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

/**
 * Translates pi subprocess RPC events into WS protocol ServerMessages.
 *
 * pi RPC events have this structure:
 * - `message_update` with nested `assistantMessageEvent` containing `type`, `delta`, `contentIndex`
 *   - sub-types: text_start, text_delta, text_end, thinking_start, thinking_delta, thinking_end
 * - `message_start` / `message_end` with `message` containing role, content, usage, stopReason
 * - `agent_start` / `turn_start` / `turn_end` / `agent_end` for lifecycle
 * - `extension_ui_request` for tool approvals etc.
 *
 * Each session gets its own adapter instance bound to a WsSender.
 */
export interface EventAdapterOptions {
  /** Called after successfully translating an extension_ui_request event. */
  onExtensionUIRequest?: (requestId: string, sessionId: string, method: string) => void
  /** Called for bridge: prefixed extension_ui_request events. Routes the request directly without frontend timeout. */
  onBridgeUIRequest?: (requestId: string, sessionId: string, method: string, data: Record<string, unknown>) => void
  /** Called when pi extension fires setStatus via ctx.ui.setStatus(key, text). */
  onStatusSetUpdate?: (payload: { sessionId: string; key: string; text: string }) => void
  /** Called after agent_end with usage data for context window tracking. */
  onContextUpdate?: (sessionId: string, data: { inputTokens: number; totalTokens: number }) => void
  /** Called by EventAdapter to execute plugin hooks on tool/message events. */
  onHookExecute?: (hookType: string, context: Record<string, unknown>) => Promise<import('./services/plugin-service/plugin-types.js').HookResult>
}

// ── Sub-handler types ──────────────────────────────────────────────
type PiEvent = Record<string, unknown>
type HandlerResult = ServerMessage | null | Promise<ServerMessage | null>
type EventHandler = (event: PiEvent, ctx: HandlerContext) => HandlerResult

interface HandlerContext {
  sessionId: string
  send: WsSender
  options: EventAdapterOptions | undefined
  hookCallback: EventAdapterOptions['onHookExecute'] | undefined
}

// ── Sub-handlers ───────────────────────────────────────────────────

function fireHook(ctx: HandlerContext, eventType: string, data: Record<string, unknown>): void {
  ctx.hookCallback?.('onPiEvent', { event: eventType, ...data }).catch(() => {})
}

/** message_update — streaming text/thinking deltas and stream errors */
function handleMessageUpdate(event: PiEvent, ctx: HandlerContext): HandlerResult {
  const sid = ctx.sessionId
  const sub = event.assistantMessageEvent as
    { type: string; delta?: string; content?: string; contentIndex?: number } | undefined
  if (!sub) return null

  switch (sub.type) {
    case 'text_delta':
      return { type: 'message.text_delta', payload: { sessionId: sid, delta: sub.delta ?? '' } }
    case 'thinking_start':
      return { type: 'message.thinking_start', payload: { sessionId: sid } }
    case 'thinking_delta':
      return { type: 'message.thinking_delta', payload: { sessionId: sid, delta: sub.delta ?? '' } }
    case 'thinking_end':
      return { type: 'message.thinking_end', payload: { sessionId: sid } }
    case 'toolcall_start': case 'toolcall_delta': case 'toolcall_end':
    case 'text_start': case 'text_end':
      return null
    // FR-5: streaming error — surface as message.stream_error
    case 'error':
      return { type: 'message.stream_error', payload: { sessionId: sid, reason: 'error', content: sub.content ?? '' } }
    default:
      console.warn('[EventAdapter] Unhandled message_update sub-type:', sub.type)
      return null
  }
}

/** tool_execution_start — with optional plugin hook */
async function handleToolExecutionStart(event: PiEvent, ctx: HandlerContext): Promise<ServerMessage | null> {
  const sid = ctx.sessionId
  const toolName = event.toolName ?? '' as string
  let input = event.args ?? event.input

  if (ctx.hookCallback) {
    try {
      const hookResult = await ctx.hookCallback('onBeforeToolCall', { toolName, input })
      if (hookResult.blocked === true) {
        fireHook(ctx, 'tool_execution_start', { toolCallId: event.toolCallId ?? '', toolName, input, blocked: true })
        return null
      }
      if (hookResult.transformedData !== undefined) {
        input = hookResult.transformedData
      }
    // eslint-disable-next-line taste/no-silent-catch
    } catch (e) {
      console.debug(`[event-adapter] hook tool_execution_start error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  fireHook(ctx, 'tool_execution_start', { toolCallId: event.toolCallId ?? '', toolName, input })

  return {
    type: 'message.tool_call_start',
    payload: { sessionId: sid, toolCallId: event.toolCallId ?? '', toolName, input },
  }
}

/** tool_execution_end — extract text + images, optional plugin hook */
async function handleToolExecutionEnd(event: PiEvent, ctx: HandlerContext): Promise<ServerMessage | null> {
  const sid = ctx.sessionId
  let output: string
  let images: Array<{ data: string; mimeType: string }> | undefined
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

  const toolCallId = event.toolCallId ?? '' as string

  if (ctx.hookCallback) {
    try {
      const hookResult = await ctx.hookCallback('onAfterToolResult', { toolCallId, output })
      if (hookResult.transformedData !== undefined) output = hookResult.transformedData as string
    // eslint-disable-next-line taste/no-silent-catch
    } catch (e) {
      console.debug(`[event-adapter] hook tool_execution_end error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  fireHook(ctx, 'tool_execution_end', { toolCallId, output, details, images })

  return {
    type: 'message.tool_call_end',
    payload: { sessionId: sid, toolCallId, output, details, images, error: event.isError ? output : event.error },
  }
}

/** agent_end — extract stop reason, usage, responseModel, diagnostics */
function handleAgentEnd(event: PiEvent, ctx: HandlerContext): HandlerResult {
  const sid = ctx.sessionId
  const messages = event.messages as Array<Record<string, unknown>> | undefined
  const lastMsg = messages?.[messages.length - 1]
  const rawReason = (lastMsg?.stopReason as string) ?? 'stop'
  const usage = lastMsg?.usage as
    { input: number; output: number; totalTokens?: number; cacheRead?: number; cacheWrite?: number } | undefined
  const responseModel = lastMsg?.responseModel as string | undefined
  const diagnostics = lastMsg?.diagnostics as Record<string, unknown> | undefined

  if (usage?.input) {
    ctx.options?.onContextUpdate?.(sid, { inputTokens: usage.input, totalTokens: usage.totalTokens ?? 0 })
  }
  fireHook(ctx, 'agent_end', { stopReason: STOP_REASON_MAP[rawReason] ?? rawReason, usage })

  return {
    type: 'message.complete',
    payload: {
      sessionId: sid,
      stopReason: STOP_REASON_MAP[rawReason] ?? rawReason,
      usage: usage
        ? { inputTokens: usage.input ?? 0, outputTokens: usage.output ?? 0, totalTokens: usage.totalTokens ?? 0 }
        : undefined,
      responseModel,
      diagnostics,
    },
  }
}

/** extension_ui_request — route by method (setStatus, setWidget, editor, etc.) */
function handleExtensionUIRequest(event: PiEvent, ctx: HandlerContext): HandlerResult {
  const sid = ctx.sessionId
  const method = event.method as string | undefined

  // setStatus → internal callback + WS event
  if (method === 'setStatus') {
    ctx.options?.onStatusSetUpdate?.({
      sessionId: sid,
      key: String(event.statusKey ?? ''),
      text: stripAnsi(String(event.statusText ?? '')),
    })
    ctx.send({
      type: EXTENSION_EVENTS.STATUS as ServerMessageType,
      payload: { sessionId: sid, statusKey: String(event.statusKey ?? ''), text: stripAnsi(String(event.statusText ?? '')) },
    })
    return null
  }

  // setWidget → WS event
  if (method === 'setWidget') {
    const widgetPayload = {
      sessionId: sid,
      widgetKey: String(event.widgetKey ?? ''),
      lines: Array.isArray(event.widgetLines) ? (event.widgetLines as unknown[]).map(l => stripAnsi(String(l))) : [],
    }
    console.log('[EventAdapter] setWidget:', widgetPayload.widgetKey, 'lines:', widgetPayload.lines.length, 'sessionId:', sid)
    ctx.send({ type: EXTENSION_EVENTS.WIDGET as ServerMessageType, payload: widgetPayload })
    return null
  }

  // setEditorText → extension:setEditorText
  if (method === 'set_editor_text') {
    return { type: 'extension:setEditorText', payload: { sessionId: sid, text: String(event.text ?? '') } }
  }

  // setTitle → extension:setTitle
  if (method === 'setTitle') {
    return { type: 'extension:setTitle', payload: { sessionId: sid, title: String(event.title ?? '') } }
  }

  // bridge:* → internal callback only
  if (method?.startsWith('bridge:')) {
    const requestId = String(event.id ?? '')
    const data = (event as Record<string, unknown>).data as Record<string, unknown> ?? {}
    ctx.options?.onBridgeUIRequest?.(requestId, sid, method, data)
    return null
  }

  // Interactive methods: confirm, select, input, notify, editor
  if (method && INTERACTIVE_UI_METHODS.has(method)) {
    const rawOptions = event.options as Array<{ label: string; value: string }> | undefined
    const requestId = String(event.id ?? '')
    ctx.options?.onExtensionUIRequest?.(requestId, sid, method)
    return {
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
    }
  }

  return null
}

/** message_start — role-based routing for non-assistant messages */
function handleMessageStart(event: PiEvent, ctx: HandlerContext): HandlerResult {
  const sid = ctx.sessionId
  const msg = event.message as Record<string, unknown> | undefined
  if (!msg) return { type: 'message.message_start', payload: { sessionId: sid } }

  const role = msg.role as string | undefined

  if (role === 'bashExecution') {
    return {
      type: 'message.bashExecution',
      payload: { sessionId: sid, command: msg.command as string | undefined, output: msg.output as string | undefined, exitCode: msg.exitCode as number | undefined },
    }
  }
  if (role === 'compactionSummary') {
    return {
      type: 'message.compactionSummary',
      payload: { sessionId: sid, summary: msg.summary as string | undefined, tokensBefore: msg.tokensBefore as number | undefined },
    }
  }
  if (role === 'branchSummary') {
    return {
      type: 'message.branchSummary',
      payload: { sessionId: sid, summary: msg.summary as string | undefined, fromId: msg.fromId as string | undefined },
    }
  }
  // custom message from pi.sendMessage
  if (msg.customType) {
    return {
      type: 'message.message_start',
      payload: {
        sessionId: sid,
        customType: msg.customType as string,
        content: msg.content as string | undefined,
        details: msg.details as Record<string, unknown> | undefined,
        display: msg.display as boolean | undefined,
      },
    }
  }
  return { type: 'message.message_start', payload: { sessionId: sid } }
}

/** tool_execution_update — forward detail (string or object) */
function handleToolExecutionUpdate(event: PiEvent, ctx: HandlerContext): HandlerResult {
  const partialResult = event.partialResult
  const detail: string | Record<string, unknown> | undefined =
    partialResult != null && typeof partialResult === 'object'
      ? (partialResult as Record<string, unknown>)
      : (partialResult as string | undefined)
  return {
    type: 'message.tool_call_update',
    payload: { sessionId: ctx.sessionId, toolCallId: event.toolCallId ?? '', detail },
  }
}

/** extension_error — field rename extensionPath → extensionName + errorEvent */
function handleExtensionError(event: PiEvent, ctx: HandlerContext): HandlerResult {
  return {
    type: 'extension.error',
    payload: {
      sessionId: ctx.sessionId,
      extensionName: (event.extensionPath as string) ?? '',
      error: event.error ?? 'Unknown extension error',
      errorEvent: event.event as string | undefined,
    },
  }
}

/** auto_retry_start → message.auto_retry_start */
function handleAutoRetryStart(event: PiEvent, ctx: HandlerContext): HandlerResult {
  return {
    type: 'message.auto_retry_start',
    payload: {
      sessionId: ctx.sessionId,
      attempt: event.attempt as number | undefined,
      maxAttempts: event.maxAttempts as number | undefined,
      delayMs: event.delayMs as number | undefined,
      errorMessage: event.errorMessage as string | undefined,
    },
  }
}

/** auto_retry_end → message.auto_retry_end */
function handleAutoRetryEnd(event: PiEvent, ctx: HandlerContext): HandlerResult {
  return {
    type: 'message.auto_retry_end',
    payload: {
      sessionId: ctx.sessionId,
      success: event.success as boolean | undefined,
      attempt: event.attempt as number | undefined,
    },
  }
}

/** queue_update → message.queue_update */
function handleQueueUpdate(event: PiEvent, ctx: HandlerContext): HandlerResult {
  return {
    type: 'message.queue_update',
    payload: {
      sessionId: ctx.sessionId,
      steering: event.steering as string[] | undefined,
      followUp: event.followUp as string[] | undefined,
    },
  }
}

/** session_info_changed → session.renamed */
function handleSessionInfoChanged(event: PiEvent, ctx: HandlerContext): HandlerResult {
  return {
    type: 'session.renamed',
    payload: { sessionId: ctx.sessionId, name: event.name as string | undefined },
  }
}

/** thinking_level_changed → session.thinkingLevelSet */
function handleThinkingLevelChanged(event: PiEvent, ctx: HandlerContext): HandlerResult {
  return {
    type: 'session.thinkingLevelSet',
    payload: { sessionId: ctx.sessionId, level: event.level as string | undefined },
  }
}

// ── Null-event types (lifecycle events not forwarded to frontend) ──
const NULL_EVENTS = new Set([
  'agent_start', 'turn_start', 'turn_end', 'message_end',
  'extension_config', 'extension_ui_response', 'response',
  'compaction_start', 'compaction_end',
])

// ── Dispatcher map ─────────────────────────────────────────────────
const DISPATCHER = new Map<string, EventHandler>()
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
  DISPATCHER.set('status', (event, ctx) => ({
    type: 'message.status',
    payload: { sessionId: ctx.sessionId, status: event.status ?? '', detail: event.detail },
  }))
  DISPATCHER.set('error', (event, ctx) => ({
    type: 'message.error',
    payload: { sessionId: ctx.sessionId, message: event.message ?? 'Unknown error' },
  }))
})()

// ── EventAdapter class ─────────────────────────────────────────────

export class EventAdapter {
  private unsub: (() => void) | null = null

  constructor(
    private sessionId: string,
    private send: WsSender,
    private options?: EventAdapterOptions,
  ) {}

  /** Start listening to events from an RpcClient. */
  attach(client: { onEvent: (listener: PiEventListener) => (() => void) }): void {
    this.unsub = client.onEvent((event) => {
      void this.handleEvent(event as unknown as Record<string, unknown>).catch((err: unknown) => {
        console.error('[EventAdapter] handleEvent error:', err)
      })
    })
  }

  /** Stop listening. */
  detach(): void {
    if (this.unsub) {
      this.unsub()
      this.unsub = null
    }
  }

  private async handleEvent(event: Record<string, unknown>): Promise<void> {
    const msg = await this.translate(event)
    if (msg) this.send(msg)
  }

  private translate(event: Record<string, unknown>): Promise<ServerMessage | null> {
    const eventType = event.type as string

    // Lifecycle events that produce no output
    if (NULL_EVENTS.has(eventType)) return Promise.resolve(null)

    // agent_start also fires a hook before returning null
    if (eventType === 'agent_start') {
      this.options?.onHookExecute?.('onPiEvent', { event: 'agent_start' }).catch(() => {})
      return Promise.resolve(null)
    }

    // Dispatch to registered handler
    const handler = DISPATCHER.get(eventType)
    if (handler) {
      const ctx: HandlerContext = {
        sessionId: this.sessionId,
        send: this.send,
        options: this.options,
        hookCallback: this.options?.onHookExecute,
      }
      return Promise.resolve(handler(event, ctx))
    }

    console.warn('[EventAdapter] Unhandled pi event type:', eventType)
    return Promise.resolve(null)
  }
}
