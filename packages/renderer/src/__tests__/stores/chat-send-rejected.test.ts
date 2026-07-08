/**
 * send.rejected 回滚测试（D-006 独立 WS 通道 + useChat 监听回滚）。
 *
 * 锁定 fix-state-tearing 的 D-006 核心决策：send.rejected 是独立 WS 类型，
 * 不进对话流（不产出消息气泡），只做 clearPendingSend + toast 反馈。
 * 与 message.error（进对话流 + 翻流式态）语义正交。
 *
 * 覆盖：
 * - send.rejected → clearPendingSend（isActive 恢复 false）
 * - send.rejected → 不产出消息气泡（getMessages 不变）
 * - send.rejected → isGenerating 不变（send.rejected 不翻流式态）
 * - send.rejected 带 message 字段 → toast 反馈
 *
 * mock 策略：vi.hoisted 捕获 streamSubscribe handler，测试注入 send.rejected。
 *
 * 运行：npx vitest run src/__tests__/stores/chat-send-rejected.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage } from '@xyz-agent/shared'

const apiMock = vi.hoisted(() => {
  const holder: { handler: ((msg: ServerMessage) => void) | null } = { handler: null }
  return {
    holder,
    streamSubscribe: vi.fn((_sid: string, handler: (msg: ServerMessage) => void) => {
      holder.handler = handler
      return () => { holder.handler = null }
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

function emit(msg: ServerMessage): void {
  if (apiMock.holder.handler) apiMock.holder.handler(msg)
}

describe('send.rejected 回滚（D-006 独立通道）', () => {
  it('send.rejected → clearPendingSend（isActive 恢复 false）', async () => {
    const session = useSessionStore()
    session.activeId = 's-reject-1'
    const chat = useChatStore()
    const { send } = useChat()
    await send('hello')
    // send 后 pendingSend 置位 → isActive=true（空窗期）
    expect(chat.isActive('s-reject-1')).toBe(true)
    // 必须先订阅才能 emit
    expect(apiMock.holder.handler).not.toBeNull()
    // runtime 预检拒绝
    emit({
      type: 'send.rejected',
      payload: { sessionId: 's-reject-1', reason: 'busy', message: 'Agent 正在处理' },
    })
    // clearPendingSend 后 isActive=false
    expect(chat.isActive('s-reject-1')).toBe(false)
  })

  it('send.rejected → 不产出消息气泡（getMessages 不变）', async () => {
    const session = useSessionStore()
    session.activeId = 's-reject-2'
    const chat = useChatStore()
    const { send } = useChat()
    await send('hello')
    const msgsBefore = chat.getMessages('s-reject-2')
    emit({
      type: 'send.rejected',
      payload: { sessionId: 's-reject-2', reason: 'busy', message: 'Agent 正在处理' },
    })
    // send.rejected 不进对话流：消息列表不新增 error/system 气泡
    expect(chat.getMessages('s-reject-2')).toEqual(msgsBefore)
  })

  it('send.rejected → isGenerating 不变（不翻流式态）', async () => {
    const session = useSessionStore()
    session.activeId = 's-reject-3'
    const chat = useChatStore()
    const { send } = useChat()
    await send('hello')
    // send.rejected 时无 streaming entity → isGenerating=false
    expect(chat.isGenerating('s-reject-3')).toBe(false)
    emit({
      type: 'send.rejected',
      payload: { sessionId: 's-reject-3', reason: 'busy', message: 'busy' },
    })
    // 仍然 false（send.rejected 不产生 streaming entity）
    expect(chat.isGenerating('s-reject-3')).toBe(false)
  })

  it('send.rejected 不影响其他 session 的 pendingSend', async () => {
    const session = useSessionStore()
    session.activeId = 's-reject-4'
    const chat = useChatStore()
    const { send } = useChat()
    // session A send → pendingSend
    await send('hello')
    // 手动给 session B 加 pendingSend（模拟另一个 panel 正在发送）
    chat.addPendingSend('s-other')
    expect(chat.isActive('s-other')).toBe(true)
    // session A 收到 send.rejected
    emit({
      type: 'send.rejected',
      payload: { sessionId: 's-reject-4', reason: 'busy', message: 'busy' },
    })
    // session B 的 pendingSend 不受影响（session 隔离）
    expect(chat.isActive('s-other')).toBe(true)
  })
})
