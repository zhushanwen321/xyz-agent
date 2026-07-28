/**
 * useMessageBusSubscription 单元测试（wave:runtime-message-bus::renderer-subscribe）。
 *
 * 覆盖 TC1-TC7：
 * - TC1: subscribeSession 调 RPC + applySnapshot + 更新 lastSeenSeq
 * - TC2: 重复 subscribe 幂等（已 subscribed 不重复 RPC）
 * - TC3: gap 检测 seq<=lastSeenSeq 丢弃（在 useConnection 测试，此处测 state 维护）
 * - TC4: gap 检测 seq>lastSeenSeq+1 触发 reconcile（在 useConnection 测试）
 * - TC5: 正常递进（在 useConnection 测试）
 * - TC6: 未 subscribe 不 gap 检测（在 useConnection 测试）
 * - TC7: clearSubscription 清除 state
 *
 * gap 检测的 routeInbound 集成测试见 useConnection-seq-gap.test.ts（TC3-TC6, TC8）。
 * 本文件聚焦 useMessageBusSubscription 模块自身的 state 管理 + subscribeSession 流程。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useMessageBusSubscription.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ServerMessage } from '@xyz-agent/shared'

// ── api mock：捕获 session.subscribe 调用 + 控制返回值 ──────────────
const apiMock = vi.hoisted(() => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/api', () => ({
  session: {
    subscribe: apiMock.subscribe,
    unsubscribe: apiMock.unsubscribe,
  },
}))

// ── events mock：捕获 dispatchSession 回放调用 ──────────────────────
const eventsMock = vi.hoisted(() => ({
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
}))
vi.mock('@/api/events', () => ({
  dispatchSession: eventsMock.dispatchSession,
  dispatchGlobal: eventsMock.dispatchGlobal,
}))

import {
  subscribeSession,
  getSubscriptionState,
  clearSubscription,
  updateLastSeenSeq,
  resetSubscriptionStates,
} from '@/composables/useMessageBusSubscription'

beforeEach(() => {
  resetSubscriptionStates()
  vi.clearAllMocks()
})

/** 构造带 seq 的 ServerMessage（测试 helper） */
function msgWithSeq(seq: number, type = 'message.chunk'): ServerMessage {
  return { type, seq, payload: { sessionId: 's1' } } as ServerMessage
}

describe('TC1: subscribeSession 调 RPC + applySnapshot + 更新 lastSeenSeq', () => {
  it('首次 subscribe：snapshot + stateSnapshot 逐条 dispatchSession + 记 lastSeenSeq + 标记 subscribed', async () => {
    const snapshot = [msgWithSeq(1), msgWithSeq(2)]
    const stateSnapshot = [
      { type: 'session.commands', seq: 2, payload: { sessionId: 's1', commands: [] } } as ServerMessage,
      { type: 'context.update', seq: 2, payload: { sessionId: 's1', usagePercent: 50 } } as ServerMessage,
    ]
    apiMock.subscribe.mockResolvedValue({ snapshot, stateSnapshot, lastSeq: 2 })

    await subscribeSession('s1')

    // RPC 被调一次，未传 fromSeq（首次订阅）
    expect(apiMock.subscribe).toHaveBeenCalledTimes(1)
    expect(apiMock.subscribe).toHaveBeenCalledWith('s1', undefined)
    // snapshot 逐条 dispatchSession（按顺序），随后 stateSnapshot 逐条 dispatchSession
    expect(eventsMock.dispatchSession).toHaveBeenCalledTimes(4)
    expect(eventsMock.dispatchSession).toHaveBeenNthCalledWith(1, 's1', snapshot[0])
    expect(eventsMock.dispatchSession).toHaveBeenNthCalledWith(2, 's1', snapshot[1])
    expect(eventsMock.dispatchSession).toHaveBeenNthCalledWith(3, 's1', stateSnapshot[0])
    expect(eventsMock.dispatchSession).toHaveBeenNthCalledWith(4, 's1', stateSnapshot[1])
    // state 记录正确
    const state = getSubscriptionState('s1')
    expect(state).toEqual({ lastSeenSeq: 2, subscribed: true })
  })

  it('空 snapshot + 空 stateSnapshot：不 dispatch，lastSeenSeq=0，仍标记 subscribed', async () => {
    apiMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 })

    await subscribeSession('s1')

    expect(eventsMock.dispatchSession).not.toHaveBeenCalled()
    expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 0, subscribed: true })
  })

  it('lastSeq 小于 snapshot 末尾 seq（ring 溢出）：取 max 作基线', async () => {
    // snapshot 含 seq=5，但 lastSeq=3（runtime 标记 ring 溢出，gap=true）
    const snapshot = [msgWithSeq(5)]
    apiMock.subscribe.mockResolvedValue({ snapshot, stateSnapshot: [], lastSeq: 3, gap: true })

    await subscribeSession('s1')

    // 基线取 max(3, 5)=5，避免基线回退（后续 seq=4 会被误判为乱序丢弃）
    expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(5)
    expect(getSubscriptionState('s1')!.subscribed).toBe(true)
  })

  it('stateSnapshot 含高 seq 消息：lastSeenSeq 纳入 stateSnapshot max（防基线回退）', async () => {
    // snapshot 被 fromSeq 过滤后空，但 stateSnapshot 含 seq=7 的 commands（last-value 高 seq）
    const stateSnapshot = [
      { type: 'session.commands', seq: 7, payload: { sessionId: 's1', commands: [] } } as ServerMessage,
    ]
    apiMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot, lastSeq: 5 })

    await subscribeSession('s1')

    // 基线取 max(5, 7)=7，stateSnapshot 的高 seq 不丢
    expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(7)
  })
})

