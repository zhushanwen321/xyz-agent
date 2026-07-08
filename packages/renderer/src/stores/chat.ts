/**
 * Chat store —— messages（按 sessionId 分区）+ isStreaming。
 *
 * 依赖方向：无（stores 间禁止互相 import）。
 *
 * 响应式策略：messages 是 Map<sessionId, Message[]>，所有变更走「取出 → 新数组 → set」
 * 的不可变更新，确保 Vue 对 Map 的集合响应性可靠触发（避免就地突变 plain 数组元素
 * 不触发响应性的陷阱）。
 *
 * 块类型覆盖（spec §9 G2-006 契约 + draft-message-stream §4 7 类块）：
 * - text（message_start/text_delta/complete）—— 主流式路径
 * - thinking（thinking_start/thinking_delta/thinking_end）—— 折进 trace
 * - tool_call（tool_call_start/tool_call_end）—— 折进 trace，失败整块红框
 * - error（message.error / message.complete stopReason:error）—— 挂最后 assistant 块
 * 历史 fixture（含 summary 收尾 text / 预置 tool_call）由 hydrate 注入，不走流式。
 *
 * FileChanges 通道（flow-2，ADR-0024 + W11 WP-L3-11）：
 * `message.file_changes` 事件由 runtime event-adapter 解析 pi 工具调用后推送
 * （协议类型见 ADR-0024 D7，待 flow-2 实施时加入 ServerMessageType 联合）。
 * 数据流处理骨架见 applyFileChanges()，类型契约已就绪（F2-1），逻辑 DEFERRED。
 */
import { defineStore } from 'pinia'
import { onScopeDispose, ref } from 'vue'
import type {
  Message,
  ServerMessage,
  SteerFollowUpMode,
} from '@xyz-agent/shared'
import { dispatchMessageEvent } from './chat-message-effects'
import { findLastAssistantIndex } from './chat-chunk-processor'
import { createChangeSetController } from './chat-changeset'
export type { RetryState, QueueState } from './chat-store-types'
import type { RetryState, QueueState } from './chat-store-types'

