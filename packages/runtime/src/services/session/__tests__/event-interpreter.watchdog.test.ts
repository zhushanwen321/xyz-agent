/**
 * EventInterpreter ping watchdog 测试（P3 s2 AC6）。
 *
 * 覆盖：
 * - TC-AC6:  审批挂起时 ping 恒成功（pi 等响应事件循环仍活）→ 推进 180s+ → onSilentAbort 不触发
 *           （spec §三表 D6：watchdog 不误 abort 等审批的 pi）
 * - TC-AC6b: 对照基线——ping 恒 reject（pi 真死）→ 推进到 PING_FAIL_THRESHOLD → onSilentAbort 触发
 *           （证明 watchdog 机制本身有效，TC-AC6「不误 abort」断言可信）
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/event-interpreter.watchdog.test.ts
 *
 * 测试策略：vi.useFakeTimers 推进 PING_INTERVAL_MS；真实 EventInterpreter 实例（不 mock pingTick 内部逻辑），
 * 仅 mock pingPi 回调 + onSilentAbort spy。常量从源码 import（SR6 SSOT，不硬编码 60/3 漂移）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventInterpreter, PING_INTERVAL_MS, PING_FAIL_THRESHOLD } from '../event-interpreter.js'

describe('EventInterpreter ping watchdog（P3 s2 AC6）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // TC-AC6: 审批挂起时 ping 正常响应，watchdog 不误 abort
  it('TC-AC6: pi 等审批时 ping 恒成功响应（事件循环活）→ 推进 180s+ → onSilentAbort 不触发', async () => {
    const onSilentAbort = vi.fn()
    // pingPi 恒 resolve 非空：模拟 pi 阻塞在 await extension 响应时，事件循环仍活，get_state 正常响应
    const pingPi = vi.fn(async () => ({ ok: true, thinkingLevel: 'medium' }))
    const interpreter = new EventInterpreter('s-ac6', {
      send: () => {},
      pingPi,
      onSilentAbort,
    })

    // turn-start 启动 pingLoop（event-interpreter.ts:208-211）
    interpreter.interpret([{ kind: 'turn-start', messageId: 'm1' }])

    // 推进 PING_INTERVAL_MS * (PING_FAIL_THRESHOLD + 1)（超过 abort 阈值，如 4*60=240s > 180s）
    // advanceTimersByTimeAsync 同时推进 setInterval 宏任务 + flush await pingPi() 微任务
    const ticks = PING_FAIL_THRESHOLD + 1
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * ticks)

    // 期间所有 ping 成功响应 → 失败计数恒为 0
    expect(pingPi).toHaveBeenCalledTimes(ticks)
    // 核心断言：审批挂起场景 watchdog 不误 abort
    expect(onSilentAbort).not.toHaveBeenCalled()
  })

  // TC-AC6b: 对照基线——pi 真卡死时 ping 连续失败达阈值 → onSilentAbort 触发
  it('TC-AC6b: pi 真卡死（ping 恒 reject）→ 连续 PING_FAIL_THRESHOLD 次失败 → onSilentAbort 触发（对照基线）', async () => {
    const onSilentAbort = vi.fn()
    // pingPi 恒 reject：模拟 pi 进程真死，get_state 永远超时/拒绝
    const pingPi = vi.fn(async () => {
      throw new Error('pi process dead: get_state timeout')
    })
    const interpreter = new EventInterpreter('s-ac6b', {
      send: () => {},
      pingPi,
      onSilentAbort,
    })

    interpreter.interpret([{ kind: 'turn-start', messageId: 'm1' }])

    // 推进到刚好 PING_FAIL_THRESHOLD 次（3*60=180s）
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * PING_FAIL_THRESHOLD)

    // 连续 3 次失败 → 判定 pi 真死 → onSilentAbort 触发（与 TC-AC6 形成对照，证明 watchdog 有效）
    expect(pingPi).toHaveBeenCalledTimes(PING_FAIL_THRESHOLD)
    expect(onSilentAbort).toHaveBeenCalledTimes(1)
    expect(onSilentAbort).toHaveBeenCalledWith({ sessionId: 's-ac6b' })
  })
})
