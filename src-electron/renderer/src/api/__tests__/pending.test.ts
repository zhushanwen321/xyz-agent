import { describe, it, expect, vi } from 'vitest'
import { createPending, ApiTimeoutError, ApiDisconnectError } from '../pending'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const makeSend = () => vi.fn<(msg: ClientMessage) => void>()

const historyMsg = (sessionId: string): ClientMessage => ({
  type: 'session.history',
  payload: { sessionId },
})

const lastSent = (send: ReturnType<typeof makeSend>, index: number): ClientMessage =>
  send.mock.calls[index][0]

describe('createPending — command', () => {
  it('发出带 uuid 格式 id 的消息，并调用 send', () => {
    const send = makeSend()
    const pending = createPending({ send })

    void pending.command(historyMsg('s1'))

    expect(send).toHaveBeenCalledTimes(1)
    const sent = lastSent(send, 0)
    expect(sent.id).toMatch(UUID_RE)
    expect(sent.type).toBe('session.history')
    expect(sent.payload).toEqual({ sessionId: 's1' })
  })
})

describe('createPending — handleMessage 路由', () => {
  it('匹配 id 的成功响应 resolve payload；type=error reject', async () => {
    const send = makeSend()
    const pending = createPending({ send })

    const p = pending.command<{ ok: true }>({ type: 'session.list', payload: {} })
    const id = lastSent(send, 0).id!

    const handled = pending.handleMessage({
      type: 'session.list',
      id,
      payload: { ok: true },
    })
    expect(handled).toBe(true)
    await expect(p).resolves.toEqual({ ok: true })

    // error 响应分支
    const p2 = pending.command({ type: 'session.list', payload: {} })
    const id2 = lastSent(send, 1).id!
    const handledErr = pending.handleMessage({
      type: 'error',
      id: id2,
      payload: { error: 'boom' },
    })
    expect(handledErr).toBe(true)
    await expect(p2).rejects.toThrow('boom')
  })

  it('error 响应无 error 字段时回落到 Unknown error', async () => {
    const send = makeSend()
    const pending = createPending({ send })
    const p = pending.command({ type: 'session.list', payload: {} })
    const id = lastSent(send, 0).id!
    pending.handleMessage({ type: 'error', id, payload: {} })
    await expect(p).rejects.toThrow('Unknown error')
  })

  it('无 id / 未知 id 的消息返回 false（交由上层作为事件）', () => {
    const send = makeSend()
    const pending = createPending({ send })
    void pending.command(historyMsg('s1'))

    // 无 id
    expect(
      pending.handleMessage({ type: 'pong', payload: {} } as ServerMessage),
    ).toBe(false)
    // 未知 id
    expect(
      pending.handleMessage({ type: 'pong', id: 'no-such-id', payload: {} }),
    ).toBe(false)
  })

  it('迟到响应：resolve 后再发同 id 消息返回 false（已不在表）', async () => {
    const send = makeSend()
    const pending = createPending({ send })
    const p = pending.command<{ v: number }>({ type: 'session.list', payload: {} })
    const id = lastSent(send, 0).id!

    pending.handleMessage({ type: 'session.list', id, payload: { v: 1 } })
    await expect(p).resolves.toEqual({ v: 1 })

    // 迟到的重复响应不再被消费
    expect(
      pending.handleMessage({ type: 'session.list', id, payload: { v: 2 } }),
    ).toBe(false)
  })
})

describe('createPending — 超时善后', () => {
  it('30s 超时 reject ApiTimeoutError 并清表', async () => {
    vi.useFakeTimers()
    try {
      const send = makeSend()
      const pending = createPending({ send })
      const p = pending.command({ type: 'session.list', payload: {} })

      vi.advanceTimersByTime(29_999)
      expect(pending.size).toBe(1)
      vi.advanceTimersByTime(1)

      const reason = await p.catch((e: unknown) => e)
      expect(reason).toBeInstanceOf(ApiTimeoutError)
      expect(pending.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createPending — 断连 / session 清理', () => {
  it('rejectAll：全部 pending reject，size 归 0', async () => {
    const send = makeSend()
    const pending = createPending({ send })
    const p1 = pending.command(historyMsg('s1'))
    const p2 = pending.command(historyMsg('s2'))
    expect(pending.size).toBe(2)

    pending.rejectAll(new ApiDisconnectError('disconnected'))

    await expect(p1).rejects.toBeInstanceOf(ApiDisconnectError)
    await expect(p2).rejects.toBeInstanceOf(ApiDisconnectError)
    expect(pending.size).toBe(0)
  })

  it('clearBySessionId：仅清匹配 session 的 pending，其余保留并可正常结算', async () => {
    const send = makeSend()
    const pending = createPending({ send })
    const p1 = pending.command(historyMsg('s1'))
    const p2 = pending.command(historyMsg('s2'))
    expect(pending.size).toBe(2)

    pending.clearBySessionId('s1')

    await expect(p1).rejects.toBeInstanceOf(ApiDisconnectError)
    expect(pending.size).toBe(1)

    // s2 仍可被正常响应结算
    const id2 = lastSent(send, 1).id!
    pending.handleMessage({
      type: 'session.history',
      id: id2,
      payload: { items: [] },
    })
    await expect(p2).resolves.toEqual({ items: [] })
    expect(pending.size).toBe(0)
  })

  it('payload 无 sessionId 的命令不受 clearBySessionId 影响', () => {
    const send = makeSend()
    const pending = createPending({ send })
    void pending.command({ type: 'session.list', payload: {} })
    expect(pending.size).toBe(1)

    pending.clearBySessionId('s1')
    expect(pending.size).toBe(1)
  })
})
