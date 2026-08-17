/**
 * chat store factory（IF1）—— chat 域状态管理 SSOT（state + actions）。
 * 设计决策叙事（归位历史 / factory 模式 / 状态撕裂修复 / 响应式策略 / 流式块类型 /
 * FileChanges 通道 / 收口出口设计 / 子域控制器委托）见 ./README.md。
 * 本文件仅保留与代码行为直接绑定的短契约注释。
 */
import { computed, onScopeDispose, ref, shallowRef, type ComputedRef, type ShallowRef } from 'vue'
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
import { normalizeContent, segmentsToText } from '@xyz-agent/shared'
import type { RetryState, QueueState, FinalizeReason } from './store-types'
import { isDevMode } from '../../platform/dev-mode'

/**
 * pendingBuffer 单项（m1 数据层，steer/follow-up 暂存）。
 *
 * text 用于匹配 pi 回流投递信号（normalizeContent + trim 归一化）；
 * segments 是原始 Segment[]，drain 时取出交 appendUser 进对话流（m2 接线，m1 不接）。
 * sendMode 区分 steer / follow-up，驱动气泡配色。
 */
interface PendingItem {
  text: string
  segments: Segment[]
  sendMode: SteerFollowUpMode
}

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
 * 构造 chat 域全部 state + actions（无参）。factory 模式与归位历史见 ./README.md。
 * 内部用 onScopeDispose（清 timer），调用方需在 effectScope 上下文内执行本 factory。
 */
