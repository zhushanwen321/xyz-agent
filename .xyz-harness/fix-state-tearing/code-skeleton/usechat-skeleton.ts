/**
 * code-skeleton: composables/features/useChat.ts —— B 策略编排 + pendingSend 迁移（#5）
 *
 * 对应 packages/renderer/src/composables/features/useChat.ts 改动：
 * - send 入口 isActive(sid) → 自动转 steer（D-001 B 策略）
 * - send/editAndResend 用 addPendingSend/clearPendingSend 替代 setDispatching
 * - abort 乐观 clearPendingSend（D-008，实体靠 runtime 广播兜底）
 * - ensureStreamSubscription 加 send.rejected 监听分支（回滚 pending + toast）
 *
 * 接线层级：
 * - 跨模块 port：chat store（addPendingSend/clearPendingSend/isActive/finalizeSession）
 * - adapter 真引 SDK：chatApi.send/steer/abort/streamSubscribe（验签 transport 层方法存在）
 * - 模块内直调：send busy 分支真接 steer；abort 真接 clearPendingSend
 *
 * 骨架密度（Level 1）：send/abort/editAndResend 真接线 store 方法 + adapter；
 * 监听分支真接 clearPendingSend + toast。
 */
import { chat as chatApi } from '@/api'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useToast } from '@/composables/useToast'
import type { ServerMessage } from '@xyz-agent/shared'

// 会话级流式订阅表（sessionId → 取消函数）—— 保持现有实现
const streamSubscriptions = new Map<string, () => void>()

/**
 * 确保指定 session 已订阅流式事件（幂等）。
 *
 * [改造] callback 新增 send.rejected 分支（#5 AC-5.3）：
 *   收到 → clearPendingSend(sid) + toast，isGenerating 不变。
 *   send.rejected 经 routeInbound dispatchSession 路由（payload.sessionId 必填）。
 */
function ensureStreamSubscription(
  sid: string,
  chat: ReturnType<typeof useChatStore>,
  sessionStore: ReturnType<typeof useSessionStore>,
): void {
  if (streamSubscriptions.has(sid)) return
  const unsub = chatApi.streamSubscribe(sid, (msg: ServerMessage) => {
    // [接线] send.rejected 防御性反馈通道（D-006 独立类型，不进对话流）
    if (msg.type === 'send.rejected') {
      const payload = msg.payload as { sessionId: string; reason: string; message: string }
      // [接线] 真接 chat.clearPendingSend + useToast（adapter）
      chat.clearPendingSend(sid)
      useToast().error(payload.message ?? 'Agent 正在处理')
      return
    }
    // message.* → 单一入口（effects 注册表）
    if (msg.type.startsWith('message.')) {
      chat.applyMessageEvent(sid, msg)
      return
    }
    // session.* → 跨 store 协调（保持现有 switch，骨架省略）
    void sessionStore
  })
  streamSubscriptions.set(sid, unsub)
}

export function useChat() {
  const chat = useChatStore()
  const session = useSessionStore()

  /**
   * 发送消息（B 策略 D-001：busy 时自动转 steer）。
   *
   * 流程：isActive(sid)?
   *   true  → 路由 steer(text)（追加上下文，不打断当前回合）
   *   false → appendUser + addPendingSend + chatApi.send（adapter）
   *           catch → clearPendingSend + throw（Composer 恢复草稿）
   *
   * pendingSend 接管 dispatching 空窗期（ack→message_start）。
   */
  async function send(text: string): Promise<void> {
    const sid = session.activeId
    if (!sid) return
    const trimmed = text.trim()
    if (!trimmed) return

    // [接线] B 策略路由：isActive → steer（D-001）
    if (chat.isActive(sid)) {
      await steer(trimmed) // 真接模块内 steer
      return
    }

    chat.appendUser(sid, trimmed)
    ensureStreamSubscription(sid, chat, session)
    // [接线] 真接 chat.addPendingSend（跨模块 port）
    chat.addPendingSend(sid)
    try {
      // [adapter] 真引 chatApi.send（验签 transport 层）
      await chatApi.send(sid, trimmed)
    } catch (e) {
      // [接线] 真接 chat.clearPendingSend
      chat.clearPendingSend(sid)
      throw e
    }
  }

  /**
   * 追加 steer（busy 时补充上下文，入 steering 队列）。
   * pending 气泡（S7）；API 失败回滚 pending + toast（不 throw）。
   */
  async function steer(text: string): Promise<void> {
    const sid = session.activeId
    if (!sid) return
    const trimmed = text.trim()
    if (!trimmed || !chat.isActive(sid)) return

    chat.appendPending(sid, trimmed, 'steer')
    try {
      // [adapter] 真引 chatApi.steer
      await chatApi.steer(sid, trimmed)
    } catch (e) {
      chat.removePending(sid, trimmed, 'steer')
      const msg = e instanceof Error ? e.message : String(e)
      useToast().error(`补充消息发送失败：${msg}`)
    }
  }

  /**
   * 中断当前回合（D-008：乐观清 pendingSend + 实体靠 runtime 广播兜底）。
   *
   * abort 语义 = 结束活跃态。前端乐观 clearPendingSend（即便 pi 没真正停也无害）。
   * 实体收口：runtime message-dispatcher.abort 成功后广播 message.complete{stopReason:'aborted'}
   *   → effects finalizeSession('aborted')（保持现行 complete 语义，非 error）。
   * abort RPC 失败：toast 反馈，pendingSend 已清，实体残留靠 runtime 重启/WS 断连兜底。
   */
  async function abort(): Promise<void> {
    const sid = session.activeId
    if (!sid) return
    // [接线] 乐观清 pendingSend（D-008）
    chat.clearPendingSend(sid)
    try {
      // [adapter] 真引 chatApi.abort
      await chatApi.abort(sid)
    } catch (e) {
      // abort 失败不重抛——用户已表达停止意图。toast 反馈（非静默吞）。
      const msg = e instanceof Error ? e.message : String(e)
      useToast().error(`停止失败：${msg}`)
    }
  }

  /**
   * 编辑重发（原地替换，BC-5 行为等价）：truncate → appendUser → send（pendingSend 对称）。
   * 显式 sessionId（编辑可发生在非 active 的 standby panel）。
   */
  async function editAndResend(sessionId: string, userMessageId: string, text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || chat.isActive(sessionId)) return
    chat.truncateFrom(sessionId, userMessageId, true)
    chat.appendUser(sessionId, trimmed)
    ensureStreamSubscription(sessionId, chat, session)
    // [接线] 真接 chat.addPendingSend（与 send 对称）
    chat.addPendingSend(sessionId)
    try {
      // [adapter] 真引 chatApi.send
      await chatApi.send(sessionId, trimmed)
    } catch (e) {
      // [接线] 真接 chat.clearPendingSend
      chat.clearPendingSend(sessionId)
      throw e
    }
  }

  return { send, steer, abort, editAndResend, /* compact/hydrateHistory 保持不变 */ }
}

// 验证：send busy 分支真接 steer（tsc 实证 isActive→steer 调用链）
// 验证：send/editAndResend 真接 addPendingSend/clearPendingSend（跨模块 port 签名匹配）
// 验证：abort 乐观清真接 clearPendingSend
// 验证：ensureStreamSubscription send.rejected 分支真接 clearPendingSend + useToast
// 验证：adapter chatApi.send/steer/abort/streamSubscribe 真引（transport 层方法存在性 + 签名）
