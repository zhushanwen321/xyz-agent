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
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/useChat.test.ts
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
    compact: vi.fn(() => Promise.resolve()),
    steer: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('@/api', () => ({
  chat: {
    streamSubscribe: apiMock.streamSubscribe,
    send: apiMock.send,
    getHistory: apiMock.getHistory,
    abort: apiMock.abort,
    compact: apiMock.compact,
    steer: apiMock.steer,
    followUp: apiMock.followUp,
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
    // 第一轮流式周期结束（message_start 清 dispatching + 设 isStreaming，complete 清 isStreaming），
    // 否则 isActive guard 会拦截第二次 send（dispatching 残留）
    emit({ type: 'message.message_start', payload: { sessionId: 's-idempotent', messageId: 'a1' } })
    emit({ type: 'message.complete', payload: { sessionId: 's-idempotent' } })
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

describe('useChat dispatching 合并态（空窗期）', () => {
  it('send 置 dispatchingSessionId → isActive 立即为 true（不等 message_start）', async () => {
    const session = useSessionStore()
    session.activeId = 's-dispatch'
    const chat = useChatStore()
    const { send } = useChat()
    // send 的 api.send 是异步的，但我们用 await 等它 resolve
    await send('hello')
    // send resolve 后到 message_start 之前，dispatching 应保持（空窗期 isActive=true）
    expect(chat.dispatchingSessionId).toBe('s-dispatch')
    expect(chat.isActive('s-dispatch')).toBe(true)
    expect(chat.isStreaming).toBe(false) // message_start 未到，isStreaming 仍 false
  })

  it('message_start 到达 → 清 dispatching + 设 isStreaming（空窗期无缝切换）', async () => {
    const session = useSessionStore()
    session.activeId = 's-switch'
    const chat = useChatStore()
    const { send } = useChat()
    await send('hi')
    expect(chat.dispatchingSessionId).toBe('s-switch')
    emit({ type: 'message.message_start', payload: { sessionId: 's-switch', messageId: 'a1' } })
    expect(chat.dispatchingSessionId).toBeNull()
    expect(chat.isStreaming).toBe(true)
    expect(chat.isActive('s-switch')).toBe(true) // 合并态仍 true
  })

  it('终态（complete）清 dispatching（兜底，message_start 未到的异常路径）', async () => {
    const session = useSessionStore()
    session.activeId = 's-terminal'
    const chat = useChatStore()
    const { send } = useChat()
    await send('hi')
    expect(chat.dispatchingSessionId).toBe('s-terminal')
    // 模拟 pi 未发 message_start 直接 complete（异常但需兜底）
    emit({ type: 'message.complete', payload: { sessionId: 's-terminal' } })
    expect(chat.dispatchingSessionId).toBeNull()
    expect(chat.isActive('s-terminal')).toBe(false)
  })

  it('send 失败清 dispatching（catch 路径）', async () => {
    const session = useSessionStore()
    session.activeId = 's-fail'
    const chat = useChatStore()
    apiMock.send.mockRejectedValueOnce(new Error('network'))
    const { send } = useChat()
    await expect(send('hi')).rejects.toThrow('network')
    expect(chat.dispatchingSessionId).toBeNull()
    expect(chat.isActive('s-fail')).toBe(false)
  })

  it('steer 在空窗期可用（isActive guard 而非 isStreaming）', async () => {
    const session = useSessionStore()
    session.activeId = 's-steer'
    const chat = useChatStore()
    const { send, steer } = useChat()
    await send('first') // 置 dispatching，isActive=true 但 isStreaming=false
    expect(chat.isStreaming).toBe(false)
    await steer('补充')
    expect(apiMock.steer).toHaveBeenCalledTimes(1)
  })

  it('steer 非活跃时早退（不发送）', async () => {
    const session = useSessionStore()
    session.activeId = 's-idle'
    const { steer } = useChat()
    await steer('补充')
    expect(apiMock.steer).not.toHaveBeenCalled()
  })

  it('steer/followUp 调 appendPending 入流（pending 气泡可见）', async () => {
    const session = useSessionStore()
    session.activeId = 's-pending'
    const chat = useChatStore()
    const { send, steer, followUp } = useChat()
    await send('first')
    await steer('steer 内容')
    await followUp('followup 内容')
    const msgs = chat.getMessages('s-pending')
    // send 的 user + steer pending + followUp pending
    const pendings = msgs.filter((m) => m.status === 'pending')
    expect(pendings).toHaveLength(2)
    expect(pendings[0].sendMode).toBe('steer')
    expect(pendings[0].content).toBe('steer 内容')
    expect(pendings[1].sendMode).toBe('follow-up')
  })
})

describe('useChat compact 状态机（#6）', () => {
  it('compact 调 chatApi.compact 且建立会话级订阅（消费 compacting/compacted）', async () => {
    const session = useSessionStore()
    session.activeId = 'c-sub'
    const { compact } = useChat()
    await compact()
    // compact(customInstructions?) → chatApi.compact(sid, undefined)（未传自定义指令）
    expect(apiMock.compact).toHaveBeenCalledWith('c-sub', undefined)
    expect(apiMock.streamSubscribe).toHaveBeenCalledTimes(1)
  })

  it('session.compacting → isCompacting=true；session.compacted → isCompacting=false', async () => {
    const session = useSessionStore()
    session.activeId = 'c-flow'
    const chat = useChatStore()
    const { compact } = useChat()
    await compact()
    emit({ type: 'session.compacting', payload: { sessionId: 'c-flow', status: 'compacting' } })
    expect(chat.isCompacting('c-flow')).toBe(true)
    emit({ type: 'session.compacted', payload: { sessionId: 'c-flow', status: 'compacted' } })
    expect(chat.isCompacting('c-flow')).toBe(false)
  })

  it('compact 失败（pending reject）→ toast 错误提示，不抛出（不卡 UI，M8 toast 方案）', async () => {
    const session = useSessionStore()
    session.activeId = 'c-err'
    const chat = useChatStore()
    apiMock.compact.mockRejectedValueOnce(new Error('Session not found'))
    const { compact } = useChat()
    await expect(compact()).resolves.toBeUndefined()
    // M8: compact 错误走 toast 而非 appendSystemNotice，不再插入 system 消息
    const msgs = chat.getMessages('c-err')
    expect(msgs).toEqual([])
  })

  it('compact 守卫：无 active session 时早退', async () => {
    const { compact } = useChat()
    await compact()
    expect(apiMock.compact).not.toHaveBeenCalled()
  })
})
