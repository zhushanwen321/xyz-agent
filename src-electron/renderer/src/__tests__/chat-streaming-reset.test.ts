/**
 * Chat store 流式状态复位回归测试（CLAUDE.md 规则 #3）。
 *
 * 锁定 MUST_FIX #1 的修复：message.error 到达时，若最后一条 assistant 仍
 * status:'streaming'（流中途错误 / 进程崩溃），必须将其转为 error 并并入 errorText，
 * 而非总新建消息导致流式气泡卡「生成中」。
 *
 * 覆盖：
 * - 流中途 message.error：最后 streaming assistant → status:error + 并入 errorText（不新建）
 * - prompt 级 message.error（无 streaming assistant）：新建独立 error 消息，不改写历史
 * - 已 complete 的历史 assistant 遇 message.error：不回写，新建独立 error 消息
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/chat-streaming-reset.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'

describe('chat store message.error 流式状态复位（规则 #3）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('流中途 message.error：最后 streaming assistant 转为 error 并并入 errorText', () => {
    const store = useChatStore()
    const sid = 'sx'
    // 建一条 streaming assistant（流中途）
    store.appendAssistantChunk(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.appendAssistantChunk(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '部分内容' },
    })
    const before = store.getMessages(sid)
    expect(before[0].status).toBe('streaming')

    // 流中途错误（event-adapter error / 进程崩溃）
    store.appendAssistantChunk(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: '进程崩溃' },
    })

    const after = store.getMessages(sid)
    expect(after).toHaveLength(1) // 不新建气泡
    expect(after[0].id).toBe('a1') // 原流式消息被转态
    expect(after[0].status).toBe('error') // 关键：复位 streaming
    expect(after[0].content).toContain('部分内容') // 保留已生成内容
    expect(after[0].content).toContain('进程崩溃') // 并入 errorText
  })

  it('prompt 级 message.error（无 streaming assistant）：新建独立 error 消息', () => {
    const store = useChatStore()
    const sid = 'sy'
    store.appendUser(sid, 'hi')
    // 无 assistant 流，直接 error
    store.appendAssistantChunk(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: 'hook 拒绝' },
    })
    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(2) // user + 新建 error
    expect(msgs[1].role).toBe('assistant')
    expect(msgs[1].status).toBe('error')
    expect(msgs[1].content).toBe('hook 拒绝')
  })

  it('已 complete 的历史 assistant 遇 message.error：不回写历史，新建独立 error 消息', () => {
    const store = useChatStore()
    const sid = 'sz'
    store.appendAssistantChunk(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-old' },
    })
    store.appendAssistantChunk(sid, {
      type: 'message.complete',
      payload: { sessionId: sid },
    })
    const before = store.getMessages(sid)
    expect(before[0].status).toBe('complete')

    // 后续错误到达，历史 complete 消息不应被改写
    store.appendAssistantChunk(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: '后置错误' },
    })

    const after = store.getMessages(sid)
    expect(after).toHaveLength(2)
    expect(after[0].status).toBe('complete') // 历史消息保持
    expect(after[0].content).toBe('') // 未被并入 errorText
    expect(after[1].status).toBe('error') // 新建 error 消息
    expect(after[1].content).toBe('后置错误')
  })

  it(`errorText 缺省时落 'Unknown error'（流中途仍复位 streaming）`, () => {
    const store = useChatStore()
    const sid = 'sw'
    store.appendAssistantChunk(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a2' },
    })
    // payload 无 message 字段
    store.appendAssistantChunk(sid, { type: 'message.error', payload: { sessionId: sid } })
    const after = store.getMessages(sid)
    expect(after).toHaveLength(1)
    expect(after[0].status).toBe('error')
    expect(after[0].content).toContain('Unknown error')
  })
})
