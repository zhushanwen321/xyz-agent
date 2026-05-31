import type { TodoState, TodoItem } from './todo-state.js'
import type { Phase2AgentAPI, ToolRegistration } from '../../../../src-electron/runtime/src/services/plugin-service/plugin-types.js'

const VALID_STATUSES: readonly TodoItem['status'][] = ['pending', 'in_progress', 'completed'] as const

const SESSION_DATA_KEY = 'todo-state'

const VALID_ACTIONS = ['list', 'add', 'update', 'delete', 'clear'] as const
type TodoAction = (typeof VALID_ACTIONS)[number]

const toolSchema: ToolRegistration = {
  name: 'todo',
  description:
    '管理 todo 清单。\n\n' +
    '可用 action：\n' +
    '- list：查看所有 todo\n' +
    '- add：批量添加 todo（需要 texts 数组）\n' +
    '- update：更新 todo（需要 id，可选 status/text）\n' +
    '- delete：批量删除 todo（需要 ids 数组）\n' +
    '- clear：清空所有 todo 并重置 ID',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: VALID_ACTIONS,
        description: '要执行的操作',
      },
      text: {
        type: 'string',
        description: 'Todo 文本（update 时使用）',
      },
      id: {
        type: 'number',
        description: 'Todo ID（update 时使用）',
      },
      texts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Todo 文本列表（add 时使用）',
      },
      ids: {
        type: 'array',
        items: { type: 'number' },
        description: 'Todo ID 列表（delete 时使用）',
      },
      status: {
        type: 'string',
        enum: VALID_STATUSES,
        description: '目标状态（update 时使用）',
      },
    },
    required: ['action'],
  },
}

/** 创建空状态 */
function createEmptyState(): TodoState {
  return { todos: [], nextId: 1 }
}

/** 从 sessionData 加载状态 */
async function loadState(api: Phase2AgentAPI, sessionId: string): Promise<TodoState> {
  const raw = await api.sessionData.get(sessionId, SESSION_DATA_KEY)
  if (raw && typeof raw === 'object' && Array.isArray((raw as TodoState).todos)) {
    return raw as TodoState
  }
  return createEmptyState()
}

/** 保存状态到 sessionData */
async function saveState(api: Phase2AgentAPI, sessionId: string, state: TodoState): Promise<void> {
  await api.sessionData.set(sessionId, SESSION_DATA_KEY, state)
}

/**
 * todo action 执行函数。
 * 由 tool execution handler 调用（当前 bridge tool 执行路由为 stub，预留此函数供后续集成）。
 */
export async function executeTodoAction(
  api: Phase2AgentAPI,
  sessionId: string,
  params: {
    action: TodoAction
    text?: string
    id?: number
    texts?: string[]
    ids?: number[]
    status?: TodoItem['status']
  },
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const state = await loadState(api, sessionId)
  const { todos, nextId } = state
  let resultText = ''

  switch (params.action) {
    case 'list': {
      resultText = todos.length
        ? todos
          .map((t) => {
            const mark =
                t.status === 'completed'
                  ? 'x'
                  : t.status === 'in_progress'
                    ? '~'
                    : ' '
            return `[${mark}] #${t.id}: ${t.text}`
          })
          .join('\n')
        : '暂无 todo'
      break
    }

    case 'add': {
      if (!params.texts || params.texts.length === 0) {
        return { content: [{ type: 'text', text: '错误：add 需要 texts 参数（非空数组）' }] }
      }
      const trimmed = params.texts.map((t) => t.trim()).filter((t) => t.length > 0)
      if (trimmed.length === 0) {
        return { content: [{ type: 'text', text: '错误：texts 中至少需要一个非空字符串' }] }
      }
      let currentId = nextId
      for (const t of trimmed) {
        todos.push({ id: currentId++, text: t, status: 'pending' })
      }
      state.nextId = currentId
      resultText = `已添加 ${trimmed.length} 项 todo (#${nextId}-#${currentId - 1})`
      break
    }

    case 'update': {
      if (params.id === undefined) {
        return { content: [{ type: 'text', text: '错误：update 需要 id 参数' }] }
      }
      if (params.status === undefined && params.text === undefined) {
        return { content: [{ type: 'text', text: '错误：update 至少需要 status 或 text 参数' }] }
      }
      if (params.text !== undefined && params.text === '') {
        return { content: [{ type: 'text', text: '错误：text 不能为空字符串' }] }
      }
      if (
        params.status !== undefined &&
        !VALID_STATUSES.includes(params.status)
      ) {
        return {
          content: [
            {
              type: 'text',
              text: `错误：status 只接受 ${VALID_STATUSES.join(' / ')}`,
            },
          ],
        }
      }

      const todo = todos.find((t) => t.id === params.id)
      if (!todo) {
        return { content: [{ type: 'text', text: `Todo #${params.id} 不存在` }] }
      }

      // 完成引导：判断是否是最后一个 pending 即将完成
      const incompleteBefore = todos.filter((t) => t.status !== 'completed')
      const isLastCompletion =
        params.status === 'completed' &&
        incompleteBefore.length === 1 &&
        incompleteBefore[0].id === todo.id

      if (params.status !== undefined) {
        (todo.status as TodoItem['status']) = params.status
      }
      if (params.text !== undefined) {
        todo.text = params.text
      }

      const parts: string[] = [`已更新 todo #${todo.id}`]
      if (params.status !== undefined) parts.push(`状态 → ${params.status}`)
      if (params.text !== undefined) parts.push(`文本 → "${todo.text}"`)
      resultText = parts.join('，')

      if (isLastCompletion) {
        resultText += '\n\n所有 todo 已完成。请总结工作成果。'
      }
      break
    }

    case 'delete': {
      if (!params.ids || params.ids.length === 0) {
        return { content: [{ type: 'text', text: '错误：delete 需要 ids 参数（非空数组）' }] }
      }
      const uniqueIds = [...new Set(params.ids)]
      const missing = uniqueIds.filter((id) => !todos.some((t) => t.id === id))
      if (missing.length > 0) {
        const missingStr = missing.map((id) => `#${id}`).join(', ')
        return { content: [{ type: 'text', text: `错误：Todo ${missingStr} 不存在` }] }
      }

      let removedCount = 0
      for (const id of uniqueIds) {
        const idx = todos.findIndex((t) => t.id === id)
        if (idx !== -1) {
          todos.splice(idx, 1)
          removedCount++
        }
      }
      resultText = `已删除 ${removedCount} 项 (#${uniqueIds.join(', #')})，剩余 ${todos.length} 项`
      break
    }

    case 'clear': {
      const count = todos.length
      state.todos = []
      state.nextId = 1
      resultText = count > 0 ? `已清空 ${count} 项 todo` : '暂无 todo，无需清空'
      break
    }

    default:
      return { content: [{ type: 'text', text: `未知 action: ${params.action}` }] }
  }

  // 持久化
  await saveState(api, sessionId, state)

  return { content: [{ type: 'text', text: resultText }] }
}

/**
 * 注册 todo tool 到 plugin API。
 */
export async function registerTodoTool(api: Phase2AgentAPI): Promise<void> {
  await api.tools.register(toolSchema)
}

/**
 * 从 sessionData 恢复 todo 状态。
 * 在 session_start 事件中调用。
 */
export async function restoreTodoState(
  api: Phase2AgentAPI,
  sessionId: string,
): Promise<TodoState> {
  return loadState(api, sessionId)
}
