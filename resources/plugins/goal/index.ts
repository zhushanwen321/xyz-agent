/**
 * Goal 插件 — 入口
 *
 * 将 pi /goal extension 转换为 xyz-agent built-in plugin。
 * 注册 goal_manager 工具 schema 和 pi 事件钩子。
 *
 * 状态通过 context.globalState 持久化（跨 session 全局共享）。
 * Tool execution handler 需由 Worker 侧 tool execution 基础设施调用。
 */

import type { PluginContext } from '../../../src-electron/runtime/src/services/plugin-service/plugin-types.js'
import { registerGoalTool, executeGoalAction } from './src/goal-tool.js'
import { createGoalHooks } from './src/goal-hooks.js'

export async function activate(context: PluginContext) {
  // 注册 goal_manager 工具 schema
  await registerGoalTool(context)

  // 注册事件钩子
  await createGoalHooks(context)
}

export async function deactivate() {
  // cleanup 由 context.subscriptions dispose 自动处理
}

// 导出 tool execution handler 供 Worker 侧 tool execution 基础设施调用
export { executeGoalAction }
