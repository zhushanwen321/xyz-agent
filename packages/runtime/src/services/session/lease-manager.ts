/**
 * LeaseManager — P5 操作互斥的租约锁状态机。
 *
 * 职责：
 * - acquire(sessionId, clientId, deviceName)：隐式获取/续租 lease（message.send 时调）。
 *   同时检查 busyOwnerId 与 isGenerating（R4-M3）：任一为 true 且 owner≠当前 clientId 返回 busy；
 *   孤儿 pi（isGenerating=true 但 busyOwnerId=undefined）返回 owner='<orphan-pi>'。
 * - renew(sessionId)：续租（只传 sessionId，内部从 session.busyOwnerId 反查 owner，M4）。
 *   挂 event-interpreter pingTick 成功路径。
 * - release(sessionId, reason)：释放 lease（四路径：turn_end/lease_expired/aborted/send_failed），
 *   清 busyOwnerId/leaseExpiresAt（不动 isGenerating）+ 广播 session.idle。
 * - sweepExpired()：reaper 5s 调用，扫 leaseExpiresAt<now 的 session 调 release('lease_expired')。
 * - getBusySession(clientId)：反查 clientId 持有的 session（P7 fallback 用）。
 *
 * 依赖经构造注入：svc（ISessionServiceInternal，读改 session lease 字段）+ broker（broadcast session.idle）。
 * 不直接持有 SessionService 具体类（避免环）。审查 M1：不引入 leaseFence（YAGNI 推迟）。
 */
import type { IMessageBroker } from '../../interfaces.js'
import type { ISessionServiceInternal } from './session-internal.js'

/**
 * lease TTL 默认 90s（spec §3.7「审批挂起期间 lease 不过期」）。
 *
 * **TTL 与 PING_INTERVAL_MS 的关系约束（必须满足）**：TTL > 2 × PING_INTERVAL_MS（60s）。
 * 原因：续租信号挂 event-interpreter pingTick（turn 内每 60s 一次 get_state），setInterval
 * 首次回调在间隔后（即首次续租最早在 turn-start 后 60s）。若 TTL ≤ 60s，turn 开始后到首次
 * ping 之间 lease 会先被 reaper（每 5s 扫）释放，广播 session.idle，UI 误显示 idle。
 *
 * 取 90s 的余量设计：ping 60s 续租 → 90s TTL 保证首次 ping（最晚 turn-start+60s）前 lease
 * 不过期（90 > 60），且 ping 偶发失败一次后还有 30s 余量等下次 ping 补续（90 - 60 = 30）。
 *
 * 原 30s 是基于「崩溃检测窗口 = TTL = 30s」的设想，但忽略了 ping 首次回调在间隔后（非立即），
 * 30s < 60s 必然导致正常 turn 内 lease 被 reaper 误释放。详见 P5 spec §3.7 + MAJOR bug 报告。
 *
 * env XYZ_AGENT_LEASE_TTL_MS 可覆盖（XYZ_ 前缀已在 ENV_WHITELIST）。覆盖时仍须满足
 * TTL > 2 × PING_INTERVAL_MS 约束（否则重蹈 30s bug）。
 */
const DEFAULT_LEASE_TTL_MS = 90_000

/** 孤儿 pi 的 owner 标识（isGenerating=true 但 lease 已过期，前端显示「Agent 正在处理（无主）」）。 */
export const ORPHAN_PI_OWNER = '<orphan-pi>'

/** lease 释放原因（spec D7 四路径 + M3 send_failed）。 */
export type LeaseReleaseReason = 'turn_end' | 'lease_expired' | 'aborted' | 'send_failed'

/** acquire 返回值：成功获取/续租 / 被占用（含 owner 供前端显示）/ session 不存在（防御性拒绝）。 */
export type AcquireResult =
  | { kind: 'acquired'; expiresAt: number }
  | { kind: 'busy'; owner: string; expiresAt: number }
  | { kind: 'not_found' }

/**
 * reaper 定时器间隔（spec D7②：5s 扫描过期 lease）。
 * 提为常量避免魔数；过期后最多 REAPER_INTERVAL_MS 延迟被清理（设计意图，R5 风险已接受）。
 */
export const REAPER_INTERVAL_MS = 5_000

export interface LeaseManagerOptions {
  /** lease TTL（ms），缺省读 env XYZ_AGENT_LEASE_TTL_MS 或 90000。 */
  ttlMs?: number
}

export class LeaseManager {
  private readonly ttlMs: number

  constructor(
    private readonly svc: ISessionServiceInternal,
    private readonly broker: IMessageBroker,
    opts?: LeaseManagerOptions,
  ) {
    this.ttlMs = opts?.ttlMs ?? Number(process.env.XYZ_AGENT_LEASE_TTL_MS ?? DEFAULT_LEASE_TTL_MS)
  }

