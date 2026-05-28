/**
 * Goal 插件 — 数据模型与状态管理
 *
 * 状态结构：
 *   - goal: 当前目标（null 表示无活跃目标）
 *   - tasks: 任务清单
 *   - nextTaskId / nextSubTodoId: 自增 ID 生成器
 *   - pendingMessage: 待注入的 steering prompt（onBeforeAgentStart 消费）
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type SubTodoStatus = 'pending' | 'in_progress' | 'completed'
export type GoalStatus = 'active' | 'complete' | 'cancelled' | 'blocked'

export const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'] as const
export const SUB_TODO_STATUSES: readonly SubTodoStatus[] = ['pending', 'in_progress', 'completed'] as const

// ── Interfaces ──────────────────────────────────────────

export interface SubTodo {
  subId: number
  text: string
  status: SubTodoStatus
}

export interface TaskItem {
  id: number
  description: string
  status: TaskStatus
  evidence?: string
  reason?: string
  cancelReason?: string
  subTodos?: SubTodo[]
}

export interface GoalInfo {
  goalId: string
  goalDescription: string
}

export interface GoalState {
  goal: GoalInfo | null
  tasks: TaskItem[]
  nextTaskId: number
  nextSubTodoId: number
  createdWithLabels: boolean
  // 待注入的 steering 消息
  pendingMessage?: PendingMessage | null
}

export interface PendingMessage {
  role: 'user'
  content: string
  display: boolean
}

export interface GoalManagerParams {
  action: string
  tasks?: string[]
  taskId?: number
  status?: string
  evidence?: string
  reason?: string
  subTodos?: string[]
  updates?: Array<{ taskId: number; status: string; evidence?: string }>
  subUpdates?: Array<{ subId: number; status: string }>
  subIds?: number[]
  texts?: string[]
  cancelReason?: string
  actionLabels?: string[]
}

// ── Helpers ─────────────────────────────────────────────

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'cancelled'
}

export function getCompletedCount(tasks: TaskItem[]): number {
  return tasks.filter(t => t.status === 'completed').length
}

export function getIncompleteTasks(tasks: TaskItem[]): TaskItem[] {
  return tasks.filter(t => !isTerminalTaskStatus(t.status))
}

/** 标准化 task description：去换行、截断 */
export function normalizeDescription(desc: string): string {
  const singleLine = desc.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  const ELLIPSIS = 3
  const MAX_LENGTH = 80
  if (singleLine.length > MAX_LENGTH) {
    return singleLine.slice(0, MAX_LENGTH - ELLIPSIS) + '...'
  }
  return singleLine
}

/** 创建空的初始状态 */
export function createInitialState(): GoalState {
  return {
    goal: null,
    tasks: [],
    nextTaskId: 1,
    nextSubTodoId: 1,
    createdWithLabels: false,
    pendingMessage: null,
  }
}

/** 格式化任务列表为文本 */
export function formatTaskList(tasks: TaskItem[]): string {
  if (tasks.length === 0) return '暂无任务。'
  const completed = tasks.filter(t => t.status === 'completed')
  const active = tasks.filter(t => t.status === 'in_progress' || t.status === 'pending')
  const cancelled = tasks.filter(t => t.status === 'cancelled')
  const lines: string[] = []

  if (active.length > 0) {
    lines.push(`进行中/待执行 (${active.length}):`)
    for (const t of active) {
      const icon = t.status === 'in_progress' ? '●' : '☐'
      lines.push(`  ${icon} #${t.id}: ${t.description}`)
      if (t.subTodos && t.subTodos.length > 0) {
        for (const s of t.subTodos) {
          const sIcon = s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '●' : '○'
          lines.push(`    ${sIcon} #${t.id}.${s.subId}: ${s.text}`)
        }
      }
    }
  }

  if (completed.length > 0) {
    lines.push(`已完成 (${completed.length}):`)
    for (const t of completed) {
      const evidence = t.evidence ? ` — ${t.evidence}` : ''
      lines.push(`  ✓ #${t.id}: ${t.description}${evidence}`)
    }
  }

  if (cancelled.length > 0) {
    lines.push(`已取消 (${cancelled.length}):`)
    for (const t of cancelled) {
      lines.push(`  ✗ #${t.id}: ${t.description}`)
    }
  }

  const summary = `${completed.length}/${tasks.length} 完成` +
    (cancelled.length > 0 ? `, ${cancelled.length} 已取消` : '')
  lines.push(summary)
  return lines.join('\n')
}
