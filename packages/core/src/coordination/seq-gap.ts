/**
 * seq-gap —— server-push 消息序号缺口检测（纯函数中间件）。
 *
 * 从 renderer useConnection.ts routeInbound 的 seq gap 检测抽出（IF3/DM1）。
 * 现状逻辑（main 基线）：
 *   - state 不存在或 subscribed=false → 不做 gap 检测，正常 dispatch（渐进迁移兼容路径）
 *   - seq <= lastSeenSeq → 丢弃（reconcile 回放的重复或乱序）
 *   - seq > lastSeenSeq+1 → 触发 subscribeSession(sid, lastSeenSeq) reconcile，当前消息仍 dispatch
 *   - seq === lastSeenSeq+1 → 正常递进，dispatch
 *
 * gap 触发消息去重（PR #175 review R1）：gap 分支 dispatch 了触发消息但基线不推进（MF-3），
 * 而 reconcile 的 subscribe(fromSeq=排他下界) 返回的 snapshot 必含触发消息本身 → 回放时
 * 该 seq 既不满足 seq<=lastSeenSeq（超前于基线）也不是正常递进（缺失段回放会先把基线
 * 推到 seq-1，触发消息恰好变成「递进」再次 dispatch）。靠 SubscriptionState.gapDispatchedSeqs
 * 簿记（applySeqGap gap 分支写入）识别「已 dispatch 但基线未覆盖」的 seq，drop 之。
 *
 * 本模块是纯函数：零副作用、零 import 业务层。副作用（reconcile RPC / updateLastSeenSeq /
 * dispatch）由 route-inbound.ts 依据返回值执行（IF3 契约）。
 */
import type { SubscriptionState } from './subscription-state'

/**
 * seq gap 判定结果（DM1 判别联合，穷举 3 种状态杜绝无效组合）：
 * - drop：丢弃，不 dispatch 不更新基线（reconcile 回放的重复/乱序）
 * - pass 无 reconcileFromSeq：正常递进（dispatch + 更新基线）
 * - pass 带 reconcileFromSeq：gap（dispatch 当前消息 + fire-and-forget subscribeSession(sid, reconcileFromSeq) 回拉）
 *   reconcileFromSeq = lastSeenSeq（runtime session.subscribe 的 fromSeq 是排他下界：只返
 *   seq > fromSeq 的消息（session-message-handler.ts filter），传 lastSeenSeq 恰好覆盖全部缺失段）
 */
export type SeqGapDecision = { action: 'drop' } | { action: 'pass'; reconcileFromSeq?: number }

/**
 * 判定一条带 seq 的 server-push 消息应如何处理（IF3 六分支）。
 *
 * @param msg 带可选 seq 的入站消息（仅读取 seq 字段，其余由调用方处理）
 * @param state 该 session 的订阅状态（undefined = 未订阅/无记录）
 * @returns SeqGapDecision
 */
export function evalSeqGap(
  msg: { seq?: number },
  state: SubscriptionState | undefined,
): SeqGapDecision {
  // 分支 1/2：state 不存在或 subscribed=false → 兼容路径，不做 gap 检测（无副作用）
  if (!state || !state.subscribed) {
    return { action: 'pass' }
  }
  // 分支 3：seq 非 number（undefined 或脏数据）→ 无 gap 语义，正常 dispatch
  if (typeof msg.seq !== 'number') {
    return { action: 'pass' }
  }
  // 分支 4：重复/乱序（reconcile 回放）→ 丢弃。两种形态：
  //   a) seq <= lastSeenSeq：基线已覆盖（正常递进路径 dispatch 时同步推进基线）
  //   b) seq ∈ gapDispatchedSeqs：gap 触发消息已 dispatch 但基线未推进（MF-3 禁止提前推进），
  //      reconcile 回放 / 重复 push 到达时靠簿记去重
  if (msg.seq <= state.lastSeenSeq || state.gapDispatchedSeqs?.has(msg.seq)) {
    return { action: 'drop' }
  }
  // 分支 5：seq > lastSeenSeq + 1 → gap，当前消息仍 dispatch + 回拉缺失段。
  // reconcileFromSeq 传 lastSeenSeq 而非 seq-1：subscribe 的 fromSeq 是排他下界（只返
  // seq > fromSeq），传 seq-1 会漏掉 lastSeenSeq+1..seq-1 整个缺失段（MF-1）。
  if (msg.seq > state.lastSeenSeq + 1) {
    return { action: 'pass', reconcileFromSeq: state.lastSeenSeq }
  }
  // 分支 6：seq === lastSeenSeq + 1 → 正常递进
  return { action: 'pass' }
}
