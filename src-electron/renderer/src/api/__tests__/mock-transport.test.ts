import { describe, it, expect, vi } from 'vitest'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import { createMockTransport } from '../mock'

/** 收集 transport 推送的所有消息。 */
const collector = (): { received: ServerMessage[]; off: () => void } => {
  const transport = createMockTransport()
  const received: ServerMessage[] = []
  const off = transport.onMessage((m) => received.push(m))
  return { received, off }
}

describe('createMockTransport — 命令响应回填 id', () => {
  it('session.list → session.list 带 id + groups', () => {
    const { received } = collector()
    const t = createMockTransport()
    t.onMessage((m) => received.push(m))

    const req: ClientMessage = { type: 'session.list', id: 'req-1', payload: {} }
    t.send(req)

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('session.list')
    expect(received[0].id).toBe('req-1')
    expect(Array.isArray(received[0].payload.groups)).toBe(true)
  })

  it('config.getProviders → config.providers 带 id + providers', () => {
    const t = createMockTransport()
    const received: ServerMessage[] = []
    t.onMessage((m) => received.push(m))

    t.send({ type: 'config.getProviders', id: 'req-2', payload: {} })

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('config.providers')
    expect(received[0].id).toBe('req-2')
    expect(Array.isArray(received[0].payload.providers)).toBe(true)
  })

  it('ping → pong 带 id', () => {
    const t = createMockTransport()
    const received: ServerMessage[] = []
    t.onMessage((m) => received.push(m))

    t.send({ type: 'ping', id: 'req-3', payload: {} })

    expect(received[0].type).toBe('pong')
    expect(received[0].id).toBe('req-3')
  })
})

describe('createMockTransport — message.send 流式序列', () => {
  it('首条 message.status 带 id 立即发（命令响应）；message_start/text_delta/complete 无 id 延迟发', () => {
    vi.useFakeTimers()
    try {
      const t = createMockTransport()
      const received: ServerMessage[] = []
      t.onMessage((m) => received.push(m))

      t.send({ type: 'message.send', id: 'req-4', payload: { sessionId: 's1', content: 'hello world' } })

      // 首条立即：message.status 带 id（命令响应，让 pending 结算）
      expect(received).toHaveLength(1)
      expect(received[0].type).toBe('message.status')
      expect(received[0].id).toBe('req-4')
      expect(received[0].payload.sessionId).toBe('s1')
      expect(received[0].payload.status).toBe('sent')

      // 推进时间收齐流式后续
      vi.advanceTimersByTime(500)

      const types = received.map((m) => m.type)
      expect(types).toContain('message.message_start')
      expect(types).toContain('message.thinking_start')
      expect(types).toContain('message.thinking_delta')
      expect(types).toContain('message.thinking_end')
      expect(types).toContain('message.text_delta')
      expect(types).toContain('message.complete')

      // 流式事件无 id（走 events 路径，不应误触发 pending 结算）
      const start = received.find((m) => m.type === 'message.message_start')
      expect(start?.id).toBeUndefined()
      const delta = received.find((m) => m.type === 'message.text_delta')
      expect(delta?.id).toBeUndefined()
      const complete = received.find((m) => m.type === 'message.complete')
      expect(complete?.id).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createMockTransport — 未覆盖 type 不崩', () => {
  it('未显式处理的 type 兜底 ack pong 带 id（pending 不挂死）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = createMockTransport()
    const received: ServerMessage[] = []
    t.onMessage((m) => received.push(m))

    // extension.install 未在 responses 显式覆盖业务逻辑 → 走 ack
    t.send({ type: 'extension.install', id: 'req-5', payload: { source: 'x' } })

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('pong')
    expect(received[0].id).toBe('req-5')
    expect(warn).not.toHaveBeenCalled() // 已知 type 走 ack，不 warn
    warn.mockRestore()
  })
})

describe('createMockTransport — onMessage 取消订阅', () => {
  it('off 后不再收到消息', () => {
    const t = createMockTransport()
    const received: ServerMessage[] = []
    const off = t.onMessage((m) => received.push(m))

    off()
    t.send({ type: 'ping', id: 'req-6', payload: {} })

    expect(received).toHaveLength(0)
  })
})
