/**
 * sealed guard 单测（D-010：finalizeSession 后晚到事件幂等丢弃）。
 *
 * 锁定 fix-state-tearing 的核心防污染逻辑：一旦 message.complete/error/stream_error
 * 收口了 assistant 实体，后续迟到的 text_delta / thinking_delta / tool_call_start /
 * tool_call_update 必须被丢弃（不污染终态实体）。
 *
 * 特殊边界：tool_call_end 不做 sealed guard（D-010 边界决策）——允许迟到 tool_call_end
 * 覆盖 end_not_received → completed。
 *
 * 覆盖：
 * - complete 后 text_delta 被丢弃（content 不变）
 * - complete 后 thinking_delta 被丢弃
 * - complete 后 tool_call_start 被丢弃（不新增 toolCall）
 * - complete 后 tool_call_update 被丢弃
 * - error 后 text_delta 被丢弃
 * - tool_call_end 不 sealed：complete 后迟到的 tool_call_end 可覆盖 end_not_received→completed
 *
 * 运行：npx vitest run src/__tests__/stores/chat-sealed-guard.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'

describe('sealed guard（D-010：finalizeSession 后晚到事件幂等丢弃）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('message.complete 后迟到 text_delta 被丢弃（content 不变）', () => {
    const store = useChatStore()
    const sid = 's1'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '正常内容' },
    })
    // 收口
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    })
    const contentBefore = store.getMessages(sid)[0].content
    // 晚到 delta
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '迟到内容' },
    })
    expect(store.getMessages(sid)[0].content).toBe(contentBefore)
  })

  it('message.complete 后迟到 thinking_delta 被丢弃', () => {
    const store = useChatStore()
    const sid = 's2'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.thinking_start',
      payload: { sessionId: sid, thinkingId: 'th1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.thinking_delta',
      payload: { sessionId: sid, delta: '正常思考' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    })
    const thinkingBefore = store.getMessages(sid)[0].thinking![0].content
    // 晚到 thinking_delta
    store.applyMessageEvent(sid, {
      type: 'message.thinking_delta',
      payload: { sessionId: sid, delta: '迟到思考' },
    })
    expect(store.getMessages(sid)[0].thinking![0].content).toBe(thinkingBefore)
  })

  it('message.complete 后迟到 tool_call_start 被丢弃（不新增 toolCall）', () => {
    const store = useChatStore()
    const sid = 's3'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, toolCallId: 'tc1', toolName: 'bash' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    })
    const tcCount = store.getMessages(sid)[0].toolCalls!.length
    expect(tcCount).toBe(1)
    // 晚到 tool_call_start
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, toolCallId: 'tc-late', toolName: 'read' },
    })
    expect(store.getMessages(sid)[0].toolCalls!.length).toBe(1) // 不新增
  })

  it('message.complete 后迟到 tool_call_update 被丢弃', () => {
    const store = useChatStore()
    const sid = 's4'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, toolCallId: 'tc1', toolName: 'bash' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    })
    // 晚到 tool_call_update
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_update',
      payload: { sessionId: sid, toolCallId: 'tc1', detail: '进度' },
    })
    // end_not_received 收口态不被 update 覆盖（update handler sealed）
    expect(store.getMessages(sid)[0].toolCalls![0].status).toBe('end_not_received')
  })

  it('message.error 后迟到 text_delta 被丢弃', () => {
    const store = useChatStore()
    const sid = 's5'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '部分' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: '崩溃' },
    })
    const contentBefore = store.getMessages(sid)[0].content
    // 晚到 delta
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '迟到' },
    })
    expect(store.getMessages(sid)[0].content).toBe(contentBefore)
  })

  it('message.stream_error 后迟到 text_delta 被丢弃', () => {
    const store = useChatStore()
    const sid = 's6'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '部分' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.stream_error',
      payload: { sessionId: sid, content: '流中断' },
    })
    const contentBefore = store.getMessages(sid)[0].content
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '迟到' },
    })
    expect(store.getMessages(sid)[0].content).toBe(contentBefore)
  })

  it('tool_call_end 不 sealed：complete 后迟到 tool_call_end 可覆盖 end_not_received→completed', () => {
    const store = useChatStore()
    const sid = 's7'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, toolCallId: 'tc1', toolName: 'bash' },
    })
    // complete 收口：running toolCall → end_not_received
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    })
    expect(store.getMessages(sid)[0].toolCalls![0].status).toBe('end_not_received')
    // 迟到的真实 tool_call_end（D-010 边界：不 sealed，允许覆盖）
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_end',
      payload: {
        sessionId: sid,
        toolCallId: 'tc1',
        status: 'completed',
        output: '实际输出',
      },
    })
    expect(store.getMessages(sid)[0].toolCalls![0].status).toBe('completed')
    expect(store.getMessages(sid)[0].toolCalls![0].output).toBe('实际输出')
  })
})
