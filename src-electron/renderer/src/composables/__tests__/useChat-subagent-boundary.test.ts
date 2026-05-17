import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { Ref } from 'vue'

/**
 * Boundary & error path tests for useChat.sendMessage with subagent.
 *
 * Supplements useChat-subagent.test.ts which covers normal paths.
 * These tests verify edge-case behavior at the composable layer.
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

// ── Session store mock — configurable per test ────────────────────

let mockCurrentSessionId: string | null = 'session-default'

vi.mock('../../stores/session', () => ({
  useSessionStore: () => ({
  get currentSessionId() { return mockCurrentSessionId },
  }),
}))

import { useChat } from '../useChat'

describe('useChat.sendMessage — boundary & error paths', () => {
  beforeEach(() => {
  sentMessages.length = 0
  mockCurrentSessionId = 'session-default'
  })

  // ── Boundary: very long task string ────────────────────────────

  it('should send subagent with a 2000-char task string without truncation', () => {
  const { sendMessage } = useChat(ref('session-long'))
  const longTask = 'A'.repeat(2000)

  sendMessage('content', { agent: 'long-task-agent', task: longTask })

  expect(sentMessages).toHaveLength(1)
  const msg = sentMessages[0] as { payload: Record<string, unknown> }
  const subagent = msg.payload.subagent as { agent: string; task: string }
  expect(subagent.task).toBe(longTask)
  expect(subagent.task).toHaveLength(2000)
  })

  // ── Boundary: special characters in agent name ─────────────────

  it('should pass through hyphens and dots in agent name unchanged', () => {
  const { sendMessage } = useChat(ref('session-chars'))
  // Hyphens and dots are valid in agent identifiers
  sendMessage('content', { agent: 'my-reviewer.v2-final', task: 'do stuff' })

  expect(sentMessages).toHaveLength(1)
  const msg = sentMessages[0] as { payload: Record<string, unknown> }
  const subagent = msg.payload.subagent as { agent: string; task: string }
  expect(subagent.agent).toBe('my-reviewer.v2-final')
  })

  it('should pass through unicode characters in agent name', () => {
  const { sendMessage } = useChat(ref('session-unicode'))
  sendMessage('内容', { agent: '审查员-中文', task: '检查代码' })

  expect(sentMessages).toHaveLength(1)
  const msg = sentMessages[0] as { payload: Record<string, unknown> }
  const subagent = msg.payload.subagent as { agent: string; task: string }
  expect(subagent.agent).toBe('审查员-中文')
  expect(subagent.task).toBe('检查代码')
  })

  it('should pass through XML-dangerous characters in agent name at composable layer', () => {
  // The composable passes through to ws-client as-is; sanitization is
  // the server's responsibility, not the composable's.
  const { sendMessage } = useChat(ref('session-xml'))
  sendMessage('content', { agent: 'agent<script>', task: 'task "quoted" & more' })

  expect(sentMessages).toHaveLength(1)
  const msg = sentMessages[0] as { payload: Record<string, unknown> }
  const subagent = msg.payload.subagent as { agent: string; task: string }
  expect(subagent.agent).toBe('agent<script>')
  expect(subagent.task).toBe('task "quoted" & more')
  })

  // ── Error: no session ID ───────────────────────────────────────

  it('should not send WS message when sessionId ref is empty string', () => {
  const { sendMessage } = useChat(ref(''))
  sendMessage('content', { agent: 'agent', task: 'task' })

  // Empty string is truthy enough to pass resolveSessionId but the
  // sid resolves to '' which is falsy in the !sid check
  expect(sentMessages).toHaveLength(0)
  })

  it('should not send WS message when explicit sessionId ref is null and store has no default', () => {
  // When sessionId ref is not provided, falls back to sessionStore.currentSessionId
  // which is null — should skip sending
  mockCurrentSessionId = null
  const { sendMessage } = useChat()
  sendMessage('content', { agent: 'agent', task: 'task' })

  expect(sentMessages).toHaveLength(0)
  })

  // ── Boundary: rapid successive calls ───────────────────────────

  it('should send multiple WS messages when sendMessage called rapidly in succession', () => {
  const { sendMessage } = useChat(ref('session-rapid'))

  // Simulate rapid-fire calls — all should be dispatched independently
  sendMessage('msg-1', { agent: 'a1', task: 't1' })
  sendMessage('msg-2', { agent: 'a2', task: 't2' })
  sendMessage('msg-3', { agent: 'a3', task: 't3' })

  expect(sentMessages).toHaveLength(3)

  const agents = sentMessages.map(
    (m: unknown) => ((m as { payload: Record<string, unknown> }).payload.subagent as { agent: string }).agent,
  )
  expect(agents).toEqual(['a1', 'a2', 'a3'])
  })

  // ── Boundary: mixed calls with and without subagent ────────────

  it('should handle interleaved calls with and without subagent', () => {
  const { sendMessage } = useChat(ref('session-mixed'))

  sendMessage('normal')
  sendMessage('with-sub', { agent: 'review', task: 'review code' })
  sendMessage('another normal')

  expect(sentMessages).toHaveLength(3)

  const msg0 = sentMessages[0] as { payload: Record<string, unknown> }
  expect(msg0.payload).not.toHaveProperty('subagent')

  const msg1 = sentMessages[1] as { payload: Record<string, unknown> }
  expect(msg1.payload).toHaveProperty('subagent')

  const msg2 = sentMessages[2] as { payload: Record<string, unknown> }
  expect(msg2.payload).not.toHaveProperty('subagent')
  })
})
