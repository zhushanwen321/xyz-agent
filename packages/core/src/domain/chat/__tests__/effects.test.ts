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
import { ref, shallowRef } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { dispatchMessageEvent } from '../effects/registry'
import type { MessageEffectContext } from '../effect-types'
import type { Message, Segment, ServerMessage } from '@xyz-agent/shared'

const SID = 's-test'

/** 构造 ctx：真实 vue ref + 回调 mock（D-1 容器：分区值为 ShallowRef<Message[]>） */
function makeCtx(initial: Message[] = []): MessageEffectContext {
  return {
    messages: ref(new Map([[SID, shallowRef(initial)]])),
    retryStates: ref(new Map()),
    queueStates: ref(new Map()),
    applyFileChanges: vi.fn(),
    markChangeSetsSuperseded: vi.fn(),
    finalizeSession: vi.fn(),
    clearPendingSend: vi.fn(),
    armStreamingTimer: vi.fn(),
    armBashTimer: vi.fn(),
    clearBashTimer: vi.fn(),
    // m2→W14：queue_update drain 接线 drainN（计数 FIFO）+ appendUser + 深度对账 reconcilePending
    drainN: vi.fn(() => []),
    reconcilePending: vi.fn(),
    appendUser: vi.fn(),
    // w21：entry 载体帧喂 reducer 的接入点（store.applyEntryFrame 注入）
    applyEntryFrame: vi.fn(),
  }
}

function msg(type: string, payload: Record<string, unknown> = {}): ServerMessage {
  return { type, payload: { sessionId: SID, ...payload } } as ServerMessage
}

/** [w21] toolCall entry 形态构造（payload.entry——event-adapter 重构载体） */
function toolCallEntry(fields: { toolCallId: string; toolName: string; arguments: Record<string, unknown>; contentIndex?: number }): Record<string, unknown> {
  return {
    type: 'toolCall',
    toolCallId: fields.toolCallId,
    toolName: fields.toolName,
    arguments: fields.arguments,
    ...(fields.contentIndex !== undefined ? { contentIndex: fields.contentIndex } : {}),
    timestamp: new Date(0).toISOString(),
  }
}

/** [w21] toolResult message entry 形态构造（payload.entry——与 pi 持久化 toolResult entry 同构） */
function toolResultEntry(fields: { toolCallId: string; toolName: string; content: unknown; isError: boolean; details?: Record<string, unknown> }): Record<string, unknown> {
  return {
    type: 'message',
    parentId: null,
    timestamp: new Date(0).toISOString(),
    // content 包 text block 数组（pi 持久化形态，W21 契约）
    message: { role: 'toolResult', toolCallId: fields.toolCallId, toolName: fields.toolName, content: [{ type: 'text', text: String(fields.content) }], isError: fields.isError, ...(fields.details !== undefined ? { details: fields.details } : {}), timestamp: 0 },
  }
}

function getMsgs(ctx: MessageEffectContext): Message[] {
  return ctx.messages.value.get(SID)?.value ?? []
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
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: { path: '/x' } }) }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: toolResultEntry({ toolCallId: 'tc1', toolName: 'read', content: 'data', isError: false }) }))
    const a = lastAssistant(ctx)
    expect(a.toolCalls).toHaveLength(1)
    expect(a.toolCalls![0].status).toBe('completed')
    expect(a.toolCalls![0].output).toBe('data')
  })

  it('sealed guard：finalizeSession 收口后 text_delta 幂等丢弃（D-010）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'before' }))
    // 模拟 finalizeSession 把 assistant 改为 complete（sealed）——同 sid 走内层 ref 数组替换
    const list = getMsgs(ctx)
    ctx.messages.value.get(SID)!.value = list.map(m => m.role === 'assistant' ? { ...m, status: 'complete' as const } : m)
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
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: { path: '/x' }, contentIndex: 1 }) }))
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
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: { path: '/x' }, contentIndex: 1 }) }))
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
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: {} }) }))
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
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: {}, contentIndex: 1 }) }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc2', toolName: 'grep', arguments: {}, contentIndex: 3 }) }))
    const a = lastAssistant(ctx)
    expect(a.contentBlocks).toEqual([
      { type: 'thinking', refId: 'th1', contentIndex: 0 },
      { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
      { type: 'text', refId: 'text', contentIndex: 2 },
      { type: 'toolCall', refId: 'tc2', contentIndex: 3 },
    ])
  })
})

