/**
 * Goal Plugin Unit Tests.
 *
 * Tests the goal_manager tool and goal state management.
 *
 * Test strategy:
 * - Mock context.globalState.get/set for state persistence
 * - Call registerGoalTool(context) to register tool schema
 * - Call executeGoalAction(context, params) to execute tool actions
 * - Pure functions from goal-state.ts tested directly (no mocking needed)
 * - Hook registration tested via createGoalHooks(context)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PluginContext } from '../src/services/plugin-service/plugin-types.js'

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

  it('isTerminalTaskStatus identifies completed and cancelled', async () => {
    const { isTerminalTaskStatus } = await import('../../../resources/plugins/goal/src/goal-state.js')
    expect(isTerminalTaskStatus('completed')).toBe(true)
    expect(isTerminalTaskStatus('cancelled')).toBe(true)
    expect(isTerminalTaskStatus('pending')).toBe(false)
    expect(isTerminalTaskStatus('in_progress')).toBe(false)
  })

  it('getCompletedCount counts completed tasks', async () => {
    const { getCompletedCount } = await import('../../../resources/plugins/goal/src/goal-state.js')
    const tasks = [
      { id: 1, description: 'A', status: 'completed' as const },
      { id: 2, description: 'B', status: 'pending' as const },
      { id: 3, description: 'C', status: 'completed' as const },
    ]
    expect(getCompletedCount(tasks)).toBe(2)
  })

  it('getIncompleteTasks filters non-terminal tasks', async () => {
    const { getIncompleteTasks } = await import('../../../resources/plugins/goal/src/goal-state.js')
    const tasks = [
      { id: 1, description: 'A', status: 'completed' as const },
      { id: 2, description: 'B', status: 'pending' as const },
      { id: 3, description: 'C', status: 'in_progress' as const },
    ]
    const result = getIncompleteTasks(tasks)
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe(2)
  })

  it('normalizeDescription removes newlines and truncates', async () => {
    const { normalizeDescription } = await import('../../../resources/plugins/goal/src/goal-state.js')
    expect(normalizeDescription('hello\nworld')).toBe('hello world')
    expect(normalizeDescription('a'.repeat(100)).length).toBeLessThan(100)
  })

  it('formatTaskList formats empty and non-empty lists', async () => {
    const { formatTaskList } = await import('../../../resources/plugins/goal/src/goal-state.js')
    expect(formatTaskList([])).toBe('暂无任务。')
    const tasks = [
      { id: 1, description: 'A', status: 'completed' as const, evidence: 'done' },
      { id: 2, description: 'B', status: 'pending' as const },
    ]
    const result = formatTaskList(tasks)
    expect(result).toContain('1/2 完成')
    expect(result).toContain('A')
  })
})

// ── Goal tool handler tests ─────────────────────────────────────

describe('Goal tool handler', () => {
  let mockGlobalStateGet: ReturnType<typeof vi.fn>
  let mockGlobalStateSet: ReturnType<typeof vi.fn>
  let mockToolsRegister: ReturnType<typeof vi.fn>
  let context: PluginContext

  beforeEach(async () => {
    mockGlobalStateGet = vi.fn().mockResolvedValue(undefined)
    mockGlobalStateSet = vi.fn().mockResolvedValue(undefined)
    mockToolsRegister = vi.fn().mockResolvedValue('goal:goal_manager')

    const api = {
      tools: {
        register: mockToolsRegister,
        unregister: vi.fn().mockResolvedValue(undefined),
      },
      hooks: {
        onBeforeSendMessage: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
        onBeforeToolCall: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
        onBeforeAgentStart: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
        onAfterToolResult: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
        onPiEvent: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
      },
      sessionData: {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        keys: vi.fn().mockResolvedValue([]),
      },
      storage: undefined as never,
      notify: undefined as never,
      sessions: undefined as never,
      events: undefined as never,
      config: undefined as never,
      ui: undefined as never,
      agent: undefined as never,
      workspace: undefined as never,
    } as never

    context = {
      pluginId: 'goal',
      pluginPath: '/plugins/goal',
      globalState: {
        get: mockGlobalStateGet,
        set: mockGlobalStateSet,
        delete: vi.fn().mockResolvedValue(undefined),
        keys: vi.fn().mockResolvedValue([]),
      },
      workspaceState: {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        keys: vi.fn().mockResolvedValue([]),
      },
      api,
      subscriptions: [],
    } as unknown as PluginContext
  })

  /** Call executeGoalAction with the given params */
  async function callAction(params: Record<string, unknown>): Promise<{ content: string }> {
    const { executeGoalAction } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    return executeGoalAction(context, params as never)
  }

  /** Set up goal state for testing */
  function setState(state: Record<string, unknown>): void {
    mockGlobalStateGet.mockResolvedValue(state)
  }

  // ── 1. create_tasks ──────────────────────────────────────────

  it('create_tasks stores tasks and returns summary', async () => {
    const { registerGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    setState({
      goal: { goalId: 'test', goalDescription: 'Test goal' },
      tasks: [],
      nextTaskId: 1,
      nextSubTodoId: 1,
      createdWithLabels: false,
      pendingMessage: null,
    })
    await registerGoalTool(context)

    const result = await callAction({
      action: 'create_tasks',
      tasks: ['Task 1', 'Task 2', 'Task 3'],
    })

    const parsed = JSON.parse(result.content)
    expect(parsed.result).toContain('已创建 3 个任务')
    expect(parsed.tasks).toHaveLength(3)
    expect(parsed.tasks[0].id).toBe(1)
    expect(parsed.summary).toBe('0/3 完成')

    // State should be persisted
    expect(mockGlobalStateSet).toHaveBeenCalled()
  })

  it('create_tasks rejects empty tasks', async () => {
    const { registerGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')

    setState({
      goal: { goalId: 'test', goalDescription: 'Test goal' },
      tasks: [],
      nextTaskId: 1,
      nextSubTodoId: 1,
      createdWithLabels: false,
      pendingMessage: null,
    })

    await registerGoalTool(context)

    await expect(callAction({ action: 'create_tasks', tasks: [] })).rejects.toThrow()
  })

  // ── 2. update_tasks ──────────────────────────────────────────

  it('update_tasks marks task completed with evidence', async () => {
    setState({
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

    const { registerGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await registerGoalTool(context)

    const result = await callAction({
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
    setState({
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

    const { registerGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await registerGoalTool(context)

    const result = await callAction({ action: 'list_tasks' })
    const parsed = JSON.parse(result.content)
    expect(parsed.summary).toBe('1/3 完成')
    expect(parsed.tasks).toHaveLength(3)
  })

  // ── 4. complete_goal ─────────────────────────────────────────

  it('complete_goal marks goal as complete when all tasks done', async () => {
    setState({
      goal: { goalId: 'test', goalDescription: 'Test goal' },
      tasks: [
        { id: 1, description: 'Done', status: 'completed', evidence: 'Yes' },
      ],
      nextTaskId: 2,
      nextSubTodoId: 1,
      createdWithLabels: false,
      pendingMessage: null,
    })

    const { registerGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await registerGoalTool(context)

    const result = await callAction({
      action: 'complete_goal',
      evidence: 'All tasks completed successfully',
    })

    const parsed = JSON.parse(result.content)
    expect(parsed.result).toContain('目标已完成')
    expect(parsed.result).toContain('All tasks completed successfully')
  })

  // ── 5. add_tasks ─────────────────────────────────────────────

  it('add_tasks appends new tasks', async () => {
    setState({
      goal: { goalId: 'test', goalDescription: 'Test goal' },
      tasks: [
        { id: 1, description: 'Existing', status: 'pending' },
      ],
      nextTaskId: 2,
      nextSubTodoId: 1,
      createdWithLabels: false,
      pendingMessage: null,
    })

    const { registerGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await registerGoalTool(context)

    const result = await callAction({
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
    setState({
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

    const { registerGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await registerGoalTool(context)

    const result = await callAction({
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
    setState({
      goal: { goalId: 'test', goalDescription: 'Test goal' },
      tasks: [
        { id: 1, description: 'Task 1', status: 'pending' },
      ],
      nextTaskId: 2,
      nextSubTodoId: 1,
      createdWithLabels: false,
      pendingMessage: null,
    })

    const { registerGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await registerGoalTool(context)

    const result = await callAction({
      action: 'report_blocked',
      reason: 'API rate limit exceeded',
    })

    const parsed = JSON.parse(result.content)
    expect(parsed.result).toContain('已报告阻塞')
    expect(parsed.result).toContain('API rate limit exceeded')
  })

  // ── 8. globalState.read on empty ─────────────────────────────

  it('globalState.read on empty returns empty state', async () => {
    mockGlobalStateGet.mockResolvedValue(undefined)

    const { registerGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await registerGoalTool(context)

    // No active goal — create_tasks without active goal should throw
    await expect(callAction({ action: 'create_tasks', tasks: ['Task'] })).rejects.toThrow(
      'Goal 模式未激活',
    )
  })

  // ── 9. Hooks registration ────────────────────────────────────

  it('createGoalHooks registers hooks for onBeforeAgentStart and onPiEvent', async () => {
    const mockOnBeforeAgentStart = vi.fn().mockResolvedValue({ dispose: vi.fn() })
    const mockOnPiEvent = vi.fn().mockResolvedValue({ dispose: vi.fn() })

    const hookContext = {
      ...context,
      api: {
        ...context.api,
        hooks: {
          onBeforeAgentStart: mockOnBeforeAgentStart,
          onPiEvent: mockOnPiEvent,
          onBeforeSendMessage: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
          onBeforeToolCall: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
          onAfterToolResult: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
        },
      },
    } as unknown as PluginContext

    const { createGoalHooks } = await import('../../../resources/plugins/goal/src/goal-hooks.js')
    await createGoalHooks(hookContext)

    expect(mockOnBeforeAgentStart).toHaveBeenCalledTimes(1)
    expect(mockOnPiEvent).toHaveBeenCalledTimes(1)
    expect(mockOnPiEvent).toHaveBeenCalledWith('agent_end', expect.any(Function))
    // disposables pushed to context.subscriptions
    expect(hookContext.subscriptions.length).toBeGreaterThanOrEqual(2)
  })

  it('onBeforeAgentStart hook injects goal context when active', async () => {
    const hookHandlers: Array<(ctx: unknown) => Promise<unknown>> = []
    const mockOnBeforeAgentStart = vi.fn().mockImplementation(async (handler: (ctx: unknown) => Promise<unknown>) => {
      hookHandlers.push(handler)
      return { dispose: vi.fn() }
    })
    const mockOnPiEvent = vi.fn().mockResolvedValue({ dispose: vi.fn() })

    const hookContext = {
      ...context,
      globalState: {
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
      api: {
        ...context.api,
        hooks: {
          onBeforeAgentStart: mockOnBeforeAgentStart,
          onPiEvent: mockOnPiEvent,
          onBeforeSendMessage: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
          onBeforeToolCall: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
          onAfterToolResult: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
        },
      },
    } as unknown as PluginContext

    const { createGoalHooks } = await import('../../../resources/plugins/goal/src/goal-hooks.js')
    await createGoalHooks(hookContext)

    expect(hookHandlers).toHaveLength(1)
    const result = await hookHandlers[0]({})
    expect(result).toHaveProperty('proceed', true)
    expect(result).toHaveProperty('modifiedData')
    const modified = (result as { modifiedData: { injectedMessages: Array<{ role: string; content: string }> } }).modifiedData
    expect(modified.injectedMessages).toHaveLength(1)
    expect(modified.injectedMessages[0].content).toContain('Build feature X')
  })

  it('onBeforeAgentStart hook returns empty when no active goal', async () => {
    const hookHandlers: Array<(ctx: unknown) => Promise<unknown>> = []
    const mockOnBeforeAgentStart = vi.fn().mockImplementation(async (handler: (ctx: unknown) => Promise<unknown>) => {
      hookHandlers.push(handler)
      return { dispose: vi.fn() }
    })
    const mockOnPiEvent = vi.fn().mockResolvedValue({ dispose: vi.fn() })

    const hookContext = {
      ...context,
      globalState: {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        keys: vi.fn().mockResolvedValue([]),
      },
      api: {
        ...context.api,
        hooks: {
          onBeforeAgentStart: mockOnBeforeAgentStart,
          onPiEvent: mockOnPiEvent,
          onBeforeSendMessage: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
          onBeforeToolCall: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
          onAfterToolResult: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
        },
      },
    } as unknown as PluginContext

    const { createGoalHooks } = await import('../../../resources/plugins/goal/src/goal-hooks.js')
    await createGoalHooks(hookContext)

    const result = await hookHandlers[0]({})
    expect(result).toEqual({ proceed: true })
  })

  // ── 10. Sub-todo operations ──────────────────────────────────

  it('add_sub_todos adds sub-todos to a task', async () => {
    setState({
      goal: { goalId: 'test', goalDescription: 'Test goal' },
      tasks: [
        { id: 1, description: 'Main task', status: 'in_progress' },
      ],
      nextTaskId: 2,
      nextSubTodoId: 1,
      createdWithLabels: false,
      pendingMessage: null,
    })

    const { registerGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await registerGoalTool(context)

    const result = await callAction({
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
    setState({
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

    const { registerGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await registerGoalTool(context)

    const result = await callAction({
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
    setState({
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

    const { registerGoalTool } = await import('../../../resources/plugins/goal/src/goal-tool.js')
    await registerGoalTool(context)

    const result = await callAction({
      action: 'delete_sub_todos',
      taskId: 1,
      subIds: [2],
    })

    const parsed = JSON.parse(result.content)
    expect(parsed.tasks[0].subTodos).toHaveLength(1)
    expect(parsed.tasks[0].subTodos[0].subId).toBe(1)
  })
})