export function createChatStore() {
  /** 按 sessionId 分区的消息表（UC-2 隔离） */
  // W10 D-1 容器范式：`ShallowRef<Map<string, ShallowRef<Message[]>>>`——外层 Map 恒等稳定
  // （只在增删 sid key 时替换），每 sid 持有独立内层 ShallowRef。同 sid commit 只替换该分区
  // 的内层 ref（commitMessages existing.value = next），A session 更新不触发依赖 B session
  // 分区的 watcher/computed 重算。写入全部走 commitMessages（见 mutations.ts）。
  // 浅代理边界对齐 ADR-0039：浅到「外层 Map + 每 sid 数组」两层，Message 对象不代理。
  const messages = shallowRef(new Map<string, ShallowRef<Message[]>>())
  /** 已 hydrate 的 session（避免切换时重复注入历史） */
  const hydrated = ref<Set<string>>(new Set())
  /**
   * 预期态：ack→message_start 空窗期的「用户已发起未确认」session 集合。
   * 取代 dispatchingSessionId（单值）。跨 session 顺序发送需要 Set（跨 panel 切换）。
   * 与 isGenerating 正交：add 在 send 前，delete 在 message_start（正常）/ finalizeSession（异常）。
   */
  const pendingSend = ref<Set<string>>(new Set())
  /** 正在压缩的 session 集合（#6：session.compacting/compacted 驱动，按 session 隔离）。
   *  membership 查询（isCompacting）用此 Set；streaming-state-machine 遍历 finalize 候选也用此 Set。 */
  const compactingSessions = ref<Set<string>>(new Set())
  /** compacting reason 平行表（M4：session.compacting{reason} 驱动，与 compactingSessions 同步维护）。
   *  区分手动（'manual'）/自动（'threshold'|'overflow'），驱动 MessageStream compacting 浮层文案。
   *  与 compactingSessions 同生共死：setCompacting 单点写入保证一致性。 */
  const compactingReasons = ref<Map<string, string>>(new Map())
  /** handingOff 瞬时态子域控制器（对称 compactingSessions），委托 chat-handoff.ts。设计见 ./README.md + chat-handoff.ts。 */
  const handoff = createHandoffController()
  const { handingOffSessions, isHandingOff, setHandingOff, clearHandingOffTimer } = handoff
  /** 按 sessionId 分区的自动重试态（W06-B，auto_retry_start/end） */
  const retryStates = ref<Map<string, RetryState>>(new Map())
  /** 按 sessionId 分区的消息队列态（W06-B，queue_update） */
  const queueStates = ref<Map<string, QueueState>>(new Map())
  /**
   * steer/follow-up 暂存缓冲（m1 数据层）。
   *
   * 与 messages 解耦——pushPending 只写本 buffer，不写 messages（pending 不进对话流）。
   * 投递信号 queue_update 到达时，drainPending 取出 segments 交 appendUser 进对话流（m2 接线）。
   * 与 queueStates 同层 ref<Map<string, T>>，disposeSession 一并清理（T2）。
   *
   * [M4 queue 子域归位契约] queue 纯状态（queueStates pi 快照 + pendingBuffer 前端暂存）
   * 全部归位 core 本 store，renderer 无副本（stores/chat.ts 仅 defineStore 薄包装）。
   * flush/取消的编排（调 chatApi.send/steer）留在 renderer shell（useCompactQueue.ts），
   * core 只经 deps.getCompactQueue() 注入调用——core 域文件不 import renderer api。
   * 组件消费点唯一：QueueBubble 经 Composer → chatStore.getQueueState 读 queueStates；
   * CompactQueueBadge 经 useCompactQueue() 单例读 compact 暂存。pendingBuffer 属 drain
   * 恢复机制留在 store（SSOT 检查点 2 裁决：不强行并入统一视图）。
   */
  const pendingBuffer = ref<Map<string, PendingItem[]>>(new Map())
  /** FileChanges 子域控制器（W10，ADR-0024 D5），委托 chat-changeset.ts。messages 由本 store 注入，设计见 ./README.md + chat-changeset.ts。 */
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
  /**
   * pendingSend 空窗期 timer（按 sessionId 隔离）。
   *
   * [ADR-0049 例外] 本 Map 不套 useSessionScopedState。判据：createChatStore() factory 由
   * renderer defineStore('chat', () => createChatStore()) 包装（renderer stores/chat.ts），
   * Pinia 按 store id 缓存——factory body 全应用只执行一次，本 Map 实质单例。factory 体内非
   * Vue setup 上下文（虽在 effectScope 内用 onScopeDispose，但无 sidRef: Ref<string|null>）；
   * Map 存的是 timer handle（ReturnType<typeof setTimeout>，非 reactive 业务状态）。
   * useSessionScopedState 是 setup-scoped 工厂（要求 sidRef + reactive 容器契约），factory
   * 体内不适用——强套需把 factory 改造成 setup composable（破坏 Pinia store 单例语义：
   * 每次 useStore() 重新执行会重建 Map 丢失单例）+ reactive 容器语义错位（timer handle 不是
   * 响应式状态）。与 lru/coordination/panel-orchestration 同属 ADR-0049 例外（单例性来源不同：
   * 那几处是模块级 ES module 单例，本处是 Pinia defineStore factory 单例）。session 销毁清理：
   * 本文件 onScopeDispose（见末尾）for + clearTimeout + clear；测试隔离：createChatStore()
   * per-instance（core 单测直接调 factory 构造新 store）。
   */
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

  // ── 派生态（D-3 per-session 惰性派生，D-005 语义保留）──

  /**
   * per-session streaming flag 惰性派生缓存（D-3，07 文档 §3.3.1(4)）。
   *
   * 取代旧 `streamingSessionIds` 全 Map 重扫 computed（R2：状态未变也 O(Σ消息) 重算的
   * 长对话卡顿放大器）。SSOT 仍是消息数组——每个 flag 是定义在其 sid 分区 ref 上的
   * computed（零 drift），惰性创建（没人问过的 session 不建不算），A session 的 token
   * 提交只失效 A 的 flag，B 的 flag 不重算。
   *
   * [生命周期] 本 Map 与 messages Map 同生共死：`disposeSession` 与 LRU 驱逐
   * （lru.deleteMessageKey）都删对应条目——这是 D-3 引入的唯一新增生命周期状态，
   * 漏删即慢泄漏（07 文档 §3.3.2 cleanup 契约）。
   */
  const sessionStreamingFlags = new Map<string, ComputedRef<boolean>>()

  /**
   * 指定 session 是否有 streaming assistant 实体（惰性派生，无 setter）。
   * 不变式：`isGenerating(sid) ≡ ∃ m ∈ messages[sid], m.role === 'assistant' && m.status === 'streaming'`。
   * 仅反映 assistant streaming——bash 消息（role:'system'）不计入（B1，见 ./README.md）。
   * 判定与旧 streamingSessionIds 逐字等价（仅扫 assistant + status==='streaming'）。
   */
  function isGenerating(sessionId: string): boolean {
    let flag = sessionStreamingFlags.get(sessionId)
    if (!flag) {
      flag = computed(() => {
        const arr = messages.value.get(sessionId)?.value ?? []
        return arr.some((m) => m.role === 'assistant' && m.status === 'streaming')
      })
      sessionStreamingFlags.set(sessionId, flag)
    }
    return flag.value
  }

  /** 活跃（派生）：`isActive(sid) ≡ isGenerating(sid) ∨ pendingSend.has(sid)`。驱动停止按钮 / steer guard / B 策略路由。 */
  function isActive(sessionId: string): boolean {
    return isGenerating(sessionId) || pendingSend.value.has(sessionId)
  }

  /** 取指定 session 的消息数组（空时返回空数组，不写入 Map）。D-1 后读内层 ref 的 .value（接口形状不变，消费方零改动） */
  function getMessages(sessionId: string): Message[] {
    return messages.value.get(sessionId)?.value ?? []
  }

  /** W3 H3：session 是否在 LRU 豁免集（streaming/pending/compacting/handoff 不驱逐，AC-9）。
   *  handingOff 并入（对称 compacting）：交接中 session 被 LRU 驱逐会清 messages，导致 UI
   *  显示「正在交接…」但对话内容消失（reviewer M3 对称性缺口）。 */
  const isLruExempt = (sid: string) => isGenerating(sid) || pendingSend.value.has(sid) || isCompacting(sid) || isHandingOff(sid)
  /** W3 H3：LRU recency 更新（AC-1 真 LRU），直接透传 lruTouch */
  const touchLru = lruTouch
  /**
   * 删除该 sid 的 changeSetStatuses 前缀条目（W19 review Fix-2 从 disposeSession 提取）。
   * key 格式 `${sessionId}:${messageId}`，按前缀过滤删除；两个消费点共用一份逻辑防 drift：
   * disposeSession（deleteSession 编排）+ LRU 驱逐（makeLruEvictDeps 注入，驱逐重进后
   * 历史 messageId 与残留 status key 异源，残留条目行为上碰巧 no-op 但 map 泄漏）。
   */
  function deleteChangeSetStatusesFor(sessionId: string): void {
    if (changeSetStatuses.value.size === 0) return
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
  /** LRU 驱逐依赖（setup 时构造一次复用，闭包经 getter 延迟读取无快照陈旧，详见 ./README.md）。
   *  D-3：deleteStreamingFlag 注入——deleteMessageKey 删 key 时同步清 streaming flag 派生缓存。
   *  W19 review Fix-2：deleteChangeSetStatusesFor 注入——删 messages 分区时同步清该 sid 的
   *  changeSetStatuses 前缀条目（此前仅 disposeSession 清理，LRU 驱逐不清 → map 泄漏）。 */
  const lruEvictDeps = makeLruEvictDeps(messages, hydrated, isLruExempt, (sid) => sessionStreamingFlags.delete(sid), deleteChangeSetStatusesFor)
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

  /** 直接覆盖某 session 的消息（subagent 虚拟 session 用，不受 hydrated 守卫；回流路径截断 AC-10/D9）。 */
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
    const prev = messages.value.get(sessionId)?.value ?? []
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
   * 暂存 steer/follow-up segments 到 pendingBuffer（m1 数据层）。
   *
   * 不碰 messages——pending 不进对话流（核心目标）。投递时 drainPending 取出 segments
   * 交 appendUser（m2 接线）。text = segmentsToText(segments).trim()，供 drainPending/abortPending
   * 匹配 pi 回流投递信号。
   */
  function pushPending(sessionId: string, segments: Segment[], sendMode: SteerFollowUpMode): void {
    const text = segmentsToText(segments).trim()
    const prev = pendingBuffer.value.get(sessionId) ?? []
    pendingBuffer.value = new Map(pendingBuffer.value).set(sessionId, [...prev, { text, segments, sendMode }])
  }

  /**
   * FIFO 取出并移除匹配的 pending item（m1 数据层）。
   *
   * normalizeContent + trim 归一化两边 text，sendMode 可选过滤。
   * 命中返回 segments（交 appendUser 进对话流，m2）；无匹配返回 undefined（幂等）。FIFO——同 text
   * 多次暂存时按入队顺序依次取出（design TC2）。
   */
  function drainPending(sessionId: string, text: string, sendMode?: SteerFollowUpMode): Segment[] | undefined {
    const prev = pendingBuffer.value.get(sessionId)
    if (!prev || prev.length === 0) return undefined
    const target = normalizeContent(text).trim()
    const idx = prev.findIndex(
      (item) => normalizeContent(item.text).trim() === target
        && (sendMode === undefined || item.sendMode === sendMode),
    )
    if (idx === -1) return undefined
    const removed = prev[idx]
    pendingBuffer.value = new Map(pendingBuffer.value).set(sessionId, prev.filter((_, i) => i !== idx))
    return removed.segments
  }

  /**
   * 移除匹配的 pending item（m1 数据层，steer/followUp RPC 失败回滚）。
   *
   * 与 drainPending 同匹配范式但不返回 segments。FIFO 移除第一条匹配项；无匹配 no-op（幂等）。
   * sendMode 必填——abort 明确指定回滚的目标模式（与 drainPending 的可选 sendMode 互补）。
   */
  function abortPending(sessionId: string, text: string, sendMode: SteerFollowUpMode): void {
    const prev = pendingBuffer.value.get(sessionId)
    if (!prev || prev.length === 0) return
    const target = normalizeContent(text).trim()
    const idx = prev.findIndex(
      (item) => normalizeContent(item.text).trim() === target
        && item.sendMode === sendMode,
    )
    if (idx === -1) return
    pendingBuffer.value = new Map(pendingBuffer.value).set(sessionId, prev.filter((_, i) => i !== idx))
  }

  /** message.* 事件单一入口（F2 消除 double-dispatch）：经 dispatchMessageEvent 查 effects/registry.ts 执行全部副作用。非 message.* / 未注册 type no-op。重构等价性见 ./README.md。 */
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
        appendUser,
        drainPending,
      },
      sessionId,
      msg,
    )
  }

  // ── 收口出口（唯一，D-007 真收口非翻 flag）──

  /**
   * session 级统一收口：streaming 实体推终态 + 清 pendingSend + 清 timer。幂等（D-010 sealed）。
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

  /** bash timer 专用收口（W1 timer-decouple，C2 回归防护）：只把 streaming bash 消息推 error 态，**不**清 streaming timer / pendingSend / 调 finalizeSession。幂等（无 streaming bash 时 no-op）。背景见 ./README.md。 */
  function finalizeBashOnly(sessionId: string): void {
    const prev = messages.value.get(sessionId)?.value ?? []
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
   * 多 session 统一收口（断连 / runtime 重启兜底）：遍历瞬态 session，逐个调 resetTransientStates。
   * 遍历范围是 messages.keys() ∪ compactingSessions ∪ retryStates ∪ queueStates 并集
   *（不能只遍历 messages——compacting/retry/queue 可独立于消息存在）。详见 ./README.md。
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
   * 统一瞬态状态收口 helper（W3）：finalizeSession（消息流收口）+ 额外清 compacting / retry / queue
   * 瞬态（断连后无事件驱动清理）。与 finalizeSession 的边界详见 ./README.md。
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
    const prev = messages.value.get(sessionId)?.value ?? []
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

  /** 设置压缩态（session.compacting{reason}→true / session.compacted→false）。
   *  不可变写保证响应性。reason 在 value=true 时挂入 compactingReasons（驱动文案），
   *  value=false 时随 membership 一起清。Set 与 Map 同生共死，单点写入保证一致性。 */
  function setCompacting(sessionId: string, value: boolean, reason?: string): void {
    const nextSet = new Set(compactingSessions.value)
    const nextMap = new Map(compactingReasons.value)
    if (value) {
      nextSet.add(sessionId)
      nextMap.set(sessionId, reason ?? '')
    } else {
      nextSet.delete(sessionId)
      nextMap.delete(sessionId)
    }
    compactingSessions.value = nextSet
    compactingReasons.value = nextMap
  }

  /** 读取 compacting reason（手动 'manual' / 自动 'threshold'|'overflow'），未在压缩时返回 undefined。
   *  MessageStream 据此切文案：手动→compressing / 自动→autoCompressing。 */
  function getCompactingReason(sessionId: string): string | undefined {
    return compactingReasons.value.get(sessionId)
  }

  // isHandingOff / setHandingOff / clearHandingOffTimer 委托 createHandoffController（chat-handoff.ts）。

  /** 追加 system 提示行（与规则 #3「错误作为消息插入聊天流」一致：不用顶部 banner）。 */
  const appendSystemNotice = (sessionId: string, text: string): void => {
    const prev = messages.value.get(sessionId)?.value ?? []
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

  /** 清理指定 session 的全部 per-session 状态（deleteSession 调用，S3）：messages/hydrated/pendingSend/compactingSessions/retryStates/queueStates/failedHistory/changeSetStatuses + timer + LRU 记录。背景见 ./README.md。 */
  function disposeSession(sessionId: string): void {
    // Map ref：不可变写保证响应式（new Map + delete + 赋值新 Map）。
    // D-1 后 messages 的 Map entry 是 per-session ShallowRef 分区——本循环删的是 Map entry
    // （该 sid 分区连同其内层 ref 整体移除），减 key 属外层 Map 合法替换情形（07 §3.3.2）。
    // retryStates/queueStates 是深 ref，此写法同样正确触发。统一用"构造新 Map → delete → 赋值"范式。
    // 显式结构类型（对齐原 disposeSession 编排参数）：数组元素统一为 Map<string, unknown>，
    // 避免 TS 将不同 Map 元素推断为具体联合类型导致 new Map(ref.value) 不兼容。
    const mapRefs: { value: Map<string, unknown> }[] = [messages, retryStates, queueStates, pendingBuffer, compactingReasons]
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
    // （W19 review Fix-2 提取为 deleteChangeSetStatusesFor，与 LRU 驱逐共用一份逻辑）
    deleteChangeSetStatusesFor(sessionId)
    // D-3 生命周期：streaming flag 惰性派生缓存随 messages 分区同点清理（漏删即慢泄漏，
    // 07 文档 §3.3.2 cleanup 契约）。
    sessionStreamingFlags.delete(sessionId)
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
    pendingBuffer,
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
    pushPending,
    drainPending,
    abortPending,
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
    getCompactingReason,
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
    /** 测试专用：暴露 D-3 streaming flag 惰性派生缓存（断言 disposeSession/LRU 驱逐的清理语义用，生产代码勿读）。 */
    _sessionStreamingFlagsForTest: sessionStreamingFlags,
    // W3 H3 LRU
    touchLru,
    evictIfNeeded,
    evictSessionWithVirtual,
    evictVirtualKey,
  }
}

/** chat store factory 产物类型（renderer defineStore 包装 + core 单测共用，避免手写大 interface 漂移） */
export type ChatStoreInstance = ReturnType<typeof createChatStore>