  /**
   * 隐式获取/续租 lease。
   *
   * session 不存在时防御性返回 not_found（不静默 acquire）：
   * - ensureActive 在 dispatcher acquire 之前调用，正常路径 session 必存在；
   *   但 acquire 是按 sessionId 查的公共方法，竞态/调用方 bug/未来新调用方可能传入不存在的 id，
   *   此时若返回 acquired 会让调用方误以为已持锁（updateSession 对不存在的 session 是 no-op，
   *   lease 实际未写入），后续逻辑基于「已 acquire」假设继续执行会产生不一致状态。
   *   防御性拒绝让调用方显式处理（dispatcher 走 message.error 拒绝本次发送）。
   *
   * 同时检查 busyOwnerId 与 isGenerating（R4-M3）：
   * - 任一为 true 且 owner≠当前 clientId → 返回 busy（owner 是 busyOwnerId 或 '<orphan-pi>'）。
   * - 无 owner（两字段都 false）或同 owner（同 clientId 重复发，如 follow_up）→ acquire/renew。
   *
   * @returns acquired（设 lease 字段，expiresAt=now+ttl）/ busy（含 owner + expiresAt 供前端显示）/ not_found
   */
  acquire(sessionId: string, clientId: string, _deviceName: string): AcquireResult {
    const session = this.svc.getSession(sessionId)
    if (!session) {
      // 防御性拒绝：session 不存在，不静默 acquire（避免调用方误以为已持锁）。
      return { kind: 'not_found' }
    }
    const occupied = session.busyOwnerId || session.isGenerating
    if (occupied && session.busyOwnerId !== clientId) {
      // 被占用且 owner≠当前 clientId → 拒绝。孤儿 pi（isGenerating 但无 owner）返回 <orphan-pi>。
      const owner = session.busyOwnerId ?? ORPHAN_PI_OWNER
      const expiresAt = session.leaseExpiresAt ?? 0
      return { kind: 'busy', owner, expiresAt }
    }
    // 无 owner 或同 owner → acquire/renew（设/续 lease 字段）。
    const expiresAt = Date.now() + this.ttlMs
    this.svc.updateSession(sessionId, { busyOwnerId: clientId, leaseExpiresAt: expiresAt })
    return { kind: 'acquired', expiresAt }
  }

  /**
   * 续租（挂 pingTick 成功路径）。只传 sessionId，内部从 session.busyOwnerId 反查（M4）。
   * @returns true=续租成功；false=无 owner（busyOwnerId 空，不误续空 lease）。
   */
  renew(sessionId: string): boolean {
    const session = this.svc.getSession(sessionId)
    if (!session?.busyOwnerId) return false // 无 owner 不续（防 undefined!==undefined 误续）
    this.svc.updateSession(sessionId, { leaseExpiresAt: Date.now() + this.ttlMs })
    return true
  }

  /**
   * 释放 lease（四路径）。清 busyOwnerId/leaseExpiresAt 为 undefined（不动 isGenerating——
   * isGenerating 由 pi turn-end/abort 路径独立复位，两者独立）+ 广播 session.idle。
   */
  release(sessionId: string, reason: LeaseReleaseReason): void {
    this.svc.updateSession(sessionId, { busyOwnerId: undefined, leaseExpiresAt: undefined })
    this.broker.broadcast({ type: 'session.idle', payload: { sessionId, reason } })
  }

  /**
   * 扫描过期 lease（reaper 5s 调用）。遍历所有 session，leaseExpiresAt<now 的调 release('lease_expired')。
   * @returns 本次被释放的 sessionId 列表。
   */
  sweepExpired(): string[] {
    const now = Date.now()
    const expired: string[] = []
    for (const session of this.svc.allSessions()) {
      if (session.leaseExpiresAt !== undefined && session.leaseExpiresAt < now) {
        this.release(session.id, 'lease_expired')
        expired.push(session.id)
      }
    }
    return expired
  }

  /**
   * 反查 clientId 当前持有 lease 的 session（P7 fallback 第二级用）。
   * @returns { sessionId } 或 undefined（该 clientId 未持有任何 session 的 lease）。
   */
  getBusySession(clientId: string): { sessionId: string } | undefined {
    for (const session of this.svc.allSessions()) {
      if (session.busyOwnerId === clientId) return { sessionId: session.id }
    }
    return undefined
  }

  /**
   * 反查 session 当前 lease owner 的 clientId（P7 长期方案 A 用）。
   *
   * bridge.tool.execute 由 pi 的 bridge_request 事件触发——此时 pi 正在为某个
   * session 跑 turn，该 session 的 lease owner（busyOwnerId）就是发起方 clientId。
   * bridge-interop 据此把 clientId 塞进 invoke params，经 Worker RPC 显式透传回主线程，
   * 绕开 ALS 跨独立 I/O tick 断裂（P7 核心缺陷）。
   *
   * @returns 该 session 的 busyOwnerId，或 undefined（无 lease / session 不存在）。
   */
  getLeaseOwner(sessionId: string): string | undefined {
    const session = this.svc.getSession(sessionId)
    return session?.busyOwnerId
  }
}
