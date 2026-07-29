/**
 * Agent API 模块
 *
 * 提供 Agent 模型/思考级别查询的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerAgentRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.agent.setModel / getModel / getThinkingLevel / setThinkingLevel / getActiveTools
 *   五个 RPC 方法。
 *
 * Worker 侧：createAgentApi() 返回代理对象，通过 RPC 转发到主线程。
 *
 * setModel / setThinkingLevel 为 trusted 插件专属。sandbox 插件调用时
 * 返回 PERMISSION_DENIED（权限检查由 PluginService dispatch 层完成）。
 *
 * Phase 2 中 get/set 模型和思考级别为 stub 实现（返回/接受假数据）。
 * Phase 3 中对接 IPiEngine（pi 的 setModel 等）。
 *
 * P7 长期方案 A：registerAgentRpcHandlers 经 clientIdResolver 从 dispatch params 解析
 * clientId（优先 Worker 注入的显式 clientId，ALS 作 fallback），透传给 handler → resolver，
 * 与 sessions 域一致——绕开 ALS 跨独立 I/O tick 断裂。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'

/** Agent 服务依赖（主线程侧）。各方法接收当前调用的 clientId（P7 per-client resolve）。 */
export interface AgentHandlers {
  getModel(clientId?: string): string | Promise<string>
  setModel(model: string, clientId?: string): void | Promise<void>
  getThinkingLevel(clientId?: string): string | Promise<string>
  setThinkingLevel(level: string, clientId?: string): void | Promise<void>
  getActiveTools(clientId?: string): string[] | Promise<string[]>
}

/**
 * 从 dispatch params 解析 clientId 的契约（P7 长期方案 A）。
 * 优先 params 显式 clientId（Worker 注入），ALS 作 fallback。
 */
export type ClientIdResolver = (params: Record<string, unknown> | undefined) => string | undefined

export function registerAgentRpcHandlers(
  rpcServer: PluginRpcServer,
  deps: AgentHandlers,
  clientIdResolver?: ClientIdResolver,
): void {
  rpcServer.registerMethod('plugin.agent.setModel', async (params) => {
    const model = params.model as string
    await deps.setModel(model, clientIdResolver?.(params))
  })

  rpcServer.registerMethod('plugin.agent.getModel', async (params) => {
    return deps.getModel(clientIdResolver?.(params))
  })

  rpcServer.registerMethod('plugin.agent.getThinkingLevel', async (params) => {
    return deps.getThinkingLevel(clientIdResolver?.(params))
  })

  rpcServer.registerMethod('plugin.agent.setThinkingLevel', async (params) => {
    const level = params.level as string
    await deps.setThinkingLevel(level, clientIdResolver?.(params))
  })

  rpcServer.registerMethod('plugin.agent.getActiveTools', async (params) => {
    return deps.getActiveTools(clientIdResolver?.(params))
  })
}

export function createAgentApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  setModel(model: string): Promise<void>
  getModel(): Promise<string>
  getThinkingLevel(): Promise<string>
  setThinkingLevel(level: string): Promise<void>
  getActiveTools(): Promise<string[]>
} {
  return {
    setModel: (model: string) =>
      rpcClient.request('plugin.agent.setModel', { pluginId, model }).then(() => {}),

    getModel: () =>
      rpcClient.request('plugin.agent.getModel', { pluginId }).then(v => (v as string) ?? ''),

    getThinkingLevel: () =>
      rpcClient.request('plugin.agent.getThinkingLevel', { pluginId }).then(v => (v as string) ?? ''),

    setThinkingLevel: (level: string) =>
      rpcClient.request('plugin.agent.setThinkingLevel', { pluginId, level }).then(() => {}),

    getActiveTools: () =>
      rpcClient.request('plugin.agent.getActiveTools', { pluginId }).then(v => (v as string[]) ?? []),
  }
}
