import type { ServerMessage, ServerMessageType, FileChange } from '@xyz-agent/shared'
import { EXTENSION_EVENTS } from '@xyz-agent/shared'
import type { PiEventListener } from '../../services/ports/pi-engine.js'
import { toErrorMessage } from '../../utils/errors.js'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { reconcileFileChanges, mergeWithIncremental } from './file-change-reconciler.js'
import { randomUUID } from 'node:crypto'

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
  onHookExecute?: (hookType: string, context: Record<string, unknown>) => Promise<import('../../services/plugin-service/plugin-types.js').HookResult>
  /**
   * pi session 工作目录（ADR-0024 D5）。用于：
   * - write 工具 added/modified 判定（existsSync 探测需绝对路径）
   * - agent_end git 对账（git status --porcelain 的 cwd）
   * 缺省时跳过 git 对账，write 一律标 modified（方案 B 兜底）。
   */
  cwd?: string
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
  /** 当前 assistant message 的 id（message.message_start 设置，file_changes 挂载目标） */
  currentMessageId: string | undefined
  /** 本回合累计的 FileChange[]（write/edit 增量提取，agent_end git 对账用） */
  accumulatedChanges: FileChange[]
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
      console.debug(`[event-adapter] hook tool_execution_start error: ${toErrorMessage(e)}`)
    }
  }

  fireHook(ctx, 'tool_execution_start', { toolCallId: event.toolCallId ?? '', toolName, input })

  return {
    type: 'message.tool_call_start',
    payload: { sessionId: sid, toolCallId: event.toolCallId ?? '', toolName, input },
  }
}

// ── FileChange 提取（ADR-0024 D2/D3）──────────────────────────────

/** 取工具参数 path（pi 契约权威参数名；file_path 作防御性 fallback，ADR-0024 D2） */
function extractPath(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined
  const p = args.path
  if (typeof p === 'string' && p) return p
  const fp = args.file_path
  return typeof fp === 'string' && fp ? fp : undefined
}

/**
 * write 工具：从 input.content 分行计 addLines；added/modified 需 existsSync 判定（D3 方案 A）。
 * end 事件已代表 write 队列 flush 完成（withFileMutationQueue 串行），时序安全。
 * cwd 缺省时一律标 modified（方案 B 兜底，交 git 对账纠正）。
 */
function extractWriteChange(args: Record<string, unknown> | undefined, cwd: string | undefined): FileChange | null {
  const filePath = extractPath(args)
  if (!filePath) return null
  let status: FileChange['status'] = 'modified'
  if (cwd) {
    const abs = resolve(cwd, filePath)
    status = existsSync(abs) ? 'modified' : 'added'
  }
  const content = typeof args?.content === 'string' ? args.content : ''
  const addLines = content === '' ? 0 : content.split('\n').length
  const change: FileChange = { filePath, status }
  if (addLines > 0) change.addLines = addLines
  return change
}

/**
 * edit 工具：恒 modified（edit 只改既有文件）；行数从 result.details.patch（unified diff）解析。
 * `+` 开头（非 `+++`）计 addLines，`-` 开头（非 `---`）计 delLines。
 */
function extractEditChange(
  args: Record<string, unknown> | undefined,
  details: Record<string, unknown> | undefined,
): FileChange | null {
  const filePath = extractPath(args)
  if (!filePath) return null
  const change: FileChange = { filePath, status: 'modified' }
  const patch = details?.patch
  if (typeof patch === 'string') {
    let addLines = 0
    let delLines = 0
    for (const line of patch.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('+')) addLines += 1
      else if (line.startsWith('-')) delLines += 1
    }
    if (addLines > 0) change.addLines = addLines
    if (delLines > 0) change.delLines = delLines
  }
  return change
}

/**
 * 从已结束的工具调用提取 FileChange（write/edit 分派，bash 不解析 D4）。
 * 返回 null 表示该工具无文件变更（read/grep/find/ls/bash 或无 path）。
 */
function extractFileChange(
  toolName: string,
  args: Record<string, unknown> | undefined,
  details: Record<string, unknown> | undefined,
  cwd: string | undefined,
): FileChange | null {
  if (toolName === 'write') return extractWriteChange(args, cwd)
  if (toolName === 'edit') return extractEditChange(args, details)
  return null
}

/** 推送 file_changes 帧（accumulating 增量，ADR-0024 D6） */
function sendAccumulatingFileChanges(ctx: HandlerContext, change: FileChange): void {
  ctx.accumulatedChanges.push(change)
  if (!ctx.currentMessageId) return
  ctx.send({
    type: 'message.file_changes',
    payload: {
      sessionId: ctx.sessionId,
      messageId: ctx.currentMessageId,
      fileChanges: [change],
      changeSetStatus: 'accumulating',
      isFullSet: false,
    },
  })
}

/** 推送 file_changes 帧（ready 全集，agent_end git 对账后真值收口，ADR-0024 D5/D6） */
function sendReadyFileChanges(ctx: HandlerContext): void {
  if (!ctx.currentMessageId) return
  const cwd = ctx.options?.cwd
  const gitSet = cwd ? reconcileFileChanges(cwd) : null
  const fullSet = mergeWithIncremental(gitSet, ctx.accumulatedChanges)
  if (fullSet.length === 0) return
  ctx.send({
    type: 'message.file_changes',
    payload: {
      sessionId: ctx.sessionId,
      messageId: ctx.currentMessageId,
      fileChanges: fullSet,
      changeSetStatus: 'ready',
      isFullSet: true,
    },
  })
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
      console.debug(`[event-adapter] hook tool_execution_end error: ${toErrorMessage(e)}`)
    }
  }

  fireHook(ctx, 'tool_execution_end', { toolCallId, output, details, images })

  // ADR-0024 D1/D2：从 write/edit 工具提取 FileChange，推送 accumulating 增量帧。
  // bash 不解析（D4，交 agent_end git 对账）。失败的工具调用（isError）不提取。
  if (!event.isError) {
    const toolName = String(event.toolName ?? '')
    const args = (event.args ?? event.input) as Record<string, unknown> | undefined
    const change = extractFileChange(toolName, args, details, ctx.options?.cwd)
    if (change) sendAccumulatingFileChanges(ctx, change)
  }

  return {
    type: 'message.tool_call_end',
    payload: {
      sessionId: sid,
      toolCallId,
      output,
      details,
      images,
      // 与历史路径 convertPiHistory（tc.status='error'）保持一致：实时失败的 tool call
      // 必须带 status:'error'，否则前端 Block.vue 的 isFailed 判定恒为 false（恒显示成功）。
      status: event.isError ? 'error' : 'completed',
      error: event.isError ? output : event.error,
    },
  }
}

