import { useChatStore } from '../stores/chat'
import { useSessionStore } from '../stores/session'
import { send } from '../lib/ws-client'
import { on, off } from '../lib/event-bus'
import { onMounted, onUnmounted, type Ref, unref, getCurrentInstance } from 'vue'
import type { ServerMessage, ToolCall } from '@xyz-agent/shared'

const RADIX_36 = 36
const SUBSTRING_START = 2
const SUBSTRING_END = 6

/**
 * 全局事件处理器注册状态。
 * 事件处理器从消息 payload 中提取 sessionId，路由到正确的 ChatStore 分区。
 * 不再绑定到特定 useChat 实例的闭包。
 */
let globalListenerRefCount = 0

// ── 全局事件处理器 ────────────────────────────────────────────────

function createGlobalHandlers() {
  const store = useChatStore()

  function getSid(msg: ServerMessage): string | null {
    return (msg.payload?.sessionId as string) ?? null
  }

  function ensureStreamingMessage(sid: string) {
    const session = store.getSessionState(sid)
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
    store.appendToStreaming(msg.payload.delta as string, sid)
  }

  function onThinkingStart(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    ensureStreamingMessage(sid)
    // 初始化一个空的 thinking block，后续 thinking_delta 会追加内容
    const streaming = store.getSessionState(sid).streamingMessage
    if (streaming) {
      const existing = streaming.thinking ?? []
      // 只在没有活跃的（未折叠的）thinking block 时才创建新的
      const last = existing[existing.length - 1]
      if (!last || last.collapsed) {
        store.setStreaming({
          ...streaming,
          thinking: [...existing, { id: `thk-${Date.now()}`, content: '', collapsed: false }],
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
          thinking: [...existing, { id: `thk-${Date.now()}`, content: msg.payload.delta as string, collapsed: false }],
        }, sid)
      }
    }
  }

  function onThinkingEnd(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const streaming = store.getSessionState(sid).streamingMessage
    if (streaming?.thinking?.length) {
      const updated = streaming.thinking.map((block, i) =>
        i === streaming.thinking!.length - 1 ? { ...block, collapsed: true } : block,
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
      store.setStreaming({ ...streaming, toolCalls: calls }, sid)
    }
  }

  function onToolCallEnd(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const streaming = store.getSessionState(sid).streamingMessage
    if (streaming?.toolCalls) {
      const calls = streaming.toolCalls.map((tc) =>
        tc.id === (msg.payload.toolCallId as string)
          ? { ...tc, output: msg.payload.output as string | undefined, status: 'completed' as const, endTime: Date.now() }
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
    store.completeStreaming(undefined, sid)
  }

  function onError(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const errMsg = (msg.payload as { message?: string }).message ?? 'Unknown error'
    store.setGenerating(false, sid)
    store.setStreaming(null, sid)
    store.setError(null, sid)
    store.addMessage({
      id: crypto.randomUUID(),
      role: 'system',
      content: errMsg,
      status: 'error' as const,
      timestamp: Date.now(),
    }, sid)
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

  return {
    'message.message_start': onMessageStart,
    'message.text_delta': onTextDelta,
    'message.thinking_start': onThinkingStart,
    'message.thinking_delta': onThinkingDelta,
    'message.thinking_end': onThinkingEnd,
    'message.tool_call_start': onToolCallStart,
    'message.tool_call_end': onToolCallEnd,
    'message.complete': onComplete,
    'message.error': onError,
    'context.update': onContextUpdate,
    'message.status': onStatus,
  } as Record<string, (msg: ServerMessage) => void>
}

let globalEventMap: Record<string, (msg: ServerMessage) => void> | null = null

function registerGlobalListeners() {
  if (globalEventMap) return // 已注册
  globalEventMap = createGlobalHandlers()
  for (const [evt, handler] of Object.entries(globalEventMap)) {
    on(evt, handler)
  }
}

function unregisterGlobalListeners() {
  if (!globalEventMap) return
  for (const [evt, handler] of Object.entries(globalEventMap)) {
    off(evt, handler)
  }
  globalEventMap = null
}

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
    const payload: Record<string, unknown> = { sessionId: sid, content }
    if (subagent) {
      payload.subagent = subagent
    }
    send({ type: 'message.send', payload })
  }

  function abort() {
    const sid = resolveSessionId()
    if (!sid) return
    send({ type: 'message.abort', payload: { sessionId: sid } })
    // 立即完成当前流，不等后端确认
    store.completeStreaming(undefined, sid)
    // 插入系统消息提示用户操作已终止
    store.addMessage({
      id: crypto.randomUUID(),
      role: 'system',
      content: '操作已被用户终止',
      status: 'complete',
      timestamp: Date.now(),
    }, sid)
  }

  // 全局事件 listener 生命周期：第一个组件 mounted 时注册，最后一个 unmounted 时注销
  // 使用 getCurrentInstance() 确保只在组件上下文中执行
  if (getCurrentInstance()) {
    onMounted(() => {
      if (globalListenerRefCount === 0) {
        registerGlobalListeners()
      }
      globalListenerRefCount++
    })

    onUnmounted(() => {
      globalListenerRefCount--
      if (globalListenerRefCount === 0) {
        unregisterGlobalListeners()
      }
    })
  }

  return { sendMessage, abort }
}
