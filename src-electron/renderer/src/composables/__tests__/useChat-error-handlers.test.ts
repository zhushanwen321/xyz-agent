import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { ServerMessage, Message } from '@xyz-agent/shared'

/**
 * D6a 错误流单一入口（CLAUDE.md #3）验证：
 *  - markSessionError（store 单一错误入口）重置 isGenerating + streamingMessage + error
 *  - onStreamError / onError / G5 重连 三处终止性错误路径统一调 markSessionError
 *  - extension.error 保持非终止语义（不重置生成流）—— 由 useChat-new-handlers 覆盖，此处不重复
 *
 * 策略：真实 Pinia + 真实 ChatStore；mock event-bus 捕获 handler 后直接调用，
 * 断言 handler 触发后的 store 状态（端到端）。
 */

type EventHandler = (msg: ServerMessage) => void
const { capturedHandlers, onConnectionRestoredCbs } = vi.hoisted(() => ({
  // hoisted：mock factory 在 import 阶段（useChat → api）执行时即可安全引用
  capturedHandlers: new Map<string, EventHandler>(),
  onConnectionRestoredCbs: new Array<() => void>(),
}))

vi.mock('../../lib/event-bus', () => ({
  on: (event: string, handler: EventHandler) => { capturedHandlers.set(event, handler); return () => {} },
  off: vi.fn(),
  emit: vi.fn(),
  clear: vi.fn(),
}))

vi.mock('../../lib/ws-client', () => ({
  send: vi.fn(),
  getState: vi.fn(() => ({ value: 'connected' })),
}))

vi.mock('../../api', () => ({
  api: {
    events: {
      on: (event: string, handler: EventHandler) => { capturedHandlers.set(event, handler); return () => {} },
      onConnectionRestored: vi.fn((cb: () => void) => {
        onConnectionRestoredCbs.push(cb)
        return () => {}
      }),
    },
    chat: {
      send: vi.fn(() => Promise.resolve()),
      abort: vi.fn(() => Promise.resolve()),
      steer: vi.fn(),
      followUp: vi.fn(),
    },
  },
}))

vi.mock('../../stores/session', () => ({
  useSessionStore: () => ({
    get currentSessionId() { return 's1' },
    sessions: [],
    renameSession: vi.fn(),
  }),
}))

import { __test_registerGlobalHandlers } from './test-utils'
import { useChatStore, type SystemNotification } from '../../stores/chat'

// ── Fixtures ────────────────────────────────────────────────────────

const STREAMING_MSG: Message = {
  id: 'stream-1',
  role: 'assistant',
  content: '部分内容',
  status: 'streaming',
  timestamp: 0,
}

const ALERT_MSG: SystemNotification = {
  id: 'alert-1',
  role: 'system',
  notificationType: 'alert',
  notificationTitle: 'boom',
  timestamp: 0,
}

function makeMsg(type: ServerMessage['type'], payload: Record<string, unknown>): ServerMessage {
  return { type, payload }
}

function invoke(type: ServerMessage['type'], payload: Record<string, unknown>, sid = 's1'): void {
  const handler = capturedHandlers.get(type)
  if (!handler) {
    throw new Error(`No handler captured for "${type}". Captured: ${Array.from(capturedHandlers.keys()).join(', ')}`)
  }
  handler(makeMsg(type, { sessionId: sid, ...payload }))
}

// ── Setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  setActivePinia(createPinia())
  capturedHandlers.clear()
  onConnectionRestoredCbs.length = 0
  __test_registerGlobalHandlers()
})

// ── markSessionError（store 单一错误入口）──────────────────────────