describe('dispatchMessageEvent queue_update drain（m2 steer/followup 解耦，W14 计数 FIFO）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  // TC1-TC3：queue_update drain 分支 = countDrained 差集条数 N → drainN(sid, mode, N) 计数
  // FIFO 取 segments + appendUser 追加进对话流（W14：不按文本匹配）。此处为 integration——
  // 测 handler 接线（调对 ctx 方法 + 参数），drainN/appendUser 内部逻辑在 store 单测。

  it('TC1: steering drain → 差集条数 N=1 调 drainN(sid, steer, 1) + appendUser 追加', () => {
    const ctx = makeCtx()
    // prev queueStates：steering 队列有 1 项（模拟之前 steer 入队）
    ctx.queueStates.value = new Map([[SID, { steering: ['adjust plan'] }]])
    // drainN mock 返回 segments（模拟 pendingBuffer 命中）
    const segs: Segment[] = [{ type: 'text', text: 'adjust plan' }]
    vi.mocked(ctx.drainN).mockReturnValue([segs])

    dispatchMessageEvent(ctx, SID, msg('message.queue_update', { steering: [] }))

    // countDrained(['adjust plan'], []) → ['adjust plan'].length = 1（prev 有 next 没有）
    expect(ctx.drainN).toHaveBeenCalledWith(SID, 'steer', 1)
    expect(ctx.appendUser).toHaveBeenCalledWith(SID, segs)
  })

  it('TC2: followUp drain → 差集条数 N=1 调 drainN(sid, follow-up, 1) + appendUser 追加', () => {
    const ctx = makeCtx()
    ctx.queueStates.value = new Map([[SID, { followUp: ['next step'] }]])
    const segs: Segment[] = [{ type: 'text', text: 'next step' }]
    vi.mocked(ctx.drainN).mockReturnValue([segs])

    dispatchMessageEvent(ctx, SID, msg('message.queue_update', { followUp: [] }))

    expect(ctx.drainN).toHaveBeenCalledWith(SID, 'follow-up', 1)
    expect(ctx.appendUser).toHaveBeenCalledWith(SID, segs)
  })

  it('TC3: drainN 取尽返回 [] 时 appendUser 不调（幂等）', () => {
    const ctx = makeCtx()
    // prev queueStates 有项（drain 会触发 countDrained），但 pendingBuffer 空（drainN 返回 []）
    ctx.queueStates.value = new Map([[SID, { steering: ['x'] }]])
    // drainN 默认 vi.fn(() => [])（模拟 pendingBuffer 空 / 已 abort）

    dispatchMessageEvent(ctx, SID, msg('message.queue_update', { steering: [] }))

    expect(ctx.drainN).toHaveBeenCalledWith(SID, 'steer', 1)
    expect(ctx.appendUser).not.toHaveBeenCalled()
  })

  it('TC4: 深度对账——reconcilePending 以帧内 pendingMessageCount 为深度调用', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.queue_update', { steering: ['a'], pendingMessageCount: 1 }))
    expect(ctx.reconcilePending).toHaveBeenCalledWith(SID, 1)

    // 字段缺失（旧 runtime / mock 帧）时退化为帧内数组长度和（W8 恒等公式，等价）
    dispatchMessageEvent(ctx, SID, msg('message.queue_update', { steering: ['a', 'b'] }))
    expect(ctx.reconcilePending).toHaveBeenLastCalledWith(SID, 2)
  })
})

