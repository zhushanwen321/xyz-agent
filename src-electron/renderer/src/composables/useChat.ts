import { useChatStore } from '../stores/chat'
import { useSessionStore } from '../stores/session'
import { getActivePinia } from 'pinia'
import { send } from '../lib/ws-client'
import { on, off } from '../lib/event-bus'
import { type Ref, unref } from 'vue'
import type {
  ServerMessage, ServerMessageType, ToolCall, ContentBlock,
  ExtensionErrorPayload, ToolCallUpdatePayload,
} from '@xyz-agent/shared'
import { createSystemNotification } from '../lib/system-notification'

const RADIX_36 = 36
const SUBSTRING_START = 2
const SUBSTRING_END = 6

/**
 * 全局事件处理器注册状态。
 * 事件处理器从消息 payload 中提取 sessionId，路由到正确的 ChatStore 分区。
 * 不再绑定到特定 useChat 实例的闭包。
 */


// ── 全局事件处理器 ────────────────────────────────────────────────

function createGlobalHandlers() {
  const store = useChatStore()
  const sessionStore = useSessionStore()

  function getSid(msg: ServerMessage): string | null {
    return (msg.payload?.sessionId as string) ?? null
  }

  function ensureStreamingMessage(sid: string) {
    const session = store.getSessionState(sid)
    // abort 后 isGenerating=false，忽略残余 delta 避免创建幽灵 streaming message
    if (!session.isGenerating) return
    if (!session.streamingMessage) {

      store.setStreaming({
        id: `stream-${Date.now()}-${Math.random().toString(RADIX_36).substring(SUBSTRING_START, SUBSTRING_END)}`,
        role: 'assistant',
        content: '',
        status: 'streaming',
        timestamp: Date.now(),
      }, sid)
    }
  }

  function onTextDelta(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    ensureStreamingMessage(sid)
    // 第一次收到 text 时注册 text contentBlock
    const session = store.getSessionState(sid)
    if (session.streamingMessage && !(session.streamingMessage.contentBlocks ?? []).some(b => b.type === 'text')) {
      const blocks: ContentBlock[] = [...(session.streamingMessage.contentBlocks ?? [])]
      blocks.push({ type: 'text', refId: 'text' })
      session.streamingMessage = { ...session.streamingMessage, contentBlocks: blocks }
    }
    store.appendToStreaming(msg.payload.delta as string, sid)
  }

  function onThinkingStart(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    ensureStreamingMessage(sid)
    const streaming = store.getSessionState(sid).streamingMessage
    if (streaming) {
      const existing = streaming.thinking ?? []
      // 只在没有活跃的（未折叠的）thinking block 时才创建新的
      const last = existing[existing.length - 1]
      if (!last || last.collapsed) {
        const blockId = `thk-${Date.now()}`
        const blocks: ContentBlock[] = [...(streaming.contentBlocks ?? [])]
        // 如果已有 text block，insert 在 text 之前（thinking 总在 text 前面）
        blocks.push({ type: 'thinking', refId: blockId })
        store.setStreaming({
          ...streaming,
          thinking: [...existing, { id: blockId, content: '', collapsed: false, startTime: Date.now() }],
          contentBlocks: blocks,
        }, sid)
      }
    }
  }

  function onThinkingDelta(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    ensureStreamingMessage(sid)
    const streaming = store.getSessionState(sid).streamingMessage
    if (streaming) {
      const existing = streaming.thinking ?? []
      const last = existing[existing.length - 1]
      if (last && !last.collapsed) {
        last.content += msg.payload.delta as string
        store.setStreaming({ ...streaming, thinking: [...existing] }, sid)
      } else {
        store.setStreaming({
          ...streaming,
          thinking: [...existing, { id: `thk-${Date.now()}`, content: msg.payload.delta as string, collapsed: false, startTime: Date.now() }],
        }, sid)
      }
    }
  }

  function onThinkingEnd(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const streaming = store.getSessionState(sid).streamingMessage
    if (streaming?.thinking?.length) {
      const now = Date.now()
      const updated = streaming.thinking.map((block, i) =>
        i === streaming.thinking!.length - 1
          ? { ...block, collapsed: true, endTime: block.endTime ?? now }
          : block,
      )
      store.setStreaming({ ...streaming, thinking: updated }, sid)
    }
  }

  function onToolCallStart(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    ensureStreamingMessage(sid)
    const streaming = store.getSessionState(sid).streamingMessage
    if (streaming) {
      const tc: ToolCall = {
        id: msg.payload.toolCallId as string,
        toolName: msg.payload.toolName as string,
        input: msg.payload.input,
        status: 'running',
        startTime: Date.now(),
      }
      const calls = [...(streaming.toolCalls ?? []), tc]
      const blocks: ContentBlock[] = [...(streaming.contentBlocks ?? [])]
      blocks.push({ type: 'toolCall', refId: tc.id })
      store.setStreaming({ ...streaming, toolCalls: calls, contentBlocks: blocks }, sid)
    }
  }

  function onToolCallEnd(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const streaming = store.getSessionState(sid).streamingMessage
    if (streaming?.toolCalls) {
      const calls = streaming.toolCalls.map((tc) =>
        tc.id === (msg.payload.toolCallId as string)
          ? { ...tc, output: msg.payload.output as string | undefined, details: msg.payload.details as Record<string, unknown> | undefined, status: 'completed' as const, endTime: Date.now() }
          : tc,
      )
      store.setStreaming({ ...streaming, toolCalls: calls }, sid)
    }
  }

  /**
   * pi 在每个 message 边界发出 message_start。
   * 如果当前有 streamingMessage（上一轮的），先完成它再开始新一轮。
   */
  function onMessageStart(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    if (store.getSessionState(sid).streamingMessage) {
      store.completeStreaming({ keepGenerating: true }, sid)
    }
  }

  function onComplete(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const usage = msg.payload.usage as { totalTokens?: number } | undefined
    if (usage?.totalTokens) {
      store.setTokenUsage(usage.totalTokens, sid)
    }
    const stopReason = msg.payload.stopReason as string | undefined
    store.completeStream({ stopReason }, sid)
  }

  function onError(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const errMsg = (msg.payload as { message?: string }).message ?? 'Unknown error'
    store.abortStream(sid, errMsg)
  }

  function onContextUpdate(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const p = msg.payload as { usagePercent: number; inputTokens: number; contextLimit: number }
    store.updateContextInfo(p.usagePercent, p.inputTokens, p.contextLimit, sid)
  }

  function onStatus(_msg: ServerMessage) {
    void _msg
  }

  function onExtensionError(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const payload = msg.payload as unknown as ExtensionErrorPayload
    const title = `Extension: ${payload.extensionName}`
    const description = payload.error ?? 'Unknown extension error'
    store.addMessage({
      ...createSystemNotification('alert', title, description),
      content: description,
      status: 'error',
    }, sid)
  }

  function onToolCallUpdate(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const payload = msg.payload as unknown as ToolCallUpdatePayload
    const streaming = store.getSessionState(sid).streamingMessage
    if (streaming?.toolCalls) {
      const calls = streaming.toolCalls.map((tc) =>
        tc.id === payload.toolCallId
          ? { ...tc, ...(payload.progress !== undefined && { progress: payload.progress }), ...(payload.detail !== undefined && { detail: payload.detail }) }
          : tc,
      )
      store.setStreaming({ ...streaming, toolCalls: calls }, sid)
    }
  }

  // ── TUI Bridge Phase 0 handlers (FR-8, FR-9) ─────────────────

  /** extension:setEditorText → set pending editor text on the session */
  function onSetEditorText(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const text = (msg.payload as { text?: string }).text
    store.setPendingEditorText(text, sid)
  }

  /**
   * message.bashExecution → add a system notification summarizing the
   * bash command and its output. Matches the pattern used by
   * onExtensionError (alert + system role).
   */
  function onBashExecution(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const p = msg.payload as { command?: string; output?: string; exitCode?: number }
    const title = p.command ? `Bash: ${p.command}` : 'Bash execution'
    const description = p.output ?? (p.exitCode !== undefined ? `Exit code: ${p.exitCode}` : undefined)
    store.addMessage(createSystemNotification('info', title, description), sid)
  }

  /** message.compactionSummary → add a system notification */
  function onCompactionSummary(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const p = msg.payload as { summary?: string; tokensBefore?: number; tokensAfter?: number }
    const description = p.summary ?? (p.tokensBefore !== undefined
      ? `Context reduced from ${p.tokensBefore} to ${p.tokensAfter ?? '?'} tokens`
      : undefined)
    store.addMessage(createSystemNotification('info', 'Compaction', description), sid)
  }

  /** message.branchSummary → add a system notification */
  function onBranchSummary(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const p = msg.payload as { branch?: string; summary?: string }
    const title = p.branch ? `Branch: ${p.branch}` : 'Branch summary'
    store.addMessage(createSystemNotification('info', title, p.summary), sid)
  }

  /** message.auto_retry_start → set active AutoRetryState */
  function onAutoRetryStart(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const p = msg.payload as {
      attempt?: number
      maxAttempts?: number
      delayMs?: number
      errorMessage?: string
    }
    store.setAutoRetryState({
      active: true,
      attempt: p.attempt ?? 0,
      maxAttempts: p.maxAttempts ?? 0,
      delayMs: p.delayMs ?? 0,
      errorMessage: p.errorMessage,
    }, sid)
  }

  /** message.auto_retry_end → clear AutoRetryState */
  function onAutoRetryEnd(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    store.setAutoRetryState(undefined, sid)
  }

  /** message.queue_update → set QueueState */
  function onQueueUpdate(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const p = msg.payload as { steering?: string[]; followUp?: string[] }
    store.setQueueState({
      steering: p.steering ?? [],
      followUp: p.followUp ?? [],
    }, sid)
  }

  /**
   * session.renamed → update the matching session's `label` field in
   * the SessionStore. The server sends `payload.name`; the renderer
   * stores it as `label` (the canonical UI display name).
   * Iterates the `sessions` array to find the matching sessionId;
   * no-op if not found.
   */
  function onSessionRenamed(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const name = (msg.payload as { name?: string }).name
    if (name === undefined) return
    sessionStore.renameSession(sid, name)
  }

  /** session.thinkingLevelSet → set thinking level on the session */
  function onThinkingLevelSet(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const level = (msg.payload as { level?: string }).level
    store.setThinkingLevel(level, sid)
  }

  /**
   * extension:setTitle → call window.electronAPI.setTitle. Uses
   * optional chaining to tolerate missing API (browser/dev mode).
   */
  function onExtensionSetTitle(msg: ServerMessage) {
    const title = (msg.payload as { title?: string }).title
    if (title === undefined) return
    window.electronAPI?.setTitle(title)
  }

  /** message.stream_error → add an alert system notification */
  function onStreamError(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const content = (msg.payload as { content?: string }).content ?? 'Stream error'
    store.addMessage(createSystemNotification('alert', content), sid)
  }

  return new Map<ServerMessageType, (msg: ServerMessage) => void>([
    ['message.message_start', onMessageStart],
    ['message.text_delta', onTextDelta],
    ['message.thinking_start', onThinkingStart],
    ['message.thinking_delta', onThinkingDelta],
    ['message.thinking_end', onThinkingEnd],
    ['message.tool_call_start', onToolCallStart],
    ['message.tool_call_end', onToolCallEnd],
    ['message.tool_call_update', onToolCallUpdate],
    ['message.complete', onComplete],
    ['message.error', onError],
    ['extension.error', onExtensionError],
    ['context.update', onContextUpdate],
    ['message.status', onStatus],
    ['extension:setEditorText', onSetEditorText],
    ['message.bashExecution', onBashExecution],
    ['message.compactionSummary', onCompactionSummary],
    ['message.branchSummary', onBranchSummary],
    ['message.auto_retry_start', onAutoRetryStart],
    ['message.auto_retry_end', onAutoRetryEnd],
    ['message.queue_update', onQueueUpdate],
    ['session.renamed', onSessionRenamed],
    ['session.thinkingLevelSet', onThinkingLevelSet],
    ['extension:setTitle', onExtensionSetTitle],
    ['message.stream_error', onStreamError],
  ])
}

