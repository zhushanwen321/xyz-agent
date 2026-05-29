/**
 * Goal 插件 — 事件钩子
 *
 * 注册 pi 事件钩子：
 *   - onBeforeAgentStart: 注入 goal steering prompt（有活跃目标时）
 *   - agent_end: 清理 pendingMessage，更新状态
 */

import type { PluginContext } from '../../../../src-electron/runtime/src/services/plugin-service/plugin-types.js'
import type { GoalState } from './goal-state.js'
import { getIncompleteTasks, getCompletedCount } from './goal-state.js'

// Goal 状态存储在 globalState 中（跨 session 全局共享）
const GOAL_STATE_KEY = 'goal-state'

// ── 钩子注册 ────────────────────────────────────────────

export async function createGoalHooks(context: PluginContext): Promise<void> {
  const api = context.api
  const store = context.globalState

  // ── onBeforeAgentStart: 注入 steering prompt ──────────

  const onBeforeAgentStartDisposable = await api.hooks.onBeforeAgentStart(
    async () => {
      let state: GoalState | undefined
      try {
        state = (await store.get(GOAL_STATE_KEY)) as GoalState | undefined
      } catch {
        state = undefined
      }

      if (!state || !state.goal) {
        return { proceed: true } // 无活跃 goal，放行
      }

      // 先检查是否有 pendingMessage
      if (state.pendingMessage) {
        const msg = { ...state.pendingMessage }
        state.pendingMessage = null
        await store.set(GOAL_STATE_KEY, state)
        return {
          proceed: true,
          modifiedData: {
            injectedMessages: [msg],
          },
        }
      }

      // 构造常规 steering prompt
      const pending = getIncompleteTasks(state.tasks)
      const completed = getCompletedCount(state.tasks)
      const total = state.tasks.length

      let content = `<goal_context>\n`
      content += `[GOAL 模式已激活]\n\n`
      content += `<objective>\n${escapeXml(state.goal.goalDescription)}\n</objective>\n`
      content += `任务进度: ${completed}/${total}\n`
      if (pending.length > 0) {
        content += `剩余任务: ${pending.map(t => `#${t.id}: ${t.description}`).join('\n')}\n\n`
      }
      content += `严格规则:\n`
      content += `1. 第一步调用 goal_manager 的 create_tasks 拆分任务（如果尚未创建）\n`
      content += `2. 每完成一个任务用 update_tasks 设置状态为 completed 并提供 evidence\n`
      content += `3. 只有所有任务完成且有整体证据时才调用 complete_goal\n`
      content += `4. 遇到阻塞调用 report_blocked\n`
      content += `5. 用 add_sub_todos / update_sub_todos 追踪细粒度步骤\n`
      content += `</goal_context>`

      return {
        proceed: true,
        modifiedData: {
          injectedMessages: [
            {
              role: 'user',
              content,
              display: false,
            },
          ],
        },
      }
    },
  )
  context.subscriptions.push(onBeforeAgentStartDisposable)

  // ── agent_end: 清理 pendingMessage ────────────────────

  const onAgentEndDisposable = await api.hooks.onPiEvent(
    'agent_end',
    async () => {
      let state: GoalState | undefined
      try {
        state = (await store.get(GOAL_STATE_KEY)) as GoalState | undefined
      } catch {
        state = undefined
      }
      if (!state) return

      // 如果 goal 已取消/完成，清理 pendingMessage
      if (!state.goal) {
        state.pendingMessage = null
        await store.set(GOAL_STATE_KEY, state)
      }
    },
  )
  context.subscriptions.push(onAgentEndDisposable)
}

// ── Helpers ─────────────────────────────────────────────

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