export const useChatStore = defineStore('chat', () => {
  /** 按 sessionId 分区的消息表（UC-2 隔离） */
  const messages = ref<Map<string, Message[]>>(new Map())
  /** 已 hydrate 的 session（避免切换时重复注入历史） */
  const hydrated = ref<Set<string>>(new Set())
  const isStreaming = ref(false)
  /**
   * 当前正在流式生成的 session id（与 isStreaming 同源，per-session 视图）。
   * message_start 记录 sid，终态（complete/error/stream_error）清空。
   * 用途：Panel 渲染守卫需 per-session 判断「本 Panel 的 session 是否在生成」，
   * 不能用全局 isStreaming——否则 A 会话流式时点新建切到空 session，空 session 的
   * Landing 会被全局 isStreaming 误伤（分支走到兜底空态，new-task 渲染撕裂）。
   * 单值足够：双 panel 并发流式目前不可达（G-023 DEFERRED），未来并发可扩展为 Set。
   */
  const streamingSessionId = ref<string | null>(null)
  /**
   * 正在派发 prompt 的 session id（填补 isStreaming 空窗期）。
   *
   * 空窗期根因：pi 的 prompt RPC 在「preflight 成功 / 已接收」即回 success（非「已开始生成」），
   * 前端收到 ack 后 isSending 复位，但 isStreaming 要等 pi 异步 emit message_start 才置位。
   * ack → message_start 之间的空窗里，停止按钮不出现、steer guard 静默丢弃追加消息。
   *
   * dispatchingSessionId 在 sendPrompt 前（useChat.send / submitFirstMessage）置位，
   * message_start 到达（setStreaming(true)）或终态/失败时清空。
   * Composer 的停止按钮和 steer guard 看「合并态」isStreaming || dispatchingSessionId===sid，
   * 使点发送到流式开始之间也能停止/追加。单值，与 streamingSessionId 对称（双 panel 并发 DEFERRED）。
   */
  const dispatchingSessionId = ref<string | null>(null)
  /** dispatching 超时兜底 timer（W3：pi 崩溃/WS 断连时 message_start 永不到，防 dispatching 永挂） */
  let dispatchingTimer: ReturnType<typeof setTimeout> | null = null
  /** dispatching 超时阈值（覆盖正常 ack→message_start 秒级延迟 + 慢网络余量） */
  const DISPATCHING_TIMEOUT_MS = 30_000
  /** streaming 超时兜底 timer（W3 扩展：message_start 已到但 message.complete 永不到）。
   *  比 dispatching 超时宽松（流式可能持续数分钟），仅作最后兜底——runtime 崩溃时
   *  useConnection 的 onRuntimeRestarting/onRuntimeFailed 会调 resetActive 立即清，此 timer 是补充。 */
  let streamingTimer: ReturnType<typeof setTimeout> | null = null
  /** streaming 超时阈值（5 分钟，覆盖长任务；runtime 崩溃由 resetActive 立即清，不必靠超时） */
  const STREAMING_TIMEOUT_MS = 300_000
  /** 正在压缩的 session 集合（#6：session.compacting/compacted 驱动，按 session 隔离） */
  const compactingSessions = ref<Set<string>>(new Set())
  /** 按 sessionId 分区的自动重试态（W06-B，auto_retry_start/end） */
  const retryStates = ref<Map<string, RetryState>>(new Map())
  /** 按 sessionId 分区的消息队列态（W06-B，queue_update） */
  const queueStates = ref<Map<string, QueueState>>(new Map())
  /**
   * FileChanges 子域控制器（W10，ADR-0024 D5 baseline diff）。
   * 变更集 5 态状态机 + FileChange 合并逻辑内聚在 chat-changeset.ts；messages ref 由
   * 本 store 拥有并注入（applyFileChanges 据此定位目标 assistant message），changeSetStatuses
   * ref 由控制器内部独占。设计选择与公共 API 见 chat-changeset.ts 顶部注释。
   */
  const changeset = createChangeSetController(messages)
  const { changeSetStatuses, getChangeSetStatus, setChangeSetStatus, applyFileChanges, markChangeSetsSuperseded } = changeset
  /** getHistory 加载失败的 session（#2 AC-2.6：landing 重试出口，不永久卡住） */
  const failedHistory = ref<Set<string>>(new Set())

  /** 取指定 session 的消息数组（空时返回空数组，不写入 Map） */
  function getMessages(sessionId: string): Message[] {
    return messages.value.get(sessionId) ?? []
  }

  /** 取指定 session 的自动重试态（无则 undefined） */
  function getRetryState(sessionId: string): RetryState | undefined {
    return retryStates.value.get(sessionId)
  }

  /** 取指定 session 的消息队列态（无则 undefined） */
  function getQueueState(sessionId: string): QueueState | undefined {
    return queueStates.value.get(sessionId)
  }

  /** 是否已加载历史（用于决定是否调 api.chat.getHistory） */
  function isHydrated(sessionId: string): boolean {
    return hydrated.value.has(sessionId)
  }

  /** 标记某 session 的历史加载失败（landing 显重试出口，AC-2.6） */
  function markHistoryFailed(sessionId: string): void {
    failedHistory.value = new Set(failedHistory.value).add(sessionId)
  }

  /** 清除某 session 的历史加载失败态（重试成功后） */
  function clearHistoryError(sessionId: string): void {
    const next = new Set(failedHistory.value)
    next.delete(sessionId)
    failedHistory.value = next
  }

  /**
   * 注入历史消息（首次进入 session 时由 useChat 调用）。
   * 不可变 set：深拷贝 fixture 避免外部突变污染源数据，标记 hydrated。
   */
  function hydrate(sessionId: string, history: Message[]): void {
    if (hydrated.value.has(sessionId)) return
    const cloned = history.map((m) => ({ ...m }))
    messages.value.set(sessionId, cloned)
    hydrated.value = new Set(hydrated.value).add(sessionId)
  }

  /** 追加 user 消息（构造完整 Message，立即 complete） */
  function appendUser(sessionId: string, text: string): void {
    const prev = messages.value.get(sessionId) ?? []
    messages.value.set(sessionId, [
      ...prev,
      {
        id: `u-${crypto.randomUUID()}`,
        role: 'user',
        content: text,
        status: 'complete',
        timestamp: Date.now(),
      },
    ])
  }

  /**
   * 追加 pending user 消息（steer/followup 已入队 pi，待投递）。
   * draft-composer-states S7：steer/followup 提交后立即在对话流显示 pending 气泡（虚线+脉冲），
   * 投递时（queue_update 移除该项 → markPendingDelivered）转 complete。
   * sendMode 区分 steer（追加当前回合）/ follow-up（回合后新轮），驱动气泡配色。
   */
  function appendPending(sessionId: string, text: string, sendMode: SteerFollowUpMode): void {
    const prev = messages.value.get(sessionId) ?? []
    messages.value.set(sessionId, [
      ...prev,
      {
        id: `u-${crypto.randomUUID()}`,
        role: 'user',
        content: text,
        status: 'pending',
        sendMode,
        timestamp: Date.now(),
      },
    ])
  }

  /**
   * 定位 session 里第一条匹配 text + sendMode 的 pending user 消息（FIFO）。
   * markPendingDelivered / removePending 共用的匹配逻辑，抽此 helper 避免谓词重复漂移。
   * sendMode 可选——未传时退化为仅 content 匹配（兼容宽松场景）。
   */
  function findPendingIndex(
    sessionId: string,
    text: string,
    sendMode?: SteerFollowUpMode,
  ): number {
    const prev = messages.value.get(sessionId)
    if (!prev) return -1
    return prev.findIndex(
      (m) =>
        m.role === 'user'
        && m.status === 'pending'
        && m.content === text
        && (sendMode === undefined || m.sendMode === sendMode),
    )
  }

  /**
   * 将指定 session 里匹配文本 + sendMode 的 pending user 消息标记为已投递（status → complete）。
   * 触发：queue_update 里某条 steer/followUp 文本消失（pi drain 投递了它）。
   * [W5] 按 content + sendMode 精确匹配，避免跨类型同文本误转（steer「补」与 followUp「补」）。
   * 仅转第一条匹配的 pending（FIFO，与 pi splice 顺序一致）；重复文本 drain 时由调用方按计数多次调用。
   * 幂等：对已 complete 的消息 no-op。
   */
  function markPendingDelivered(
    sessionId: string,
    text: string,
    sendMode?: SteerFollowUpMode,
  ): void {
    const idx = findPendingIndex(sessionId, text, sendMode)
    if (idx === -1) return
    const prev = messages.value.get(sessionId)!
    const next = [...prev]
    next[idx] = { ...next[idx], status: 'complete' }
    messages.value.set(sessionId, next)
  }

  /**
   * 移除指定 session 里匹配文本 + sendMode 的 pending user 消息（W1：steer/followUp API 失败回滚）。
   * 与 markPendingDelivered 的区别：转 complete 是「投递成功」，removePending 是「发送失败，消息作废」。
   * 仅移除第一条匹配的 pending（FIFO）。失败时调用——pending 气泡从对话流删除，不留孤儿。
   */
  function removePending(
    sessionId: string,
    text: string,
    sendMode: SteerFollowUpMode,
  ): void {
    const idx = findPendingIndex(sessionId, text, sendMode)
    if (idx === -1) return
    const prev = messages.value.get(sessionId)!
    messages.value.set(sessionId, prev.filter((_, i) => i !== idx))
  }

  /**
   * message.* 事件的单一入口（F2 重构：消除 double-dispatch）。
   *
   * useChat.ensureStreamSubscription 收到 message.* 后调本方法，不再自己 switch。
   * 内部经 dispatchMessageEvent 查 effect 注册表，执行该 type 的全部副作用：
   * (a) chunk 状态更新（messages/retryStates/queueStates）+ (b) lifecycle flag 翻转
   * （setStreaming）。注册表见 chat-message-effects.ts。
   *
   * 行为等价：与原 appendAssistantChunk(applyChunk) + useChat.setStreaming 的串联一致——
   * handler 内先更新 chunk 状态后翻 flag，对应原「先 appendAssistantChunk 再 switch 翻 flag」顺序。
   * 非 message.* / 未注册 type no-op（等价原 applyChunk default return）。
   */
  function applyMessageEvent(sessionId: string, msg: ServerMessage): void {
    dispatchMessageEvent(
      {
        messages,
        retryStates,
        queueStates,
        applyFileChanges,
        markChangeSetsSuperseded,
        setStreaming,
        markPendingDelivered,
      },
      sessionId,
      msg,
    )
  }

  function setStreaming(value: boolean, sessionId?: string | null): void {
    isStreaming.value = value
    // true 时记录哪个 session 在流式；false 时清空（终态事件不携带 sid 语义，直接清）
    streamingSessionId.value = value ? (sessionId ?? null) : null
    // message_start 到达（流式正式开始）或终态时，空窗期结束，清 dispatching + 取消超时兜底。
    // 兜底：正常情况 message_start 已清，此处防御性清理终态路径（complete/error）。
    clearDispatchingTimer()
    if (dispatchingSessionId.value !== null) dispatchingSessionId.value = null
    // streaming 超时兜底：true 挂载（防 message.complete 永不到），false 清除（正常收口）
    clearStreamingTimer()
    if (value) {
      streamingTimer = setTimeout(() => {
        if (isStreaming.value) {
          isStreaming.value = false
          streamingSessionId.value = null
          console.warn('[chat] streaming timeout, force-reset (message.complete never arrived)')
        }
      }, STREAMING_TIMEOUT_MS)
    }
  }

  /**
   * 置位/清除派发态（sendPrompt 前置位 → message_start/终态/失败清空）。
   * [W3] 置位时挂 30s 超时兜底——若 pi 崩溃/WS 断连导致 message_start 永不到达，
   * dispatching 会永久挂着（停止按钮/steer guard 死锁）。超时后自动清，让 UI 恢复可操作。
   * 30s 足够覆盖正常 ack→message_start（秒级）+ 慢网络/模型冷启动余量。
   * 清除（null）时取消 timer。setStreaming 也会清 timer（正常流转）。
   */
  function setDispatching(sessionId: string | null): void {
    clearDispatchingTimer()
    dispatchingSessionId.value = sessionId
    if (sessionId !== null) {
      dispatchingTimer = setTimeout(() => {
        // 超时兜底：dispatching 仍未被 message_start/终态清除 → 强制清
        if (dispatchingSessionId.value === sessionId) {
          dispatchingSessionId.value = null
          console.warn(`[chat] dispatching timeout for session ${sessionId}, force-clearing (message_start never arrived)`)
        }
      }, DISPATCHING_TIMEOUT_MS)
    }
  }

  /** 取消 dispatching 超时 timer（正常流转或手动清除时调） */
  function clearDispatchingTimer(): void {
    if (dispatchingTimer !== null) {
      clearTimeout(dispatchingTimer)
      dispatchingTimer = null
    }
  }

  /** 取消 streaming 超时 timer（message.complete 正常收口或 resetActive 时调） */
  function clearStreamingTimer(): void {
    if (streamingTimer !== null) {
      clearTimeout(streamingTimer)
      streamingTimer = null
    }
  }

  /**
   * 强制重置所有活跃态（streaming + dispatching）——runtime 崩溃/重启/WS 断连时调。
   * runtime 崩溃 = pi 子进程没了 = 流不可能继续。此时 isStreaming/dispatching 残留会让
   * UI 永久卡在「思考中」，停止按钮/steer guard 死锁。useConnection 监听 runtime 崩溃事件
   * 后调此方法立即清，比等待 streaming/dispatching 超时更准确（不误杀长任务）。
   */
  function resetActive(): void {
    clearDispatchingTimer()
    clearStreamingTimer()
    isStreaming.value = false
    streamingSessionId.value = null
    dispatchingSessionId.value = null
  }

  /**
   * session 级错误统一入口：追加 error assistant 消息 + 重置所有活跃态。
   * 用于 session.exited（进程退出）/ error envelope（有 sessionId 时）/ restore 失败等场景。
   * 消除各错误路径分散重置导致的状态遗漏（规则 #3：错误必须重置 isGenerating + streaming）。
   */
  function markSessionError(sessionId: string, errorText: string): void {
    const prev = messages.value.get(sessionId) ?? []
    const idx = findLastAssistantIndex(prev)
    if (idx >= 0 && prev[idx].status === 'streaming') {
      const next = [...prev]
      const last = next[idx]
      next[idx] = {
        ...last,
        content: last.content ? `${last.content}\n\n${errorText}` : errorText,
        status: 'error',
      }
      messages.value.set(sessionId, next)
    } else {
      messages.value.set(sessionId, [
        ...prev,
        { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: errorText, status: 'error', timestamp: Date.now() },
      ])
    }
    clearDispatchingTimer()
    clearStreamingTimer()
    isStreaming.value = false
    streamingSessionId.value = null
    dispatchingSessionId.value = null
  }

  // store 作用域销毁时（HMR 热替换 / $dispose / 测试 teardown）清理 timer，
  // 避免回调操作已废弃的 store 实例 ref + warn 噪音。
  onScopeDispose(() => {
    clearDispatchingTimer()
    clearStreamingTimer()
  })

  /**
   * 指定 session 是否「活跃」——合并 isStreaming 和 dispatching 空窗态。
   * Composer 停止按钮 / steer guard 用此判断，而非单一 isStreaming，
   * 消除「ack 已到但 message_start 未到」的空窗期。
   */
  function isActive(sessionId: string): boolean {
    return (isStreaming.value && streamingSessionId.value === sessionId)
      || dispatchingSessionId.value === sessionId
  }

  /** 指定 session 是否正在压缩上下文（#6） */
  function isCompacting(sessionId: string): boolean {
    return compactingSessions.value.has(sessionId)
  }

  /** 设置压缩态（session.compacting→true / session.compacted→false），不可变 set 保证响应性 */
  function setCompacting(sessionId: string, value: boolean): void {
    const next = new Set(compactingSessions.value)
    if (value) next.add(sessionId)
    else next.delete(sessionId)
    compactingSessions.value = next
  }

  /**
   * 追加 system 提示行（runtime 主动推送的元信息反馈，如 compactionSummary，作 SystemNotice 渲染）。
   * 与规则 #3 「错误作为消息插入聊天流」一致：不用顶部 banner。
   * 注：compact 失败的错误反馈走 useChat.compact 的 toast（§4.4 异常路径），不走此方法。
   */
  function appendSystemNotice(sessionId: string, text: string): void {
    const prev = messages.value.get(sessionId) ?? []
    messages.value.set(sessionId, [
      ...prev,
      {
        id: `sys-${crypto.randomUUID()}`,
        role: 'system',
        content: text,
        status: 'complete',
        timestamp: Date.now(),
      },
    ])
  }

  /**
   * 截断指定 session 的消息：删除 messageId（含/不含）及其后所有消息。
   * 编辑重发场景（原地替换 user 消息，非 fork）：truncate(含该 user) → appendUser(新文本) → send。
   * 不可变 set（slice 新数组）保证响应式触发。
   */
  function truncateFrom(sessionId: string, messageId: string, inclusive: boolean): void {
    const prev = messages.value.get(sessionId) ?? []
    const idx = prev.findIndex((m) => m.id === messageId)
    if (idx === -1) return
    const end = inclusive ? idx : idx + 1
    messages.value.set(sessionId, prev.slice(0, end))
  }

  return {
    messages,
    isStreaming,
    streamingSessionId,
    dispatchingSessionId,
    compactingSessions,
    retryStates,
    queueStates,
    changeSetStatuses,
    failedHistory,
    getMessages,
    getRetryState,
    getQueueState,
    getChangeSetStatus,
    setChangeSetStatus,
    markChangeSetsSuperseded,
    isHydrated,
    markHistoryFailed,
    clearHistoryError,
    hydrate,
    appendUser,
    appendPending,
    markPendingDelivered,
    removePending,
    applyMessageEvent,
    setStreaming,
    setDispatching,
    resetActive,
    markSessionError,
    isActive,
    isCompacting,
    setCompacting,
    appendSystemNotice,
    truncateFrom,
    applyFileChanges,
  }
})
