/**
 * LeaseManager 单测（P5 lease 状态机）。
 *
 * 覆盖：
 * - TC3: acquire 冲突返回 busy / 同 owner / 无 owner 返回 acquired
 * - TC4: 孤儿 pi（isGenerating=true 且无 owner）返回 owner='<orphan-pi>'
 * - TC5: renew 只传 sessionId（owner 有值续租 / 空 return false）
 * - TC6: release 清 lease 字段 + 广播 session.idle（不动 isGenerating）
 * - TC7: TTL 过期 sweepExpired（advance 31s 释放 / 29s 不释放）
 * - TC8: getBusySession 反查 clientId
 * - TC10: getLeaseOwner 反查 session lease owner（P7 长期方案 A：bridge-interop 用）
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/lease-manager.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LeaseManager, ORPHAN_PI_OWNER, REAPER_INTERVAL_MS } from '../lease-manager.js'
import type { ISessionServiceInternal } from '../session-internal.js'
import type { IMessageBroker } from '../../../interfaces.js'
import type { IManagedSessionView } from '../types.js'

/** 构造 mock session（含可选 lease/isGenerating 字段）。 */
function mockSession(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 's1', cwd: '/p', label: 's', modelId: 'm', createdAt: 0, lastActiveAt: 0,
    tokenCount: 0, inputTokens: 0, isGenerating: false, isCompacting: false, labelPersisted: false,
    isBashRunning: false, bashRunToken: undefined,
    ...overrides,
  }
}

/** 构造 mock svc（sessions Map + getSession/updateSession/allSessions）。 */
function mockSvc(sessions: IManagedSessionView[] = []): { svc: ISessionServiceInternal; sessions: Map<string, IManagedSessionView> } {
  const map = new Map<string, IManagedSessionView>()
  for (const s of sessions) map.set(s.id, s)
  const svc = {
    getSession: (id: string) => map.get(id),
    updateSession: (id: string, patch: Partial<Pick<IManagedSessionView, 'busyOwnerId' | 'leaseExpiresAt'>>) => {
      const s = map.get(id)
      if (!s) return
      if ('busyOwnerId' in patch) s.busyOwnerId = patch.busyOwnerId
      if ('leaseExpiresAt' in patch) s.leaseExpiresAt = patch.leaseExpiresAt
    },
    allSessions: () => map.values(),
  } as unknown as ISessionServiceInternal
  return { svc, sessions: map }
}

function mockBroker(): IMessageBroker & { broadcasts: unknown[] } {
  const broadcasts: unknown[] = []
  return {
    send: vi.fn(),
    broadcast: (msg: unknown) => { broadcasts.push(msg) },
    sendError: vi.fn(),
    sendToClient: vi.fn(),
    broadcastExcept: vi.fn(),
    broadcasts,
  } as unknown as IMessageBroker & { broadcasts: unknown[] }
}