/** agent_end — extract stop reason, usage, responseModel, diagnostics, errorMessage */
function handleAgentEnd(event: PiEvent, ctx: HandlerContext): HandlerResult {
  const sid = ctx.sessionId
  const messages = event.messages as Array<Record<string, unknown>> | undefined
  const lastMsg = messages?.[messages.length - 1]
  const rawReason = (lastMsg?.stopReason as string) ?? 'stop'
  const usage = lastMsg?.usage as
    { input: number; output: number; totalTokens?: number; cacheRead?: number; cacheWrite?: number } | undefined
  const responseModel = lastMsg?.responseModel as string | undefined
  const diagnostics = lastMsg?.diagnostics as Record<string, unknown> | undefined
  const errorMessage = (rawReason === 'error' || rawReason === 'tool_use') ? lastMsg?.errorMessage as string | undefined : undefined

  if (usage?.input) {
    ctx.options?.onContextUpdate?.(sid, { inputTokens: usage.input, totalTokens: usage.totalTokens ?? 0 })
  }
  fireHook(ctx, 'agent_end', { stopReason: STOP_REASON_MAP[rawReason] ?? rawReason, usage })

  // ADR-0024 D5/D6：agent_end 回合边界推送 ready 全集（git 对账真值收口）。
  // 推送后清空本回合累计，为下一回合重新累计。
  sendReadyFileChanges(ctx)
  ctx.accumulatedChanges.length = 0

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
      errorMessage,
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
  if (!msg) {
    // assistant turn 开始（无 role）。生成 messageId 供 file_changes 挂载，并跟踪到 ctx。
    const messageId = `a-${randomUUID()}`
    ctx.currentMessageId = messageId
    // 原地清空（splice），保持实例数组引用不变（后续 tool_end 按 reference push）
    ctx.accumulatedChanges.splice(0, ctx.accumulatedChanges.length)
    return { type: 'message.message_start', payload: { sessionId: sid, messageId } }
  }

  const role = msg.role as string | undefined

  // toolResult 是 pi agent-core 工具执行完毕的内部记账（agent-loop.js emitToolResultMessage：
  // executeToolCalls 后 emit message_start/end{role:'toolResult'}）。
  // 前端已通过 tool_execution_end 拿到 output，toolResult message_start 对前端是噪声——
  // 若转发，chat-chunk-processor 会建空 assistant message，干扰 findLastAssistantIndex
  // 导致后续 tool_call_end 匹配错位（toolCall 永久卡 running）。
  // 与历史路径 message-converter.ts:36（toolResult 合并进父 assistant，非独立消息）语义一致。
  if (role === 'toolResult') return null

  if (role === 'bashExecution') {
    return {
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
    }
  }
  if (role === 'compactionSummary') {
    return {
      type: 'message.compactionSummary',
      payload: { sessionId: sid, summary: msg.summary as string | undefined, tokensBefore: msg.tokensBefore as number | undefined, timestamp: msg.timestamp as number | undefined },
    }
  }
  if (role === 'branchSummary') {
    return {
      type: 'message.branchSummary',
      payload: { sessionId: sid, summary: msg.summary as string | undefined, fromId: msg.fromId as string | undefined, timestamp: msg.timestamp as number | undefined },
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
  // 兜底：assistant turn（有 msg 但无 role）—— 同样生成 messageId 供 file_changes 挂载。
  const fallbackId = `a-${randomUUID()}`
  ctx.currentMessageId = fallbackId
  ctx.accumulatedChanges.splice(0, ctx.accumulatedChanges.length)
  return { type: 'message.message_start', payload: { sessionId: sid, messageId: fallbackId } }
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
      finalError: event.finalError as string | undefined,
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
  /** 当前 assistant message 的 id（message_start 设置，file_changes 挂载目标，跨事件保持） */
  private currentMessageId: string | undefined
  /** 本回合累计的 FileChange[]（write/edit 增量提取，agent_end git 对账后清空） */
  private accumulatedChanges: FileChange[] = []

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
      // ctx 直接持有实例字段引用：accumulatedChanges 数组按引用突变（push/length=0），
      // currentMessageId 经 holder 对象桥接（handlers 写 holder.value，实例读 holder.value）。
      const ctx: HandlerContext = {
        sessionId: this.sessionId,
        send: this.send,
        options: this.options,
        hookCallback: this.options?.onHookExecute,
        currentMessageId: this.currentMessageId,
        accumulatedChanges: this.accumulatedChanges,
      }
      return Promise.resolve(handler(event, ctx)).then((result) => {
        // 回写实例态（currentMessageId 可能在 message_start 被 handler 改写）
        this.currentMessageId = ctx.currentMessageId
        return result
      })
    }

    console.warn('[EventAdapter] Unhandled pi event type:', eventType)
    return Promise.resolve(null)
  }
}
