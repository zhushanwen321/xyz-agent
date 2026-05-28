/**
 * Goal 插件 — goal_manager 工具
 *
 * 注册 goal_manager 工具（10 个 action），通过 api.sessionData 持久化状态。
 */

import type {
  GoalState,
  GoalManagerParams,
  TaskItem,
  SubTodo,
  TaskStatus,
  SubTodoStatus,
} from './goal-state.js'
import type { Phase2AgentAPI } from '../../../../src-electron/runtime/src/services/plugin-service/plugin-types.js'
import {
  createInitialState,
  isTerminalTaskStatus,
  getCompletedCount,
  getIncompleteTasks,
  normalizeDescription,
  formatTaskList,
} from './goal-state.js'

// ── 工具注册 ────────────────────────────────────────────

export async function createGoalTool(api: Phase2AgentAPI): Promise<{ dispose(): void }> {
  return api.tools.register({
    name: 'goal_manager',
    description:
      '管理 /goal 模式的任务清单、完成状态和退出\n\n' +
      '可用 action:\n' +
      '- create_tasks: 首次拆分目标为任务清单（每个 goal 开始时调用一次）。每条 task description 必须是一行简短摘要（不超过 60 字），不要包含换行、markdown、详细参数\n' +
      '- add_tasks: 向已有任务清单追加新任务（执行中发现遗漏时使用）。每条 task description 必须是一行简短摘要（不超过 60 字），不要包含换行、markdown、详细参数\n' +
      '- update_tasks: 批量更新任务状态（completed 必须带 evidence，cancelled 不阻碍 goal 完成）\n' +
      '- list_tasks: 查看进度和剩余预算\n' +
      '- complete_goal: 标记目标达成（必须所有任务完成 + evidence）\n' +
      '- cancel_goal: 取消当前目标（用户要求退出/停止时使用）\n' +
      '- report_blocked: 报告阻塞（遇到无法解决的问题时使用）\n' +
      '- add_sub_todos: 给指定 task 添加 sub-todo（参数: taskId, texts[]）。Goal 模式下用此替代 todo 工具\n' +
      '- update_sub_todos: 批量更新 sub-todo 状态（参数: taskId, subUpdates[]）\n' +
      '- delete_sub_todos: 删除指定 task 的 sub-todo（参数: taskId, subIds[]）',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'create_tasks', 'add_tasks', 'update_tasks', 'list_tasks',
            'complete_goal', 'cancel_goal', 'report_blocked',
            'add_sub_todos', 'update_sub_todos', 'delete_sub_todos',
          ],
        },
        tasks: { type: 'array', items: { type: 'string' } },
        taskId: { type: 'number' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
        evidence: { type: 'string' },
        reason: { type: 'string' },
        subTodos: { type: 'array', items: { type: 'string' } },
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              taskId: { type: 'number' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
              evidence: { type: 'string' },
            },
            required: ['taskId', 'status'],
          },
        },
        subUpdates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              subId: { type: 'number' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['subId', 'status'],
          },
        },
        subIds: { type: 'array', items: { type: 'number' } },
        texts: { type: 'array', items: { type: 'string' } },
        cancelReason: { type: 'string' },
        actionLabels: { type: 'array', items: { type: 'string' } },
      },
      required: ['action'],
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi tool handler extra context is loosely typed
    handler: async (params: GoalManagerParams, extra: any) => {
      // 加载/初始化状态
      let state: GoalState
      try {
        // @ts-expect-error - pi sessionData.get accepts single-arg form for plugin-scoped keys
        state = (await api.sessionData.get('goal-state')) as GoalState | undefined
      } catch {
        state = undefined
      }
      if (!state) {
        state = createInitialState()
      }

      // 路由 action
      let resultText: string

      try {
        switch (params.action) {
          case 'create_tasks':
            resultText = handleCreateTasks(state, params)
            break
          case 'add_tasks':
            resultText = handleAddTasks(state, params)
            break
          case 'update_tasks':
            resultText = handleUpdateTasks(state, params)
            break
          case 'list_tasks':
            resultText = formatTaskList(state.tasks)
            break
          case 'complete_goal':
            resultText = handleCompleteGoal(state, params)
            break
          case 'cancel_goal':
            resultText = handleCancelGoal(state, params)
            break
          case 'report_blocked':
            resultText = handleReportBlocked(state, params)
            break
          case 'add_sub_todos':
            resultText = handleAddSubTodos(state, params)
            break
          case 'update_sub_todos':
            resultText = handleUpdateSubTodos(state, params)
            break
          case 'delete_sub_todos':
            resultText = handleDeleteSubTodos(state, params)
            break
          default:
            throw new Error(`未知 action: ${params.action}`)
        }
      } catch (err: unknown) {
        // 错误时也持久化（状态可能已部分修改）
        await api.sessionData.set('goal-state', state)
        throw new Error(`${err.message}\n\nInput: ${JSON.stringify(params, null, 2)}`)
      }

      // 持久化状态
      await api.sessionData.set('goal-state', state)

      // 构建返回
      const completed = getCompletedCount(state.tasks)
      const total = state.tasks.length
      return {
        content: JSON.stringify({
          result: resultText,
          summary: `${completed}/${total} 完成`,
          tasks: state.tasks.map(t => ({
            id: t.id,
            description: t.description,
            status: t.status,
            evidence: t.evidence,
            subTodos: t.subTodos,
          })),
          goal: state.goal,
        }),
      }
    },
  })
}

