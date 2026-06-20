/**
 * useChat —— chat 业务编排（R2 features 层，唯一跨 api + stores 的层）。
 *
 * 数据流链（plan-frontend §3 UC-2）：
 *   Composer → useChat.send → store.appendUser + api.chat.send
 *            → api.transport.send(ws) → mock 回流 ServerMessage
 *            → api.events.streamSubscribe → store.appendAssistantChunk
 *            → MessageStream 响应式渲染 + useChatScroll.scrollToBottom
 *
 * hydrate：首次进入 session 调 api.chat.getHistory 注入历史 fixture（含 tool_call/summary），
 * 让 UC-2 切换会话可见块类型丰富度（G2-006）。
 *
 * abort：调 api.chat.abort（方法存在，中断流转 DEFERRED G-025）。
 */
import { chat as chatApi } from '@/api'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'

export function useChat() {
  const chat = useChatStore()
  const session = useSessionStore()

  /**
   * 发送消息：appendUser → (S5 sending 窗口) → api.send + streamSubscribe
   *          → 首个 chunk 到达才 setStreaming(true)（S6 streaming）→ appendAssistantChunk。
   * streamSubscribe 的 handler 在 api 层已按 sessionId 路由（events.on 第二层隔离）。
   *
   * S5 窗口（spec §composer）：不立即 setStreaming(true)，等首个 assistant chunk 才转 S6，
   * 让 composer 发送位 spinner 在请求发出→流式开始之间可见。
   */
  async function send(text: string): Promise<void> {
    const sid = session.activeId
    if (!sid) return
    const trimmed = text.trim()
    if (!trimmed || chat.isStreaming) return

    chat.appendUser(sid, trimmed)

    let streamingStarted = false
    const unsub = chatApi.streamSubscribe(sid, (msg) => {
      if (!streamingStarted) {
        streamingStarted = true
        chat.setStreaming(true)
      }
      chat.appendAssistantChunk(sid, msg)
    })

    try {
      await chatApi.send(sid, trimmed)
    } finally {
      unsub()
      chat.setStreaming(false)
    }
  }

  /** 中断当前回合（G-025 流转 DEFERRED：方法存在，实际中断留联调） */
  async function abort(): Promise<void> {
    const sid = session.activeId
    if (!sid) return
    await chatApi.abort(sid)
  }

  /**
   * 拉取并注入历史（首次进入 session）。
   * 无历史（空 session）也标记 hydrated，避免反复请求。
   */
  async function hydrateHistory(sessionId: string): Promise<void> {
    if (chat.isHydrated(sessionId)) return
    const history = await chatApi.getHistory(sessionId)
    chat.hydrate(sessionId, history)
  }

  return { send, abort, hydrateHistory }
}
