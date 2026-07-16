/**
 * ws-client.send 返回布尔值回归测试（W4 fast-fail）。
 *
 * 锁定 W4 改动：send(msg) 应返回 boolean，让调用方能在连接未就绪时 fast-fail
 * （如 pending.send 在 connecting / closed 态立即 reject，而非默默丢弃消息
 * 让 Promise 永挂，直到超时才报错）。
 *
 * 测试环境 VITE_MOCK=true：ws-client 的 send 走 mock 分支，由 mockSend 桩控制返回值。
 * mockSend 返回 undefined → send 视为发送成功（true）；返回 boolean → 以它为准。
 * 非 mock 模式下 readyState 分支的行为由集成测试覆盖。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/ws-client-send-boolean.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ClientMessage } from '@xyz-agent/shared'

// ── mock-ws stub：VITE_MOCK=true 时 ws-client.send 走 mockSend 分支。
// 桩返回值由 mockSend 控制（undefined=成功/true，boolean=精确控制）。
const mockSend = vi.fn<unknown[], unknown>()
vi.mock('@/mock/mock-ws', () => ({
  mockConnect: vi.fn(),
  mockSend: (msg: unknown) => mockSend(msg),
  mockDisconnect: vi.fn(),
}))

import { send } from '@/lib/ws-client'

describe('ws-client.send 返回 boolean（W4 fast-fail）', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('mockSend 返回 undefined 时 send 返回 true（发送成功）', () => {
    mockSend.mockReturnValue(undefined)
    const msg: ClientMessage = { type: 'ping', payload: {} }
    const result = send(msg)
    expect(result).toBe(true)
  })

  it('mockSend 返回 false 时 send 返回 false（模拟未就绪/拒绝发送）', () => {
    mockSend.mockReturnValue(false)
    const msg: ClientMessage = { type: 'ping', payload: {} }
    const result = send(msg)
    expect(result).toBe(false)
  })

  it('mockSend 返回 true 时 send 返回 true（显式确认发送）', () => {
    mockSend.mockReturnValue(true)
    const msg: ClientMessage = { type: 'ping', payload: {} }
    const result = send(msg)
    expect(result).toBe(true)
  })

  it('send 返回值类型为 boolean（非 undefined / void）', () => {
    mockSend.mockReturnValue(undefined)
    const msg: ClientMessage = { type: 'ping', payload: {} }
    const result = send(msg)
    // 关键契约：返回值必须是布尔类型（W4 前是 void）
    expect(typeof result).toBe('boolean')
  })
})
