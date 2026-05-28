/**
 * Goal 插件 — 入口
 *
 * 将 pi /goal extension 转换为 xyz-agent built-in plugin。
 * 注册 goal_manager 工具和 pi 事件钩子。
 */

import { createGoalTool } from './src/goal-tool.js'
import { createGoalHooks } from './src/goal-hooks.js'

export async function activate(context: any) {
  const api = context.api

  // 注册 goal_manager 工具
  const toolDisposable = await createGoalTool(api)
  context.subscriptions.push(toolDisposable)

  // 注册事件钩子
  const hookDisposables = createGoalHooks(api)
  for (const d of hookDisposables) {
    context.subscriptions.push(d)
  }
}

export async function deactivate() {
  // cleanup 由 context.subscriptions dispose 自动处理
}
