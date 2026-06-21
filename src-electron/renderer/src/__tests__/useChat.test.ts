/**
 * useChat 单测 —— 流式状态机（CLAUDE.md 规则 #3/#7 防护的「UI 卡思考中」失败模式）。
 *
 * 覆盖：
 * - ensureStreamSubscription 幂等：首次 send 订阅一次，二次不重复订阅
 * - send 三守卫：无 active session / 空文本 / 已 streaming 时早退
 * - 事件驱动 setStreaming：
 *   message.message_start → isStreaming=true
 *   message.complete / message.error / message.stream_error → isStreaming=false
 *   （stream_error 终态复位是规则 #3 关键分支）
 *
 * mock 策略：vi.hoisted 捕获 streamSubscribe 的 handler，测试向其注入 ServerMessage。
 * 每个测试用唯一 sid 避免 useChat 模块级 streamSubscriptions Map 跨测试干扰。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/useChat.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage } from '@xyz-agent/shared'

// vi.hoisted 保证 mock 工厂在模块加载前就绪；holder 捕获 streamSubscribe 注册的 handler
const apiMock = vi.hoisted(() => {
  const holder: { handler: ((msg: ServerMessage) => void) | null } = { handler: null }
  return {
    holder,
    streamSubscribe: vi.fn((_sid: string, handler: (msg: ServerMessage) => void) => {
      holder.handler = handler
      return () => {
        holder.handler = null
      }
    }),
    send: vi.fn(() => Promise.resolve()),
    getHistory: vi.fn(() => Promise.resolve([])),
    abort: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('@/api', () => ({
  chat: {
    streamSubscribe: apiMock.streamSubscribe,
    send: apiMock.send,
    getHistory: apiMock.getHistory,
    abort: apiMock.abort,
  },
  session: {},
}))

import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useChat } from '@/composables/features/useChat'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  apiMock.holder.handler = null
})

/** 向被测 useChat 订阅的 handler 注入一条 ServerMessage */
function emit(msg: ServerMessage): void {
  if (apiMock.holder.handler) apiMock.holder.handler(msg)
}

describe('useChat 流式状态机', () => {
  it('首次 send 订阅流式事件恰好一次', async () => {
    const session = useSessionStore()
    session.activeId = 's-subscribe'
    const { send } = useChat()
    await send('hello')
    expect(apiMock.streamSubscribe).toHaveBeenCalledTimes(1)
    expect(apiMock.send).toHaveBeenCalledTimes(1)
  })

  it('同 session 二次 send 不重复订阅（ensureStreamSubscription 幂等）', async () => {
    const session = useSessionStore()
    session.activeId = 's-idempotent'
    const { send } = useChat()
    await send('one')
    await send('two')
    expect(apiMock.streamSubscribe).toHaveBeenCalledTimes(1)
    expect(apiMock.send).toHaveBeenCalledTimes(2)
  })

  it('message.message_start → isStreaming=true', async () => {
    const session = useSessionStore()
    session.activeId = 's-start'
    const chat = useChatStore()
    const { send } = useChat()
    await send('hi')
    expect(chat.isStreaming).toBe(false)
    emit({ type: 'message.message_start', payload: { sessionId: 's-start', messageId: 'a1' } })
    expect(chat.isStreaming).toBe(true)
  })

  it('message.complete → isStreaming=false', async () => {
    const session = useSessionStore()
    session.activeId = 's-complete'
    const chat = useChatStore()
    const { send } = useChat()
    await send('hi')
    emit({ type: 'message.message_start', payload: { sessionId: 's-complete' } })
    expect(chat.isStreaming).toBe(true)
    emit({ type: 'message.complete', payload: { sessionId: 's-complete' } })
    expect(chat.isStreaming).toBe(false)
  })

  it('message.error → isStreaming=false（规则 #3 终态复位）', async () => {
    const session = useSessionStore()
    session.activeId = 's-error'
    const chat = useChatStore()
    const { send } = useChat()
    await send('hi')
    emit({ type: 'message.message_start', payload: { sessionId: 's-error' } })
    expect(chat.isStreaming).toBe(true)
    emit({ type: 'message.error', payload: { sessionId: 's-error', message: 'boom' } })
    expect(chat.isStreaming).toBe(false)
  })

  it('message.stream_error → isStreaming=false（stream_error 终态复位关键分支）', async () => {
    const session = useSessionStore()
    session.activeId = 's-stream-err'
    const chat = useChatStore()
    const { send } = useChat()
    await send('hi')
    emit({ type: 'message.message_start', payload: { sessionId: 's-stream-err' } })
    expect(chat.isStreaming).toBe(true)
    // 若 pi 发了 message_update{error} 后不再发 agent_end，必须在此复位
    emit({ type: 'message.stream_error', payload: { sessionId: 's-stream-err', content: 'err' } })
    expect(chat.isStreaming).toBe(false)
  })

  it('send 守卫：无 active session 时早退（不订阅/不发送）', async () => {
    const { send } = useChat()
    await send('hello')
    expect(apiMock.streamSubscribe).not.toHaveBeenCalled()
    expect(apiMock.send).not.toHaveBeenCalled()
  })

  it('send 守卫：空文本/纯空白时早退', async () => {
    const session = useSessionStore()
    session.activeId = 's-empty'
    const { send } = useChat()
    await send('   ')
    await send('')
    expect(apiMock.streamSubscribe).not.toHaveBeenCalled()
    expect(apiMock.send).not.toHaveBeenCalled()
  })

  it('send 守卫：已 streaming 时早退（不重复发送）', async () => {
    const session = useSessionStore()
    session.activeId = 's-busy'
    const chat = useChatStore()
    const { send } = useChat()
    await send('first')
    emit({ type: 'message.message_start', payload: { sessionId: 's-busy' } })
    expect(chat.isStreaming).toBe(true)
    await send('second')
    expect(apiMock.send).toHaveBeenCalledTimes(1) // 仅首次发送
  })
})
