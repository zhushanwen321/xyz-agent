/**
 * useMessageBusSubscription —— re-export shim 单元测试（wave:renderer-rebuild-v2 W2, T3）。
 *
 * SSOT 已迁入 @xyz-agent/core（core/coordination/subscription-state.ts，w1 落地），
 * 本文件不再保留本地实现（原 TC1-TC7 行为测试已随实现迁往 core 侧，
 * 见 packages/core/src/coordination/subscription-state.test.ts 与 route-inbound.test.ts）。
 *
 * 本测试验证 shim 转发面（T3 验收）：
 * - S1: 5 个函数导出 === core 同引用（纯转发，无本地实现残留）
 * - S2: 行为等价冒烟——经 shim 调用 subscribeSession（注入 spy 端口）：
 *   RPC 调用 + snapshot 回放 + lastSeenSeq 基线 + subscribed 标记（原 TC1 核心路径）
 * - S3: 未注入端口防御路径：console.warn 且不抛（core 防御语义经 shim 透传）
 * - S4: clearSubscription / updateLastSeenSeq / resetSubscriptionStates 行为等价（原 TC7 子集）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useMessageBusSubscription.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ServerMessage } from '@xyz-agent/shared'
import * as core from '@xyz-agent/core'

// ── 端口 spy：经 core.setSubscriptionPorts 注入（S2 行为冒烟用） ─────
const portSpy = vi.hoisted(() => ({
  subscribe: vi.fn(),
  dispatchSession: vi.fn(),
}))
// core 是模块级单例 Map，spy 注入后需在测试间重置
import { setSubscriptionPorts } from '@xyz-agent/core'

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

describe('S3a: 未注入端口防御路径（必须在任何 setSubscriptionPorts 之前执行，core 模块级注入状态泄漏）', () => {
  it('subscribeSession 不抛、console.warn 提示端口未注入', async () => {
    // 不调用 setSubscriptionPorts（保持未注入状态）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(subscribeSession('s1')).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toContain('ports not injected')
    expect(getSubscriptionState('s1')).toBeUndefined()
    warnSpy.mockRestore()
  })
})

describe('S1: shim 5 导出 === core 同引用（纯转发，无本地实现）', () => {
  it('subscribeSession / getSubscriptionState / clearSubscription / updateLastSeenSeq / resetSubscriptionStates 均直接转发', () => {
    expect(subscribeSession).toBe(core.subscribeSession)
    expect(getSubscriptionState).toBe(core.getSubscriptionState)
    expect(clearSubscription).toBe(core.clearSubscription)
    expect(updateLastSeenSeq).toBe(core.updateLastSeenSeq)
    expect(resetSubscriptionStates).toBe(core.resetSubscriptionStates)
  })
})

describe('S2: 行为等价冒烟——经 shim 走 core 订阅流程（原 TC1 核心路径）', () => {
  it('注入端口后 subscribeSession：RPC + snapshot 逐条 dispatch + 记 lastSeenSeq + 标记 subscribed', async () => {
    const snapshot = [msgWithSeq(1), msgWithSeq(2)]
    portSpy.subscribe.mockResolvedValue({ snapshot, stateSnapshot: [], lastSeq: 2 })
    setSubscriptionPorts({ subscribe: portSpy.subscribe, events: { dispatchSession: portSpy.dispatchSession } })

    await subscribeSession('s1')

    // RPC 被调一次，未传 fromSeq（首次订阅）
    expect(portSpy.subscribe).toHaveBeenCalledTimes(1)
    expect(portSpy.subscribe).toHaveBeenCalledWith('s1', undefined)
    // snapshot 逐条 dispatchSession（按顺序）
    expect(portSpy.dispatchSession).toHaveBeenCalledTimes(2)
    expect(portSpy.dispatchSession).toHaveBeenNthCalledWith(1, 's1', snapshot[0])
    expect(portSpy.dispatchSession).toHaveBeenNthCalledWith(2, 's1', snapshot[1])
    // state 记录正确
    const state = getSubscriptionState('s1')
    expect(state).toEqual({ lastSeenSeq: 2, subscribed: true })
  })

  it('lastSeq 小于 snapshot 末尾 seq（ring 溢出）：取 max 作基线', async () => {
    portSpy.subscribe.mockResolvedValue({ snapshot: [msgWithSeq(5)], stateSnapshot: [], lastSeq: 3, gap: true })
    setSubscriptionPorts({ subscribe: portSpy.subscribe, events: { dispatchSession: portSpy.dispatchSession } })

    await subscribeSession('s1')

    expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(5)
    expect(getSubscriptionState('s1')!.subscribed).toBe(true)
  })

  it('连续两次 subscribeSession：第二次 no-op（幂等守卫，不重复 RPC）', async () => {
    portSpy.subscribe.mockResolvedValue({ snapshot: [msgWithSeq(1)], stateSnapshot: [], lastSeq: 1 })
    setSubscriptionPorts({ subscribe: portSpy.subscribe, events: { dispatchSession: portSpy.dispatchSession } })

    await subscribeSession('s1')
    await subscribeSession('s1')

    expect(portSpy.subscribe).toHaveBeenCalledTimes(1)
    expect(portSpy.dispatchSession).toHaveBeenCalledTimes(1)
  })
})

describe('S3: RPC 失败防御路径（core 语义经 shim 透传）', () => {
  it('subscribe RPC 失败：不标记 subscribed（意图条目留存，可重试）', async () => {
    portSpy.subscribe.mockRejectedValue(new Error('RPC failed'))
    setSubscriptionPorts({ subscribe: portSpy.subscribe, events: { dispatchSession: portSpy.dispatchSession } })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await subscribeSession('s1')

    // M1/W09 follow-up：失败留存 subscribed=false 意图条目（供 WS 重连后 resubscribeAll
    // 重发），gap 检测走兼容路径，行为与「无条目」一致
    expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 0, subscribed: false })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toContain('subscribe failed')
    warnSpy.mockRestore()
  })
})

describe('S4: clearSubscription / updateLastSeenSeq 行为等价（原 TC7 子集）', () => {
  it('subscribe 后 clear：state 变 undefined；clear 不存在 session：no-op', async () => {
    portSpy.subscribe.mockResolvedValue({ snapshot: [msgWithSeq(1)], stateSnapshot: [], lastSeq: 1 })
    setSubscriptionPorts({ subscribe: portSpy.subscribe, events: { dispatchSession: portSpy.dispatchSession } })

    await subscribeSession('s1')
    expect(getSubscriptionState('s1')).toBeDefined()

    clearSubscription('s1')
    expect(getSubscriptionState('s1')).toBeUndefined()

    expect(() => clearSubscription('nonexistent')).not.toThrow()
  })

  it('updateLastSeenSeq：已订阅更新基线；state 不存在 no-op', async () => {
    portSpy.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    setSubscriptionPorts({ subscribe: portSpy.subscribe, events: { dispatchSession: portSpy.dispatchSession } })
    await subscribeSession('s1')
    expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(5)

    updateLastSeenSeq('s1', 8)
    expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(8)

    updateLastSeenSeq('nonexistent', 99)
    expect(getSubscriptionState('nonexistent')).toBeUndefined()
  })
})
