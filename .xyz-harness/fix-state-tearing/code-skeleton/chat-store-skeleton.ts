/**
 * code-skeleton: stores/chat.ts + chat-store-types.ts —— 派生模型重构（#2 核心根因修复）
 *
 * 对应 packages/renderer/src/stores/chat.ts + chat-store-types.ts 改动：
 * - 删 isStreaming/streamingSessionId/dispatchingSessionId/setStreaming/setDispatching/resetActive/clearDispatchingTimer/clearStreamingTimer
 * - 加 FinalizeReason(chat-store-types) + pendingSend + isGenerating + isActive(重定义) + finalizeSession + addPendingSend/clearPendingSend
 * - STREAMING_TIMEOUT_MS 改读 env，callback 改调 finalizeSession('timeout')
 *
 * 接线层级：
 * - isGenerating: 模块内直调（isActive 调）+ 跨模块 port（测试/Panel 读）
 * - isActive: 跨模块 port（Composer/useChat 消费）
 * - finalizeSession: 跨模块 port（effects/useConnection/timer 调）
 *
 * 骨架密度（Level 1）：isActive 真接线 isGenerating + pendingSend（模块内调用链）；
 * isGenerating/finalizeSession/addPendingSend/clearPendingSend 为叶子（实体收口/scan 逻辑属实现期）。
 */
import { defineStore } from 'pinia'
import { ref, type Ref } from 'vue'
import type { Message } from '@xyz-agent/shared'

// ── chat-store-types.ts 新增（跨 chat.ts + effects 共享）──

/**
 * finalizeSession 收口原因（与 system-arch §5 reason 字段对齐）。
 *
 * reason → 终态映射（finalizeSession 内部不变式）：
 *   normal      → message:complete, toolCall:end_not_received（诚实态，迟到 tool_call_end 覆盖到 completed，D-011）
 *   aborted     → message:complete, toolCall:end_not_received（同上，D-008 message 保持 complete）
 *   stream_error→ message:error,     toolCall:error
 *   error       → message:error,     toolCall:error
 *   timeout     → message:error,     toolCall:end_not_received
 *   disconnect  → message:error,     toolCall:end_not_received
 *   restart     → message:error,     toolCall:end_not_received
 */
export type FinalizeReason =
  | 'normal'
  | 'aborted'
  | 'stream_error'
  | 'error'
  | 'timeout'
  | 'disconnect'
  | 'restart'

// effects 共享类型（落地时住在 chat-store-types.ts）
export interface QueueState { steering: unknown[]; followUp: unknown[] }
export interface RetryState { retrying: boolean }

// ── chat.ts 重构骨架 ──

