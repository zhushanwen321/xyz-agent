import { describe, it, expect, vi } from 'vitest'
import type { ClientMessage, ServerMessage, ServerMessageType } from '@xyz-agent/shared'
import { createEvents } from '../events'
import { createApiClient } from '../factory'
import type { Transport } from '../transport'

const msg = (
  type: ServerMessageType,
  payload: Record<string, unknown>,
  id?: string,
): ServerMessage => ({ type, id, payload })

describe('createEvents — on 订阅与取消', () => {
  it('on 订阅 + _dispatch 触发 handler；返回的取消函数能取消', () => {
    const events = createEvents()
    const handler = vi.fn()
    const off = events.on('message.text_delta', handler)

    events._dispatch(msg('message.text_delta', { sessionId: 's1', content: 'hi' }))
    expect(handler).toHaveBeenCalledTimes(1)

    off()
    events._dispatch(msg('message.text_delta', { sessionId: 's1', content: 'again' }))
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('createEvents — D6b 无 sessionId 丢弃', () => {
  it('payload 有 sessionId 字段但值缺失(undefined/null/空串) → 丢弃 + warn', () => {
    const events = createEvents()
    const handler = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    events.on('message.text_delta', handler)

    events._dispatch(msg('message.text_delta', { sessionId: undefined, content: 'x' }))
    events._dispatch(msg('message.text_delta', { sessionId: null, content: 'x' }))
    events._dispatch(msg('message.text_delta', { sessionId: '', content: 'x' }))

    expect(handler).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(3)
    expect(warn.mock.calls[0][0]).toContain('丢弃无 sessionId 消息')
    warn.mockRestore()
  })

  it('payload 有效 sessionId → 正常 emit；payload 无 sessionId 字段(config.providers) → 正常 emit', () => {
    const events = createEvents()
    const textHandler = vi.fn()
    const configHandler = vi.fn()
    events.on('message.text_delta', textHandler)
    events.on('config.providers', configHandler)

    events._dispatch(msg('message.text_delta', { sessionId: 's1', content: 'x' }))
    events._dispatch(msg('config.providers', { providers: [] }))

    expect(textHandler).toHaveBeenCalledTimes(1)
    expect(configHandler).toHaveBeenCalledTimes(1)
  })

  // 用 spec/plan 点名的两个类型钉死 D6b 契约：session.created（带 sessionId 字段但空）丢弃、
  // pong（根本无 sessionId 字段）放行。防止未来重构 _dispatch 时这两类回归（phase-5 guardrails 5.1）。
  it('session.created 空 sid 丢弃；pong 无 sessionId 字段放行（同一 _dispatch 规则）', () => {
    const events = createEvents()
    const createdHandler = vi.fn()
    const pongHandler = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    events.on('session.created', createdHandler)
    events.on('pong', pongHandler)

    events._dispatch(msg('session.created', { sessionId: '' }))
    events._dispatch(msg('pong', {}))

    expect(createdHandler).not.toHaveBeenCalled()
    expect(pongHandler).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('createEvents — 重连收尾信号 (G5)', () => {
  it('_notifyConnectionRestored 触发 onConnectionRestored 订阅者；取消后不再触发', () => {
    const events = createEvents()
    const handler = vi.fn()
    const off = events.onConnectionRestored(handler)

    events._notifyConnectionRestored()
    expect(handler).toHaveBeenCalledTimes(1)

    off()
    events._notifyConnectionRestored()
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('createEvents — handler 错误隔离', () => {
  it('一个 handler 抛错不影响同 type 其他 handler', () => {
    const events = createEvents()
    const boom = vi.fn(() => {
      throw new Error('boom')
    })
    const ok = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    events.on('message.text_delta', boom)
    events.on('message.text_delta', ok)

    events._dispatch(msg('message.text_delta', { sessionId: 's1', content: 'x' }))

    expect(boom).toHaveBeenCalledTimes(1)
    expect(ok).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('createApiClient — 命令/事件分流集成', () => {
  it('命令响应(id 匹配)被 pending 结算、不泄漏为事件；无 id 事件 → events emit', async () => {
    let captured: ((m: ServerMessage) => void) | null = null
    const send = vi.fn<(msg: ClientMessage) => void>()
    const fakeTransport: Transport = {
      send,
      onMessage: (h) => {
        captured = h
        return () => {
          captured = null
        }
      },
      onClose: () => () => {},
    }
    const api = createApiClient({ transport: fakeTransport })

    // session.list 既是命令响应 type 也是事件 type：用同 type 验证 id 分流
    const listHandler = vi.fn()
    api.events.on('session.list', listHandler)

    // 命令：发出带 id 的请求
    const p = api.session.list()
    expect(send).toHaveBeenCalledTimes(1)
    const sent = send.mock.calls[0][0]
    expect(sent.id).toBeTruthy()

    // runtime 回带同 id 的响应 → pending 结算，events 不 emit
    captured?.({ type: 'session.list', id: sent.id, payload: { items: [] } })
    await expect(p).resolves.toEqual({ items: [] })
    expect(listHandler).not.toHaveBeenCalled()

    // 事件：无 id 的 session.list → events emit
    captured?.({ type: 'session.list', payload: { items: [{ id: 'pushed' }] } })
    expect(listHandler).toHaveBeenCalledTimes(1)
  })
})
