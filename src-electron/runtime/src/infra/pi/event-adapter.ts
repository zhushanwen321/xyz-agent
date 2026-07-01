import type { ServerMessage, ServerMessageType } from '@xyz-agent/shared'
import { EXTENSION_EVENTS } from '@xyz-agent/shared'
import type { PiEventListener } from '../../services/ports/pi-engine.js'
import { toErrorMessage } from '../../utils/errors.js'
import { snapshotGitStatus, diffSnapshots, computeLineCounts } from './file-change-reconciler.js'
import type { StatusSnapshot } from './file-change-reconciler.js'
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
   * pi session 工作目录（ADR-0024 D5 重构：git 作为唯一真值源）。用于：
   * - message_start 采集 baseline 快照（snapshotGitStatus）
   * - write/edit/bash 结束后 diff baseline vs current
   * - 行数填充（computeLineCounts：numstat + untracked content 回退）
   * 缺省时跳过 baseline diff（非 git 仓库降级，不推 file_changes）。
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
  /** turn 开始时的 git status 快照（baseline diff 的基准） */
  statusBaseline: StatusSnapshot
  /** 本 turn write 工具写入的 content（filePath → content，untracked 行数回退用） */
  writeContents: Map<string, string>
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

// ── FileChange baseline diff（ADR-0024 D5 重构：git 作为唯一真值源）──

/** 取工具参数 path（pi 契约权威参数名；file_path 作防御性 fallback，ADR-0024 D2） */
function extractPath(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined
  const p = args.path
  if (typeof p === 'string' && p) return p
  const fp = args.file_path
  return typeof fp === 'string' && fp ? fp : undefined
}

/**
 * 推送 baseline diff 结果的 file_changes 帧。
 *
 * 机制：diff 当前 git status vs turn 开始时的 baseline → 得到本 turn 引入的变更。
 * isFullSet=true 因为 baseline diff 每次都是全量结果（前端全集替换，不增量合并）。
 *
 * @param changeSetStatus 'accumulating'（写操作后实时）/ 'ready'（agent_end 最终对账）
 * 非 git 仓库 / cwd 缺省 → 跳过（不推 file_changes）。
 */
function sendDiffFileChanges(ctx: HandlerContext, changeSetStatus: 'accumulating' | 'ready'): void {
  if (!ctx.currentMessageId) return
  const cwd = ctx.options?.cwd
  if (!cwd) return
  const current = snapshotGitStatus(cwd)
  if (!current) return
  const changes = diffSnapshots(ctx.statusBaseline, current)
  if (changes.length === 0) return
  // 行数：numstat（已跟踪）+ writeContents 回退（untracked）
  computeLineCounts(cwd, changes, ctx.writeContents)
  ctx.send({
    type: 'message.file_changes',
    payload: {
      sessionId: ctx.sessionId,
      messageId: ctx.currentMessageId,
      fileChanges: changes,
      changeSetStatus,
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

  // ADR-0024 D5 重构：git 作为唯一真值源。write/edit/bash 结束后走 baseline diff。
  // write 工具：记录 content 供 untracked 行数回退（numstat 不报告 untracked 文件）。
  // 失败的工具调用（isError）不触发 diff（避免噪声）。
  if (!event.isError) {
    const toolName = String(event.toolName ?? '')
    if (toolName === 'write') {
      const args = (event.args ?? event.input) as Record<string, unknown> | undefined
      const filePath = extractPath(args)
      if (filePath && typeof args?.content === 'string') {
        ctx.writeContents.set(filePath, args.content)
      }
    }
    // 所有可能改文件的工具（write/edit/bash）都走 baseline diff。
    // bash 改的文件无法从参数静态解析（sed/echo/tee），只能靠 git diff 兜底。
    if (toolName === 'write' || toolName === 'edit' || toolName === 'bash') {
      sendDiffFileChanges(ctx, 'accumulating')
    }
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

  // ADR-0024 D5 重构：agent_end 推送 ready 全集（baseline diff 最终结果）。
  // 推送后清空 baseline + writeContents，为下一回合重新采集。
  sendDiffFileChanges(ctx, 'ready')
  ctx.statusBaseline = null
  ctx.writeContents.clear()

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
    // ADR-0024 D5 重构：采集 turn 开始时的 git status 快照作为 baseline。
    // 整个 turn 内的写操作 diff 都 vs baseline（即使中途 commit 重置工作区，baseline 仍稳定）。
    // 非 git 仓库 / cwd 缺省 → null（后续 baseline diff 跳过，不推 file_changes）。
    ctx.statusBaseline = ctx.options?.cwd ? snapshotGitStatus(ctx.options.cwd) : null
    ctx.writeContents.clear()
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
  // 同主路径：采集 baseline 快照（ADR-0024 D5 重构）
  ctx.statusBaseline = ctx.options?.cwd ? snapshotGitStatus(ctx.options.cwd) : null
  ctx.writeContents.clear()
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
  /** turn 开始时的 git status 快照（baseline diff 基准，message_start 采集，agent_end 清空） */
  private statusBaseline: StatusSnapshot = null
  /** 本 turn write 工具写入的 content（untracked 行数回退用，message_start 清空） */
  private writeContents: Map<string, string> = new Map()

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
      // ctx 持有实例态：writeContents 是 Map 引用（set/clear 原地突变），
      // currentMessageId / statusBaseline 经值传递，handler 改写后需回写实例（与 currentMessageId 同模式）。
      const ctx: HandlerContext = {
        sessionId: this.sessionId,
        send: this.send,
        options: this.options,
        hookCallback: this.options?.onHookExecute,
        currentMessageId: this.currentMessageId,
        statusBaseline: this.statusBaseline,
        writeContents: this.writeContents,
      }
      return Promise.resolve(handler(event, ctx)).then((result) => {
        // 回写实例态（currentMessageId / statusBaseline 可能在 message_start / agent_end 被改写）
        this.currentMessageId = ctx.currentMessageId
        this.statusBaseline = ctx.statusBaseline
        return result
      })
    }

    console.warn('[EventAdapter] Unhandled pi event type:', eventType)
    return Promise.resolve(null)
  }
}
