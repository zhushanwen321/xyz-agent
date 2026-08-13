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
import type { Message, Segment, ServerMessage } from '@xyz-agent/shared'

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
    // m2：queue_update drain 接线 drainPending + appendUser
    drainPending: vi.fn(),
    appendUser: vi.fn(),
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

  // ── §11 检查点 3：两条 contentBlocks 填充路径顺序语义统一 ──
  // streaming 事件序列（本文件）与持久化 content array（runtime message-converter 测试）
  // 对同一消息内容必须产生一致顺序。真实 pi 事件流：模型输出 tool_use 时发 toolcall_start
  // （带 contentIndex），text_delta 实时到达，tool_execution_start（工具执行）最后到——
  // 故「text 在 tool 之后」时事件到达顺序是 [thinking, text, tool]，但 contentIndex 顺序是
  // [thinking(0), toolCall(1), text(2)]。前端按 contentIndex 有序插入，结果与持久化路径一致。

  it('顺序统一：text 在 tool 之后时按 contentIndex 插入（与持久化路径一致）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    // 事件到达顺序：thinking → text（模型先输出 thinking，再输出 tool_use，turn 结束后才执行工具）
    dispatchMessageEvent(ctx, SID, msg('message.thinking_start', { thinkingId: 'th1', contentIndex: 0 }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'answer', contentIndex: 2 }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { toolCallId: 'tc1', toolName: 'read', input: { path: '/x' }, contentIndex: 1 }))
    const a = lastAssistant(ctx)
    expect(a.contentBlocks).toEqual([
      { type: 'thinking', refId: 'th1', contentIndex: 0 },
      { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
      { type: 'text', refId: 'text', contentIndex: 2 },
    ])
  })

  it('顺序统一：text 在 tool 之前时按 contentIndex 插入（append 等价，行为不变）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'let me check', contentIndex: 0 }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { toolCallId: 'tc1', toolName: 'read', input: { path: '/x' }, contentIndex: 1 }))
    const a = lastAssistant(ctx)
    expect(a.contentBlocks).toEqual([
      { type: 'text', refId: 'text', contentIndex: 0 },
      { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
    ])
  })

  it('顺序统一：无 contentIndex 时退化为 append（旧事件兼容）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.thinking_start', { thinkingId: 'th1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { toolCallId: 'tc1', toolName: 'read', input: {} }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'text' }))
    const a = lastAssistant(ctx)
    expect(a.contentBlocks).toEqual([
      { type: 'thinking', refId: 'th1' },
      { type: 'toolCall', refId: 'tc1' },
      { type: 'text', refId: 'text' },
    ])
  })

  it('顺序统一：多 tool 交错的 contentIndex 插入（thinking0/tool1/text2/tool3）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.thinking_start', { thinkingId: 'th1', contentIndex: 0 }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'mid', contentIndex: 2 }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { toolCallId: 'tc1', toolName: 'read', input: {}, contentIndex: 1 }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { toolCallId: 'tc2', toolName: 'grep', input: {}, contentIndex: 3 }))
    const a = lastAssistant(ctx)
    expect(a.contentBlocks).toEqual([
      { type: 'thinking', refId: 'th1', contentIndex: 0 },
      { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
      { type: 'text', refId: 'text', contentIndex: 2 },
      { type: 'toolCall', refId: 'tc2', contentIndex: 3 },
    ])
  })
})

describe('dispatchMessageEvent queue_update drain（m2 steer/followup 解耦）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  // TC1-TC3：m2 把 queue_update drain 分支从 markPendingDelivered 切换为 drainPending + appendUser。
  // drainPending FIFO 取匹配 pending 的 segments，appendUser 追加进对话流（complete user）。
  // 此处为 integration——测 handler 接线（调对 ctx 方法 + 参数），appendUser 内部逻辑在 store 单测。

  it('TC1: steering drain → drainPending 取 segments + appendUser 追加', () => {
    const ctx = makeCtx()
    // prev queueStates：steering 队列有 1 项（模拟之前 steer 入队）
    ctx.queueStates.value = new Map([[SID, { steering: ['adjust plan'] }]])
    // drainPending mock 返回 segments（模拟 pendingBuffer 命中）
    const segs: Segment[] = [{ type: 'text', text: 'adjust plan' }]
    vi.mocked(ctx.drainPending).mockReturnValue(segs)

    dispatchMessageEvent(ctx, SID, msg('message.queue_update', { steering: [] }))

    // countDrained(['adjust plan'], []) → ['adjust plan']（prev 有 next 没有）
    expect(ctx.drainPending).toHaveBeenCalledWith(SID, 'adjust plan', 'steer')
    expect(ctx.appendUser).toHaveBeenCalledWith(SID, segs)
  })

  it('TC2: followUp drain → drainPending 取 segments + appendUser 追加', () => {
    const ctx = makeCtx()
    ctx.queueStates.value = new Map([[SID, { followUp: ['next step'] }]])
    const segs: Segment[] = [{ type: 'text', text: 'next step' }]
    vi.mocked(ctx.drainPending).mockReturnValue(segs)

    dispatchMessageEvent(ctx, SID, msg('message.queue_update', { followUp: [] }))

    expect(ctx.drainPending).toHaveBeenCalledWith(SID, 'next step', 'follow-up')
    expect(ctx.appendUser).toHaveBeenCalledWith(SID, segs)
  })

  it('TC3: drainPending 无匹配返回 undefined 时 appendUser 不调（幂等）', () => {
    const ctx = makeCtx()
    // prev queueStates 有项（drain 会触发 countDrained），但 pendingBuffer 空（drainPending 返回 undefined）
    ctx.queueStates.value = new Map([[SID, { steering: ['x'] }]])
    // drainPending 默认 vi.fn() 返回 undefined（模拟 pendingBuffer 空 / 已 abort）

    dispatchMessageEvent(ctx, SID, msg('message.queue_update', { steering: [] }))

    expect(ctx.drainPending).toHaveBeenCalledWith(SID, 'x', 'steer')
    expect(ctx.appendUser).not.toHaveBeenCalled()
  })
})