// ── Action Handlers ─────────────────────────────────────

function requireActiveGoal(state: GoalState): void {
  if (!state.goal) {
    throw new Error('Goal 模式未激活。请先使用 /goal <目标> 启动目标。')
  }
}

function handleCreateTasks(state: GoalState, params: GoalManagerParams): string {
  requireActiveGoal(state)
  if (!params.tasks || params.tasks.length === 0) {
    throw new Error('create_tasks 需要非空的 tasks 数组')
  }

  const existingIncomplete = getIncompleteTasks(state.tasks)
  if (state.tasks.length > 0 && existingIncomplete.length > 0) {
    throw new Error(
      `已有 ${state.tasks.length} 个任务（${existingIncomplete.length} 个未完成）。` +
      '如需追加任务请用 add_tasks，如需全部重新规划请先取消当前 goal。',
    )
  }

  let id = state.nextTaskId
  state.tasks = params.tasks.map(desc => ({
    id: id++,
    description: normalizeDescription(desc),
    status: 'pending' as TaskStatus,
  }))
  state.nextTaskId = id

  return (
    `已创建 ${state.tasks.length} 个任务：\n` +
    state.tasks.map(t => `  #${t.id}: ${t.description}`).join('\n')
  )
}

function handleAddTasks(state: GoalState, params: GoalManagerParams): string {
  requireActiveGoal(state)
  if (!params.tasks || params.tasks.length === 0) {
    throw new Error('add_tasks 需要非空的 tasks 数组')
  }

  let id = state.nextTaskId
  const newTasks: TaskItem[] = params.tasks.map(desc => ({
    id: id++,
    description: normalizeDescription(desc),
    status: 'pending' as TaskStatus,
  }))
  state.nextTaskId = id
  state.tasks.push(...newTasks)

  return (
    `已追加 ${newTasks.length} 个任务：\n` +
    newTasks.map(t => `  #${t.id}: ${t.description}`).join('\n')
  )
}

function handleUpdateTasks(state: GoalState, params: GoalManagerParams): string {
  requireActiveGoal(state)
  if (!params.updates || params.updates.length === 0) {
    throw new Error('update_tasks 需要非空的 updates 数组')
  }

  // 检查重复 taskId
  const taskIds = params.updates.map(u => u.taskId)
  const dupIds = taskIds.filter((id, i) => taskIds.indexOf(id) !== i)
  if (dupIds.length > 0) {
    throw new Error(`重复的 taskId: ${[...new Set(dupIds)].join(', ')}`)
  }

  for (const u of params.updates) {
    const task = state.tasks.find(t => t.id === u.taskId)
    if (!task) throw new Error(`Task #${u.taskId} 不存在`)
    if (isTerminalTaskStatus(task.status)) {
      throw new Error(`Task #${task.id} 已处于终态 (${task.status})，不可变更`)
    }
    if (u.status === 'completed' && (!u.evidence || u.evidence.trim() === '')) {
      throw new Error(`Task #${task.id}: completed 必须提供 evidence`)
    }
  }

  const results: string[] = []
  for (const u of params.updates) {
    const task = state.tasks.find(t => t.id === u.taskId)!
    const prev = task.status
    if (u.status === 'completed') {
      task.status = 'completed'
      task.evidence = u.evidence
      results.push(`#${task.id}: ${prev} → completed (${u.evidence})`)
    } else {
      task.status = u.status as TaskStatus
      results.push(`#${task.id}: ${prev} → ${u.status}`)
    }
  }

  return `已更新 ${results.length} 个任务：\n${results.join('\n')}`
}

function handleCompleteGoal(state: GoalState, params: GoalManagerParams): string {
  requireActiveGoal(state)
  if (!params.evidence || params.evidence.trim() === '') {
    throw new Error('complete_goal 需要 evidence — 提供具体的证据证明目标已达成')
  }
  if (state.tasks.length === 0) {
    throw new Error('请先使用 create_tasks 创建任务清单，再完成目标。')
  }

  const incomplete = getIncompleteTasks(state.tasks)
  if (incomplete.length > 0) {
    throw new Error(
      `还有 ${incomplete.length} 个任务未完成：${incomplete.map(t => `#${t.id}`).join(', ')}。` +
      '请先完成这些任务或提供理由说明为什么它们不需要完成。',
    )
  }

  const completed = getCompletedCount(state.tasks)
  if (completed === 0) {
    throw new Error('至少需要完成一个任务才能完成目标。全部取消不算达成。')
  }

  state.goal = null
  state.pendingMessage = null

  return (
    `目标已完成！\n证据: ${params.evidence}\n\n` +
    `任务完成: ${completed}/${state.tasks.length}`
  )
}

