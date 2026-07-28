/**
 * MessageBus —— per-session 消息广播核心（wave:bus-core）。
 *
 * 职责：维护每个 session 的环形缓冲（streamRing）+ 状态快照（stateSnapshot）+
 * 订阅者集合（subscribers）。publish 时分配 per-session 单调 seq、写 ring、
 * 更新 state 快照、广播给所有订阅者；subscribe 时返回当前 ring 全量快照 +
 * state 快照（last-value）+ 最新 seq；unsubscribe / unsubscribeAll / clearSession
 * 维护订阅生命周期。
 *
 * 双向不变量（由 sessions 与 wsSubscriptions 两 Map 显式维护，测试覆盖）：
 *   ws ∈ sessions[sid].subscribers  ⟺  sid ∈ wsSubscriptions[ws]
 *
 * 不接线真实 WebSocket——BusClient 是最小契约（readyState + send），测试用 mock 注入。
 * 不改协议——seq 是 per-session 内部分配器，不写入 ServerMessage（无协议字段），
 * 经 subscribe 的 lastSeq 暴露给调用方（runtime-wiring wave 用于增量同步）。
 *
 * 错误路径：
 * - ES1：clearSession 对不存在 session no-op（幂等）。
 * - ES2：unsubscribe / unsubscribeAll 对未订阅 ws no-op（幂等）。
 * - ES4：publish 广播时单个 ws.send 抛错——try/catch 兜底，单 ws 失败不影响其它 ws 与 publish 主流程。
 */
import type { ServerMessage } from '@xyz-agent/shared'
import type { BusClient, SessionBusState } from './types.js'

/** streamRing 默认容量（FIFO，满则 shift 最旧）。 */
const DEFAULT_RING_CAPACITY = 1000

/**
 * state topic 的 typeKey 占位映射（slice GAP3）。
 *
 * 把 ServerMessage.type 映射到 stateSnapshot 的 typeKey——同 typeKey 的新消息覆盖旧（状态去重语义）。
 * 返回 null 表示该消息不是 state topic（进 streamRing 但不进 stateSnapshot）。
 *
 * 占位映射：当前只覆盖 4 个明确的 state topic；完整映射在 runtime-wiring wave 细化。
 * TC10 只测『同 typeKey 覆盖』语义，不依赖完整映射。
 *
 * @param message 待判定消息
 * @returns typeKey（写入 stateSnapshot 的 key）或 null（非 state topic）
 */
function stateTypeKey(message: ServerMessage): string | null {
  const map: Record<string, string> = {
    'session.commands': 'commands',
    'context.update': 'context',
    'session.subagents': 'subagents',
    'session.workflows': 'workflows',
  }
  return map[message.type] ?? null
}

/**
 * per-session 消息广播核心。
 *
 * 两个 Map 显式管理 session 与订阅者：
 * - sessions：sessionId → SessionBusState（ring + snapshot + subscribers）。
 * - wsSubscriptions：ws → Set<sessionId>（反查表，unsubscribeAll 用它一次清掉该 ws 的所有订阅）。
 *
 * ringCapacity 是 ring 上限，构造时固定（默认 1000）。
 */
export class MessageBus {
  /** sessionId → SessionBusState。 */
  private readonly sessions = new Map<string, SessionBusState>()
  /** ws → Set<sessionId>（反查表，双向不变量维护 + unsubscribeAll 用）。 */
  private readonly wsSubscriptions = new Map<BusClient, Set<string>>()
  /** ring 容量（构造时固定）。 */
  private readonly ringCapacity: number

  /**
   * @param ringCapacity streamRing 容量上限，默认 1000。满时 publish 淘汰最旧（shift）。
   */
  constructor(ringCapacity: number = DEFAULT_RING_CAPACITY) {
    this.ringCapacity = ringCapacity
  }

  /**
   * 发布消息到 session：分配 seq → 写 ring → 更新 state 快照 → 广播。
   *
   * 步骤：
   * 1. lazy 创建 session 状态（首次 publish 时建 entry）。
   * 2. ++seqCounter（per-session 单调）。
   * 3. push streamRing；若超出 ringCapacity，shift 淘汰最旧（FIFO，不阻塞 publish）。
   * 4. 若是 state topic（stateTypeKey 非 null），更新 stateSnapshot（同 typeKey 覆盖）。
   * 5. 遍历 subscribers，readyState===1（OPEN）的 ws 调 send(JSON.stringify(message))；
   *    单个 ws.send 抛错 try/catch 兜底（ES4），不影响其它 ws 与 publish 主流程。
   *
   * @param sessionId 目标 session
   * @param message 待发布消息（广播时 JSON.stringify，不修改 message 自身字段）
   */
  publish(sessionId: string, message: ServerMessage): void {
    const state = this.getOrCreateSession(sessionId)
    state.seqCounter += 1
    state.streamRing.push(message)
    // ring FIFO：超容量则淘汰最旧（shift）。不会阻塞 publish。
    while (state.streamRing.length > this.ringCapacity) {
      state.streamRing.shift()
    }
    // state topic：更新快照（同 typeKey 覆盖，状态去重语义）。
    const typeKey = stateTypeKey(message)
    if (typeKey !== null) {
      state.stateSnapshot.set(typeKey, message)
    }
    // 广播：readyState===1（OPEN）才发；单 ws.send 抛错 ES4 兜底。
    const payload = JSON.stringify(message)
    for (const ws of state.subscribers) {
      if (ws.readyState !== 1) continue
      try {
        ws.send(payload)
      } catch (e) {
        // ES4：单个 ws.send 抛错（连接已断 / 内部异常）不应影响其它订阅者或 publish 主流程。
        // 不 rethrow，继续广播给下一个 ws。
        console.warn('[message-bus] ws.send failed during publish:', e)
      }
    }
  }

