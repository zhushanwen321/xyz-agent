/**
 * Chat store —— messages（按 sessionId 分区）+ 派生 isGenerating。
 *
 * 状态撕裂修复（cw-2026-07-08-fix-state-tearing）：
 * 删除命令式 isStreaming flag，改为从 message 实体派生的 isGenerating(sid) computed scan。
 * pendingSend Set 取代 dispatchingSessionId（跨 session 顺序发送）。
 * finalizeSession 统一收口出口（所有异常路径的单一收口，非翻 flag）。
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
export type { RetryState, QueueState, FinalizeReason } from './chat-store-types'
import type { RetryState, QueueState, FinalizeReason } from './chat-store-types'

export const useChatStore = defineStore('chat', () => {
  /** 按 sessionId 分区的消息表（UC-2 隔离） */
  const messages = ref<Map<string, Message[]>>(new Map())
  /** 已 hydrate 的 session（避免切换时重复注入历史） */
  const hydrated = ref<Set<string>>(new Set())
  /**
   * 预期态：ack→message_start 空窗期的「用户已发起未确认」session 集合。
   * 取代 dispatchingSessionId（单值）。跨 session 顺序发送需要 Set（跨 panel 切换）。
   * 与 isGenerating 正交：add 在 send 前，delete 在 message_start（正常）/ finalizeSession（异常）。
   */
  const pendingSend = ref<Set<string>>(new Set())
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

  // ── 超时兜底 timer（D-003 阈值可配置 + D-007 真收口）──

  /**
   * streaming 超时阈值。默认 24h（86_400_000ms）。
   * 24h = 放弃主动时间检测，靠 runtime 重启/WS 断连 + 用户手动停止；timer 是 pi 静默卡死最后兑底。
   * 可经 env XYZ_STREAMING_TIMEOUT_MS 配置（IPC 从主进程读，D-016）。
   */
  const STREAMING_TIMEOUT_MS = readStreamingTimeoutMs()
  /** pendingSend 空窗期 timer 阈值（D-015/F4，接管 dispatchingTimer 30s 语义） */
  const PENDING_SEND_TIMEOUT_MS = 30_000
  /** streaming 超时 timer（per-session 跟踪） */
  let streamingTimer: ReturnType<typeof setTimeout> | null = null
  let streamingTimerSid: string | null = null
  /** pendingSend 空窗期 timer */
  let pendingSendTimer: ReturnType<typeof setTimeout> | null = null
  let pendingSendTimerSid: string | null = null

  /** streaming 超时默认值：24h（放弃主动检测，靠 runtime 重启/WS 断连兑底） */
  const DEFAULT_STREAMING_TIMEOUT_MS = 86_400_000 // 24h

  function readStreamingTimeoutMs(): number {
    // [D-016] 经 IPC 读主进程 env（非 import.meta.env，Vite 不暴露 XYZ_ 前缀）
    // TODO: 接 IPC — window.electronAPI?.getStreamingTimeout?.()
    const env = undefined
    const parsed = env ? Number(env) : Number.NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAMING_TIMEOUT_MS
  }

  // ── 派生态（computed scan，D-005，零手动维护）──

  /**
   * 指定 session 是否有 streaming 实体（派生，无 setter）。
   * 不变式：`isGenerating(sid) ≡ ∃ m ∈ messages[sid], m.status === 'streaming'`
   * scan 限定 per-session（messages.value.get(sid)），防跨 session 响应式失效扩散。
   * 取代命令式 isStreaming flag —— 物理不可撕裂（无写路径需手动同步）。
   */
  function isGenerating(sessionId: string): boolean {
    const list = messages.value.get(sessionId)
    if (!list) return false
    return list.some((m) => m.status === 'streaming')
  }

  /**
   * 指定 session 是否「活跃」（派生）。
   * 不变式：`isActive(sid) ≡ isGenerating(sid) ∨ pendingSend.has(sid)`
   * 驱动 Composer 停止按钮 / steer guard / B 策略路由。
   */
  function isActive(sessionId: string): boolean {
    return isGenerating(sessionId) || pendingSend.value.has(sessionId)
  }

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
   * (a) chunk 状态更新（messages/retryStates/queueStates）+ (b) 终态收口
   * （finalizeSession）。注册表见 chat-message-effects.ts。
   *
   * 行为等价：与原 appendAssistantChunk(applyChunk) + finalizeSession 的串联一致——
   * handler 内先更新 chunk 状态后收口实体，对应原「先 appendAssistantChunk 再 finalizeSession」顺序。
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
        finalizeSession,
        clearPendingSend,
        markPendingDelivered,
      },
      sessionId,
      msg,
    )
  }

  // ── 收口出口（唯一，D-007 真收口非翻 flag）──

  /**
   * session 级统一收口：把 streaming/running 实体推到终态 + 清 pendingSend + 清 timer。
   *
   * 不变式（幂等，D-010 sealed）：重复调用不报错，sealed 后实体不变。
   * 不处理 usage 回填（message.complete handler 单独 enrichment）。
   *
   * @param reason 决定 message.status + toolCall.status 终态映射（见 FinalizeReason）
   */
  function finalizeSession(sessionId: string, reason: FinalizeReason, errorText?: string): void {
    const prev = messages.value.get(sessionId)
    if (prev) {
      const next = prev.map((m) => {
        if (m.status !== 'streaming') return m
        // reason → message 终态映射
        const isErrorReason = reason === 'error' || reason === 'stream_error' || reason === 'timeout' || reason === 'disconnect' || reason === 'restart'
        const finalStatus = isErrorReason ? 'error' : 'complete'
        const finalContent = errorText && m.role === 'assistant'
          ? (m.content ? `${m.content}\n\n${errorText}` : errorText)
          : m.content
        // toolCall 级联终态（D-011 诚实态）
        const toolCalls = m.toolCalls?.map((tc): typeof tc => {
          if (tc.status !== 'running') return tc
          const tcIsError = reason === 'error' || reason === 'stream_error'
          return {
            ...tc,
            status: tcIsError ? 'error' : 'end_not_received',
            ...(reason !== 'normal' && reason !== 'aborted' ? { endTime: Date.now() } : {}),
          }
        })
        return { ...m, status: finalStatus, content: finalContent, toolCalls } satisfies Message
      })
      messages.value.set(sessionId, next)
    }
    // 清 pendingSend + timer
    clearPendingSend(sessionId)
    clearStreamingTimer()
    console.warn(`[chat] finalizeSession sid=${sessionId} reason=${reason}`)
  }

  /**
   * 多 session 统一收口（F1 修正）：遍历所有 session，对每个 isGenerating(sid) 的调 finalizeSession。
   * useConnection runtime 重启/失败时调此 helper，确保后台 streaming session 也收口。
   */
  function finalizeAllStreaming(reason: FinalizeReason): void {
    for (const sid of messages.value.keys()) {
      if (isGenerating(sid)) finalizeSession(sid, reason)
    }
  }

  // ── pendingSend 生命周期（useChat/effects 经 ctx/port 调）──

  /** send 前置位（填空窗）。不可变 Set add（保证响应式）。同时挂 pendingSendTimer（D-015）。 */
  function addPendingSend(sessionId: string): void {
    pendingSend.value = new Set(pendingSend.value).add(sessionId)
    clearPendingSendTimer()
    pendingSendTimerSid = sessionId
    pendingSendTimer = setTimeout(() => {
      if (pendingSendTimerSid) finalizeSession(pendingSendTimerSid, 'timeout')
    }, PENDING_SEND_TIMEOUT_MS)
  }

  /** message_start（正常）/ finalizeSession（异常）/ abort（乐观）/ send.rejected（回滚）调。幂等。 */
  function clearPendingSend(sessionId: string): void {
    if (pendingSend.value.has(sessionId)) {
      const next = new Set(pendingSend.value)
      next.delete(sessionId)
      pendingSend.value = next
    }
    clearPendingSendTimer()
  }

  function clearPendingSendTimer(): void {
    if (pendingSendTimer !== null) {
      clearTimeout(pendingSendTimer)
      pendingSendTimer = null
    }
    pendingSendTimerSid = null
  }

  // ── streaming timer（超时兜底）──

  /** message_start 挂载超时兜底（防 message.complete 永不到）。callback 调 finalizeSession('timeout')。 */
  function armStreamingTimer(sessionId: string): void {
    clearStreamingTimer()
    streamingTimerSid = sessionId
    streamingTimer = setTimeout(() => {
      if (streamingTimerSid) finalizeSession(streamingTimerSid, 'timeout')
    }, STREAMING_TIMEOUT_MS)
  }

  /** 取消超时 timer（finalizeSession / store dispose 调） */
  function clearStreamingTimer(): void {
    if (streamingTimer !== null) {
      clearTimeout(streamingTimer)
      streamingTimer = null
    }
    streamingTimerSid = null
  }

  /**
   * session 级错误统一入口：追加 error assistant 消息 + finalizeSession。
   * 用于 session.exited（进程退出）/ error envelope（有 sessionId 时）/ restore 失败等场景。
   */
  function markSessionError(sessionId: string, errorText: string): void {
    const prev = messages.value.get(sessionId) ?? []
    const idx = findLastAssistantIndex(prev)
    if (idx >= 0 && prev[idx].status === 'streaming') {
      // streaming assistant → finalizeSession('error', errorText) 收口（合一逻辑）
      finalizeSession(sessionId, 'error', errorText)
    } else {
      // 无 streaming entity → 直接追加 error 消息
      messages.value.set(sessionId, [
        ...prev,
        { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: errorText, status: 'error', timestamp: Date.now() },
      ])
      clearPendingSend(sessionId)
      clearStreamingTimer()
    }
  }

  // store 作用域销毁时（HMR 热替换 / $dispose / 测试 teardown）清理 timer，
  // 避免回调操作已废弃的 store 实例 ref + warn 噪音。
  onScopeDispose(() => {
    clearPendingSendTimer()
    clearStreamingTimer()
  })

  /**
   * 指定 session 是否正在压缩上下文（#6） */
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
    pendingSend,
    compactingSessions,
    retryStates,
    queueStates,
    changeSetStatuses,
    failedHistory,
    hydrated,
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
    isGenerating,
    isActive,
    finalizeSession,
    finalizeAllStreaming,
    addPendingSend,
    clearPendingSend,
    armStreamingTimer,
    markSessionError,
    isCompacting,
    setCompacting,
    appendSystemNotice,
    truncateFrom,
    applyFileChanges,
  }
})
