/**
 * events safeForEach 测试（W4 / M4）。
 *
 * 锁定 dispatchSession/dispatchGlobal 的订阅者隔离：单 handler 抛错不中断同通道
 * 剩余订阅者。sidebar 有 6+ 组件实例化 useSidebar，一个坏 handler 不应阻断整条广播。
 *
 * 运行：npx vitest run src/__tests__/api/events-safe-forEach.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as events from '@/api/events'
import type { ServerMessage } from '@xyz-agent/shared'

const msg: ServerMessage = { type: 'session.list', payload: { groups: [] } }

beforeEach(() => {
  // events 是模块级单例，无法清理已注册的 handler。每个 case 用唯一 sessionId 避免串扰。
  vi.clearAllMocks()
})

describe('U10: events safeForEach 订阅者隔离（W4 / M4）', () => {
  it('dispatchSession：单 handler 抛错不中断同 sessionId 剩余订阅者', () => {
    const sid = 'test-safe-session-1'
    const throwingHandler = vi.fn(() => { throw new Error('boom') })
    const normalHandler = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    events.on(sid, throwingHandler)
    events.on(sid, normalHandler)

    events.dispatchSession(sid, msg)

    // normalHandler 仍被调用（未被 throwingHandler 中断）
    expect(normalHandler).toHaveBeenCalledTimes(1)
    expect(normalHandler).toHaveBeenCalledWith(msg)
    // throwingHandler 也被调用（只是抛了错）
    expect(throwingHandler).toHaveBeenCalledTimes(1)
    // 错误被 console.error 记录
    expect(errorSpy).toHaveBeenCalled()

    errorSpy.mockRestore()
  })

  it('dispatchGlobal：单 handler 抛错不中断其余 global 订阅者', () => {
    const throwingHandler = vi.fn(() => { throw new Error('crash') })
    const normalHandler = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    events.onGlobal(throwingHandler)
    events.onGlobal(normalHandler)

    events.dispatchGlobal(msg)

    expect(normalHandler).toHaveBeenCalledTimes(1)
    expect(throwingHandler).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalled()

    errorSpy.mockRestore()
  })
})
