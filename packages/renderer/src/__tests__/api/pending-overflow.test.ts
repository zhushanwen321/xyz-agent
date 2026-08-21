/**
 * pending 容量上限 + 共享超时 timer 单测（Q1-5）。
 *
 * 覆盖：
 * 1. 超 256 驱逐最老（Map 插入序首个），reject 带 code:'overflow'；新请求正常注册
 * 2. 被驱逐 id 的迟到响应静默丢弃（resolveEnvelope 契约：no-op 不抛错）
 * 3. N 个 pending 只挂 ≤1 个共享 sweep timer（不再 per-request 一个 timer）
 * 4. timeoutMs=0 的请求不挂 timer 参与 sweep（无超时语义保持）
 * 5. resolve/reject 删除条目后重算 sweep timer（W04 review：最后带 deadline 的
 *    pending 正常完成时 timer 立即 disarm，不空转到原触发点）
 * 6. 被驱逐 id 的迟到 error envelope 同样静默丢弃（对称路径）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as pending from '@/api/pending'
import type { ServerMessage } from '@xyz-agent/shared'

/** 构造 resolveEnvelope 入参（payload 用 as 断言对齐 ServerMessage 联合 payload） */
function envelopeMsg(type: string, id: string, payload: Record<string, unknown>): ServerMessage {
  return { type: type as ServerMessage['type'], id, payload } as ServerMessage
}

/**
 * 注册并立即吞掉终态 rejection——本文件多数用例只观察 map/timer 状态，
 * 不 await 各 promise 结果；驱逐/rejectAll 触发的 reject 若无 handler 会报 unhandled rejection。
 */
function registerSwallowed(id: string, timeoutMs: number): void {
  pending.register(id, timeoutMs).catch(() => {})
}

