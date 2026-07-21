/**
 * Tasks Drawer tool_call_end 的 toolName 解析回归测试。
 *
 * [HISTORICAL] bug：tool_call_end 事件 payload 不带 toolName（event-adapter 只保证
 * tool_call_start 带）。routeToolResultToTasks 原从 payload 读 toolName，fallback 成 'tool'，
 * 导致 todo/goal_control tool result 永远不进 tasks store → tasks tab 不显示。
 *
 * 修复：tool_call_end handler 从已锚定的 toolCall（tool_call_start 时记录）取 toolName，
 * 不靠 payload.toolName。本测试锁住该修复——payload 不带 toolName 时 tasks store 仍写入。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/tasks-tool-name-resolution.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { useTasksStore } from '@/stores/tasks'
import type { ServerMessage } from '@xyz-agent/shared'

describe('tasks tool_call_end toolName 解析', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('tool_call_end payload 不带 toolName → 从已存 toolCall 取 todo，tasks store 正确写入', () => {
    const chat = useChatStore()
    const tasks = useTasksStore()
    const sid = 's-todo-test'

    // hydrate user message（前置：applyMessageEvent 需要已有 assistant 占位）
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'm1' },
    } as ServerMessage<'message.message_start'>)

    // tool_call_start：payload 带 toolName='todo'（event-adapter 保证），此时 toolCall 被记录
    chat.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, toolCallId: 'tc1', toolName: 'todo', input: { action: 'add' } },
    } as ServerMessage<'message.tool_call_start'>)

    // tool_call_end：**故意不带 toolName**（模拟真实 event-adapter 行为）
    // details 含 todos + __gui__（todo extension tool result 结构）
    chat.applyMessageEvent(sid, {
      type: 'message.tool_call_end',
      payload: {
        sessionId: sid,
        toolCallId: 'tc1',
        // 注意：无 toolName 字段
        status: 'completed',
        details: {
          action: 'add',
          nextId: 2,
          todos: [{ id: 1, text: '测试任务', status: 'pending' }],
          __gui__: { type: 'list-tree', props: { items: [{ label: '#1: 测试任务' }] } },
        },
      },
    } as ServerMessage<'message.tool_call_end'>)

    // 关键断言：tasks store 写入成功（toolName 从已存 toolCall 解析为 'todo'）
    expect(tasks.hasData(sid)).toBe(true)
    expect(tasks.getTodos(sid)).toEqual([{ id: 1, text: '测试任务', status: 'pending' }])
    expect(tasks.getTodoCount(sid)).toEqual({ done: 0, total: 1 })
  })

  it('payload 带 toolName 时（旧路径兼容）仍正确写入', () => {
    const chat = useChatStore()
    const tasks = useTasksStore()
    const sid = 's-todo-explicit'

    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'm1' },
    } as ServerMessage<'message.message_start'>)

    chat.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, toolCallId: 'tc1', toolName: 'todo', input: {} },
    } as ServerMessage<'message.tool_call_start'>)

    // tool_call_end 带 toolName（某些 event-adapter 路径会带）
    chat.applyMessageEvent(sid, {
      type: 'message.tool_call_end',
      payload: {
        sessionId: sid,
        toolCallId: 'tc1',
        toolName: 'todo',
        status: 'completed',
        details: {
          todos: [{ id: 1, text: '显式 toolName', status: 'completed' }],
          __gui__: { type: 'list-tree', props: { items: [] } },
        },
      },
    } as ServerMessage<'message.tool_call_end'>)

    expect(tasks.hasData(sid)).toBe(true)
    expect(tasks.getTodoCount(sid)).toEqual({ done: 1, total: 1 })
  })
})
