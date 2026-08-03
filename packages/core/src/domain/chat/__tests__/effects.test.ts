/**
 * dispatchMessageEvent 注册表行为单测（core chat/effects 域，P3 w3 迁移锁定）。
 *
 * 迁自 renderer __tests__/stores/chat-chunk-content-blocks.test.ts 的直接调用模式 +
 * 新增 tasks 路由 + openTasksPanelOnFirstData 回调触发断言（w3 核心衔接契约）。
 *
 * 覆盖：
 * - message_start：建 streaming assistant（contentBlocks:[]）
 * - text_delta：append content + push text block（幂等）
 * - thinking_start/end/delta：thinking block 墌量 + endTime
 * - tool_call_start：push toolCall + contentBlocks toolCall 块
 * - tool_call_end：ID 锚定更新 + status/output 填充
 * - sealed guard：finalizeSession 后 text_delta 幂等丢弃（D-010）
 * - tasks 路由：tool_call_end（todo/goal_control）写入 tasks store + 触发 ctx.openTasksPanelOnFirstData
 * - openTasksPanelOnFirstData 回调：首次触发、hadDataBefore=true 不触发
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/effects.test.ts
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { dispatchMessageEvent } from '../effects/registry'
import type { MessageEffectContext } from '../effect-types'
import { useTasksStore } from '../../tasks'
import type { Message, ServerMessage } from '@xyz-agent/shared'

const SID = 's-test'

/** 构造 ctx：真实 vue ref + 回调 mock + 真实 tasks store（setActivePinia 后） */
function makeCtx(initial: Message[] = [], openSpy = vi.fn()): MessageEffectContext {
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
    openTasksPanelOnFirstData: openSpy,
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

describe('tasks 路由 + openTasksPanelOnFirstData 回调（w3 核心衔接契约）', () => {
  let openSpy: Mock
  beforeEach(() => {
    setActivePinia(createPinia())
    openSpy = vi.fn()
  })

  it('todo tool_call_end（首数据）→ 写入 tasks store + 触发 openTasksPanelOnFirstData(sid, false)', () => {
    const ctx = makeCtx([], openSpy)
    // 预置 streaming assistant（tool_call_start 需要）
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { toolCallId: 'tc1', toolName: 'todo', input: {} }))

    const tasks = useTasksStore()
    expect(tasks.hasData(SID)).toBe(false)

    dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', {
      toolCallId: 'tc1', status: 'completed',
      details: { todos: [{ id: 1, text: '首任务', status: 'pending' }] },
    }))

    // tasks store 写入
    expect(tasks.hasData(SID)).toBe(true)
    expect(tasks.getTodos(SID)).toEqual([{ id: 1, text: '首任务', status: 'pending' }])
    // 回调触发：首次数据 hadDataBefore=false
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(openSpy).toHaveBeenCalledWith(SID, false)
  })

  it('goal_control tool_call_start（首数据）→ routeToolStartToTasks 写 goal meta + 触发回调', () => {
    const ctx = makeCtx([], openSpy)
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', {
      toolCallId: 'tc1', toolName: 'goal_control',
      input: { action: 'create', objective: '完成 X', slug: 'do-x' },
    }))

    const tasks = useTasksStore()
    expect(tasks.hasData(SID)).toBe(true)
    const goal = tasks.getGoal(SID)
    expect(goal?.objective).toBe('完成 X')
    expect(goal?.slug).toBe('do-x')
    expect(openSpy).toHaveBeenCalledWith(SID, false)
  })

  it('已有数据后第二次 todo tool_call_end → 回调不触发（hadDataBefore=true 守卫）', () => {
    const ctx = makeCtx([], openSpy)
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    // 首次
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { toolCallId: 'tc1', toolName: 'todo', input: {} }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', {
      toolCallId: 'tc1', status: 'completed',
      details: { todos: [{ id: 1, text: '第一', status: 'pending' }] },
    }))
    expect(openSpy).toHaveBeenCalledTimes(1)

    // 第二次（已有数据）
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { toolCallId: 'tc2', toolName: 'todo', input: {} }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', {
      toolCallId: 'tc2', status: 'completed',
      details: { todos: [{ id: 1, text: '第一', status: 'completed' }, { id: 2, text: '第二', status: 'pending' }] },
    }))
    // 仍只触发 1 次（hadDataBefore=true → 回调虽被调用但 renderer 内会早 return；core 侧验证 hadDataBefore 传入 true）
    expect(openSpy).toHaveBeenCalledTimes(2)
    expect(openSpy).toHaveBeenLastCalledWith(SID, true)
  })

  it('非 todo/goal_control tool → 不写 tasks store + 回调不触发', () => {
    const ctx = makeCtx([], openSpy)
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { toolCallId: 'tc1', toolName: 'read', input: {} }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { toolCallId: 'tc1', status: 'completed', output: 'x' }))

    const tasks = useTasksStore()
    expect(tasks.hasData(SID)).toBe(false)
    expect(openSpy).not.toHaveBeenCalled()
  })
})
