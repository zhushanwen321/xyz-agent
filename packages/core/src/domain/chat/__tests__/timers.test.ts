/**
 * timers 子域独立单测（MF-2，initTimers factory + clearSessionTimer 行为锁定）。
 *
 * 直接调 initTimers() 工厂构造实例：finalizeSession / finalizeBashOnly 用 vi.fn() mock
 * （依赖注入，避免引循环 import）。timer 用 vi.useFakeTimers() + vi.advanceTimersByTime()
 * 模拟到期，避免真实等待触发 vitest 5s 超时。
 *
 * 覆盖分支（对应 R1 MF-2）：
 * - [W1 decouple] bash timer 到期调 finalizeBashOnly，**不**调 finalizeSession（C2 回归防护）
 * - streaming timer 到期调 finalizeSession(reason='timeout')
 * - clearStreamingTimer / clearBashTimer / disposeAllTimers（HMR/dispose 清理）
 * - clearSessionTimer（export 纯函数）
 * - per-session 隔离 + 重复 arm 不泄漏旧 timer
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initTimers, clearSessionTimer } from '../timers'

const STREAMING_TIMEOUT_MS = 10_000
const BASH_TIMEOUT_MS = 300_000

function makeTimers() {
  const finalizeSession = vi.fn<(sessionId: string, reason: string, errorText?: string) => void>()
  const finalizeBashOnly = vi.fn<(sessionId: string) => void>()
  const t = initTimers(finalizeSession, finalizeBashOnly, STREAMING_TIMEOUT_MS)
  return { t, finalizeSession, finalizeBashOnly }
}

describe('initTimers — streaming timer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('armStreamingTimer 挂 timer；未到期不调 finalizeSession', () => {
    const { t, finalizeSession } = makeTimers()
    t.armStreamingTimer('s1')
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS - 1)
    expect(finalizeSession).not.toHaveBeenCalled()
  })

  it('streaming timer 到期调 finalizeSession(sessionId, "timeout")', () => {
    const { t, finalizeSession } = makeTimers()
    t.armStreamingTimer('s1')

    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS)
    expect(finalizeSession).toHaveBeenCalledTimes(1)
    expect(finalizeSession).toHaveBeenCalledWith('s1', 'timeout')
  })

  it('streaming timer 到期后自动从 Map 移除（getTimerCount 归 0）', () => {
    const { t } = makeTimers()
    t.armStreamingTimer('s1')
    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clearStreamingTimer 清 timer，到期不再调 finalizeSession', () => {
    const { t, finalizeSession } = makeTimers()
    t.armStreamingTimer('s1')
    t.clearStreamingTimer('s1')
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS)
    expect(finalizeSession).not.toHaveBeenCalled()
  })

  it('重复 armStreamingTimer 先清旧再挂新（同 session 不叠加）', () => {
    const { t } = makeTimers()
    t.armStreamingTimer('s1')
    t.armStreamingTimer('s1') // 再次 arm
    expect(vi.getTimerCount()).toBe(1)
  })
})

describe('initTimers — bash timer [W1 decouple 回归防护]', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('armBashTimer 挂 timer；未到期不调 finalizeBashOnly', () => {
    const { t, finalizeBashOnly } = makeTimers()
    t.armBashTimer('s1')
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(BASH_TIMEOUT_MS - 1)
    expect(finalizeBashOnly).not.toHaveBeenCalled()
  })

  it('[W1 核心] bash timer 到期调 finalizeBashOnly，**不**调 finalizeSession', () => {
    // C2 回归防护：L1 放宽 bash↔streaming 并发后，bash timer 到期若调 finalizeSession
    // 会把共存中正在生成的 assistant turn 一并收口。必须解耦到 finalizeBashOnly。
    const { t, finalizeSession, finalizeBashOnly } = makeTimers()
    t.armBashTimer('s1')

    vi.advanceTimersByTime(BASH_TIMEOUT_MS)

    expect(finalizeBashOnly).toHaveBeenCalledTimes(1)
    expect(finalizeBashOnly).toHaveBeenCalledWith('s1')
    expect(finalizeSession).not.toHaveBeenCalled() // 关键：不跨域误杀
  })

  it('bash timer 到期后自动从 Map 移除', () => {
    const { t } = makeTimers()
    t.armBashTimer('s1')
    vi.advanceTimersByTime(BASH_TIMEOUT_MS)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clearBashTimer 清 timer，到期不再调 finalizeBashOnly', () => {
    const { t, finalizeBashOnly } = makeTimers()
    t.armBashTimer('s1')
    t.clearBashTimer('s1')
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(BASH_TIMEOUT_MS)
    expect(finalizeBashOnly).not.toHaveBeenCalled()
  })

  it('重复 armBashTimer 先清旧再挂新（per-session 互斥，同 session 不叠加）', () => {
    const { t } = makeTimers()
    t.armBashTimer('s1')
    t.armBashTimer('s1')
    expect(vi.getTimerCount()).toBe(1)
  })

  it('streaming 与 bash timer 独立：clearStreamingTimer 不影响 bashTimer', () => {
    const { t, finalizeSession, finalizeBashOnly } = makeTimers()
    t.armStreamingTimer('s1')
    t.armBashTimer('s1')
    expect(vi.getTimerCount()).toBe(2)

    t.clearStreamingTimer('s1')
    expect(vi.getTimerCount()).toBe(1) // 只剩 bash

    vi.advanceTimersByTime(BASH_TIMEOUT_MS) // streaming 已清，不会触发
    expect(finalizeSession).not.toHaveBeenCalled()
    expect(finalizeBashOnly).toHaveBeenCalledTimes(1) // bash 正常触发
  })

  it('streaming 与 bash timer 独立：clearBashTimer 不影响 streamingTimer', () => {
    const { t, finalizeSession, finalizeBashOnly } = makeTimers()
    t.armStreamingTimer('s1')
    t.armBashTimer('s1')

    t.clearBashTimer('s1')
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS)
    expect(finalizeBashOnly).not.toHaveBeenCalled()
    expect(finalizeSession).toHaveBeenCalledTimes(1)
  })

  it('per-session 隔离：s1 到期不影响 s2 的 timer', () => {
    const { t, finalizeSession, finalizeBashOnly } = makeTimers()
    t.armStreamingTimer('s1')
    t.armStreamingTimer('s2')

    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS)
    // 两个同时挂同时到期（同 timeout），都应触发
    expect(finalizeSession).toHaveBeenCalledWith('s1', 'timeout')
    expect(finalizeSession).toHaveBeenCalledWith('s2', 'timeout')
    expect(vi.getTimerCount()).toBe(0)
    // bash 不受影响
    expect(finalizeBashOnly).not.toHaveBeenCalled()
  })
})

describe('initTimers — disposeAllTimers', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('disposeAllTimers 清全部 streaming + bash timer（HMR/store dispose）', () => {
    const { t, finalizeSession, finalizeBashOnly } = makeTimers()
    t.armStreamingTimer('s1')
    t.armStreamingTimer('s2')
    t.armBashTimer('s1')
    t.armBashTimer('s3')
    expect(vi.getTimerCount()).toBe(4)

    t.disposeAllTimers()
    expect(vi.getTimerCount()).toBe(0)

    // advance 超过所有 timeout：无任何回调
    vi.advanceTimersByTime(BASH_TIMEOUT_MS + STREAMING_TIMEOUT_MS)
    expect(finalizeSession).not.toHaveBeenCalled()
    expect(finalizeBashOnly).not.toHaveBeenCalled()
  })

  it('disposeAllTimers 幂等：无 timer 时 no-op', () => {
    const { t } = makeTimers()
    expect(() => t.disposeAllTimers()).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disposeAllTimers 后可重新 arm timer（实例可复用）', () => {
    const { t, finalizeSession } = makeTimers()
    t.armStreamingTimer('s1')
    t.disposeAllTimers()

    t.armStreamingTimer('s1') // 重新 arm
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS)
    expect(finalizeSession).toHaveBeenCalledTimes(1)
  })
})

describe('clearSessionTimer — export 纯函数', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('清指定 session 的 timer（从 Map 移除 + clearTimeout）', () => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    timers.set('s1', setTimeout(() => {}, 1000))
    timers.set('s2', setTimeout(() => {}, 1000))

    clearSessionTimer(timers, 's1')

    expect(timers.has('s1')).toBe(false)
    expect(timers.has('s2')).toBe(true) // s2 不受影响
  })

  it('幂等：清不存在的 session timer 不报错（Map 无该 key 时 no-op）', () => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    expect(() => clearSessionTimer(timers, 'ghost')).not.toThrow()
    expect(timers.size).toBe(0)
  })

  it('clearSessionTimer 是 timers.ts 公共 API：initTimers 内部 armStreaming/armBash 共用同一函数', () => {
    // 间接验证：armStreamingTimer 后用 clearSessionTimer 形态（经 clearStreamingTimer 封装）
    // 能正确清除，说明 initTimers 内部 Map 与 clearSessionTimer 的 Map 类型一致
    const { t } = makeTimers()
    t.armStreamingTimer('s1')
    t.clearStreamingTimer('s1') // 内部调 clearSessionTimer
    expect(vi.getTimerCount()).toBe(0)
  })
})