describe('dispatchMessageEvent message.customStart 完成通知 display 覆写（M2 display 前置）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  /** customStart 追加消息的便捷断言：返回最后一条 system 消息 */
  function lastSystem(ctx: MessageEffectContext): Message {
    const list = getMsgs(ctx)
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].role === 'system') return list[i]
    }
    throw new Error('no system message')
  }

  it('TC1: subagent-bg-notify（完成通知）→ display 覆写为 false（即使 pi 扩展透传 display:true）', () => {
    const ctx = makeCtx()
    // pi-subagent-workflow notifier 生产端写 display:true（pi 原生语义）——消费端必须覆写
    dispatchMessageEvent(ctx, SID, msg('message.customStart', {
      customType: 'subagent-bg-notify',
      content: '子代理完成',
      display: true,
      details: { id: 'job-1', status: 'done', agent: 'coder', startedAt: 1000, endedAt: 2000 },
    }))

    const m = lastSystem(ctx)
    expect(m.customType).toBe('subagent-bg-notify')
    expect(m.display).toBe(false)
    // details 原始字段仍保留（消息进 store 供 fork/compact/replay 等其他消费）
    expect(m.details).toEqual({ id: 'job-1', status: 'done', agent: 'coder', startedAt: 1000, endedAt: 2000 })
  })

  it('TC2: workflow-result（完成通知）→ display 覆写为 false', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.customStart', {
      customType: 'workflow-result',
      content: 'run done',
      display: true,
    }))

    const m = lastSystem(ctx)
    expect(m.customType).toBe('workflow-result')
    expect(m.display).toBe(false)
  })

  it('TC3: 非完成通知 customType → display 原样透传（三态保留，undefined 安全显示）', () => {
    const ctx = makeCtx()
    // goal/todo context 类：pi 扩展声明 display:false → 透传隐藏
    dispatchMessageEvent(ctx, SID, msg('message.customStart', {
      customType: 'goal-context',
      content: '<goal_context>...',
      display: false,
    }))
    // 普通通知：display:true → 透传显示
    dispatchMessageEvent(ctx, SID, msg('message.customStart', {
      customType: 'future-extension-notify',
      content: '显示',
      display: true,
    }))
    // 无 display 字段 → undefined（!== false 即显示）
    dispatchMessageEvent(ctx, SID, msg('message.customStart', {
      customType: 'legacy-notify',
      content: 'legacy',
    }))

    const list = getMsgs(ctx)
    const sys = list.filter((m) => m.role === 'system')
    expect(sys[0].display).toBe(false)
    expect(sys[1].display).toBe(true)
    expect(sys[2].display).toBeUndefined()
  })
})

describe('message.complete error 路径的 errorMessage 可见性（模型 400 秒败回归）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('streaming 气泡收口：errorMessage 写入最后一条 assistant 的 error 字段（追加形态）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: '部分正文' }))
    dispatchMessageEvent(ctx, SID, msg('message.complete', {
      stopReason: 'error',
      errorMessage: '400: {"code":"400","message":"Unsupported model mimo-v2-pro"}',
    }))
    const a = lastAssistant(ctx)
    expect(a.status).toBe('error')
    expect(a.content).toBe('部分正文')
    expect(a.error).toBe('400: {"code":"400","message":"Unsupported model mimo-v2-pro"}')
  })

  it('无 streaming 气泡（message_start 丢失）：errorMessage 追加为纯 error 气泡', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.complete', {
      stopReason: 'error',
      errorMessage: '400: Unsupported model mimo-v2-pro',
    }))
    const list = getMsgs(ctx)
    expect(list).toHaveLength(1)
    expect(list[0].role).toBe('assistant')
    expect(list[0].status).toBe('error')
    expect(list[0].content).toBe('400: Unsupported model mimo-v2-pro')
  })

  it('非 error stopReason 不消费 errorMessage 字段（正常完成不受影响）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'ok' }))
    dispatchMessageEvent(ctx, SID, msg('message.complete', {
      stopReason: 'stop',
      content: 'ok',
      errorMessage: undefined,
    }))
    const a = lastAssistant(ctx)
    expect(a.status).toBe('complete')
    expect(a.error).toBeUndefined()
  })
})
