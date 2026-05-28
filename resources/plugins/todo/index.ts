import type { PluginContext } from '../../../src-electron/runtime/src/services/plugin-service/plugin-types.js'
import { registerTodoTool, restoreTodoState } from './src/todo-tool.js'

export async function activate(context: PluginContext): Promise<void> {
  const { api } = context

  // 1. 注册 todo tool
  await registerTodoTool(api)

  // 2. 监听 session_start 事件，恢复 todo 状态
  const sessionStartDisposable = await api.hooks.onPiEvent('session_start', async (_eventName, data) => {
    const sessionId = extractSessionId(data)
    if (sessionId) {
      await restoreTodoState(api, sessionId)
    }
  })
  context.subscriptions.push(sessionStartDisposable)
}

function extractSessionId(data: unknown): string | undefined {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (typeof obj.sessionId === 'string') return obj.sessionId
    if (typeof obj.id === 'string') return obj.id
  }
  return undefined
}
