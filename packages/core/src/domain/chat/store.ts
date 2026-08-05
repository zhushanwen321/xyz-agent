/**
 * chat store factory（IF1）—— chat 域状态管理 SSOT。
 *
 * [归位] 迁自 renderer src/stores/chat.ts（906 行 defineStore setup 函数体）。P3 chat 域绞杀 w4。
 *
 * factory 模式（IF1 契约）：core 不绑 pinia store id（平台无关，pinia store 注册是 shell 关切），
 * 暴露 createChatStore() factory 返回 store 对象（state + actions）。renderer 经
 * defineStore('chat', () => createChatStore()) 薄包装注册到 pinia。
 *
 * [P4 s5 w2] 原唯一 deps（openTasksPanelOnFirstData 回调，首数据到达开 tasks panel）已随
 * tasks 域删除一并移除（tasks store 是回调的触发源与消费目标），factory 改无参。
 * core factory 主体零 renderer 跨域 import（grep 验证，TC3）。
 *
 * per-session 分区：保持 ref(Map<sessionId, T>)（原样迁移）。ADR-0049 把「单例 + Map<sid,T>」
 * 明确列为 Map 分区派（SSOT）正确范式，store 的 ref(Map) 正是此范式的 store 层实现。
 * useSessionScopedState 是该范式在 composable 层的便捷封装（需 sidRef），store 服务全量 sid
 * 无 sidRef 可传，故不套用（clarify Q1）。DM1 精神（Map 分区派，非 watch 清理派）由 ref(Map) 满足。
 *
 * 状态撕裂修复（cw-2026-07-08-fix-state-tearing）：
 * 删除命令式 isStreaming flag，改为从 message 实体派生的 isGenerating(sid) computed scan。
 * pendingSend Set 取代 dispatchingSessionId（跨 session 顺序发送）。
 * finalizeSession 统一收口出口（所有异常路径的单一收口，非翻 flag）。
 *
 * 响应式策略：messages 是 shallowRef<Map<sessionId, Message[]>>，所有变更走「取出 → 新数组 → set」
 * 的不可变更新（经 commitMessages helper），确保 Vue 对 Map 的集合响应性可靠触发。
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
import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import { commitMessages, truncateMessagesFrom, prependHistory as prependHistoryMut } from './mutations'
import { truncateToolOutputBatch } from './truncate-tool-output'
import { dispatchMessageEvent } from './effects/registry'
import {
  initTimers,
  clearSessionTimer,
} from './timers'
import { createStreamingStateMachine } from './streaming-state-machine'
import {
  touchLru as lruTouch,
  evictIfNeeded as lruEvictIfNeeded,
  evictSessionWithVirtual as lruEvictSession,
  makeLruEvictDeps,
  disposeLruEntry,
} from './lru'
import { findLastAssistantIndex } from './chunk-processor'
import { findLastStreamingBashIndex, markBashError } from './bash-effects'
import { createChangeSetController } from './changeset'
import { createHandoffController } from './handoff'
import type {
  Message,
  Segment,
  ServerMessage,
  SteerFollowUpMode,
} from '@xyz-agent/shared'
import { normalizeContent } from '@xyz-agent/shared'
import type { RetryState, QueueState, FinalizeReason } from './store-types'
import { isDevMode } from '../../platform/dev-mode'

/**
 * streaming 超时默认值：10min。
 *
 * W6 调整：原 24h 形同虚设。降到 10min 作为 runtime pi watchdog（5min ABORT）之后的第二道 UI 兜底——
 * runtime watchdog 先检测 pi 卡死并自动 abort（广播 message.error），前端 streaming 超时只处理
 * runtime 自身也卡死的极端场景（runtime 主进程卡死时 watchdog 跑不了）。
 */
export const DEFAULT_STREAMING_TIMEOUT_MS = 600_000 // 10min

/**
 * 读 streaming 超时阈值（D-003 阈值可配置 + D-016 IPC）。
 * [D-016] 经 IPC 读主进程 env（非 import.meta.env，Vite 不暴露 XYZ_ 前缀）。
 * 留在模块作用域以控制 setup 函数行数（max-lines-per-function）。
 *
 * [w4 归位] IPC 接线经 PlatformPort 注入属另一个 wave（标 TODO @platform-port-wave）。
 * 当前 const env = undefined（实际未读 window.electronAPI），返回 DEFAULT_STREAMING_TIMEOUT_MS。
 */
