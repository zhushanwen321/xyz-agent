/**
 * dispatchMessageEvent 注册表行为单测（core chat/effects 域，P3 w3 迁移锁定）。
 *
 * 迁自 renderer __tests__/stores/chat-chunk-content-blocks.test.ts 的直接调用模式。
 * [P4 s5 w2] tasks 路由 + openTasksPanelOnFirstData 回调断言随 tasks 域删除移除。
 *
 * 覆盖：
 * - message_start：建 streaming assistant（contentBlocks:[]）
 * - text_delta：append content + push text block（幂等）
 * - thinking_start/end/delta：thinking block 墌量 + endTime
 * - tool_call_start：push toolCall + contentBlocks toolCall 块
 * - tool_call_end：ID 锚定更新 + status/output 填充
 * - sealed guard：finalizeSession 后 text_delta 幂等丢弃（D-010）
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/effects.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { dispatchMessageEvent } from '../effects/registry'
import type { MessageEffectContext } from '../effect-types'
import type { Message, ServerMessage } from '@xyz-agent/shared'

const SID = 's-test'

/** 构造 ctx：真实 vue ref + 回调 mock */
function makeCtx(initial: Message[] = []): MessageEffectContext {
  return {
    messages: ref(new Map([[SID, initial]])),
    retryStates: ref(new Map()),
    queueStates: ref(new Map()),
    applyFileChanges: vi.fn(),
    markChangeSetsSuperseded: vi.fn(),
    finalizeSession: vi.fn(),
    clearPendingSend: vi.fn(),
    armStreamingTimer: vi.fn(),
    armBashTimer: vi.fn(),
    clearBashTimer: vi.fn(),
    markPendingDelivered: vi.fn(),
  }
}

function msg(type: string, payload: Record<string, unknown> = {}): ServerMessage {
  return { type, payload: { sessionId: SID, ...payload } } as ServerMessage
}

function getMsgs(ctx: MessageEffectContext): Message[] {
  return ctx.messages.value.get(SID) ?? []
}

function lastAssistant(ctx: MessageEffectContext): Message {
  const list = getMsgs(ctx)
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].role === 'assistant') return list[i]
  }
  throw new Error('no assistant')
}

describe('dispatchMessageEvent 流式 contentBlocks 填充', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('message_start → 新 streaming assistant（contentBlocks:[]）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    const list = getMsgs(ctx)
    expect(list).toHaveLength(1)
    expect(list[0].role).toBe('assistant')
    expect(list[0].status).toBe('streaming')
    expect(list[0].contentBlocks).toEqual([])
  })

  it('text_delta append content + 首次 push text 块（幂等不重复）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'hel' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'lo' }))
    const a = lastAssistant(ctx)
    expect(a.content).toBe('hello')
    expect(a.contentBlocks).toEqual([{ type: 'text', refId: 'text' }])
  })

  it('thinking_start/delta/end：thinking block 墌量 + endTime', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.thinking_start', { thinkingId: 'th1' }))
    dispatchMessageEvent(ctx, SID, msg('message.thinking_delta', { delta: 'reasoning' }))
    dispatchMessageEvent(ctx, SID, msg('message.thinking_end'))
    const a = lastAssistant(ctx)
    expect(a.thinking).toHaveLength(1)
    expect(a.thinking![0].content).toBe('reasoning')
    expect(a.thinking![0].endTime).toBeDefined()
    expect(a.contentBlocks).toContainEqual({ type: 'thinking', refId: 'th1' })
  })

  it('tool_call_start/end：ID 锚定更新 status + output', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { toolCallId: 'tc1', toolName: 'read', input: { path: '/x' } }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { toolCallId: 'tc1', status: 'completed', output: 'data' }))
    const a = lastAssistant(ctx)
    expect(a.toolCalls).toHaveLength(1)
    expect(a.toolCalls![0].status).toBe('completed')
    expect(a.toolCalls![0].output).toBe('data')
  })

  it('sealed guard：finalizeSession 收口后 text_delta 幂等丢弃（D-010）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'before' }))
    // 模拟 finalizeSession 把 assistant 改为 complete（sealed）
    const list = getMsgs(ctx)
    ctx.messages.value.set(SID, list.map(m => m.role === 'assistant' ? { ...m, status: 'complete' as const } : m))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'AFTER' }))
    // 收口后 delta 被丢弃，content 不变
    expect(lastAssistant(ctx).content).toBe('before')
  })
})
