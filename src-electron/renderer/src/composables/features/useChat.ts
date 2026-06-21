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

/**
 * 会话级流式订阅表（sessionId → 取消函数）。
 *
 * [HISTORICAL] 为什么不能 per-send 订阅：
 *   原 send() 在 `await chatApi.send()` resolve 后于 finally 里 unsub。但服务端 message.send
 *   在 pi ack（prompt 已接收，非生成完成）即回 message.status{sent}，rpc-client.prompt()
 *   明确「resolves when pi acknowledges receipt (not when generation completes)」。
 *   故 finally 在首个 chunk 到达前就拆订阅 → 流式事件全丢。
 *   改为会话级长订阅：首次 send 时订阅一次，由 message_start/complete/error 驱动 streaming 状态，
 *   不在 ack 时拆订阅。
 */
const streamSubscriptions = new Map<string, () => void>()

/** 确保指定 session 已订阅流式事件（幂等：已订阅则 no-op）。 */
function ensureStreamSubscription(
  sid: string,
  chat: ReturnType<typeof useChatStore>,
): void {
  if (streamSubscriptions.has(sid)) return
  const unsub = chatApi.streamSubscribe(sid, (msg) => {
    chat.appendAssistantChunk(sid, msg)
    // 流式状态由事件驱动，不随 send() ack 翻转
    switch (msg.type) {
      case 'message.message_start':
        chat.setStreaming(true)
        break
      case 'message.complete':
      case 'message.error':
      case 'message.stream_error':
        // stream_error 也属终态：若 pi 发了 message_update{error} 后不再发 agent_end，
        // 必须在此复位 isStreaming，否则 UI 卡在「思考中」（规则 #3/#7 防护的失败模式）。
        chat.setStreaming(false)
        break
      default:
        break
    }
  })
  streamSubscriptions.set(sid, unsub)
}

export function useChat() {
  const chat = useChatStore()
  const session = useSessionStore()

  /**
   * 发送消息：appendUser → 确保会话级订阅 → api.send（ack 仅表示 pi 已接收）。
   *
   * 流式状态由会话级订阅的事件驱动（message_start→true，complete/error→false），
   * 不依赖 send() 的 resolve 时机——避免 ack 早于首个 chunk 导致订阅被提前拆除。
   */
  async function send(text: string): Promise<void> {
    const sid = session.activeId
    if (!sid) return
    const trimmed = text.trim()
    if (!trimmed || chat.isStreaming) return

    chat.appendUser(sid, trimmed)
    ensureStreamSubscription(sid, chat)

    await chatApi.send(sid, trimmed)
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
