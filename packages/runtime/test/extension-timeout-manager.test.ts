/**
 * ExtensionTimeoutManager 单测 —— 纯逻辑状态机。
 *
 * 覆盖：
 * - registerTimeout 三分支（notify 早退 / bridge: 仅登记 / 交互式 method 仅 session 跟踪不建 timer）
 * - clearTimeout 单条清理
 * - clearForSession（含 bridgeRequestIds 清理 + 跨 session 隔离）
 * - [2026-07-16] 交互式 method（select/confirm/input/editor/ask-user）不再触发 onTimeout
 * - 重复 register 不再产生定时器
 * - isBridgeRequest / removeBridgeRequest
 *
 * 用 vi.useFakeTimers() 控制 setTimeout（manager 内部用真实 setTimeout + 300s 超时）。
 *
 * 运行：pnpm --filter @xyz-agent/runtime run test -- test/extension-timeout-manager.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ExtensionTimeoutManager } from '../src/services/extension-timeout-manager.js'

describe('ExtensionTimeoutManager', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('registerTimeout(method="notify") 不建 timer（早退）', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'notify', onTimeout)
    // 远超 5min 超时
    vi.advanceTimersByTime(mgr.TIMEOUT_MS + 1)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('registerTimeout(method="bridge:*") 仅登记 bridgeRequestIds + session，不建 timer', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'bridge:something', onTimeout)
    expect(mgr.isBridgeRequest('r1')).toBe(true)
    vi.advanceTimersByTime(mgr.TIMEOUT_MS + 1)
    // bridge 请求靠跨进程序列驱动，不建本地 timer
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('registerTimeout(交互式 method) 仅 session 跟踪，不再建 timer/触发 onTimeout', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'select', onTimeout)
    // [2026-07-16] 交互式 method 统一不超时，block 等待用户决策
    vi.advanceTimersByTime(mgr.TIMEOUT_MS + 1)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('clearTimeout 对交互式 method 是 no-op（无 timer 可清，仍不触发回调）', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'select', onTimeout)
    mgr.clearTimeout('r1')
    vi.advanceTimersByTime(mgr.TIMEOUT_MS)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('clearForSession 清掉该 session 的 bridge 请求，不影响其他 session 的 session 跟踪', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout1 = vi.fn()
    const onTimeout2 = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'select', onTimeout1)
    mgr.registerTimeout('s1', 'r2', 'bridge:cmd', vi.fn())
    mgr.registerTimeout('s2', 'r3', 'select', onTimeout2)

    mgr.clearForSession('s1')

    vi.advanceTimersByTime(mgr.TIMEOUT_MS)
    expect(onTimeout1).not.toHaveBeenCalled() // 交互式 method 本就不触发
    expect(mgr.isBridgeRequest('r2')).toBe(false) // s1 bridge 请求已清
    expect(onTimeout2).not.toHaveBeenCalled() // 交互式 method 本就不触发
  })

  it('clearForSession 对无请求的 session 是 no-op', () => {
    const mgr = new ExtensionTimeoutManager()
    expect(() => mgr.clearForSession('no-such-session')).not.toThrow()
  })

  it('重复 registerTimeout(相同 requestId) 不再产生定时器，回调均不触发', () => {
    const mgr = new ExtensionTimeoutManager()
    const oldCb = vi.fn()
    const newCb = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'select', oldCb)
    mgr.registerTimeout('s1', 'r1', 'select', newCb) // 覆盖

    vi.advanceTimersByTime(mgr.TIMEOUT_MS)
    expect(oldCb).not.toHaveBeenCalled()
    expect(newCb).not.toHaveBeenCalled()
  })

  it('removeBridgeRequest 从 bridge 跟踪表移除', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.registerTimeout('s1', 'r1', 'bridge:cmd', vi.fn())
    expect(mgr.isBridgeRequest('r1')).toBe(true)
    mgr.removeBridgeRequest('r1')
    expect(mgr.isBridgeRequest('r1')).toBe(false)
  })

  it('isBridgeRequest 对未登记 id 返回 false', () => {
    const mgr = new ExtensionTimeoutManager()
    expect(mgr.isBridgeRequest('never-registered')).toBe(false)
  })
})
