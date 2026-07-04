/**
 * ExtensionTimeoutManager 单测 —— 纯逻辑状态机。
 *
 * 覆盖：
 * - registerTimeout 三分支（notify 早退 / bridge: 仅登记 / 正常建 timer）
 * - clearTimeout 单条清理
 * - clearForSession（含 bridgeRequestIds 清理 + 跨 session 隔离）
 * - timer 到期触发 onTimeout
 * - 重复 register 覆盖旧 timer
 * - isBridgeRequest / removeBridgeRequest
 *
 * 用 vi.useFakeTimers() 控制 setTimeout（manager 内部用真实 setTimeout + 300s 超时）。
 *
 * 运行：cd src-electron/runtime && npx vitest run test/extension-timeout-manager.test.ts
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

  it('registerTimeout(正常 method) 建 timer，到期触发 onTimeout', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'select', onTimeout)
    expect(onTimeout).not.toHaveBeenCalled()
    // 未到期不触发
    vi.advanceTimersByTime(mgr.TIMEOUT_MS - 1)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('clearTimeout 取消 pending timer', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'select', onTimeout)
    mgr.clearTimeout('r1')
    vi.advanceTimersByTime(mgr.TIMEOUT_MS)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('clearForSession 清掉该 session 的 timer + bridge 请求，不影响其他 session', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout1 = vi.fn()
    const onTimeout2 = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'select', onTimeout1)
    mgr.registerTimeout('s1', 'r2', 'bridge:cmd', vi.fn())
    mgr.registerTimeout('s2', 'r3', 'select', onTimeout2)

    mgr.clearForSession('s1')

    vi.advanceTimersByTime(mgr.TIMEOUT_MS)
    expect(onTimeout1).not.toHaveBeenCalled() // s1 timer 已清
    expect(mgr.isBridgeRequest('r2')).toBe(false) // s1 bridge 请求已清
    expect(onTimeout2).toHaveBeenCalledTimes(1) // s2 不受影响
  })

  it('clearForSession 对无请求的 session 是 no-op', () => {
    const mgr = new ExtensionTimeoutManager()
    expect(() => mgr.clearForSession('no-such-session')).not.toThrow()
  })

  it('重复 registerTimeout(相同 requestId) 覆盖旧 timer，旧回调不再触发', () => {
    const mgr = new ExtensionTimeoutManager()
    const oldCb = vi.fn()
    const newCb = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'select', oldCb)
    mgr.registerTimeout('s1', 'r1', 'select', newCb) // 覆盖

    vi.advanceTimersByTime(mgr.TIMEOUT_MS)
    expect(oldCb).not.toHaveBeenCalled() // 旧 timer 已被 clearTimeout
    expect(newCb).toHaveBeenCalledTimes(1) // 新 timer 触发一次
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