// Module-level variable: holds the map of (event type → handler) created by createGlobalHandlers().
// Declared before createGlobalHandlers for readability — the function references this variable,
// but since registerGlobalListeners is called via queueMicrotask, the declaration is hoisted.
let globalEventMap: Map<ServerMessageType, (msg: ServerMessage) => void> | null = null

function registerGlobalListeners() {
  if (globalEventMap) return // 已注册
  globalEventMap = createGlobalHandlers()
  for (const [evt, handler] of globalEventMap) {
    on(evt, handler)
  }
}

// unregisterGlobalListeners: removed — listeners registered at module load, never unregistered

// ── useChat composable ─────────────────────────────────────────────

/**
 * Chat composable bound to a specific session.
 *
 * 事件处理已全局化（从消息 payload 提取 sessionId 路由到 ChatStore 分区）。
 * useChat 现在只提供操作接口（sendMessage / abort）。
 *
 * @param sessionId - Ref to the session ID this chat view is bound to.
 *   If omitted, defaults to using `sessionStore.currentSessionId`
 *   (backward compatibility).
 */
export function useChat(sessionId?: Ref<string>) {
  const store = useChatStore()
  const sessionStore = useSessionStore()

  /** Resolve the active session ID: explicit param > store current > null */
  function resolveSessionId(): string | null {
    if (sessionId) return unref(sessionId)
    return sessionStore.currentSessionId
  }

  function sendMessage(content: string, subagent?: { agent: string; task: string }) {
    const sid = resolveSessionId()
    if (!sid) {
      console.warn('[useChat] sendMessage skipped: no sessionId')
      return
    }
    store.setGenerating(true, sid)
    store.setError(null, sid)
    const payload = { sessionId: sid, content, ...(subagent && { subagent }) }
    send({ type: 'message.send', payload })
  }

  function abort() {
    const sid = resolveSessionId()
    if (!sid) return
    send({ type: 'message.abort', payload: { sessionId: sid } })
    // 立即完成当前流，不等后端确认
    store.completeStream({ stopReason: 'aborted' }, sid)
    // 插入系统消息提示用户操作已终止
    store.addMessage({
      ...createSystemNotification('info', '操作已被用户终止'),
      content: '操作已被用户终止',
      status: 'complete',
    }, sid)
  }

  return { sendMessage, abort }
}