function readStreamingTimeoutMs(): number {
  // TODO @platform-port-wave: 接 IPC — window.electronAPI?.getStreamingTimeout?.()
  const env = undefined
  const parsed = env ? Number(env) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAMING_TIMEOUT_MS
}

/**
 * chat store factory（IF1）：构造 chat 域全部状态 + actions，返回 store 对象。
 *
 * renderer 经 defineStore('chat', () => createChatStore()) 注册到 pinia。
 * core 单测在 effectScope 内直接调 createChatStore 验证 factory 产物（不经 pinia）。
 *
 * 内部用 onScopeDispose（清 timer），调用方需在 effectScope 上下文内执行本 factory。
 *
 * [P4 s5 w2] tasks 域删除：原唯一 deps（openTasksPanelOnFirstData 回调）已随 tasks store
 * 一并移除，factory 改为无参（renderer defineStore 薄包装同步简化）。
 */
export function createChatStore() {
  /** 按 sessionId 分区的消息表（UC-2 隔离） */
  // W1: shallowRef——messages 更新全部走 commitMessages（新 Map + set + 赋值 .value），
  // 不再用 messages.value.set（shallowRef 下 Map mutation 不触发响应式）。
  // 消除万级深 proxy（每条 Message 的嵌套对象不再被代理），降低长对话内存与 GC 压力（ADR 0039）。
  const messages = shallowRef<Map<string, Message[]>>(new Map())
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
  /**
   * handingOff 瞬时态子域控制器（fast-handoff，ADR：对称 compactingSessions）。
   * handingOffSessions ref + per-session 超时兜底 timer 内聚在 chat-handoff.ts；本 store
   * 经 createHandoffController() 组合后原样透出公共 API（isHandingOff/setHandingOff 等），
   * 行为与原内联实现零变化。设计选择见 chat-handoff.ts 顶部注释。
   */
  const handoff = createHandoffController()
  const { handingOffSessions, isHandingOff, setHandingOff, clearHandingOffTimer } = handoff
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
   * streaming 超时阈值。默认 10min（600_000ms，DEFAULT_STREAMING_TIMEOUT_MS）。
   * W6 调整：原 24h 形同虚设，降到 10min 作为 runtime pi watchdog（5min ABORT）之后的第二道
   * UI 兜底——runtime watchdog 先 abort 广播 message.error，本 timer 只兜底 runtime 自身卡死。
   * 可经 env XYZ_STREAMING_TIMEOUT_MS 配置（IPC 从主进程读，D-016）。
   */
  const STREAMING_TIMEOUT_MS = readStreamingTimeoutMs()
  /** pendingSend 空窗期 timer 阈值（D-015/F4，接管 dispatchingTimer 30s 语义） */
  const PENDING_SEND_TIMEOUT_MS = 30_000
  /** pendingSend 空窗期 timer（按 sessionId 隔离） */
  const pendingSendTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // handingOff 超时兜底 timer + HANDING_OFF_TIMEOUT_MS 阈值内聚在 createHandoffController（chat-handoff.ts）

  // ── streaming 状态机深模块（B6：3 个原模块级状态机编排函数 + 2 个新提取的瞬态清理 helper 内聚为 factory，本 store 仅委托）──
  const streamingStateMachine = createStreamingStateMachine({
    messages,
    compactingSessions,
    handingOffSessions,
    retryStates,
    queueStates,
    pendingSend,
    setCompacting,
    setHandingOff,
  })

  // ── 派生态（computed scan，D-005，零手动维护）──

  /**
   * 当前所有含 streaming assistant 消息的 session 集合（W2，ADR 0041）。
   *
   * computed 派生 Set——单一真相源，物理不可撕裂（任何 messages 写入路径自动覆盖，
   * 含 13+ 处写入点 + 3 个边界点 truncateFrom/disposeSession/hydrate）。messages 变化时
   * 全量扫一次并缓存，服务所有 isGenerating 查询，消除"每个消费点重复 O(n) 扫描"。
   *
   * shallowRef 下依赖 messages.value 的整体替换（commitMessages 已保证），computed 正确重算。
   *
   * [B1 PR#116 review] 仅扫 `m.role === 'assistant' && m.status === 'streaming'`。
   * bashStartEffect 创建的 bash 消息是 `role:'system', status:'streaming'`——纯 bash 执行
   * 期间若计入此集合，isGenerating(sid)===true → isActive(sid)===true，用户发普通消息会被错误
   * 路由到 steer，Composer isBusy 为真，停止按钮按 assistant abort 动作而非 abortBash，
   * 与「bash 不阻塞」核心承诺矛盾。bash 消息的生命周期由 finalizeBashOnly / bashResultEffect /
   * markBashError 独立管理（不依赖此 isGenerating 派生）。
   */
  const streamingSessionIds = computed(() => {
    const ids = new Set<string>()
    for (const [sid, msgs] of messages.value) {
      for (const m of msgs) {
        if (m.role === 'assistant' && m.status === 'streaming') {
          ids.add(sid)
          break
        }
      }
    }
    return ids
  })

  /**
   * 指定 session 是否有 streaming assistant 实体（派生，无 setter）。
   * 不变式：`isGenerating(sid) ≡ ∃ m ∈ messages[sid], m.role === 'assistant' && m.status === 'streaming'`
   * W2：改用 streamingSessionIds computed 的 O(1) has 查询（ADR 0041），
   * 取代每次调用 O(n) list.some 扫描。不变式逻辑完全相同，仅加缓存层。
   *
   * [B1] 仅反映 assistant streaming——bash 消息（role:'system'）不计入，确保纯 bash 执行
   * 期间 isGenerating 为 false，与「bash 不阻塞」承诺一致。
   */
  function isGenerating(sessionId: string): boolean {
    return streamingSessionIds.value.has(sessionId)
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

  /** W3 H3：session 是否在 LRU 豁免集（streaming/pending/compacting/handoff 不驱逐，AC-9）。
   *  handingOff 并入（对称 compacting）：交接中 session 被 LRU 驱逐会清 messages，导致 UI
   *  显示「正在交接…」但对话内容消失（reviewer M3 对称性缺口）。 */
  const isLruExempt = (sid: string) => isGenerating(sid) || pendingSend.value.has(sid) || isCompacting(sid) || isHandingOff(sid)
  /** W3 H3：LRU recency 更新（AC-1 真 LRU），直接透传 lruTouch */
  const touchLru = lruTouch
  /**
   * LRU 驱逐依赖（W9：store setup 时构造一次复用）。
   * messages/hydrated 是稳定 ref 引用，isLruExempt 闭包每次调用读当前 .value（无快照陈旧），
   * makeLruEvictDeps 内部又用 getter（() => messages.value）延迟读取，故 deps 可在 setup 时
   * 构造一次，三个 evict 函数复用，避免每次 evictIfNeeded 重建 5 个闭包对象。
   */
  const lruEvictDeps = makeLruEvictDeps(messages, hydrated, isLruExempt)
  /** W3 H3：LRU 驱逐（阈值触发）/ 显式驱逐（带虚拟 key）/ [M7] 单虚拟 key 删除 */
  function evictIfNeeded(): void { lruEvictIfNeeded(lruEvictDeps) }
  function evictSessionWithVirtual(sessionId: string): void { lruEvictSession(sessionId, lruEvictDeps) }
  function evictVirtualKey(virtualId: string): void { lruEvictDeps.deleteMessageKey(virtualId) }

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

  /** 注入历史（首入 session）。W2 H3 截断回流（AC-10），W3 touchLru。 */
  function hydrate(sessionId: string, history: Message[]): void {
    if (hydrated.value.has(sessionId)) return
    const cloned = truncateToolOutputBatch(history.map((m) => ({ ...m })))
    commitMessages(messages, sessionId, cloned)
    hydrated.value = new Set(hydrated.value).add(sessionId)
    lruTouch(sessionId) // W3: LRU recency
  }

  /**
   * 直接覆盖某 session 的消息（subagent 虚拟 session 用，不受 hydrated 守卫）。
   * W2 H3：回流路径截断（AC-10/D9），与 hydrate 一致。
   */
  function setMessages(sessionId: string, history: Message[]): void {
    const cloned = truncateToolOutputBatch(history.map((m) => ({ ...m })))
    commitMessages(messages, sessionId, cloned)
  }

  /** W4 H4：全量历史去重合并到头部（加载更多）。截断 + 委托 chat-mutations。 */
  function prependHistory(sessionId: string, fullHistory: Message[]): void {
    prependHistoryMut(messages, sessionId, truncateToolOutputBatch(fullHistory.map((m) => ({ ...m }))))
  }

  /** 追加 user 消息（Segment[]，ADR-0043）。返回 id：useChat 用作 clientUuid 建立重开回填映射。 */
  function appendUser(sessionId: string, segments: Segment[]): string {
    const prev = messages.value.get(sessionId) ?? []
    const id = `u-${crypto.randomUUID()}`
    commitMessages(messages, sessionId, [
      ...prev,
      {
        id,
        role: 'user',
        content: segments,
        status: 'complete',
        timestamp: Date.now(),
      },
    ])
    return id
  }

  /**
   * 追加 pending user 消息（steer/followup 已入队 pi，待投递）。
   * draft-composer-states S7：steer/followup 提交后立即在对话流显示 pending 气泡（虚线+脉冲），
   * 投递时（queue_update 移除该项 → markPendingDelivered）转 complete。
   * sendMode 区分 steer（追加当前回合）/ follow-up（回合后新轮），驱动气泡配色。
   */
  function appendPending(sessionId: string, segments: Segment[], sendMode: SteerFollowUpMode): void {
    const prev = messages.value.get(sessionId) ?? []
    commitMessages(messages, sessionId, [
      ...prev,
      {
        id: `u-${crypto.randomUUID()}`,
        role: 'user',
        content: segments,
        status: 'pending',
        sendMode,
        timestamp: Date.now(),
      },
    ])
  }

  /**
   * 定位 session 里第一条匹配的 pending user 消息（FIFO）。
   * markPendingDelivered / removePending 共用的匹配逻辑，抽此 helper 避免谓词重复漂移。
   * sendMode 可选——未传时退化为仅 content 匹配（兼容宽松场景）。
   *
   * content 改 Segment[] 后，用 normalizeContent 归一化两边比较（FR-7，AC-5.1）。
   * matcher 接收 string | Segment[]：
   * - removePending（useChat 调）传 Segment[]（前端发送时的 segments）
   * - markPendingDelivered（chat-message-effects 调）传 string（pi queue_update 回传的 text）
   * 两种来源经 normalizeContent 归一化后统一比较。
   */
  function findPendingIndex(
    sessionId: string,
    matcher: string | Segment[],
    sendMode?: SteerFollowUpMode,
  ): number {
    const prev = messages.value.get(sessionId)
    if (!prev) return -1
    // 两边统一 trim 后比较：matcher 可能是 Segment[]（前端发送，segmentsToText 不 trim）
    // 或 string（pi 回流，已 trim）；m.content 是 Segment[]（segmentsToText 不 trim）。
    // trim 对齐防止首尾空白致匹配失败（pending 卡住无法转 complete）。
    const target = normalizeContent(matcher).trim()
    return prev.findIndex(
      (m) =>
        m.role === 'user'
        && m.status === 'pending'
        && normalizeContent(m.content).trim() === target
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
    matcher: string | Segment[],
    sendMode?: SteerFollowUpMode,
  ): void {
    const idx = findPendingIndex(sessionId, matcher, sendMode)
    if (idx === -1) return
    const prev = messages.value.get(sessionId)!
    const next = [...prev]
    next[idx] = { ...next[idx], status: 'complete' }
    commitMessages(messages, sessionId, next)
  }

  /**
   * 移除指定 session 里匹配文本 + sendMode 的 pending user 消息（W1：steer/followUp API 失败回滚）。
   * 与 markPendingDelivered 的区别：转 complete 是「投递成功」，removePending 是「发送失败，消息作废」。
   * 仅移除第一条匹配的 pending（FIFO）。失败时调用——pending 气泡从对话流删除，不留孤儿。
   */
  function removePending(
    sessionId: string,
    matcher: string | Segment[],
    sendMode: SteerFollowUpMode,
  ): void {
    const idx = findPendingIndex(sessionId, matcher, sendMode)
    if (idx === -1) return
    const prev = messages.value.get(sessionId)!
    commitMessages(messages, sessionId, prev.filter((_, i) => i !== idx))
  }

  /**
   * message.* 事件的单一入口（F2 重构：消除 double-dispatch）。
   *
   * useChat.ensureStreamSubscription 收到 message.* 后调本方法，不再自己 switch。
   * 内部经 dispatchMessageEvent 查 effect 注册表，执行该 type 的全部副作用：
   * (a) chunk 状态更新（messages/retryStates/queueStates）+ (b) 终态收口
   * （finalizeSession）。注册表见 core/src/domain/chat/effects/registry.ts。
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
        armStreamingTimer,
        armBashTimer,
        clearBashTimer,
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
    streamingStateMachine.finalizeMessages(sessionId, reason, errorText)
    // 清 pendingSend + streaming timer（bash timer 不清：W1 timer-decouple 解耦，bash timer 由
    // bashResultEffect/markBashError/finalizeBashOnly 独立清，不应被 assistant 收口误清）。
    // [M2 PR#116 review] clearStreamingTimer 此前被误删：正常 message.complete 路径不再清
    // streaming timer，10min 后 timer 仍会触发 finalizeSession('timeout')，造成已 complete 的
    // turn 被二次收口（幂等无功能损害，但浪费一次 finalize 调用 + DEV warn 噪音）。
    clearPendingSend(sessionId)
    clearStreamingTimer(sessionId)
    // 收口日志：仅异常 reason 打 dev warn（保留诊断价值），normal/aborted 正常路径不打（去长对话噪音）
    if (isDevMode() && reason !== 'normal' && reason !== 'aborted') console.warn(`[chat] finalizeSession sid=${sessionId} reason=${reason}`)
  }

  /**
   * [W1 timer-decouple] bash timer 专用收口（C2 回归防护）。
   *
   * L1 放宽 bash↔streaming 并发后，bash 与 assistant turn 可能共存。原 bash timer 到期
   * 调 finalizeSession('timeout') 会把正在 streaming 的 assistant turn 一并收口（C2 回归）。
   * 此函数只把 streaming bash 消息推到 error 态（cancelled=true），**不**清 streaming timer、
   * **不**清 pendingSend、**不**调 finalizeSession——bash timer 不应碰 streaming 域。
   *
   * 幂等：无 streaming bash 消息时 no-op（与 bashResultEffect/markBashError 的 findLastIndex 一致）。
   */
  function finalizeBashOnly(sessionId: string): void {
    const prev = messages.value.get(sessionId) ?? []
    // [S7] 复用 findLastStreamingBashIndex，与 bashResultEffect/markBashError 一致。
    const realIdx = findLastStreamingBashIndex(prev, sessionId)
    if (realIdx === -1) return
    const next = prev.map((m, i) => i === realIdx ? {
      ...m,
      status: 'error' as const,
      bashExecution: { ...m.bashExecution!, cancelled: true },
      error: 'timeout',
    } : m)
    commitMessages(messages, sessionId, next)
  }

  /**
   * 多 session 统一收口（F1 修正 + W3 瞬态全收口）：遍历所有可能持有瞬态态的 session，
   * 对每个有瞬态态的调 resetTransientStates（一次性清 streaming + compacting + retry + queue +
   * pendingSend）。
   *
   * useConnection runtime 重启/失败/断连时调此 helper，确保后台 session 的全部瞬态指示位收口，
   * 避免 UI 在断连后永久卡「生成中 / 压缩中 / 重试中 / 队列中」。
   *
   * 遍历范围：messages.keys() ∪ compactingSessions ∪ retryStates ∪ queueStates 的 key 并集。
   * 不能只遍历 messages.keys()——compacting / retry / queue 可能独立于消息存在（如 setCompacting
   * 直接置位、auto_retry_start 只写 retryStates 不写 messages），仅遍历 messages 会漏掉这些 session。
   */
  function finalizeAllStreaming(reason: FinalizeReason): void {
    const candidateSids = streamingStateMachine.collectFinalizeCandidates()
    for (const sid of candidateSids) {
      if (isGenerating(sid) || isCompacting(sid) || isHandingOff(sid) || retryStates.value.has(sid) || queueStates.value.has(sid) || pendingSend.value.has(sid)) {
        resetTransientStates(sid, reason)
      }
    }
  }

  /**
   * 统一瞬态状态收口 helper（W3）：一次性清理指定 session 的全部瞬态指示位。
   *
   * 背景：断连 / runtime 重启等异常路径下，compactingSessions / retryStates / queueStates
   * 不再有事件驱动清理（断连意味着不会再有 session.compacted / auto_retry_end / queue_update
   * 到达），若不主动清则永久残留（UI 卡「压缩中 / 重试中」）。
   *
   * 与 finalizeSession 的关系：finalizeSession 是消息流正常/异常收口（只清 streaming 实体 +
   * pendingSend + timer，保留 session 级独立状态如 compacting——compaction 由 session.compacted
   * 事件独立清，不能被消息收尾误清）。resetTransientStates 是更广的「断连兜底全清」，在
   * finalizeSession 基础上额外清 compacting / retry / queue。
   *
   * @param reason 透传给 finalizeSession 决定 message.status 终态映射（见 FinalizeReason）
   */
  function resetTransientStates(sessionId: string, reason: FinalizeReason = 'disconnect'): void {
    // 先走 finalizeSession 收口 streaming 实体 + 清 pendingSend + 清 timer（保留其幂等语义）
    finalizeSession(sessionId, reason)
    // 再清 session 级独立瞬态（断连兜底：这些态在断连后无事件驱动清理）
    streamingStateMachine.clearIndependentTransient(sessionId)
  }

  // ── pendingSend 生命周期（useChat/effects 经 ctx/port 调）──

  /** send 前置位（填空窗）。不可变 Set add（保证响应式）。同时挂 pendingSendTimer（D-015）。 */
  function addPendingSend(sessionId: string): void {
    pendingSend.value = new Set(pendingSend.value).add(sessionId)
    clearPendingSendTimer(sessionId)
    pendingSendTimers.set(sessionId, setTimeout(() => {
      finalizeSession(sessionId, 'timeout')
      pendingSendTimers.delete(sessionId)
    }, PENDING_SEND_TIMEOUT_MS))
  }

  /** message_start（正常）/ finalizeSession（异常）/ abort（乐观）/ send.rejected（回滚）调。幂等。 */
  function clearPendingSend(sessionId: string): void {
    if (pendingSend.value.has(sessionId)) {
      const next = new Set(pendingSend.value)
      next.delete(sessionId)
      pendingSend.value = next
    }
    clearPendingSendTimer(sessionId)
  }

  function clearPendingSendTimer(sessionId: string): void {
    clearSessionTimer(pendingSendTimers, sessionId)
  }

  // ── timer（streaming + bash）：从 chat-timers.ts 提取，闭包注入 finalizeSession ──
  const { armStreamingTimer, clearStreamingTimer, armBashTimer, clearBashTimer, disposeAllTimers } = initTimers(finalizeSession, finalizeBashOnly, STREAMING_TIMEOUT_MS)

  /**
   * session 级错误统一入口：追加 error assistant 消息 + finalizeSession。
   * 用于 session.exited（进程退出）/ error envelope（有 sessionId 时）/ restore 失败等场景。
   */
  function markSessionError(sessionId: string, errorText: string): void {
    const prev = messages.value.get(sessionId) ?? []
    const idx = findLastAssistantIndex(prev)
    if (idx >= 0 && prev[idx].status === 'streaming') {
      finalizeSession(sessionId, 'error', errorText)
      return
    }
    // 无 streaming entity → 直接追加 error 消息
    commitMessages(messages, sessionId, [
      ...prev,
      { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: errorText, status: 'error', timestamp: Date.now() },
    ])
    clearPendingSend(sessionId)
    clearStreamingTimer(sessionId)
  }

  // store 作用域销毁时（HMR 热替换 / $dispose / 测试 teardown）清理 timer，
  // 避免回调操作已废弃的 store 实例 ref + warn 噪音。
  onScopeDispose(() => {
    for (const timer of pendingSendTimers.values()) clearTimeout(timer)
    pendingSendTimers.clear()
    disposeAllTimers()
    handoff.clearAllTimers()
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

  // isHandingOff / setHandingOff / clearHandingOffTimer 委托 createHandoffController（chat-handoff.ts）。

  /** 追加 system 提示行（与规则 #3「错误作为消息插入聊天流」一致：不用顶部 banner）。 */
  const appendSystemNotice = (sessionId: string, text: string): void => {
    const prev = messages.value.get(sessionId) ?? []
    commitMessages(messages, sessionId, [
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

  /** 截断 session 消息到 messageId（编辑重发用）。委托 chat-mutations.truncateMessagesFrom。 */
  const truncateFrom = (sessionId: string, messageId: string, inclusive: boolean): void => truncateMessagesFrom(messages, sessionId, messageId, inclusive)

  /**
   * 清理指定 session 的全部 per-session 状态（deleteSession 调用，S3）。
   *
   * deleteSession 此前只清 session 列表 + panel 绑定，chat store 的 per-session 状态
   * （messages / hydrated / pendingSend / compactingSessions / retryStates / queueStates /
   * failedHistory / changeSetStatuses）永久残留。频繁建删 session 后内存单调增长。
   * 此函数一次性清理该 session 的所有分区数据 + 取消 timer。
   */
  function disposeSession(sessionId: string): void {
    // Map ref：不可变写保证响应式（new Map + delete + 赋值新 Map）。
    // W1 后 messages 是 shallowRef，必须整体替换 .value 才触发；retryStates/queueStates
    // 是深 ref，此写法同样正确触发。统一用"构造新 Map → delete → 赋值"范式。
    // 显式结构类型（对齐原 disposeSession 编排参数）：数组元素统一为 Map<string, unknown>，
    // 避免 TS 将不同 Map 元素推断为具体联合类型导致 new Map(ref.value) 不兼容。
    const mapRefs: { value: Map<string, unknown> }[] = [messages, retryStates, queueStates]
    const setRefs: { value: Set<string> }[] = [hydrated, pendingSend, compactingSessions, handingOffSessions, failedHistory]
    for (const ref of mapRefs) {
      if (ref.value.has(sessionId)) {
        const next = new Map(ref.value)
        next.delete(sessionId)
        ref.value = next
      }
    }
    // Set ref：不可变写保证响应式
    for (const ref of setRefs) {
      if (ref.value.has(sessionId)) {
        const next = new Set(ref.value)
        next.delete(sessionId)
        ref.value = next
      }
    }
    // changeSetStatuses：key 格式 `${sessionId}:${messageId}`，前缀过滤删除
    if (changeSetStatuses.value.size > 0) {
      const prefix = `${sessionId}:`
      let changed = false
      const next = new Map(changeSetStatuses.value)
      for (const key of next.keys()) {
        if (key.startsWith(prefix)) {
          next.delete(key)
          changed = true
        }
      }
      if (changed) changeSetStatuses.value = next
    }
    // timer 清理（模块级 Map，非响应式）
    for (const clear of [() => clearPendingSendTimer(sessionId), () => clearStreamingTimer(sessionId), () => clearBashTimer(sessionId), () => clearHandingOffTimer(sessionId)]) clear()
    disposeLruEntry(sessionId) // R5: 清理 LRU 时序记录，防止内存泄漏
  }

  return {
    messages,
    pendingSend,
    compactingSessions,
    handingOffSessions,
    retryStates,
    queueStates,
    changeSetStatuses,
    failedHistory,
    hydrated,
    getMessages,
    getRetryState, getQueueState,
    getChangeSetStatus, setChangeSetStatus,
    markChangeSetsSuperseded,
    isHydrated, markHistoryFailed, clearHistoryError,
    hydrate, setMessages,
    prependHistory,
    applySubagentStreamDelta: (virtualId: string, lines: string[]) => streamingStateMachine.applySubagentStreamDelta(virtualId, lines),
    finalizeSubagentStream: (virtualId: string) => streamingStateMachine.finalizeSubagentStream(virtualId),
    appendUser,
    appendPending,
    markPendingDelivered,
    removePending,
    applyMessageEvent,
    isGenerating,
    isActive,
    finalizeSession,
    finalizeAllStreaming,
    resetTransientStates,
    addPendingSend,
    clearPendingSend,
    armStreamingTimer,
    armBashTimer,
    clearBashTimer,
    markSessionError,
    isCompacting,
    setCompacting,
    isHandingOff,
    setHandingOff,
    appendSystemNotice,
    truncateFrom,
    applyFileChanges,
    disposeSession,
    // w5 chat-use-chat：abortBash RPC 失败兼底（找最后 streaming bash 消息标 error 态）。
    // store 持有自己的 messages ref，useChat 经此方法调用不碰 ref（解耦 pinia Store/factory
    // 产物的 messages 类型鸿沟：pinia Store.messages 被解包为 Map，factory 产物为 ShallowRef）。
    markStreamingBashError: (sessionId: string, errorText: string) =>
      markBashError(messages, sessionId, errorText, clearBashTimer),
    // W3 H3 LRU
    touchLru,
    evictIfNeeded,
    evictSessionWithVirtual,
    evictVirtualKey,
  }
}

/** chat store factory 产物类型（renderer defineStore 包装 + core 单测共用，避免手写大 interface 漂移） */
export type ChatStoreInstance = ReturnType<typeof createChatStore>