  /**
   * 订阅 session：加入 subscribers + 反查表，返回当前 ring 全量快照 + state 快照 + 最新 seq。
   *
   * 步骤：
   * 1. lazy 创建 session（首次 subscribe 也建 entry——保证 lastSeq 从 0 起）。
   * 2. subscribers.add(ws) + wsSubscriptions[ws].add(sid)（双向不变量）。
   * 3. 返回：
   *    - snapshot：[...streamRing]（浅拷贝，防外部修改内部 ring），流式消息历史。
   *    - stateSnapshot：[...stateSnapshot.values()]（4 个 state topic 的 last-value 拷贝）。
   *      wave:remove-bandaids 新增——让 renderer subscribe 后一次性把 commands/context/subagents/
   *      workflows 的当前状态灌入对应 store（reconcile），替代 selectSession/submitFirstMessage
   *      内的主动拉取 RPC 兜底。stateSnapshot 与 snapshot 独立：snapshot 受 subscribe RPC 的 fromSeq
   *      增量过滤影响（runtime-wiring session-message-handler），stateSnapshot 是 last-value 语义不受影响。
   *    - lastSeq：seqCounter（已 publish 的消息数）。
   *
   * @param sessionId 目标 session
   * @param ws 订阅者（BusClient，满足 readyState + send 契约）
   * @returns snapshot/stateSnapshot 均为当前状态的浅拷贝；lastSeq 是当前 seqCounter
   */
  subscribe(sessionId: string, ws: BusClient): {
    snapshot: ServerMessage[]
    stateSnapshot: ServerMessage[]
    lastSeq: number
  } {
    const state = this.getOrCreateSession(sessionId)
    state.subscribers.add(ws)
    this.getOrCreateWsSubs(ws).add(sessionId)
    return {
      snapshot: [...state.streamRing],
      stateSnapshot: [...state.stateSnapshot.values()],
      lastSeq: state.seqCounter,
    }
  }

  /**
   * 取消单个 session 订阅（幂等，ES2）。
   *
   * 从 sessions[sid].subscribers 与 wsSubscriptions[ws] 双向删除；
   * wsSubscriptions[ws] 集合空则 delete ws entry（防反查表累积空 Set）。
   *
   * @param sessionId 目标 session
   * @param ws 订阅者
   */
  unsubscribe(sessionId: string, ws: BusClient): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    state.subscribers.delete(ws)
    const subs = this.wsSubscriptions.get(ws)
    if (subs) {
      subs.delete(sessionId)
      if (subs.size === 0) {
        this.wsSubscriptions.delete(ws)
      }
    }
  }

  /**
   * 取消该 ws 的所有 session 订阅（连接断开时调用，幂等，ES2）。
   *
   * 遍历 wsSubscriptions[ws] 的全部 sid，逐个从 sessions[sid].subscribers 删除 ws；
   * 最后 delete wsSubscriptions[ws]。
   *
   * @param ws 订阅者
   */
  unsubscribeAll(ws: BusClient): void {
    const subs = this.wsSubscriptions.get(ws)
    if (!subs) return
    for (const sid of subs) {
      this.sessions.get(sid)?.subscribers.delete(ws)
    }
    this.wsSubscriptions.delete(ws)
  }

  /**
   * 清除整个 session 状态（session 销毁时调用，幂等，ES1）。
   *
   * 取 entry → 遍历其 subscribers 的每个 ws，从 wsSubscriptions[ws] 删除 sid
   * （集合空则 delete ws entry，维持反查表不累积空 Set）→ sessions.delete(sid)。
   *
   * @param sessionId 目标 session
   */
  clearSession(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    for (const ws of state.subscribers) {
      const subs = this.wsSubscriptions.get(ws)
      if (subs) {
        subs.delete(sessionId)
        if (subs.size === 0) {
          this.wsSubscriptions.delete(ws)
        }
      }
    }
    this.sessions.delete(sessionId)
  }

  /**
   * lazy 创建 session 状态（首次 publish/subscribe 时建 entry）。
   * seqCounter 从 0 起（首次 publish 后变 1）。
   */
  private getOrCreateSession(sessionId: string): SessionBusState {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = {
        seqCounter: 0,
        streamRing: [],
        stateSnapshot: new Map(),
        subscribers: new Set(),
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  /**
   * lazy 创建 wsSubscriptions[ws] 反查集合。
   */
  private getOrCreateWsSubs(ws: BusClient): Set<string> {
    let subs = this.wsSubscriptions.get(ws)
    if (!subs) {
      subs = new Set()
      this.wsSubscriptions.set(ws, subs)
    }
    return subs
  }
}
