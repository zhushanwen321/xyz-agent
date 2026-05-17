import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

/**
 * T2 测试：sendMessage 的 subagent 参数传递
 *
 * 当前 sendMessage 签名是 (content: string)，不接收 subagent 参数。
 * 目标签名：(content: string, subagent?: { agent: string; task: string })
 *
 * 当 subagent 被传入时，WS payload 必须包含 subagent 字段。
 * 当 subagent 未传入时，行为与现有完全一致（backward compat）。
 */

// ── Mock 依赖 ──────────────────────────────────────────────────────

const sentMessages: unknown[] = []

vi.mock('../../lib/ws-client', () => ({
  send: (msg: unknown) => { sentMessages.push(msg) },
}))

vi.mock('../../lib/event-bus', () => ({
  on: vi.fn(),
  off: vi.fn(),
}))

vi.mock('../../stores/chat', () => ({
  useChatStore: () => ({
  setGenerating: vi.fn(),
  setError: vi.fn(),
  getSessionState: vi.fn(() => ({ streamingMessage: null })),
  setStreaming: vi.fn(),
  completeStreaming: vi.fn(),
  addMessage: vi.fn(),
  updateContextInfo: vi.fn(),
  }),
}))

vi.mock('../../stores/session', () => ({
  useSessionStore: () => ({
  currentSessionId: 'session-default',
  }),
}))

// 在 mock 之后导入被测模块
import { useChat } from '../useChat'

describe('useChat.sendMessage — subagent parameter', () => {
  beforeEach(() => {
  sentMessages.length = 0
  })

  it('should include subagent field in WS payload when sendMessage is called with subagent', () => {
  const { sendMessage } = useChat(ref('session-1'))

  sendMessage('hello', { agent: 'code-review', task: 'review src/foo.ts' })

  expect(sentMessages).toHaveLength(1)
  const msg = sentMessages[0] as { type: string; payload: Record<string, unknown> }
  expect(msg.type).toBe('message.send')
  expect(msg.payload.sessionId).toBe('session-1')
  expect(msg.payload.content).toBe('hello')
  expect(msg.payload.subagent).toEqual({
    agent: 'code-review',
    task: 'review src/foo.ts',
  })
  })

  it('should NOT include subagent field when sendMessage is called without subagent', () => {
  const { sendMessage } = useChat(ref('session-2'))

  sendMessage('plain message')

  expect(sentMessages).toHaveLength(1)
  const msg = sentMessages[0] as { type: string; payload: Record<string, unknown> }
  expect(msg.type).toBe('message.send')
  expect(msg.payload.sessionId).toBe('session-2')
  expect(msg.payload.content).toBe('plain message')
  // subagent 字段不应存在
  expect(msg.payload).not.toHaveProperty('subagent')
  })

  it('should pass agent name and task correctly in subagent field', () => {
  const { sendMessage } = useChat(ref('session-3'))

  sendMessage('do something', { agent: 'bug-fixer', task: 'fix null pointer in bar()' })

  expect(sentMessages).toHaveLength(1)
  const msg = sentMessages[0] as { type: string; payload: Record<string, unknown> }
  const subagent = msg.payload.subagent as { agent: string; task: string }
  expect(subagent.agent).toBe('bug-fixer')
  expect(subagent.task).toBe('fix null pointer in bar()')
  })

  it('should maintain backward compat: same WS payload shape as before when no subagent', () => {
  const { sendMessage } = useChat(ref('session-4'))

  sendMessage('backward compat')

  expect(sentMessages).toHaveLength(1)
  const msg = sentMessages[0] as { type: string; payload: Record<string, unknown> }

  // 精确匹配 payload keys — 不应该多出 subagent 之类的额外字段
  const payloadKeys = Object.keys(msg.payload).sort()
  expect(payloadKeys).toEqual(['content', 'sessionId'])
  })

  it('should handle undefined subagent same as omitted subagent', () => {
  const { sendMessage } = useChat(ref('session-5'))

  sendMessage('msg with undefined', undefined)

  expect(sentMessages).toHaveLength(1)
  const msg = sentMessages[0] as { type: string; payload: Record<string, unknown> }
  // undefined subagent 等同于不传，不应在 payload 中出现
  expect(msg.payload).not.toHaveProperty('subagent')
  })
})
