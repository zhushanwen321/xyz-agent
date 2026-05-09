import { useChatStore } from '../stores/chat'
import { useSessionStore } from '../stores/session'
import { send } from '../lib/ws-client'
import { on, off } from '../lib/event-bus'
import { onMounted, onUnmounted } from 'vue'
import type { ServerMessage, ToolCall } from '@xyz-agent/shared'

// Module-level guard: prevent duplicate event listeners when multiple
// ChatView instances mount (e.g. split mode)
let listenerRefCount = 0

export function useChat() {
  const store = useChatStore()
  const sessionStore = useSessionStore()

  // --- Outbound helpers ---------------------------------------------------

  function sendMessage(content: string) {
    const sid = sessionStore.currentSessionId
    if (!sid) {
      console.warn('[useChat] sendMessage skipped: no currentSessionId')
      return
    }
    console.log('[useChat] sendMessage:', { sessionId: sid, contentLength: content.length })
    store.setGenerating(true)
    store.setError(null)
    send({ type: 'message.send', payload: { sessionId: sid, content } })
  }

  function abort() {
    const sid = sessionStore.currentSessionId
    if (!sid) return
    send({ type: 'message.abort', payload: { sessionId: sid } })
  }

  // --- Inbound event handlers --------------------------------------------

  function onTextDelta(msg: ServerMessage) {
    if (!isForCurrentSession(msg)) return
    ensureStreamingMessage()
    store.appendToStreaming(msg.payload.delta as string)
  }

  function onThinkingDelta(msg: ServerMessage) {
    if (!isForCurrentSession(msg)) return
    ensureStreamingMessage()
    const streaming = store.streamingMessage
    if (streaming) {
      const existing = streaming.thinking ?? []
      const last = existing[existing.length - 1]
      if (last && !last.collapsed) {
        // Append to the current thinking block
        last.content += msg.payload.delta as string
        store.setStreaming({ ...streaming, thinking: [...existing] })
      } else {
        // Start a new thinking block
        store.setStreaming({
          ...streaming,
          thinking: [...existing, { id: `thk-${Date.now()}`, content: msg.payload.delta as string, collapsed: false }],
        })
      }
    }
  }

  function onToolCallStart(msg: ServerMessage) {
    if (!isForCurrentSession(msg)) return
    ensureStreamingMessage()
    const streaming = store.streamingMessage
    if (streaming) {
      const tc: ToolCall = {
        id: msg.payload.toolCallId as string,
        toolName: msg.payload.toolName as string,
        input: msg.payload.input,
        status: 'running',
        startTime: Date.now(),
      }
      const calls = [...(streaming.toolCalls ?? []), tc]
      store.setStreaming({ ...streaming, toolCalls: calls })
    }
  }

  function onToolCallEnd(msg: ServerMessage) {
    if (!isForCurrentSession(msg)) return
    const streaming = store.streamingMessage
    if (streaming?.toolCalls) {
      const calls = streaming.toolCalls.map((tc) =>
        tc.id === (msg.payload.toolCallId as string)
          ? { ...tc, output: msg.payload.output as string | undefined, status: 'completed' as const, endTime: Date.now() }
          : tc,
      )
      store.setStreaming({ ...streaming, toolCalls: calls })
    }
  }

  function onMessageStart(msg: ServerMessage) {
    if (!isForCurrentSession(msg)) return
    // Finalize the current streaming bubble as its own message
    if (store.streamingMessage) {
      store.completeStreaming({ keepGenerating: true })
    }
  }

  function onComplete(msg: ServerMessage) {
    if (!isForCurrentSession(msg)) return
    console.log('[useChat] message.complete:', msg.payload)
    store.completeStreaming()
  }

  function onError(msg: ServerMessage) {
    if (!isForCurrentSession(msg)) return
    const errMsg = (msg.payload as { message?: string }).message ?? 'Unknown error'
    console.error('[useChat] message.error:', errMsg)
    store.setGenerating(false)
    store.setStreaming(null)
    store.setError(null)
    store.addMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: `**Error:** ${errMsg}`,
      status: 'error' as const,
      timestamp: Date.now(),
    })
  }

  function onContextUpdate(msg: ServerMessage) {
    if (!isForCurrentSession(msg)) return
    const p = msg.payload as { usagePercent: number; inputTokens: number; contextLimit: number }
    store.updateContextInfo(p.usagePercent, p.inputTokens, p.contextLimit)
  }

  function onStatus(msg: ServerMessage) {
    const p = msg.payload as { status: string }
    console.log('[chat] status:', p.status)
  }

  // --- Session-aware helpers -----------------------------------------------

  /** Check if a server message belongs to the currently active session. */
  function isForCurrentSession(msg: ServerMessage): boolean {
    const sid = sessionStore.currentSessionId
    // If payload carries a sessionId, gate on it; otherwise let it through.
    if (msg.payload?.sessionId && sid) {
      return msg.payload.sessionId === sid
    }
    return true
  }

  /** Create the streaming message placeholder if it doesn't exist yet. */
  function ensureStreamingMessage() {
    if (!store.streamingMessage) {
      store.setStreaming({
        id: 'streaming',
        role: 'assistant',
        content: '',
        status: 'streaming',
        timestamp: Date.now(),
      })
    }
  }

  // --- Lifecycle -----------------------------------------------------------

  const eventMap: Record<string, (msg: ServerMessage) => void> = {
    'message.message_start': onMessageStart,
    'message.text_delta': onTextDelta,
    'message.thinking_delta': onThinkingDelta,
    'message.tool_call_start': onToolCallStart,
    'message.tool_call_end': onToolCallEnd,
    'message.complete': onComplete,
    'message.error': onError,
    'context.update': onContextUpdate,
    'message.status': onStatus,
  }

  onMounted(() => {
    if (listenerRefCount === 0) {
      for (const [evt, handler] of Object.entries(eventMap)) {
        on(evt, handler)
      }
    }
    listenerRefCount++
  })

  onUnmounted(() => {
    listenerRefCount--
    if (listenerRefCount === 0) {
      for (const [evt, handler] of Object.entries(eventMap)) {
        off(evt, handler)
      }
    }
  })

  return { sendMessage, abort, messages: store.completedMessages }
}
