import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import type { ChatSessionState } from '../../stores/chat'

/**
 * SA6 测试：useChat 迁移到 api.events / api.chat 后的行为。
 *
 * - sendMessage：调 api.chat.send（不再 ws send），payload 形状含 sessionId/content/subagent?
 * - __test_registerGlobalHandlers：订阅 23 个全局事件 + 1 个 G5 onConnectionRestored
 * - G5：onConnectionRestored 回调收尾所有 isGenerating 的 session
 */

// ── hoisted 单例 mock（vi.mock 提升后在 factory 内引用）──────────────

const {
  mockChatStore,
  mockSessionStore,
  chatSend,
  chatAbort,
  eventsOn,
  onConnRestored,
} = vi.hoisted(() => {
  // chatStore 单例：G5 回调与 sendMessage 共用同一实例，chatSessions 可塞数据
  const mockChatStore = {
    chatSessions: new Map<string, ChatSessionState>(),
    setGenerating: vi.fn(),
    setError: vi.fn(),
    markSessionError: vi.fn(),
    getSessionState: vi.fn(() => ({ streamingMessage: null, isGenerating: false })),
    setStreaming: vi.fn(),
    completeStreaming: vi.fn(),
    completeStream: vi.fn(),
    addMessage: vi.fn(),
    updateContextInfo: vi.fn(),
  }
  return {
    mockChatStore,
    mockSessionStore: { currentSessionId: 'session-default' },
    chatSend: vi.fn<() => Promise<unknown>>(),
    chatAbort: vi.fn<() => Promise<unknown>>(),
    eventsOn: vi.fn<() => () => void>(),
    onConnRestored: vi.fn<() => () => void>(),
  }
})

// ── Mock 依赖 ──────────────────────────────────────────────────────

vi.mock('../../api', () => ({
  api: {
    events: {
      on: eventsOn,
      onConnectionRestored: onConnRestored,
      _dispatch: vi.fn(),
      _notifyConnectionRestored: vi.fn(),
    },
    chat: {
      send: chatSend,
      abort: chatAbort,
      steer: vi.fn(),
      followUp: vi.fn(),
    },
  },
}))

vi.mock('../../stores/chat', () => ({
  useChatStore: () => mockChatStore,
}))

vi.mock('../../stores/session', () => ({
  useSessionStore: () => mockSessionStore,
}))

// 在 mock 之后导入被测模块
import { useChat, __test_registerGlobalHandlers } from '../useChat'

beforeEach(() => {
  vi.clearAllMocks()
  mockChatStore.chatSessions.clear()
  // clearAllMocks 清掉返回值实现，重设
  chatSend.mockResolvedValue(undefined)
  chatAbort.mockResolvedValue(undefined)
  eventsOn.mockReturnValue(() => {})
  onConnRestored.mockReturnValue(() => {})
})

describe('useChat.sendMessage — subagent parameter', () => {
  it('should include subagent field in payload when sendMessage is called with subagent', () => {
    const { sendMessage } = useChat(ref('session-1'))

    sendMessage('hello', { agent: 'code-review', task: 'review src/foo.ts' })

    expect(chatSend).toHaveBeenCalledTimes(1)
    expect(chatSend).toHaveBeenCalledWith({
      sessionId: 'session-1',
      content: 'hello',
      subagent: { agent: 'code-review', task: 'review src/foo.ts' },
    })
  })

  it('should NOT include subagent field when sendMessage is called without subagent', () => {
    const { sendMessage } = useChat(ref('session-2'))

    sendMessage('plain message')

    expect(chatSend).toHaveBeenCalledTimes(1)
    expect(chatSend).toHaveBeenCalledWith({
      sessionId: 'session-2',
      content: 'plain message',
    })
  })

  it('should pass agent name and task correctly in subagent field', () => {
    const { sendMessage } = useChat(ref('session-3'))

    sendMessage('do something', { agent: 'bug-fixer', task: 'fix null pointer in bar()' })

    const payload = chatSend.mock.calls[0][0] as { subagent: { agent: string; task: string } }
    expect(payload.subagent.agent).toBe('bug-fixer')
    expect(payload.subagent.task).toBe('fix null pointer in bar()')
  })

  it('should maintain backward compat: same payload shape as before when no subagent', () => {
    const { sendMessage } = useChat(ref('session-4'))

    sendMessage('backward compat')

    const payload = chatSend.mock.calls[0][0] as Record<string, unknown>
    // 精确匹配 payload keys — 不应该多出 subagent 之类的额外字段
    expect(Object.keys(payload).sort()).toEqual(['content', 'sessionId'])
  })

  it('should handle undefined subagent same as omitted subagent', () => {
    const { sendMessage } = useChat(ref('session-5'))

    sendMessage('msg with undefined', undefined)

    const payload = chatSend.mock.calls[0][0] as Record<string, unknown>
    expect(payload).not.toHaveProperty('subagent')
  })
})

