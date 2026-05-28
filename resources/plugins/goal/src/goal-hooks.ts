/**
 * Goal 插件 — 事件钩子
 *
 * 注册 pi 事件钩子：
 *   - onBeforeAgentStart: 注入 goal steering prompt（有活跃目标时）
 *   - agent_end: 清理 pendingMessage，更新状态
 */

import type { GoalState } from './goal-state.js'
import { getIncompleteTasks, getCompletedCount } from './goal-state.js'
import type { Phase2AgentAPI } from '../../../../src-electron/runtime/src/services/plugin-service/plugin-types.js'

// ── 钩子注册 ────────────────────────────────────────────

export function createGoalHooks(api: Phase2AgentAPI): Array<{ dispose(): void }> {
  const disposables: Array<{ dispose(): void }> = []

  // ── onBeforeAgentStart: 注入 steering prompt ──────────

  disposables.push(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    api.hooks.onBeforeAgentStart(async (_ctx) => {
      let state: GoalState | undefined
      try {
        // @ts-expect-error - pi sessionData.get accepts single-arg form for plugin-scoped keys
        state = (await api.sessionData.get('goal-state')) as GoalState | undefined
      } catch {
        state = undefined
      }

      if (!state || !state.goal) {
        return {} // 无活跃 goal，不注入
      }

      // 先检查是否有 pendingMessage
      if (state.pendingMessage) {
        const msg = { ...state.pendingMessage }
        state.pendingMessage = null
        await api.sessionData.set('goal-state', state)
        return {
          injectedMessages: [msg],
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
        injectedMessages: [
          {
            role: 'user',
            content,
            display: false,
          },
        ],
      }
    }),
  )

  // ── agent_end: 清理 pendingMessage ────────────────────

  disposables.push(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    api.hooks.onPiEvent('agent_end', async (_data) => {
      let state: GoalState | undefined
      try {
        // @ts-expect-error - pi sessionData.get accepts single-arg form for plugin-scoped keys
        state = (await api.sessionData.get('goal-state')) as GoalState | undefined
      } catch {
        state = undefined
      }
      if (!state) return

      // 如果 goal 已取消/完成，清理 pendingMessage
      if (!state.goal) {
        state.pendingMessage = null
        await api.sessionData.set('goal-state', state)
      }
    }),
  )

  return disposables
}

// ── Helpers ─────────────────────────────────────────────

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
