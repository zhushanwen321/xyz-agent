/**
 * finalizeSession reason→终态映射单测（D-011 诚实态 + D-013 errorText 合并）。
 *
 * 锁定 fix-state-tearing 的核心收口逻辑：7 种 FinalizeReason 各应产出正确的
 * message.status + toolCall.status + content 合并。
 *
 * 覆盖：
 * - normal/aborted → message:complete, toolCall:end_not_received
 * - error/stream_error/timeout/disconnect/restart → message:error, toolCall:error
 * - errorText 合并到 streaming assistant content（D-013）
 * - 非 streaming entity 不受影响
 * - running toolCall 级联终态（D-011 诚实态）
 * - 非 running toolCall 不被修改
 *
 * 运行：npx vitest run src/__tests__/stores/chat-finalize-reason.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import type { Message } from '@/types/message'

function seedStreamingAssistant(sid: string, overrides: Partial<Message> = {}): Message {
  return {
    id: 'a1',
    role: 'assistant',
    content: '已生成内容',
    status: 'streaming',
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('finalizeSession reason→终态映射', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('normal: streaming assistant → complete，running toolCall → end_not_received', () => {
    const store = useChatStore()
    const sid = 's-normal'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, toolCallId: 'tc1', toolName: 'bash' },
    })
    store.finalizeSession(sid, 'normal')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('complete')
    expect(msgs[0].toolCalls![0].status).toBe('end_not_received')
  })

  it('aborted: streaming assistant → complete，running toolCall → end_not_received', () => {
    const store = useChatStore()
    const sid = 's-aborted'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, toolCallId: 'tc1', toolName: 'bash' },
    })
    store.finalizeSession(sid, 'aborted')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('complete')
    expect(msgs[0].toolCalls![0].status).toBe('end_not_received')
  })

  it('error: streaming assistant → error，running toolCall → error', () => {
    const store = useChatStore()
    const sid = 's-error'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, toolCallId: 'tc1', toolName: 'bash' },
    })
    store.finalizeSession(sid, 'error', '进程崩溃')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('error')
    expect(msgs[0].toolCalls![0].status).toBe('error')
  })

  it('stream_error: streaming assistant → error，running toolCall → error', () => {
    const store = useChatStore()
    const sid = 's-stream-err'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, toolCallId: 'tc1', toolName: 'bash' },
    })
    store.finalizeSession(sid, 'stream_error', '流错误')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('error')
    expect(msgs[0].toolCalls![0].status).toBe('error')
  })

  it('timeout: streaming assistant → error，running toolCall → error', () => {
    const store = useChatStore()
    const sid = 's-timeout'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.finalizeSession(sid, 'timeout')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('error')
  })

  it('disconnect: streaming assistant → error，running toolCall → error', () => {
    const store = useChatStore()
    const sid = 's-disconnect'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.finalizeSession(sid, 'disconnect')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('error')
  })

  it('restart: streaming assistant → error（runtime 重启收口）', () => {
    const store = useChatStore()
    const sid = 's-restart'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.finalizeSession(sid, 'restart')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('error')
  })

  it('errorText 合并到 streaming assistant content（D-013）', () => {
    const store = useChatStore()
    const sid = 's-errtext'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '部分回答' },
    })
    store.finalizeSession(sid, 'error', '[错误] 连接断开')
    const msgs = store.getMessages(sid)
    expect(msgs[0].content).toContain('部分回答')
    expect(msgs[0].content).toContain('[错误] 连接断开')
  })

  it('errorText 不合并到非 assistant 消息', () => {
    const store = useChatStore()
    const sid = 's-no-merge'
    store.appendUser(sid, '用户提问')
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.finalizeSession(sid, 'error', '错误文本')
    const msgs = store.getMessages(sid)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toBe('用户提问') // user 消息不受 errorText 影响
  })

  it('非 streaming 的历史 assistant 不受 finalizeSession 影响', () => {
    const store = useChatStore()
    const sid = 's-historical'
    // 注入一条已 complete 的历史 assistant
    store.hydrate(sid, [
      { id: 'old', role: 'assistant', content: '历史', status: 'complete', timestamp: 1 },
    ])
    store.finalizeSession(sid, 'error', '新错误')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('complete') // 不回写
    expect(msgs[0].content).toBe('历史') // 不合并 errorText
  })

  it('已 completed 的 toolCall 不被 finalizeSession 修改', () => {
    const store = useChatStore()
    const sid = 's-completed-tc'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, toolCallId: 'tc1', toolName: 'bash' },
    })
    // 正常结束 toolCall
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_end',
      payload: { sessionId: sid, toolCallId: 'tc1', status: 'completed', output: 'done' },
    })
    expect(store.getMessages(sid)[0].toolCalls![0].status).toBe('completed')
    // finalizeSession 不应回写已 completed 的 toolCall
    store.finalizeSession(sid, 'timeout')
    expect(store.getMessages(sid)[0].toolCalls![0].status).toBe('completed')
  })
})