describe('useChat.abort', () => {
  it('calls api.chat.abort with sessionId and completes stream locally', () => {
    const { abort } = useChat(ref('session-abort'))

    abort()

    expect(chatAbort).toHaveBeenCalledTimes(1)
    expect(chatAbort).toHaveBeenCalledWith({ sessionId: 'session-abort' })
    // 本地立即收尾 + 系统消息（不等后端确认）
    expect(mockChatStore.completeStream).toHaveBeenCalledWith({ stopReason: 'aborted' }, 'session-abort')
    expect(mockChatStore.addMessage).toHaveBeenCalledTimes(1)
  })
})

describe('__test_registerGlobalHandlers — 全局事件订阅', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('订阅 23 个全局事件 + 1 个 G5 onConnectionRestored', () => {
    eventsOn.mockClear()
    onConnRestored.mockClear()
    eventsOn.mockReturnValue(() => {})
    onConnRestored.mockReturnValue(() => {})

    __test_registerGlobalHandlers()

    // 23 个 ServerMessage 事件订阅
    expect(eventsOn).toHaveBeenCalledTimes(23)
    // 1 个重连收尾订阅
    expect(onConnRestored).toHaveBeenCalledTimes(1)
  })

  it('重复调用先取消旧订阅再重注（off 被调，再注册）', () => {
    const off = vi.fn()
    eventsOn.mockReturnValue(off)
    onConnRestored.mockReturnValue(off)

    __test_registerGlobalHandlers()
    __test_registerGlobalHandlers()

    // 第二次注册前取消全部旧订阅（23 + 1 = 24 个 off）
    expect(off).toHaveBeenCalledTimes(24)
  })
})

describe('G5 — onConnectionRestored 收尾 isGenerating 的 session', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('重连后收尾所有 isGenerating=true 的 session（统一调 markSessionError）', () => {
    __test_registerGlobalHandlers()

    mockChatStore.chatSessions.set('s-active', { isGenerating: true } as ChatSessionState)
    mockChatStore.chatSessions.set('s-idle', { isGenerating: false } as ChatSessionState)

    const cb = onConnRestored.mock.calls[0][0] as () => void
    cb()

    // 终止性错误单一入口：重置 isGenerating + streamingMessage + error（D6a / CLAUDE.md #3）
    expect(mockChatStore.markSessionError).toHaveBeenCalledWith('s-active', '连接已重置')
    // 非 generating 的 session 不被收尾
    expect(mockChatStore.markSessionError).not.toHaveBeenCalledWith('s-idle', '连接已重置')
  })

  it('无 isGenerating session 时重连不触发收尾', () => {
    __test_registerGlobalHandlers()

    mockChatStore.chatSessions.set('s-idle', { isGenerating: false } as ChatSessionState)

    const cb = onConnRestored.mock.calls[0][0] as () => void
    cb()

    expect(mockChatStore.markSessionError).not.toHaveBeenCalled()
  })
})
