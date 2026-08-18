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
 * setModel 经 modelService.switchModel 统一入口（persist + broadcast），
 * getModel / getThinkingLevel 读取 active session 的 modelId / thinkingLevel。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import { asBoundedString } from '../validation.js'

/**
 * model / thinkingLevel 标识符长度上限（UTF-8 字节）。
 * provider/modelId 复合串与枚举值均远小于此；上限防超长串进入
 * sessionService.switchModel 的 split/join 与缓存键。
 */
const AGENT_ID_MAX_BYTES = 512

/** Agent 服务依赖（主线程侧） */
export interface AgentHandlers {
  getModel(): string | Promise<string>
  setModel(model: string): void | Promise<void>
  getThinkingLevel(): string | Promise<string>
  setThinkingLevel(level: string): void | Promise<void>
  getActiveTools(): string[] | Promise<string[]>
}

export function registerAgentRpcHandlers(
  rpcServer: PluginRpcServer,
  deps: AgentHandlers,
): void {
  rpcServer.registerMethod('plugin.agent.setModel', async (params) => {
    // S3-W3 窄校验：model 非字符串/超长 → INVALID_MODEL，不进 switchModel
    const model = asBoundedString(params.model, 'model', AGENT_ID_MAX_BYTES)
    await deps.setModel(model)
  })

  rpcServer.registerMethod('plugin.agent.getModel', async () => {
    return deps.getModel()
  })

  rpcServer.registerMethod('plugin.agent.getThinkingLevel', async () => {
    return deps.getThinkingLevel()
  })

  rpcServer.registerMethod('plugin.agent.setThinkingLevel', async (params) => {
    const level = asBoundedString(params.level, 'level', AGENT_ID_MAX_BYTES)
    await deps.setThinkingLevel(level)
  })

  rpcServer.registerMethod('plugin.agent.getActiveTools', async () => {
    return deps.getActiveTools()
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