describe('TC2: 重复 subscribe 幂等（已 subscribed 不重复 RPC）', () => {
  it('连续两次 subscribeSession：第二次 no-op（不调 RPC、不重放 snapshot）', async () => {
    const snapshot = [msgWithSeq(1), msgWithSeq(2)]
    apiMock.subscribe.mockResolvedValue({ snapshot, stateSnapshot: [], lastSeq: 2 })

    await subscribeSession('s1')
    await subscribeSession('s1')

    // RPC 只调一次（幂等守卫）
    expect(apiMock.subscribe).toHaveBeenCalledTimes(1)
    // dispatchSession 只回放一次（==snapshot.length）
    expect(eventsMock.dispatchSession).toHaveBeenCalledTimes(2)
  })
})

describe('TC7: clearSubscription 清除 SubscriptionState', () => {
  it('subscribe 后 clear：state 变 undefined', async () => {
    apiMock.subscribe.mockResolvedValue({ snapshot: [msgWithSeq(1)], stateSnapshot: [], lastSeq: 1 })

    await subscribeSession('s1')
    expect(getSubscriptionState('s1')).toBeDefined()

    clearSubscription('s1')
    expect(getSubscriptionState('s1')).toBeUndefined()
  })

  it('clear 不存在的 session：no-op（不抛错）', () => {
    expect(() => clearSubscription('nonexistent')).not.toThrow()
    expect(getSubscriptionState('nonexistent')).toBeUndefined()
  })
})

describe('updateLastSeenSeq', () => {
  it('已订阅 session：更新 lastSeenSeq', async () => {
    apiMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await subscribeSession('s1')
    expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(5)

    updateLastSeenSeq('s1', 8)
    expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(8)
  })

  it('state 不存在：no-op（不创建 state）', () => {
    updateLastSeenSeq('nonexistent', 99)
    expect(getSubscriptionState('nonexistent')).toBeUndefined()
  })
})

describe('getSubscriptionState', () => {
  it('未订阅 session：返回 undefined', () => {
    expect(getSubscriptionState('never')).toBeUndefined()
  })

  it('subscribeSession 失败：不标记 subscribed（可重试）', async () => {
    apiMock.subscribe.mockRejectedValue(new Error('RPC failed'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await subscribeSession('s1')

    // 失败不标记 subscribed（state 不存在，下次可重试）
    expect(getSubscriptionState('s1')).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toContain('subscribe failed')
    warnSpy.mockRestore()
  })
})