// 模块级注册：延后到 Pinia 安装后执行。
// import 阶段 App.vue → useChat.ts → createGlobalHandlers → useChatStore() 需要 Pinia。
// 测试环境中 Pinia 可能未安装，通过 getActivePinia 安全检测后延迟注册。
let registerAttempted = false
function safeRegisterGlobalListeners() {
  if (globalEventMap || registerAttempted) return
  registerAttempted = true
  if (!getActivePinia()) {
    console.warn('[useChat] Pinia not active, global listeners deferred')
    return
  }
  registerGlobalListeners()
}
queueMicrotask(safeRegisterGlobalListeners)

/**
 * @internal — testing helper. Triggers global handler registration against
 * the currently active Pinia. Idempotent at the event-bus level (the
 * mocked `on` overwrites the previous handler for each event).
 *
 * Production code does not call this; it relies on the auto-registration
 * scheduled above. Tests call this from beforeEach to ensure registration
 * occurs even when the microtask fires before Pinia is set up, and to
 * re-create handlers per test against fresh Pinia + mock stores.
 */
export function __test_registerGlobalHandlers(): void {
  if (!getActivePinia()) return
  // Cleanup old handlers before re-registering
  if (globalEventMap) {
    for (const [evt, handler] of globalEventMap) {
      off(evt, handler)
    }
  }
  globalEventMap = createGlobalHandlers()
  for (const [evt, handler] of globalEventMap) {
    on(evt, handler)
  }
}
