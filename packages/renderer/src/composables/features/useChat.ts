/**
 * useChat —— chat 业务编排（R2 features 层，唯一跨 api + stores 的层）。
 *
 * 数据流链（plan-frontend §3 UC-2）：
 *   Composer → useChat.send → store.appendUser + api.chat.send
 *            → api.transport.send(ws) → mock 回流 ServerMessage
 *            → api.events.streamSubscribe → store.applyMessageEvent（message.* 单一入口）
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
import { useToast } from '@/composables/useToast'

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
  sessionStore: ReturnType<typeof useSessionStore>,
): void {
  if (streamSubscriptions.has(sid)) return
  const unsub = chatApi.streamSubscribe(sid, (msg) => {
    // message.* → 单一入口（F2 重构：消除 double-dispatch）。
    // applyMessageEvent 内部经 effect 注册表执行该 type 的全部副作用（chunk 状态更新
    // + setStreaming flag），useChat 不再自己 switch message.*。message.* 处理完即 return，
    // 下方 session.* 分支仅处理跨 store 事件（compacting/renamed 等）。
    if (msg.type.startsWith('message.')) {
      chat.applyMessageEvent(sid, msg)
      return
    }
    // session.* → 跨 store 协调（sessionStore.updateLabel/updateSessionState/setCompacting），
    // 保留在 useChat（stores 间禁止互相 import）。
    switch (msg.type) {
      case 'session.compacting':
        // #6：compact 生命周期开始（runtime server-push，走 session 通道）
        chat.setCompacting(sid, true)
        break
      case 'session.compacted':
        // #6：compact 生命周期结束（成功/失败均广播）。错误反馈走 compact() 的 catch，此处仅复位态。
        chat.setCompacting(sid, false)
        break
      case 'session.renamed': {
        // pi 改写 session 名（session_info_changed → session.renamed，见 event-adapter.ts）。
        // guard：payload.name 为空时跳过 —— 防 pi 推空名/旧名覆盖用户手动 rename 的值。
        const payload = msg.payload as { sessionId?: string; name?: string }
        if (payload.sessionId && payload.name) {
          sessionStore.updateLabel(payload.sessionId, payload.name)
        }
        break
      }
      case 'session.state_changed': {
        // 模型切换后 runtime 推送（model-service switchModel 末尾广播，含新 modelId/thinkingLevel
        // + 按新 contextWindow 重算的用量）。局部更新 session 状态，不触发整表 setGroups。
        // thinkingLevel optional：未设置时（undefined）不更新，保留旧值。
        const p = msg.payload as { sessionId?: string; modelId?: string; thinkingLevel?: string }
        if (p.sessionId) {
          sessionStore.updateSessionState(p.sessionId, {
            ...(p.modelId !== undefined && { modelId: p.modelId }),
            ...(p.thinkingLevel !== undefined && { thinkingLevel: p.thinkingLevel }),
          })
        }
        break
      }
      case 'session.thinkingLevelSet': {
        // pi 切模型 / 用户手切档位后推 thinking_level_changed（runtime event-adapter 转为此类型）。
        // 补 state_changed 的时序缺口：switchModel 的 broadcastSessionState 在 set_model RPC resolve 后
        // 立即广播，而 thinking_level_changed 事件可能晚到（异步），此时 state_changed 的 thinkingLevel 为空。
        // 本 handler 独立更新 thinkingLevel，不依赖两条消息的先后顺序。
        const p = msg.payload as { sessionId?: string; level?: string }
        if (p.sessionId && p.level) {
          sessionStore.updateSessionState(p.sessionId, { thinkingLevel: p.level })
        }
        break
      }
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
   *
   * dispatching 态在 send 前置位（填 isStreaming 空窗期，让 Composer 停止按钮/steer 立即可用），
   * message_start 到达时 setStreaming 自动清；失败也清（catch）。
   */
  async function send(text: string): Promise<void> {
    const sid = session.activeId
    if (!sid) return
    const trimmed = text.trim()
    if (!trimmed || chat.isActive(sid)) return

    chat.appendUser(sid, trimmed)
    ensureStreamSubscription(sid, chat, session)
    chat.setDispatching(sid)
    try {
      await chatApi.send(sid, trimmed)
    } catch (e) {
      chat.setDispatching(null)
      throw e
    }
  }

  /**
   * 追加 steer：AI 执行中（isStreaming）时，把补充消息排入 steering 队列，
   * 当前回合工具调用结束后、下次 LLM 调用前投递，不打断当前回合。
   */
  async function steer(text: string): Promise<void> {
    const sid = session.activeId
    if (!sid) return
    const trimmed = text.trim()
    if (!trimmed || !chat.isActive(sid)) return

    // pending 气泡（S7）：steer 发出后立即入流，投递时（queue_update 移除）转 complete。
    // [W1] API 失败（WS 断连/steer_failed envelope/hook 拦截）回滚 pending + toast 提示，
    // 不 throw（错误已消化：pending 已回滚 + 用户已得反馈；throw 只会变 unhandled rejection）。
    chat.appendPending(sid, trimmed, 'steer')
    try {
      await chatApi.steer(sid, trimmed)
    } catch (e) {
      chat.removePending(sid, trimmed, 'steer')
      const msg = e instanceof Error ? e.message : String(e)
      const { error } = useToast()
      error(`补充消息发送失败：${msg}`)
    }
  }

  /**
   * 追加 follow-up：把消息排入 followUp 队列，当前回合结束后另起一轮处理。
   * 非执行中按普通发送处理（避免 Alt+⏎ 死键）。
   */
  async function followUp(text: string): Promise<void> {
    const sid = session.activeId
    if (!sid) return
    const trimmed = text.trim()
    if (!trimmed) return

    // 非活跃（含空窗期）退化为普通发送，避免 Alt+⏎ 死键
    if (!chat.isActive(sid)) {
      await send(trimmed)
      return
    }

    // pending 气泡（S7）：followUp 发出后立即入流，投递时（queue_update 移除）转 complete。
    // [W1] API 失败回滚 pending + toast 提示（同 steer，不 throw）。
    chat.appendPending(sid, trimmed, 'follow-up')
    try {
      await chatApi.followUp(sid, trimmed)
    } catch (e) {
      chat.removePending(sid, trimmed, 'follow-up')
      const msg = e instanceof Error ? e.message : String(e)
      const { error } = useToast()
      error(`下轮消息发送失败：${msg}`)
    }
  }

  /**
   * 中断当前回合（G-025 流转 DEFERRED：方法存在，实际中断留联调）。
   * [W3/W4] abort 乐观清 dispatching——abort 语义就是「结束当前活跃态」，即便 pi 没真正停也无害。
   * 正常成功路径由 MessageDispatcher.abort 广播的 message.complete 驱动 setStreaming(false) 收口；
   * 失败路径（pi 死/getClientOrThrow 抛 handler_error → abort reject）若无此 catch，dispatching 永挂。
   */
  async function abort(): Promise<void> {
    const sid = session.activeId
    if (!sid) return
    chat.setDispatching(null)
    try {
      await chatApi.abort(sid)
    } catch (e) {
      // abort 失败不重抛——用户已表达「停止」意图，UI 不应因 abort RPC 失败而卡住。
      // dispatching 已清（乐观），streaming 态若残留由后续 message.complete 兜底。
      // 给用户 toast 反馈（而非静默吞掉），满足 taste/no-silent-catch 的"反馈"要求。
      const msg = e instanceof Error ? e.message : String(e)
      const { error } = useToast()
      error(`停止失败：${msg}`)
    }
  }

  /**
   * 压缩上下文（#6）：确保会话级订阅（消费 session.compacting/compacted）→ 调 api.compact。
   *
   * 错误反馈（§4.4 异常路径）：session 不存在 / pi 错误 → sendError（pending reject）→
   * 在此 catch，以 toast 提示用户，不卡 UI（toast 非顶部 banner，不违反规则 #3）。compacting 态
   * 由 session.compacted 广播复位（broadcast 必达：compacting 后无论成败都广播 compacted）。
   */
  async function compact(customInstructions?: string): Promise<void> {
    const sid = session.activeId
    if (!sid) return
    ensureStreamSubscription(sid, chat, session)
    try {
      await chatApi.compact(sid, customInstructions)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const { error } = useToast()
      error(`压缩失败：${msg}`)
    }
  }

  /**
   * 编辑 user 消息并重新发送（原地替换语义，非 fork）：
   * 截断该 user 消息（含）及其后所有 → appendUser 新文本 → 走 send 流式。
   *
   * 与 fork 的区别：fork 复制到新 session 保留原 session；editAndResend 在当前 session
   * 原地替换（删旧 user + 其后 assistant，重新发送）。UI 层用 canEdit 守卫仅最后一条 user 可编辑，
   * 避免删除中间 user 导致其后对话丢失。
   *
   * 显式接收 sessionId：编辑可发生在非 active 的 standby panel，不能依赖全局 activeId。
   */
  async function editAndResend(sessionId: string, userMessageId: string, text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || chat.isActive(sessionId)) return
    chat.truncateFrom(sessionId, userMessageId, true)
    chat.appendUser(sessionId, trimmed)
    ensureStreamSubscription(sessionId, chat, session)
    chat.setDispatching(sessionId)
    try {
      await chatApi.send(sessionId, trimmed)
    } catch (e) {
      chat.setDispatching(null)
      throw e
    }
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

  return { send, steer, followUp, abort, compact, editAndResend, hydrateHistory }
}