function handleCancelGoal(state: GoalState, params: GoalManagerParams): string {
  requireActiveGoal(state)
  const reason = params.cancelReason ?? '用户要求取消'
  state.goal = null
  state.tasks = []
  state.nextTaskId = 1
  state.nextSubTodoId = 1
  state.pendingMessage = null
  return `Goal 已取消: ${reason}`
}

function handleReportBlocked(state: GoalState, params: GoalManagerParams): string {
  requireActiveGoal(state)
  if (!params.reason || params.reason.trim() === '') {
    throw new Error('report_blocked 需要 reason — 说明阻塞原因')
  }
  return `已报告阻塞。原因: ${params.reason}`
}

function handleAddSubTodos(state: GoalState, params: GoalManagerParams): string {
  requireActiveGoal(state)
  if (params.taskId === undefined) {
    throw new Error('add_sub_todos 需要 taskId')
  }
  if (!params.texts || params.texts.length === 0) {
    throw new Error('add_sub_todos 需要非空的 texts 数组')
  }

  const task = state.tasks.find(t => t.id === params.taskId)
  if (!task) throw new Error(`Task #${params.taskId} 不存在`)
  if (isTerminalTaskStatus(task.status)) {
    throw new Error(`Task #${task.id} 已处于终态 (${task.status})，不能添加 sub-todo`)
  }

  const subTodos = task.subTodos ?? []
  const trimmed = params.texts.map(t => t.trim()).filter(t => t.length > 0)
  if (trimmed.length === 0) {
    throw new Error('texts 中至少需要一个非空字符串')
  }

  let sid = state.nextSubTodoId
  const newSubTodos: SubTodo[] = trimmed.map(text => ({
    subId: sid++,
    text,
    status: 'pending' as SubTodoStatus,
  }))
  state.nextSubTodoId = sid
  task.subTodos = [...subTodos, ...newSubTodos]

  return (
    `已给 Task #${task.id} 添加 ${newSubTodos.length} 项 sub-todo：\n` +
    newSubTodos.map(s => `  - #${task.id}.${s.subId}: ${s.text}`).join('\n')
  )
}

function handleUpdateSubTodos(state: GoalState, params: GoalManagerParams): string {
  requireActiveGoal(state)
  if (params.taskId === undefined) {
    throw new Error('update_sub_todos 需要 taskId')
  }
  if (!params.subUpdates || params.subUpdates.length === 0) {
    throw new Error('update_sub_todos 需要非空的 subUpdates 数组')
  }

  const task = state.tasks.find(t => t.id === params.taskId)
  if (!task) throw new Error(`Task #${params.taskId} 不存在`)
  if (!task.subTodos || task.subTodos.length === 0) {
    throw new Error(`Task #${params.taskId} 没有 sub-todo`)
  }

  const results: string[] = []
  for (const u of params.subUpdates) {
    const sub = task.subTodos.find(s => s.subId === u.subId)
    if (!sub) throw new Error(`Sub-todo #${params.taskId}.${u.subId} 不存在`)
    if (sub.status === 'completed') {
      throw new Error(`Sub-todo #${params.taskId}.${sub.subId} 已完成，不可变更`)
    }
    const prev = sub.status
    sub.status = u.status as SubTodoStatus
    results.push(`#${params.taskId}.${sub.subId}: ${prev} → ${u.status}`)
  }

  return `已更新 ${results.length} 项 sub-todo：\n${results.join('\n')}`
}

function handleDeleteSubTodos(state: GoalState, params: GoalManagerParams): string {
  requireActiveGoal(state)
  if (params.taskId === undefined) {
    throw new Error('delete_sub_todos 需要 taskId')
  }
  if (!params.subIds || params.subIds.length === 0) {
    throw new Error('delete_sub_todos 需要非空的 subIds 数组')
  }

  const task = state.tasks.find(t => t.id === params.taskId)
  if (!task) throw new Error(`Task #${params.taskId} 不存在`)
  if (!task.subTodos || task.subTodos.length === 0) {
    throw new Error(`Task #${params.taskId} 没有 sub-todo`)
  }

  const uniqueIds = [...new Set(params.subIds)]
  const missing = uniqueIds.filter(id => !task.subTodos!.some(s => s.subId === id))
  if (missing.length > 0) {
    throw new Error(
      `Sub-todo ${missing.map(id => `#${params.taskId}.${id}`).join(', ')} 不存在`,
    )
  }

  task.subTodos = task.subTodos.filter(s => !uniqueIds.includes(s.subId))
  if (task.subTodos.length === 0) {
    task.subTodos = undefined
  }

  return (
    `已删除 ${uniqueIds.length} 项 sub-todo，Task #${params.taskId} 剩余 ` +
    `${task.subTodos?.length ?? 0} 项`
  )
}