export const useChatStore = defineStore('chat', () => {
  /** 按 sessionId 分区的消息表（唯一真值源，实体状态机） */
  const messages: Ref<Map<string, Message[]>> = ref(new Map())

  /**
   * 预期态：ack→message_start 空窗期的「用户已发起未确认」session 集合（取代 dispatchingSessionId）。
   * 与 isGenerating 正交：add 在 send 前，delete 在 message_start（正常）/ finalizeSession（异常）。
   */
  const pendingSend: Ref<Set<string>> = ref(new Set())

  // ── 派生态（computed scan，D-005，零手动维护）──

  /**
   * 指定 session 是否有 streaming 实体（派生，无 setter）。
   *
   * 不变式：`isGenerating(sid) ≡ ∃ m ∈ messages[sid], m.status === 'streaming'`
   * scan 限定 per-session（messages.value.get(sid)），防跨 session 响应式失效扩散。
   * 取代命令式 isStreaming flag —— 物理不可撕裂（无写路径需手动同步）。
   */
  function isGenerating(sessionId: string): boolean {
    // 叶子逻辑：scan messages[sid]?.some(m => m.status === 'streaming')
    throw new Error('not implemented: isGenerating scan')
  }

  /**
   * 指定 session 是否活跃（派生）。
   *
   * 不变式：`isActive(sid) ≡ isGenerating(sid) ∨ pendingSend.has(sid)`
   * 驱动 Composer 停止按钮 / steer guard / B 策略路由。
   * 替代旧 `(isStreaming && streamingSessionId===sid) || dispatchingSessionId===sid`。
   *
   * [接线] 真接线 isGenerating + pendingSend（模块内调用链，tsc 验签名匹配）。
   */
  function isActive(sessionId: string): boolean {
    return isGenerating(sessionId) || pendingSend.value.has(sessionId)
  }

  // ── 收口出口（唯一，D-007 真收口非翻 flag）──

  /**
   * session 级统一收口：把 streaming/running 实体推到终态 + 清 pendingSend + 清 timer。
   *
   * 不变式（幂等，D-010 sealed）：重复调用不报错，sealed 后实体不变。
   * 不处理 usage 回填（message.complete handler 单独 enrichment）。
   *
   * 触发源（6 条异常 + 2 条事件驱动终态）：
   *   timeout(timer) / disconnect(useConn) / restart(useConn)
   *   + message.complete{agent_end/aborted} / message.error / message.stream_error（经 effects）
   *
   * @param reason 决定 message.status + toolCall.status 终态映射（见 FinalizeReason）
   */
  function finalizeSession(sessionId: string, reason: FinalizeReason, errorText?: string): void {
    // 叶子逻辑（实现期填）：
    // 1. 所有 streaming assistant → 终态（complete | error，按 reason 映射）
    //    errorText 可选：reason ∈ {error, stream_error} 时写入（并入末条 streaming content 或新建 error 消息，保持现行语义，F2）
    // 2. running toolCall → 级联终态：一律 end_not_received（error/stream_error→error），不直接 completed（诚实态，F3）
    // 3. pendingSend 不可变 delete(sessionId)
    // 4. clearStreamingTimer（if streamingTimerSid === sessionId）
    // 幂等：实体已终态则 no-op
    // 实现约束：行为按终态类分 3 支（complete/error/end_not_received），reason 原样透传 logger（不按 7 值写 7 个 switch case）
    void sessionId
    void reason
    void errorText
    throw new Error('not implemented: finalizeSession')
  }

  /**
   * 多 session 统一收口（F1 修正）：遍历所有 session，对每个 isGenerating(sid) 的调 finalizeSession。
   * useConnection runtime 重启/失败时调此 helper（非逐个 finalizeSession(activeId)），
   * 确保后台 streaming session 也收口（违背 G1 的陷阱：只清 active 会漏后台 streaming）。
   */
  function finalizeAllStreaming(reason: FinalizeReason): void {
    for (const sid of messages.value.keys()) {
      if (isGenerating(sid)) finalizeSession(sid, reason)
    }
  }

  // ── pendingSend 生命周期（useChat/effects 经 ctx/port 调）──

  /** send 前置位（填空窗）。不可变 Set add（保证响应式）。幂等。同时挂 pendingSendTimer（D-015）。 */
  function addPendingSend(sessionId: string): void {
    // [D-015] 挂 pendingSendTimer（30s 兜底，防 ack 后 pi 静默卡死）
    clearPendingSendTimer()
    pendingSendTimerSid = sessionId
    pendingSendTimer = setTimeout(() => {
      if (pendingSendTimerSid) finalizeSession(pendingSendTimerSid, 'timeout')
    }, PENDING_SEND_TIMEOUT_MS)
    void sessionId
    throw new Error('not implemented: addPendingSend')
  }

  /** message_start（正常）/ finalizeSession（异常）/ abort（乐观）/ send.rejected（回滚）调。幂等。同时清 pendingSendTimer。 */
  function clearPendingSend(sessionId: string): void {
    clearPendingSendTimer()
    void sessionId
    throw new Error('not implemented: clearPendingSend')
  }

  function clearPendingSendTimer(): void {
    if (pendingSendTimer !== null) {
      clearTimeout(pendingSendTimer)
      pendingSendTimer = null
    }
    pendingSendTimerSid = null
  }

  // ── 超时兜底（D-003 阈值可配置 + D-007 真收口）──

  /**
   * streaming 超时阈值。读 env XYZ_STREAMING_TIMEOUT_MS，默认 24h（86_400_000ms）。
   * 24h = 放弃主动时间检测，靠 runtime 重启/WS 断连 + 用户手动停止；timer 是 pi 静默卡死最后兑底。
   *
   * [F5/D-016] renderer 读 env 必须经 IPC 从主进程读（process.env.XYZ_* 在主进程合法，
   * 经 ENV_WHITELIST_PREFIXES 过滤；Vite renderer 的 import.meta.env 不暴露 XYZ_ 前缀）。
   * preload 暴露 electronAPI.getStreamingTimeout() → 主进程读 env。
   */
  const STREAMING_TIMEOUT_MS = readStreamingTimeoutMs()

  function readStreamingTimeoutMs(): number {
    // [D-016] 经 IPC 读主进程 env（非 import.meta.env，Vite 不暴露 XYZ_ 前缀）
    const env = undefined // 占位，实现期接 IPC
    const parsed = env ? Number(env) : Number.NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 86_400_000
  }

  /** streaming 超时 timer（per-session 跟踪，单流场景单值足够，G-023 DEFERRED） */
  let streamingTimer: ReturnType<typeof setTimeout> | null = null
  let streamingTimerSid: string | null = null

  /**
   * pendingSend 空窗期 timer（D-015/F4，接管 dispatchingTimer 30s 语义）。
   * addPendingSend 时挂载，message_start/finalizeSession/clearPendingSend 时清除。
   * 防 pi 静默卡死在 ack 后（进程活、WS 连、不 emit message_start）导致 isActive 恒 true。
   */
  const PENDING_SEND_TIMEOUT_MS = 30_000
  let pendingSendTimer: ReturnType<typeof setTimeout> | null = null
  let pendingSendTimerSid: string | null = null

  /**
   * message_start 挂载超时兜底（防 message.complete 永不到）。
   * callback 改调 finalizeSession('timeout')（D-007 真收口，非翻 flag）。
   */
  function armStreamingTimer(sessionId: string): void {
    clearStreamingTimer()
    streamingTimerSid = sessionId
    streamingTimer = setTimeout(() => {
      // [接线] callback 真接 finalizeSession（模块内调用链）
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

  return {
    // 真值源
    messages,
    pendingSend,
    // 派生态
    isGenerating,
    isActive,
    // 收口出口
    finalizeSession,
    finalizeAllStreaming,
    addPendingSend,
    clearPendingSend,
    // （其余现有 export 如 appendUser/hydrate/truncateFrom/appendPending/markPendingDelivered/removePending 等保持不变，此处省略）
  }
})

// 验证：isActive 真接线 isGenerating + pendingSend（tsc 实证调用链闭合）
// 验证：armStreamingTimer callback 真接线 finalizeSession（tsc 实证）
// 验证：无 isStreaming/streamingSessionId/dispatchingSessionId/setStreaming/setDispatching/resetActive 声明（grep AC-2.1/2.2/6.2）
