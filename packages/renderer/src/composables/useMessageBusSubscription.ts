/**
 * useMessageBusSubscription —— MessageBus 订阅状态管理（runtime-message-bus slice）。
 *
 * 职责（DM4 + IF8 + ES3）：
 * - 维护 per-session 的 SubscriptionState（lastSeenSeq + subscribed 标记）
 * - subscribeSession：调 sessionApi.subscribe RPC → 把返回的 snapshot 依次 dispatch 到 events
 *   通道（reconcile 回放历史）→ 记 lastSeenSeq → 标记 subscribed
 * - getSubscriptionState：routeInbound 用此判是否启用 gap 检测
 * - clearSubscription：session 销毁时清理（useChat.disposeSession 调用）
 * - updateLastSeenSeq：live push 收到合法递进 seq 时更新基线
 *
 * 为什么用模块级单例 Map 而非 Vue 响应式 store（T1）：
 * - routeInbound 在 useConnection 顶层闭包需同步访问（不能依赖 Pinia store 实例化时机）
 * - 这是 WS 订阅状态（数据完整性层），非 per-instance UI 状态——UI 经 events 通道消费消息，
 *   不直接读 lastSeenSeq（lastSeenSeq 变化不触发 UI 更新，无副作用）
 * - 参照 useChat.streamSubscriptions 的模块级 Map 模式（会话级长订阅去重）
 *
 * 渐进迁移（T2）：gap 检测只对「已 subscribe（state 存在且 subscribed=true）」的 session 生效。
 * 未 subscribe 的 session（useChat.ensureStreamSubscription 旧路径未走 subscribeSession）不做
 * gap 检测，正常 dispatch。统一在 remove-bandaids wave 完成。
 *
 * 依赖方向：useMessageBusSubscription → api/domains/session（subscribe RPC）+ api/events（回放）。
 * 不依赖任何 store（routeInbound 在 useConnection 全局闭包直接 import 调用）。
 */
import type { ServerMessage } from '@xyz-agent/shared'
import * as events from '@/api/events'
import { session as sessionApi } from '@/api'

/**
 * per-session 订阅状态。
 *
 * - lastSeenSeq：最后处理的 server-push seq（gap 检测基线）。0 表示无历史（首次订阅空 snapshot）。
 * - subscribed：是否已完成 subscribe RPC + snapshot 回放。true 后 routeInbound 启用 gap 检测。
 *   false 或 state 不存在 → 兼容路径（不 gap 检测，正常 dispatch）。
 */
export interface SubscriptionState {
  lastSeenSeq: number
  subscribed: boolean
}

/**
 * 模块级单例订阅状态表（sessionId → SubscriptionState）。
 *
 * 跨 useConnection / useChat 共享同一份（routeInbound 读 + 更新，subscribeSession 写，
 * disposeSession 删）。与 useChat.streamSubscriptions 同范式（会话级状态在模块顶层）。
 */
const subscriptionStates = new Map<string, SubscriptionState>()

/**
 * 订阅指定 session 的 live 事件流（幂等：已 subscribed 则 no-op）。
 *
 * 流程：
 *   1. 幂等守卫：state.subscribed=true 直接 return（重复 subscribe 不重复 RPC、不重放 snapshot）
 *   2. 调 sessionApi.subscribe(sessionId, fromSeq) → reply { snapshot, lastSeq, gap? }
 *   3. applySnapshot：snapshot 内每条 ServerMessage 依次 events.dispatchSession（回放历史，
 *      与 live push 同一通道消费）
 *   4. 记 lastSeenSeq=lastSeq（后续 gap 检测基线）+ 标记 subscribed=true
 *
 * @param sessionId 目标 session
 * @param fromSeq 可选，gap reconcile 时指定起始 seq 回拉缺失段（首次订阅不传）
 *
 * 失败处理：subscribe RPC 失败时 console.warn，不标记 subscribed（下次可重试）。
 * 调用方（ensureStreamSubscription）fire-and-forget 不 await，失败属连接级故障，WS 重连后重建。
 */