describe('LeaseManager（P5 lease 状态机）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  // TC3: acquire 三态
  it('TC3a: 无 owner 时 acquire 返回 acquired 并设 lease 字段', () => {
    const { svc } = mockSvc([mockSession({ id: 's1', isGenerating: false })])
    const broker = mockBroker()
    const lm = new LeaseManager(svc, broker, { ttlMs: 30000 })

    vi.setSystemTime(1000)
    const res = lm.acquire('s1', 'clientA', 'Mac')

    expect(res).toEqual({ kind: 'acquired', expiresAt: 31000 })
    expect(svc.getSession('s1')?.busyOwnerId).toBe('clientA')
    expect(svc.getSession('s1')?.leaseExpiresAt).toBe(31000)
  })

  it('TC3b: 同 owner 重复 acquire 返回 acquired（renew 语义）', () => {
    const { svc } = mockSvc([mockSession({ id: 's1', busyOwnerId: 'clientA', leaseExpiresAt: 5000 })])
    const broker = mockBroker()
    const lm = new LeaseManager(svc, broker, { ttlMs: 30000 })

    vi.setSystemTime(10000)
    const res = lm.acquire('s1', 'clientA', 'Mac')

    expect(res.kind).toBe('acquired')
    expect(svc.getSession('s1')?.leaseExpiresAt).toBe(40000) // 续租
  })

  it('TC3c: 异 owner acquire 返回 busy（含 owner/expiresAt）', () => {
    const { svc } = mockSvc([mockSession({ id: 's1', busyOwnerId: 'clientA', leaseExpiresAt: 5000, isGenerating: true })])
    const broker = mockBroker()
    const lm = new LeaseManager(svc, broker, { ttlMs: 30000 })

    const res = lm.acquire('s1', 'clientB', 'Phone')

    expect(res).toEqual({ kind: 'busy', owner: 'clientA', expiresAt: 5000 })
    // 未改 lease（仍是 clientA）
    expect(svc.getSession('s1')?.busyOwnerId).toBe('clientA')
  })

  // TC4: 孤儿 pi
  it('TC4: 孤儿 pi（isGenerating=true 且无 owner）acquire 返回 owner=<orphan-pi>', () => {
    const { svc } = mockSvc([mockSession({ id: 's1', isGenerating: true, busyOwnerId: undefined })])
    const broker = mockBroker()
    const lm = new LeaseManager(svc, broker, { ttlMs: 30000 })

    const res = lm.acquire('s1', 'clientB', 'Phone')

    expect(res).toEqual({ kind: 'busy', owner: ORPHAN_PI_OWNER, expiresAt: 0 })
    expect(ORPHAN_PI_OWNER).toBe('<orphan-pi>')
  })

  // TC10: not_found 防御（session 不存在时不静默 acquire）
  it('TC10a: session 不存在时 acquire 返回 not_found（不静默创建 lease）', () => {
    // mockSvc() 无 sessions → getSession('missing') 返回 undefined
    const { svc, sessions } = mockSvc([])
    const broker = mockBroker()
    const lm = new LeaseManager(svc, broker, { ttlMs: 30000 })

    const res = lm.acquire('missing', 'clientA', 'Mac')

    expect(res).toEqual({ kind: 'not_found' })
    // sessions Map 仍空（未创建 lease 条目，updateSession 对不存在 session 是 no-op）
    expect(sessions.size).toBe(0)
  })

  it('TC10b: not_found 后再 acquire 同一不存在 session 仍返回 not_found（不累积状态）', () => {
    const { svc } = mockSvc([])
    const broker = mockBroker()
    const lm = new LeaseManager(svc, broker, { ttlMs: 30000 })

    const res1 = lm.acquire('ghost', 'clientA', 'Mac')
    const res2 = lm.acquire('ghost', 'clientB', 'Phone')

    expect(res1).toEqual({ kind: 'not_found' })
    expect(res2).toEqual({ kind: 'not_found' })
    // 不应误判为 busy（未写入 busyOwnerId，clientB 不该看到 clientA 持锁）
  })

  // TC5: renew
  it('TC5a: renew owner 有值时续租成功返回 true', () => {
    const { svc } = mockSvc([mockSession({ id: 's1', busyOwnerId: 'clientA', leaseExpiresAt: 5000 })])
    const broker = mockBroker()
    const lm = new LeaseManager(svc, broker, { ttlMs: 30000 })

    vi.setSystemTime(10000)
    const ok = lm.renew('s1')

    expect(ok).toBe(true)
    expect(svc.getSession('s1')?.leaseExpiresAt).toBe(40000)
  })

  it('TC5b: renew owner 空时 return false（不误续）', () => {
    const { svc } = mockSvc([mockSession({ id: 's1', busyOwnerId: undefined })])
    const broker = mockBroker()
    const lm = new LeaseManager(svc, broker, { ttlMs: 30000 })

    expect(lm.renew('s1')).toBe(false)
  })

  // TC6: release
  it('TC6: release 清 lease 字段并广播 session.idle（不动 isGenerating）', () => {
    const { svc } = mockSvc([mockSession({ id: 's1', busyOwnerId: 'clientA', leaseExpiresAt: 5000, isGenerating: true })])
    const broker = mockBroker()
    const lm = new LeaseManager(svc, broker, { ttlMs: 30000 })

    lm.release('s1', 'turn_end')

    expect(svc.getSession('s1')?.busyOwnerId).toBeUndefined()
    expect(svc.getSession('s1')?.leaseExpiresAt).toBeUndefined()
    expect(svc.getSession('s1')?.isGenerating).toBe(true) // 不动 isGenerating
    expect(broker.broadcasts).toHaveLength(1)
    expect(broker.broadcasts[0]).toEqual({ type: 'session.idle', payload: { sessionId: 's1', reason: 'turn_end' } })
  })

  // TC7: TTL 过期
  it('TC7a: advance 31s sweepExpired 释放该 session', () => {
    const { svc } = mockSvc([mockSession({ id: 's1' })])
    const broker = mockBroker()
    const lm = new LeaseManager(svc, broker, { ttlMs: 30000 })

    vi.setSystemTime(1000)
    lm.acquire('s1', 'clientA', 'Mac')
    expect(svc.getSession('s1')?.busyOwnerId).toBe('clientA')

    vi.setSystemTime(32000) // advance 31s
    const expired = lm.sweepExpired()

    expect(expired).toEqual(['s1'])
    expect(svc.getSession('s1')?.busyOwnerId).toBeUndefined()
  })

  it('TC7b: advance 29s sweepExpired 不释放', () => {
    const { svc } = mockSvc([mockSession({ id: 's1' })])
    const broker = mockBroker()
    const lm = new LeaseManager(svc, broker, { ttlMs: 30000 })

    vi.setSystemTime(1000)
    lm.acquire('s1', 'clientA', 'Mac')

    vi.setSystemTime(30000) // advance 29s（leaseExpiresAt=31000，未过期）
    const expired = lm.sweepExpired()

    expect(expired).toEqual([])
    expect(svc.getSession('s1')?.busyOwnerId).toBe('clientA')
  })

  it('TC7c: reaper 间隔常量 REAPER_INTERVAL_MS=5000', () => {
    expect(REAPER_INTERVAL_MS).toBe(5000)
  })

  // TC7d: TTL > 2 × PING_INTERVAL_MS 联调（MAJOR 修复：原 TTL=30s < ping 60s 导致 lease 误释放）
  // 续租信号挂 event-interpreter pingTick（每 60s 一次），setInterval 首次回调在间隔后
  // （turn-start+60s 才首次续租）。TTL 必须 > ping 间隔，否则 turn 开始到首次 ping 之间
  // lease 被 reaper 误释放。default TTL=90s 满足约束（90 > 60）。
  it('TC7d: default TTL=90s 时 turn 内 advance 到 ping 首次续租前（89s）lease 不过期（MAJOR 修复回归）', () => {
    const { svc } = mockSvc([mockSession({ id: 's1' })])
    const broker = mockBroker()
    // default TTL（不传 ttlMs → 读常量 90_000）
    const lm = new LeaseManager(svc, broker)

    vi.setSystemTime(1000)
    lm.acquire('s1', 'clientA', 'Mac') // leaseExpiresAt = 1000 + 90000 = 91000
    expect(svc.getSession('s1')?.busyOwnerId).toBe('clientA')

    // advance 到 turn-start+89s（ping 首次续租最早在 turn-start+60s，此处 89s < TTL=90s）
    // 修复前（TTL=30s）：89s 远超 30s，lease 必被 reaper 释放 → busyOwnerId 为空（bug）
    // 修复后（TTL=90s）：89s < 91s（leaseExpiresAt），lease 仍有效
    vi.setSystemTime(90000) // advance 89s
    const expiredAt89s = lm.sweepExpired()
    expect(expiredAt89s).toEqual([])
    expect(svc.getSession('s1')?.busyOwnerId).toBe('clientA') // lease 仍持有
  })

  it('TC7e: default TTL=90s 时 advance 超过 TTL（91s）+ reaper 扫描后 lease 过期释放', () => {
    const { svc } = mockSvc([mockSession({ id: 's1' })])
    const broker = mockBroker()
    const lm = new LeaseManager(svc, broker) // default TTL=90000

    vi.setSystemTime(1000)
    lm.acquire('s1', 'clientA', 'Mac') // leaseExpiresAt = 91000

    // advance 到 leaseExpiresAt 之后（91001 > 91000）
    vi.setSystemTime(91001)
    const expired = lm.sweepExpired()

    expect(expired).toEqual(['s1'])
    expect(svc.getSession('s1')?.busyOwnerId).toBeUndefined()
  })

  // TC8: getBusySession
  it('TC8: getBusySession 反查 clientId 持有的 session', () => {
    const { svc } = mockSvc([
      mockSession({ id: 's1', busyOwnerId: 'clientA' }),
      mockSession({ id: 's2', busyOwnerId: undefined }),
    ])
    const broker = mockBroker()
    const lm = new LeaseManager(svc, broker, { ttlMs: 30000 })

    expect(lm.getBusySession('clientA')).toEqual({ sessionId: 's1' })
    expect(lm.getBusySession('clientB')).toBeUndefined()
  })

  // TC10: getLeaseOwner（P7 长期方案 A：bridge-interop 反查发起方 clientId）
  it('TC10: getLeaseOwner 反查 session 的 lease owner clientId', () => {
    const { svc } = mockSvc([
      mockSession({ id: 's1', busyOwnerId: 'clientA' }),
      mockSession({ id: 's2', busyOwnerId: undefined }), // 无 lease
    ])
    const broker = mockBroker()
    const lm = new LeaseManager(svc, broker, { ttlMs: 30000 })

    expect(lm.getLeaseOwner('s1')).toBe('clientA')
    expect(lm.getLeaseOwner('s2')).toBeUndefined() // 无 lease
    expect(lm.getLeaseOwner('nonexistent')).toBeUndefined() // session 不存在
  })

  // env TTL
  it('TC9: ttlMs 默认读 env XYZ_AGENT_LEASE_TTL_MS', () => {
    vi.stubEnv('XYZ_AGENT_LEASE_TTL_MS', '12345')
    const { svc } = mockSvc([mockSession({ id: 's1' })])
    const broker = mockBroker()
    const lm = new LeaseManager(svc, broker)

    vi.setSystemTime(0)
    const res = lm.acquire('s1', 'a', 'd')
    expect(res).toEqual({ kind: 'acquired', expiresAt: 12345 })
    vi.unstubAllEnvs()
  })
})
