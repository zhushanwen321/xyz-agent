/**
 * tasks store 的纯函数读取/守卫（从 tasks.ts 提取，对齐 chat-readers.ts 范式）。
 *
 * 提取动机：isTodoItem 原本在 tasks.ts 和 chat-message-effects.ts 各有一份完全相同的实现。
 * 该纯函数无任何 store 依赖，提到独立文件供 store 与 effects 共享，消除重复。
 */
import type { TodoItem } from './tasks'

/** todo 项 status 的合法枚举值（对齐 todo extension model.ts Todo.status） */
const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const

/**
 * details.todos 元素类型守卫（容错：过滤掉非合法结构）。
 *
 * 用于过滤 pi tool result details.todos 中的非法项（结构不全 / status 非枚举值）。
 * tasks.hydrateFromToolCall（历史路恢复）与 chat-message-effects.routeToolResultToTasks
 * （实时路）共用。
 */
export function isTodoItem(v: unknown): v is TodoItem {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o['id'] === 'number' &&
    typeof o['text'] === 'string' &&
    typeof o['status'] === 'string' &&
    (TODO_STATUSES as readonly string[]).includes(o['status'] as string)
  )
}