export async function subscribeSession(sessionId: string, fromSeq?: number): Promise<void> {
  // 幂等守卫：已 subscribed 不重复订阅（避免 reconcile 期间重复 RPC + snapshot 二次回放）。
  // 但 fromSeq 显式传入时（gap 检测触发 reconcile）跳过守卫——这是显式 backfill 请求，
  // 必须发 RPC 回拉缺失段（即使已 subscribed）。
  const existing = subscriptionStates.get(sessionId)
  if (existing?.subscribed && fromSeq === undefined) return

  let reply: { snapshot: ServerMessage[]; lastSeq: number; gap?: boolean }
  try {
    reply = await sessionApi.subscribe(sessionId, fromSeq)
  } catch (e) {
    // subscribe 失败：不标记 subscribed（下次 ensureStreamSubscription 可重试）。
    // 不抛——调用方 fire-and-forget，抛出变 unhandled rejection（错误已 console.warn 消化）。
    console.warn(`[useMessageBusSubscription] subscribe failed for session ${sessionId}:`, e)
    return
  }

  // applySnapshot：回放历史到 events 通道（与 live push 同一消费入口）。
  // snapshot 元素是带 seq 的 ServerMessage（bus ring 内当前事件序列），逐条 dispatchSession
  // 让订阅端（useChat/useSessionEvents 等）复现已发生事件。
  //
  // 注：reconcile（fromSeq 传入）回放的 snapshot 可能与 gap 期间已 dispatch 的 live 消息重叠
  // （routeInbound 在触发 reconcile 时仍 dispatch 了当前 msg），存在重复 dispatch 的竞态（R2）。
  // 订阅端需自行幂等（如 chat store 按 message id 去重）。本 wave 不在 dispatch 层做去重
  // （会破坏 events 层纯分发语义），统一治理在 remove-bandaids wave。
  for (const msg of reply.snapshot) {
    events.dispatchSession(sessionId, msg)
  }

  // 记基线 + 标记 subscribed（后续 routeInbound 启用 gap 检测）。
  // lastSeq 可能小于已 dispatch 的某条 snapshot seq（ring 溢出场景）或小于 routeInbound 已更新
  // 的 lastSeenSeq（reconcile 期间 live 消息已推进基线），取 max 保证基线不回退。
  const existingNow = subscriptionStates.get(sessionId)
  const prevLastSeen = existingNow?.lastSeenSeq ?? 0
  const maxSnapshotSeq = reply.snapshot.reduce((max, m) => (typeof m.seq === 'number' && m.seq > max ? m.seq : max), 0)
  const lastSeenSeq = Math.max(reply.lastSeq, maxSnapshotSeq, prevLastSeen)
  subscriptionStates.set(sessionId, { lastSeenSeq, subscribed: true })
}

/**
 * 读取 session 的订阅状态。
 *
 * routeInbound 用此判是否启用 gap 检测：
 * - 返回 undefined 或 subscribed=false → 兼容路径（未 subscribe，不做 gap 检测，正常 dispatch）
 * - 返回 subscribed=true → 启用 gap 检测（seq<=lastSeenSeq 丢弃，seq>lastSeenSeq+1 触发 reconcile）
 *
 * @returns state 或 undefined（未订阅）
 */
export function getSubscriptionState(sessionId: string): SubscriptionState | undefined {
  return subscriptionStates.get(sessionId)
}

/**
 * 清除 session 的订阅状态（session 销毁时调用）。
 *
 * useChat.disposeSession 调用（session 删除/销毁）：清除此 session 的 SubscriptionState，
 * 后续该 session 的带 seq 消息走兼容路径（不 gap 检测）。与 streamSubscriptions.delete 配对。
 */
export function clearSubscription(sessionId: string): void {
  subscriptionStates.delete(sessionId)
}

/**
 * 更新 session 的 lastSeenSeq（routeInbound 收到合法递进 seq 时调用）。
 *
 * state 不存在时 no-op（兼容路径不维护基线）。仅更新 lastSeenSeq，不动 subscribed 标记。
 */
export function updateLastSeenSeq(sessionId: string, seq: number): void {
  const state = subscriptionStates.get(sessionId)
  if (state) {
    state.lastSeenSeq = seq
  }
}

/**
 * 重置所有订阅状态（测试隔离用）。
 *
 * 生产代码无需调用（session 切换/删除时各自清理：disposeSession 调 clearSubscription）。
 * 测试间不 reset 会泄漏到下一用例（subscriptionStates 残留 → gap 检测误判）。
 * 测试需在 beforeEach 调用本函数清空 Map（与 useChat.resetChatModuleState 配合）。
 */
export function resetSubscriptionStates(): void {
  subscriptionStates.clear()
}