describe('D6a — markSessionError（store 单一错误入口）', () => {
  it('重置 isGenerating + streamingMessage，设 error，并追加可选消息', () => {
    const store = useChatStore()
    const sid = 's1'
    store.setGenerating(true, sid)
    store.setStreaming(STREAMING_MSG, sid)

    store.markSessionError(sid, 'boom', ALERT_MSG)

    const s = store.getSessionState(sid)
    expect(s.isGenerating).toBe(false)
    expect(s.streamingMessage).toBeNull()
    expect(s.error).toBe('boom')
    expect(s.completedMessages).toHaveLength(1)
    // reactive proxy 与原始字面量引用不等，用 toMatchObject 校验字段一致
    expect(s.completedMessages[0]).toMatchObject(ALERT_MSG)
  })

  it('不传 msg 时不追加消息（仅重置状态 + 设 error）', () => {
    const store = useChatStore()
    const sid = 's2'
    store.setGenerating(true, sid)
    store.setStreaming(STREAMING_MSG, sid)

    store.markSessionError(sid, '连接断开')

    const s = store.getSessionState(sid)
    expect(s.isGenerating).toBe(false)
    expect(s.streamingMessage).toBeNull()
    expect(s.error).toBe('连接断开')
    expect(s.completedMessages).toHaveLength(0)
  })
})

// ── onStreamError handler（终止性：stream_error）────────────────────

describe('D6a — onStreamError handler（终止性错误重置生成状态）', () => {
  it('生成中收到 stream_error：重置 isGenerating/streamingMessage + 设 error + 插入 alert', () => {
    const store = useChatStore()
    const sid = 's1'
    store.setGenerating(true, sid)
    store.setStreaming(STREAMING_MSG, sid)

    invoke('message.stream_error', { content: '上游断流' }, sid)

    const s = store.getSessionState(sid)
    expect(s.isGenerating).toBe(false)
    expect(s.streamingMessage).toBeNull()
    expect(s.error).toBe('上游断流')
    expect(s.completedMessages).toHaveLength(1)
    const alert = s.completedMessages[0] as SystemNotification
    expect(alert.notificationType).toBe('alert')
  })

  it('fallback content：payload 无 content 时用默认文案', () => {
    const store = useChatStore()
    invoke('message.stream_error', {}, 's1')
    const s = store.getSessionState('s1')
    expect(s.error).toBe('Stream error')
  })
})

// ── onError handler（终止性：message.error）────────────────────────

describe('D6a — onError handler（统一调 markSessionError）', () => {
  it('message.error：重置 isGenerating/streamingMessage + 设 error，不追加消息', () => {
    const store = useChatStore()
    const sid = 's1'
    store.setGenerating(true, sid)
    store.setStreaming(STREAMING_MSG, sid)

    invoke('message.error', { message: 'runtime 挂了' }, sid)

    const s = store.getSessionState(sid)
    expect(s.isGenerating).toBe(false)
    expect(s.streamingMessage).toBeNull()
    expect(s.error).toBe('runtime 挂了')
    expect(s.completedMessages).toHaveLength(0)
  })

  it('fallback message：payload 无 message 时用默认文案', () => {
    const store = useChatStore()
    invoke('message.error', {}, 's1')
    expect(store.getSessionState('s1').error).toBe('Unknown error')
  })
})

// ── G5 connectionRestored（重连收尾）──────────────────────────────

describe('D6a — G5 connectionRestored（重连收尾所有 isGenerating session）', () => {
  it('重连后对所有 isGenerating 的 session 调 markSessionError，非生成态 session 不动', () => {
    const store = useChatStore()
    store.setGenerating(true, 'gen-1')
    store.setStreaming(STREAMING_MSG, 'gen-1')
    store.setGenerating(true, 'gen-2')
    store.setStreaming(STREAMING_MSG, 'gen-2')
    store.setGenerating(false, 'idle')
    store.setError(null, 'idle')

    for (const cb of onConnectionRestoredCbs) cb()

    expect(store.getSessionState('gen-1').isGenerating).toBe(false)
    expect(store.getSessionState('gen-1').streamingMessage).toBeNull()
    expect(store.getSessionState('gen-1').error).toBe('连接已重置')
    expect(store.getSessionState('gen-2').isGenerating).toBe(false)
    expect(store.getSessionState('gen-2').error).toBe('连接已重置')
    // 非生成态不受影响
    expect(store.getSessionState('idle').isGenerating).toBe(false)
    expect(store.getSessionState('idle').error).toBeNull()
  })
})