describe('pending 容量上限 + 共享 sweep timer（Q1-5）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    pending.rejectAll(new Error('setup cleanup'))
  })

  afterEach(() => {
    pending.rejectAll(new Error('teardown cleanup'))
    vi.useRealTimers()
  })

  it('超 256 驱逐最老：第 257 个注册时最老的 pending 被 reject（code overflow），新请求正常可用', async () => {
    const ids: string[] = []
    // 注册满 256 个（长超时，防 sweep 路径误清——本用例只验证 overflow 驱逐）
    for (let i = 0; i < 256; i++) {
      const id = pending.createCommandId()
      ids.push(id)
      registerSwallowed(id, 60_000)
    }
    expect(pending.has(ids[255])).toBe(true)

    // 第 257 个注册 → 触发驱逐最老（第 1 个）：同步发生，无需推进时间
    const id257 = pending.createCommandId()
    const p257 = pending.register<string>(id257, 60_000)

    expect(pending.has(ids[0])).toBe(false) // 最老被驱逐
    expect(pending.has(ids[1])).toBe(true) // 第二老仍在
    expect(pending.has(id257)).toBe(true)

    // 新请求（第 257 个）可正常 resolve
    pending.resolve(id257, 'ok')
    await expect(p257).resolves.toBe('ok')
  })

  it('被驱逐 id 的迟到响应经 resolveEnvelope 静默丢弃（no-op 不抛错、不误 settle 其他请求）', async () => {
    const victim = pending.createCommandId()
    const victimPromise = pending.register(victim, 60_000)
    // 填满至 256
    for (let i = 0; i < 255; i++) {
      registerSwallowed(pending.createCommandId(), 60_000)
    }
    // 下一个注册驱逐 victim（最老）
    const newcomer = pending.createCommandId()
    const pNew = pending.register<string>(newcomer, 60_000)

    // victim 已被驱逐 reject
    await expect(victimPromise).rejects.toMatchObject({ code: 'overflow' })

    // 迟到的响应到达（runtime 慢回）：resolveEnvelope 对已驱逐 id no-op
    expect(() => pending.resolveEnvelope(envelopeMsg('session.getHistory', victim, { sessionId: 's' }))).not.toThrow()
    // newcomer 不受影响，仍可正常 settle
    pending.resolve(newcomer, 'late-ok')
    await expect(pNew).resolves.toBe('late-ok')
  })

  it('N 个 pending 只挂 1 个共享 sweep timer（无 per-request timer 泄漏）', () => {
    expect(vi.getTimerCount()).toBe(0)

    for (let i = 0; i < 100; i++) {
      registerSwallowed(pending.createCommandId(), 60_000)
    }
    // 100 个 pending：全部共享 1 个指向最近 deadline 的 timer
    expect(vi.getTimerCount()).toBe(1)

    // 更早 deadline 的新请求加入 → 仍是 1 个（重挂到更近的 deadline）
    registerSwallowed(pending.createCommandId(), 1_000)
    expect(vi.getTimerCount()).toBe(1)

    // sweep 到期批量 reject 过期条目（1s 的那个）后，剩余条目仍有 timer 在管
    vi.advanceTimersByTime(1_000)
    expect(vi.getTimerCount()).toBe(1)

    // rejectAll 清空 map → timer 一并清除
    pending.rejectAll(new Error('cleanup'))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('timeoutMs=0 的请求不挂 timer 参与 sweep（无超时语义保持）', () => {
    registerSwallowed(pending.createCommandId(), 0)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(120_000)
    // 无 deadline 条目，sweep 无事可做
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resolve/reject 后重算 sweep timer：最后带 deadline 的 pending settle 时 timer 立即清除（W04 review）', async () => {
    // resolve 路径：唯一带 deadline 的 pending 正常完成 → disarm，不空转到原触发点
    const id1 = pending.createCommandId()
    const p1 = pending.register<string>(id1, 60_000)
    expect(vi.getTimerCount()).toBe(1)
    pending.resolve(id1, 'done')
    await expect(p1).resolves.toBe('done')
    expect(vi.getTimerCount()).toBe(0)

    // reject 路径对称：settle 后 timer 同步清除
    const id2 = pending.createCommandId()
    const p2 = pending.register(id2, 60_000)
    expect(vi.getTimerCount()).toBe(1)
    pending.reject(id2, new Error('boom'))
    await expect(p2).rejects.toThrow('boom')
    expect(vi.getTimerCount()).toBe(0)

    // 部分 settle：resolve 最早 deadline 条目后，剩余条目仍被 timer 管（不误 disarm）
    const a = pending.createCommandId()
    const b = pending.createCommandId()
    void pending.register<string>(a, 1_000).catch(() => {})
    void pending.register<string>(b, 60_000).catch(() => {})
    expect(vi.getTimerCount()).toBe(1)
    pending.resolve(a, 'early-done')
    expect(vi.getTimerCount()).toBe(1) // b 的 deadline 仍被管
    vi.advanceTimersByTime(60_000)
    expect(vi.getTimerCount()).toBe(0) // b 超时 sweep 后 map 空 → disarm
  })

  it('被驱逐 id 的迟到 error envelope 经 resolveEnvelope 静默丢弃（对称路径：error type 不抛错不误伤其他请求）', async () => {
    const victim = pending.createCommandId()
    const victimPromise = pending.register(victim, 60_000)
    // 填满至 256
    for (let i = 0; i < 255; i++) {
      registerSwallowed(pending.createCommandId(), 60_000)
    }
    // 下一个注册驱逐 victim（最老）
    const newcomer = pending.createCommandId()
    const pNew = pending.register<string>(newcomer, 60_000)

    await expect(victimPromise).rejects.toMatchObject({ code: 'overflow' })

    // 迟到的 error envelope 到达（runtime 慢回错误）：resolveEnvelope 的 pendingMap.has
    // 前置守卫对 error 分支同样生效——已驱逐 id 不进 reject 展开，no-op
    expect(() =>
      pending.resolveEnvelope(
        envelopeMsg('error', victim, { code: 'permission_denied', message: 'denied' }),
      ),
    ).not.toThrow()
    // newcomer 不受影响（未被误 reject），仍可正常 settle
    pending.resolve(newcomer, 'ok')
    await expect(pNew).resolves.toBe('ok')
  })
})
