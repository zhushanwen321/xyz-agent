/**
 * subscription-state.test.ts —— 订阅状态迁移等价断言（F9，TC-3）。
 *
 * IF5 契约 + ES2：
 * ① 已 subscribed 且 fromSeq undefined → 幂等直接 return（subscribe 不被调用）
 * ② fromSeq 显式传入 → 跳过守卫发 RPC（reconcile backfill）
 * ③ snapshot/stateSnapshot 依次回放 dispatchSession
 * ④ lastSeenSeq = max(reply.lastSeq, maxSnapshotSeq, maxStateSnapshotSeq, prevLastSeen)
 * ⑤ subscribe RPC 失败 → console.warn + 不标记 subscribed
 * ⑥ clearSubscription 删除、resetSubscriptionStates 清空、updateLastSeenSeq 更新基线
 *
 * 注入驱动：setSubscriptionPorts 注入 subscribe spy + dispatchSession spy；
 * beforeEach resetSubscriptionStates() 清 Map（测试隔离）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import {
  subscribeSession,
  getSubscriptionState,
  clearSubscription,
  updateLastSeenSeq,
  resetSubscriptionStates,
  setSubscriptionPorts,
} from './subscription-state'
import type { TransportPorts } from './route-inbound'
import type { ServerMessage } from '@xyz-agent/shared'

function makeMsg(seq: number, type = 'session.ping'): ServerMessage {
  return { type: type as ServerMessage['type'], seq, payload: { sessionId: 's1' } }
}

function setup() {
  // TransportPorts['subscribe'] 形状的 mock（resolve 形状在用例内 mockResolvedValue 给定）
  const subscribe = vi.fn() as Mock<TransportPorts['subscribe']>
  const dispatchSession = vi.fn()
  setSubscriptionPorts({
    subscribe,
    events: { dispatchSession, dispatchGlobal: vi.fn(), dispatchCrossSession: vi.fn() },
  })
  return { subscribe, dispatchSession }
}

describe('subscribeSession', () => {
  beforeEach(() => {
    resetSubscriptionStates()
    vi.restoreAllMocks()
  })

  it('① 幂等守卫：已 subscribed 且 fromSeq undefined → 直接 return（subscribe 不被重复调用）', async () => {
    const { subscribe } = setup()
    subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await subscribeSession('s1')
    await subscribeSession('s1')
    await subscribeSession('s1')
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 5, subscribed: true })
  })

  it('② fromSeq 显式传入 → 跳过幂等守卫发 RPC（reconcile backfill，即使已 subscribed）', async () => {
    const { subscribe } = setup()
    subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await subscribeSession('s1') // 首次订阅
    await subscribeSession('s1', 7) // gap reconcile：即使已 subscribed 也发 RPC
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(subscribe).toHaveBeenLastCalledWith('s1', 7)
  })

  it('③ snapshot/stateSnapshot 依次回放 dispatchSession', async () => {
    const { subscribe, dispatchSession } = setup()
    subscribe.mockResolvedValue({
      snapshot: [makeMsg(1), makeMsg(2)],
      stateSnapshot: [makeMsg(3, 'session.commands'), makeMsg(4, 'session.context')],
      lastSeq: 10,
    })
    await subscribeSession('s1')
    expect(dispatchSession).toHaveBeenCalledTimes(4)
    expect(dispatchSession.mock.calls.map((c) => c[1].seq)).toEqual([1, 2, 3, 4])
    // 全部以 sessionId 路由
    for (const call of dispatchSession.mock.calls) {
      expect(call[0]).toBe('s1')
    }
  })

  it('④ lastSeenSeq = max(reply.lastSeq, maxSnapshotSeq, maxStateSnapshotSeq, prevLastSeen)', async () => {
    const { subscribe } = setup()
    // 场景 A：reply.lastSeq 最大
    subscribe.mockResolvedValue({
      snapshot: [makeMsg(2)],
      stateSnapshot: [makeMsg(1)],
      lastSeq: 10,
    })
    await subscribeSession('s1')
    expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(10)

    // 场景 B：snapshot seq 最大（ring 溢出场景：lastSeq 小于已 dispatch 的 snapshot seq）
    resetSubscriptionStates()
    subscribe.mockResolvedValue({
      snapshot: [makeMsg(50), makeMsg(51)],
      stateSnapshot: [],
      lastSeq: 30,
    })
    await subscribeSession('s2')
    expect(getSubscriptionState('s2')?.lastSeenSeq).toBe(51)

    // 场景 C：prevLastSeen 最大（reconcile 期间 live 消息已推进基线，不回落）
    subscribe.mockResolvedValue({
      snapshot: [],
      stateSnapshot: [],
      lastSeq: 3,
    })
    await subscribeSession('s3') // lastSeenSeq=3
    updateLastSeenSeq('s3', 20) // live 推进到 20
    await subscribeSession('s3', 5) // reconcile 回拉，reply.lastSeq=3 < 20
    expect(getSubscriptionState('s3')?.lastSeenSeq).toBe(20)
  })

  it('⑤ subscribe RPC 失败 → console.warn + 不标记 subscribed（下次可重试）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { subscribe } = setup()
    subscribe.mockRejectedValue(new Error('connection lost'))
    await subscribeSession('s1')
    expect(warnSpy).toHaveBeenCalled()
    expect(getSubscriptionState('s1')).toBeUndefined() // 不标记
    // 重试成功
    subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 8 })
    await subscribeSession('s1')
    expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 8, subscribed: true })
    warnSpy.mockRestore()
  })

  it('防御：端口未注入时 console.warn + 不崩（不标记 subscribed）', async () => {
    // 隔离模块实例（其他用例已 setSubscriptionPorts 注入，模块级状态被污染）
    vi.resetModules()
    const fresh = await import('./subscription-state')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await fresh.subscribeSession('s1')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not injected'))
    expect(fresh.getSubscriptionState('s1')).toBeUndefined()
    warnSpy.mockRestore()
  })
})

describe('getSubscriptionState / clearSubscription / updateLastSeenSeq / resetSubscriptionStates', () => {
  beforeEach(() => {
    resetSubscriptionStates()
    vi.restoreAllMocks()
  })

  it('getSubscriptionState：未订阅返回 undefined；订阅后返回 state', async () => {
    const { subscribe } = setup()
    expect(getSubscriptionState('s1')).toBeUndefined()
    subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 1 })
    await subscribeSession('s1')
    expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 1, subscribed: true })
  })

  it('clearSubscription：删除后 getSubscriptionState 返回 undefined', async () => {
    const { subscribe } = setup()
    subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 1 })
    await subscribeSession('s1')
    clearSubscription('s1')
    expect(getSubscriptionState('s1')).toBeUndefined()
  })

  it('updateLastSeenSeq：更新基线（仅 lastSeenSeq，不动 subscribed）；state 不存在 no-op', async () => {
    const { subscribe } = setup()
    subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 1 })
    await subscribeSession('s1')
    updateLastSeenSeq('s1', 42)
    expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 42, subscribed: true })
    // state 不存在 → no-op 不崩
    expect(() => updateLastSeenSeq('ghost', 1)).not.toThrow()
  })

  it('resetSubscriptionStates：清空全部 Map', async () => {
    const { subscribe } = setup()
    subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 1 })
    await subscribeSession('s1')
    await subscribeSession('s2')
    resetSubscriptionStates()
    expect(getSubscriptionState('s1')).toBeUndefined()
    expect(getSubscriptionState('s2')).toBeUndefined()
  })
})
