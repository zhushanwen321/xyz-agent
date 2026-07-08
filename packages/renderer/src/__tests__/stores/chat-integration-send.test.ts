/**
 * useChat 集成测试（T1.4/T1.5/T5.1）—— send 全链 + 失败回滚 + editAndResend pendingSend 对称。
 *
 * T1.4: idle + send(text) → appendUser + addPendingSend + api.send → message_start → clearPendingSend
 * T1.5: send + api.send reject → clearPendingSend + throw（Composer 恢复草稿）
 * T5.1: editAndResend → truncate + appendUser + addPendingSend + send, catch → clearPendingSend
 *
 * 运行：npx vitest run src/__tests__/stores/chat-integration-send.test.ts
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

describe('T1.4 useChat.send 全链', () => {
  it('send(text) → appendUser + addPendingSend + api.send → message_start → clearPendingSend', async () => {
    const session = useSessionStore()
    session.activeId = 's-fullchain'
    const chat = useChatStore()
    const { send } = useChat()
    await send('hello')
    // 1. appendUser：消息列表有 user 气泡
    const msgs = chat.getMessages('s-fullchain')
    expect(msgs.some((m) => m.role === 'user' && m.content === 'hello')).toBe(true)
    // 2. addPendingSend：isActive=true（空窗期）
    expect(chat.isActive('s-fullchain')).toBe(true)
    // 3. api.send 被调
    expect(apiMock.send).toHaveBeenCalledWith('s-fullchain', 'hello')
    // 4. message_start 到达 → clearPendingSend
    emit({ type: 'message.message_start', payload: { sessionId: 's-fullchain', messageId: 'a1' } })
    // message_start 后 isGenerating=true（streaming entity 存在），isActive 仍 true
    expect(chat.isGenerating('s-fullchain')).toBe(true)
    expect(chat.isActive('s-fullchain')).toBe(true)
  })
})

describe('T1.5 send api.send 失败回滚', () => {
  it('api.send reject → clearPendingSend + throw（Composer 恢复草稿）', async () => {
    const session = useSessionStore()
    session.activeId = 's-fail'
    const chat = useChatStore()
    const { send } = useChat()
    apiMock.send.mockRejectedValueOnce(new Error('ws disconnected'))
    // send 应 throw（Composer catch 恢复草稿）
    await expect(send('hello')).rejects.toThrow('ws disconnected')
    // clearPendingSend：isActive 恢复 false（无 streaming entity + 无 pendingSend）
    expect(chat.isActive('s-fail')).toBe(false)
  })
})

describe('T5.1 editAndResend pendingSend 对称', () => {
  it('editAndResend → truncate + appendUser + addPendingSend + send', async () => {
    const session = useSessionStore()
    session.activeId = 's-edit'
    const chat = useChatStore()
    // 先注入历史消息（供 truncateFrom 操作）
    chat.appendUser('s-edit', '原问题')
    const userMsg = chat.getMessages('s-edit').find((m) => m.role === 'user')!
    const { editAndResend } = useChat()
    await editAndResend('s-edit', userMsg.id, 'edited text')
    // api.send 被调（editAndResend 内部走 chatApi.send 骨架）
    expect(apiMock.send).toHaveBeenCalledWith('s-edit', 'edited text')
    // addPendingSend：isActive=true（空窗期）
    expect(chat.isActive('s-edit')).toBe(true)
  })

  it('editAndResend api.send 失败 → clearPendingSend + throw（不留孤儿）', async () => {
    const session = useSessionStore()
    session.activeId = 's-edit-fail'
    const chat = useChatStore()
    chat.appendUser('s-edit-fail', '原问题')
    const userMsg = chat.getMessages('s-edit-fail').find((m) => m.role === 'user')!
    apiMock.send.mockRejectedValueOnce(new Error('ws disconnected'))
    const { editAndResend } = useChat()
    await expect(editAndResend('s-edit-fail', userMsg.id, 'text')).rejects.toThrow('ws disconnected')
    // 失败后 pendingSend 被清（isActive=false，无 streaming）
    expect(chat.isActive('s-edit-fail')).toBe(false)
  })

  it('editAndResend guard：busy 时早退（isActive=true 不执行）', async () => {
    const session = useSessionStore()
    session.activeId = 's-edit-busy'
    const chat = useChatStore()
    chat.addPendingSend('s-edit-busy')
    expect(chat.isActive('s-edit-busy')).toBe(true)
    const { editAndResend } = useChat()
    // busy 时早退，不 throw，不调 send
    await expect(editAndResend('s-edit-busy', 'msg-id', 'text')).resolves.toBeUndefined()
    expect(apiMock.send).not.toHaveBeenCalled()
  })
})
