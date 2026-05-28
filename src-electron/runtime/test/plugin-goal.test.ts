/**
 * Goal Plugin Unit Tests.
 *
 * Tests the goal_manager tool and goal state management.
 *
 * Test strategy:
 * - Mock api.sessionData.get/set for state persistence
 * - Mock api.tools.register to capture tool handler
 * - Call createGoalTool(api) to register the tool
 * - Extract handler from register mock and invoke it with test parameters
 * - Pure functions from goal-state.ts tested directly (no mocking needed)
 * - Hook registration tested via createGoalHooks(api)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Phase2AgentAPI } from '../src/services/plugin-service/plugin-types.js'

// ── Pure function tests (no mocking needed) ─────────────────────

describe('GoalState pure functions', () => {
  it('createInitialState returns empty state', async () => {
    const { createInitialState } = await import('../../../resources/plugins/goal/src/goal-state.js')
    const state = createInitialState()
    expect(state.goal).toBeNull()
    expect(state.tasks).toHaveLength(0)
    expect(state.nextTaskId).toBe(1)
    expect(state.nextSubTodoId).toBe(1)
    expect(state.createdWithLabels).toBe(false)
    expect(state.pendingMessage).toBeNull()
  })

  it('isTerminalTaskStatus returns true for completed and cancelled', async () => {
    const { isTerminalTaskStatus } = await import('../../../resources/plugins/goal/src/goal-state.js')
    expect(isTerminalTaskStatus('completed')).toBe(true)
    expect(isTerminalTaskStatus('cancelled')).toBe(true)
    expect(isTerminalTaskStatus('pending')).toBe(false)
    expect(isTerminalTaskStatus('in_progress')).toBe(false)
  })

  it('getCompletedCount counts completed tasks', async () => {
    const { getCompletedCount } = await import('../../../resources/plugins/goal/src/goal-state.js')
    const tasks = [
      { id: 1, description: 'Task 1', status: 'completed' as const, subTodos: [] },
      { id: 2, description: 'Task 2', status: 'in_progress' as const, subTodos: [] },
      { id: 3, description: 'Task 3', status: 'pending' as const, subTodos: [] },
    ]
    expect(getCompletedCount(tasks)).toBe(1)
  })

  it('getIncompleteTasks returns pending/in_progress tasks', async () => {
    const { getIncompleteTasks } = await import('../../../resources/plugins/goal/src/goal-state.js')
    const tasks = [
      { id: 1, description: 'Completed', status: 'completed' as const, subTodos: [] },
      { id: 2, description: 'Pending', status: 'pending' as const, subTodos: [] },
      { id: 3, description: 'In Progress', status: 'in_progress' as const, subTodos: [] },
      { id: 4, description: 'Cancelled', status: 'cancelled' as const, subTodos: [] },
    ]
    const incomplete = getIncompleteTasks(tasks)
    expect(incomplete).toHaveLength(2)
    expect(incomplete.map(t => t.id)).toEqual([2, 3])
  })

  it('normalizeDescription removes newlines and truncates', async () => {
    const { normalizeDescription } = await import('../../../resources/plugins/goal/src/goal-state.js')
    expect(normalizeDescription('  hello\nworld  ')).toBe('hello world')
    expect(normalizeDescription('a'.repeat(100))).toHaveLength(80) // 80 = MAX_LENGTH
  })

  it('formatTaskList formats active, completed and cancelled tasks', async () => {
    const { formatTaskList } = await import('../../../resources/plugins/goal/src/goal-state.js')
    const tasks = [
      { id: 1, description: 'Active', status: 'in_progress' as const, subTodos: [] },
      { id: 2, description: 'Done', status: 'completed' as const, evidence: 'Test passed', subTodos: [] },
    ]
    const result = formatTaskList(tasks)
    expect(result).toContain('Active')
    expect(result).toContain('Done')
    expect(result).toContain('1/2 完成')
  })

  it('formatTaskList shows empty state when no tasks', async () => {
    const { formatTaskList } = await import('../../../resources/plugins/goal/src/goal-state.js')
    expect(formatTaskList([])).toBe('暂无任务。')
  })

  it('formatTaskList includes sub-todos', async () => {
    const { formatTaskList } = await import('../../../resources/plugins/goal/src/goal-state.js')
    const tasks = [
      {
        id: 1, description: 'Task with subtodos', status: 'in_progress' as const,
        subTodos: [
          { subId: 1, text: 'Step 1', status: 'pending' as const },
          { subId: 2, text: 'Step 2', status: 'completed' as const },
        ],
      },
    ]
    const result = formatTaskList(tasks)
    expect(result).toContain('Step 1')
    expect(result).toContain('Step 2')
  })
})

// ── Goal tool handler tests ─────────────────────────────────────

describe('Goal tool handler', () => {
  let mockSessionDataGet: ReturnType<typeof vi.fn>
  let mockSessionDataSet: ReturnType<typeof vi.fn>
  let registeredHandler: ((params: Record<string, unknown>, _extra: unknown) => Promise<{ content: string }>) | null
  let api: Phase2AgentAPI

  beforeEach(async () => {
    mockSessionDataGet = vi.fn().mockResolvedValue(undefined)
    mockSessionDataSet = vi.fn().mockResolvedValue(undefined)
    registeredHandler = null

    api = {
      sessionData: {
        get: mockSessionDataGet,
        set: mockSessionDataSet,
        delete: vi.fn().mockResolvedValue(undefined),
        keys: vi.fn().mockResolvedValue([]),
      },
      tools: {
        register: vi.fn().mockImplementation(async (registration: { name: string; description: string; parameters: Record<string, unknown>; handler: unknown }) => {
          registeredHandler = registration.handler as typeof registeredHandler
          return 'dispose-key'
        }),
        unregister: vi.fn().mockResolvedValue(undefined),
      },
      hooks: {
        onBeforeSendMessage: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
        onBeforeToolCall: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
        onBeforeAgentStart: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
        onAfterToolResult: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
        onPiEvent: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
      },
      storage: undefined as never,
      notify: undefined as never,
      sessions: undefined as never,
      events: undefined as never,
      config: undefined as never,
      ui: undefined as never,
      agent: undefined as never,
      workspace: undefined as never,
    } as unknown as Phase2AgentAPI
  })

  /** Invoke the registered tool handler with the given params */
  async function callHandler(params: Record<string, unknown>): Promise<{ content: string }> {
    if (!registeredHandler) throw new Error('Handler not registered')
    return registeredHandler(params, null) as Promise<{ content: string }>
  }

  // ── 1. create_tasks ──────────────────────────────────────────

  it('create_tasks stores tasks and returns summary', async () => {
    const { createGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    // Set active goal before calling handler
    mockSessionDataGet.mockResolvedValue({
      goal: { goalId: 'test', goalDescription: 'Test goal' },
      tasks: [],
      nextTaskId: 1,
      nextSubTodoId: 1,
      createdWithLabels: false,
      pendingMessage: null,
    })
    await createGoalTool(api)

    const result = await callHandler({
      action: 'create_tasks',
      tasks: ['Task 1', 'Task 2', 'Task 3'],
    })

    const parsed = JSON.parse(result.content)
    expect(parsed.result).toContain('已创建 3 个任务')
    expect(parsed.tasks).toHaveLength(3)
    expect(parsed.tasks[0].id).toBe(1)
    expect(parsed.summary).toBe('0/3 完成')

    // State should be persisted
    expect(mockSessionDataSet).toHaveBeenCalled()
  })

  it('create_tasks rejects empty tasks', async () => {
    const { createGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')

    // Need an active goal first — create_tasks requires active goal
    // The handler is inside createGoalTool's register call. Let me set initial state
    mockSessionDataGet.mockResolvedValue({
      goal: { goalId: 'test', goalDescription: 'Test goal' },
      tasks: [],
      nextTaskId: 1,
      nextSubTodoId: 1,
      createdWithLabels: false,
      pendingMessage: null,
    })

    await createGoalTool(api)

    await expect(callHandler({ action: 'create_tasks', tasks: [] })).rejects.toThrow()
  })

  // ── 2. update_tasks ──────────────────────────────────────────

  it('update_tasks marks task completed with evidence', async () => {
    mockSessionDataGet.mockResolvedValue({
      goal: { goalId: 'test', goalDescription: 'Test goal' },
      tasks: [
        { id: 1, description: 'Task 1', status: 'pending' },
        { id: 2, description: 'Task 2', status: 'in_progress' },
      ],
      nextTaskId: 3,
      nextSubTodoId: 1,
      createdWithLabels: false,
      pendingMessage: null,
    })

    const { createGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await createGoalTool(api)

    const result = await callHandler({
      action: 'update_tasks',
      updates: [{ taskId: 1, status: 'completed', evidence: 'Test passed' }],
    })

    const parsed = JSON.parse(result.content)
    expect(parsed.result).toContain('completed')
    expect(parsed.tasks[0].status).toBe('completed')
    expect(parsed.tasks[0].evidence).toBe('Test passed')
  })

  // ── 3. list_tasks ────────────────────────────────────────────

  it('list_tasks shows correct progress', async () => {
    mockSessionDataGet.mockResolvedValue({
      goal: { goalId: 'test', goalDescription: 'Test goal' },
      tasks: [
        { id: 1, description: 'Done', status: 'completed', evidence: 'Yes' },
        { id: 2, description: 'Pending', status: 'pending' },
        { id: 3, description: 'In Progress', status: 'in_progress' },
      ],
      nextTaskId: 4,
      nextSubTodoId: 1,
      createdWithLabels: false,
      pendingMessage: null,
    })

    const { createGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await createGoalTool(api)

    const result = await callHandler({ action: 'list_tasks' })
    const parsed = JSON.parse(result.content)
    expect(parsed.summary).toBe('1/3 完成')
    expect(parsed.tasks).toHaveLength(3)
  })

  // ── 4. complete_goal ─────────────────────────────────────────

  it('complete_goal marks goal as complete when all tasks done', async () => {
    mockSessionDataGet.mockResolvedValue({
      goal: { goalId: 'test', goalDescription: 'Test goal' },
      tasks: [
        { id: 1, description: 'Done', status: 'completed', evidence: 'Yes' },
      ],
      nextTaskId: 2,
      nextSubTodoId: 1,
      createdWithLabels: false,
      pendingMessage: null,
    })

    const { createGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await createGoalTool(api)

    const result = await callHandler({
      action: 'complete_goal',
      evidence: 'All tasks completed successfully',
    })

    const parsed = JSON.parse(result.content)
    expect(parsed.result).toContain('目标已完成')
    expect(parsed.result).toContain('All tasks completed successfully')
  })

  // ── 5. add_tasks ─────────────────────────────────────────────

  it('add_tasks appends new tasks', async () => {
    mockSessionDataGet.mockResolvedValue({
      goal: { goalId: 'test', goalDescription: 'Test goal' },
      tasks: [
        { id: 1, description: 'Existing', status: 'pending' },
      ],
      nextTaskId: 2,
      nextSubTodoId: 1,
      createdWithLabels: false,
      pendingMessage: null,
    })

    const { createGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await createGoalTool(api)

    const result = await callHandler({
      action: 'add_tasks',
      tasks: ['New task 1', 'New task 2'],
    })

    const parsed = JSON.parse(result.content)
    expect(parsed.result).toContain('已追加 2 个任务')
    expect(parsed.tasks).toHaveLength(3)
    expect(parsed.tasks[1].description).toBe('New task 1')
    expect(parsed.tasks[2].id).toBe(3) // auto-increment from 2
  })

  // ── 6. cancel_goal ───────────────────────────────────────────

  it('cancel_goal aborts and clears state', async () => {
    mockSessionDataGet.mockResolvedValue({
      goal: { goalId: 'test', goalDescription: 'Test goal' },
      tasks: [
        { id: 1, description: 'Task 1', status: 'pending' },
        { id: 2, description: 'Task 2', status: 'completed', evidence: 'done' },
      ],
      nextTaskId: 3,
      nextSubTodoId: 1,
      createdWithLabels: false,
      pendingMessage: null,
    })

    const { createGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await createGoalTool(api)

    const result = await callHandler({
      action: 'cancel_goal',
      cancelReason: 'Changed priorities',
    })

    const parsed = JSON.parse(result.content)
    expect(parsed.result).toContain('Goal 已取消')
    expect(parsed.result).toContain('Changed priorities')
    expect(parsed.tasks).toHaveLength(0) // state cleared
  })

  // ── 7. report_blocked ────────────────────────────────────────

  it('report_blocked records error state', async () => {
    mockSessionDataGet.mockResolvedValue({
      goal: { goalId: 'test', goalDescription: 'Test goal' },
      tasks: [
        { id: 1, description: 'Task 1', status: 'pending' },
      ],
      nextTaskId: 2,
      nextSubTodoId: 1,
      createdWithLabels: false,
      pendingMessage: null,
    })

    const { createGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await createGoalTool(api)

    const result = await callHandler({
      action: 'report_blocked',
      reason: 'API rate limit exceeded',
    })

    const parsed = JSON.parse(result.content)
    expect(parsed.result).toContain('已报告阻塞')
    expect(parsed.result).toContain('API rate limit exceeded')
  })

  // ── 8. sessionData.read on empty ─────────────────────────────

  it('sessionData.read on empty returns empty state', async () => {
    mockSessionDataGet.mockResolvedValue(undefined)

    const { createGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await createGoalTool(api)

    // No active goal — should still work as listing empty state
    // create_tasks without active goal should throw
    await expect(callHandler({ action: 'create_tasks', tasks: ['Task'] })).rejects.toThrow(
      'Goal 模式未激活',
    )
  })

  // ── 9. Hooks registration ────────────────────────────────────

  it('createGoalHooks registers hooks for onBeforeAgentStart and onPiEvent', async () => {
    // createGoalHooks pushes return values directly (does not await),
    // so the mock must return a plain object, not a Promise
    const mockOnBeforeAgentStart = vi.fn().mockReturnValue({ dispose: vi.fn() })
    const mockOnPiEvent = vi.fn().mockReturnValue({ dispose: vi.fn() })

    const hooksApi = {
      ...api,
      hooks: {
        onBeforeAgentStart: mockOnBeforeAgentStart,
        onPiEvent: mockOnPiEvent,
        onBeforeSendMessage: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
        onBeforeToolCall: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
        onAfterToolResult: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
      },
    } as unknown as Phase2AgentAPI

    const { createGoalHooks } = await import('../../../resources/plugins/goal/src/goal-hooks.js')
    const disposables = createGoalHooks(hooksApi)

    expect(mockOnBeforeAgentStart).toHaveBeenCalledTimes(1)
    expect(mockOnPiEvent).toHaveBeenCalledTimes(1)
    expect(mockOnPiEvent).toHaveBeenCalledWith('agent_end', expect.any(Function))
    expect(disposables).toHaveLength(2)
    disposables.forEach(d => expect(d).toHaveProperty('dispose'))
  })

  it('onBeforeAgentStart hook injects goal context when active', async () => {
    const hookHandlers: Array<(ctx: unknown) => Promise<unknown>> = []
    const mockOnBeforeAgentStart = vi.fn().mockImplementation(async (handler: (ctx: unknown) => Promise<unknown>) => {
      hookHandlers.push(handler)
      return { dispose: vi.fn() }
    })
    const mockOnPiEvent = vi.fn().mockResolvedValue({ dispose: vi.fn() })

    const hooksApi = {
      ...api,
      sessionData: {
        get: vi.fn().mockResolvedValue({
          goal: { goalId: 'test', goalDescription: 'Build feature X' },
          tasks: [{ id: 1, description: 'Task 1', status: 'pending' }],
          nextTaskId: 2,
          nextSubTodoId: 1,
          createdWithLabels: false,
          pendingMessage: null,
        }),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        keys: vi.fn().mockResolvedValue([]),
      },
      hooks: {
        onBeforeAgentStart: mockOnBeforeAgentStart,
        onPiEvent: mockOnPiEvent,
        onBeforeSendMessage: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
        onBeforeToolCall: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
        onAfterToolResult: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
      },
    } as unknown as Phase2AgentAPI

    const { createGoalHooks } = await import('../../../resources/plugins/goal/src/goal-hooks.js')
    createGoalHooks(hooksApi)

    expect(hookHandlers).toHaveLength(1)
    const result = await hookHandlers[0]({})
    expect(result).toHaveProperty('injectedMessages')
    const injected = (result as { injectedMessages: Array<{ role: string; content: string }> }).injectedMessages
    expect(injected).toHaveLength(1)
    expect(injected[0].content).toContain('Build feature X')
  })

  it('onBeforeAgentStart hook returns empty when no active goal', async () => {
    const hookHandlers: Array<(ctx: unknown) => Promise<unknown>> = []
    const mockOnBeforeAgentStart = vi.fn().mockImplementation(async (handler: (ctx: unknown) => Promise<unknown>) => {
      hookHandlers.push(handler)
      return { dispose: vi.fn() }
    })
    const mockOnPiEvent = vi.fn().mockResolvedValue({ dispose: vi.fn() })

    const hooksApi = {
      ...api,
      sessionData: {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        keys: vi.fn().mockResolvedValue([]),
      },
      hooks: {
        onBeforeAgentStart: mockOnBeforeAgentStart,
        onPiEvent: mockOnPiEvent,
        onBeforeSendMessage: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
        onBeforeToolCall: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
        onAfterToolResult: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
      },
    } as unknown as Phase2AgentAPI

    const { createGoalHooks } = await import('../../../resources/plugins/goal/src/goal-hooks.js')
    createGoalHooks(hooksApi)

    const result = await hookHandlers[0]({})
    expect(result).toEqual({})
  })

  // ── 10. Sub-todo operations ──────────────────────────────────

  it('add_sub_todos adds sub-todos to a task', async () => {
    mockSessionDataGet.mockResolvedValue({
      goal: { goalId: 'test', goalDescription: 'Test goal' },
      tasks: [
        { id: 1, description: 'Main task', status: 'in_progress' },
      ],
      nextTaskId: 2,
      nextSubTodoId: 1,
      createdWithLabels: false,
      pendingMessage: null,
    })

    const { createGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await createGoalTool(api)

    const result = await callHandler({
      action: 'add_sub_todos',
      taskId: 1,
      texts: ['Step A', 'Step B'],
    })

    const parsed = JSON.parse(result.content)
    expect(parsed.result).toContain('添加 2 项 sub-todo')
    expect(parsed.tasks[0].subTodos).toHaveLength(2)
    expect(parsed.tasks[0].subTodos[0].subId).toBe(1)
  })

  it('update_sub_todos updates sub-todo status', async () => {
    mockSessionDataGet.mockResolvedValue({
      goal: { goalId: 'test', goalDescription: 'Test goal' },
      tasks: [
        {
          id: 1, description: 'Main task', status: 'in_progress',
          subTodos: [
            { subId: 1, text: 'Step A', status: 'pending' },
            { subId: 2, text: 'Step B', status: 'in_progress' },
          ],
        },
      ],
      nextTaskId: 2,
      nextSubTodoId: 3,
      createdWithLabels: false,
      pendingMessage: null,
    })

    const { createGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await createGoalTool(api)

    const result = await callHandler({
      action: 'update_sub_todos',
      taskId: 1,
      subUpdates: [{ subId: 1, status: 'in_progress' }, { subId: 2, status: 'completed' }],
    })

    const parsed = JSON.parse(result.content)
    expect(parsed.result).toContain('已更新 2 项 sub-todo')
    expect(parsed.tasks[0].subTodos[0].status).toBe('in_progress')
    expect(parsed.tasks[0].subTodos[1].status).toBe('completed')
  })

  it('delete_sub_todos removes sub-todos', async () => {
    mockSessionDataGet.mockResolvedValue({
      goal: { goalId: 'test', goalDescription: 'Test goal' },
      tasks: [
        {
          id: 1, description: 'Main task', status: 'in_progress',
          subTodos: [
            { subId: 1, text: 'Step A', status: 'pending' },
            { subId: 2, text: 'Step B', status: 'pending' },
          ],
        },
      ],
      nextTaskId: 2,
      nextSubTodoId: 3,
      createdWithLabels: false,
      pendingMessage: null,
    })

    const { createGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await createGoalTool(api)

    const result = await callHandler({
      action: 'delete_sub_todos',
      taskId: 1,
      subIds: [2],
    })

    const parsed = JSON.parse(result.content)
    expect(parsed.tasks[0].subTodos).toHaveLength(1)
    expect(parsed.tasks[0].subTodos[0].subId).toBe(1)
  })
})
