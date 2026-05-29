/**
 * Tool API 模块
 *
 * 提供 Tool 注册/注销的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerToolRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.tools.register / plugin.tools.unregister 两个 RPC 方法。
 *
 * Worker 侧：createToolApi() 返回代理对象，通过 RPC 转发到主线程。
 */

import type { PluginRpcServer } from './plugin-rpc-server.js'
import type { PluginRpcClient } from './plugin-rpc-client.js'
import type { ToolRegistration, ToolEntry } from './plugin-types.js'
import { PluginRpcErrorCodes } from './plugin-types.js'
/** Tool 注册服务依赖（主线程侧） */
export interface ToolService {
  /** 工具注册表，key 为 toolKey */
  toolRegistry: Map<string, ToolEntry>
  /** 工具变更后同步到 bridge 层 */
  syncToolsToBridge: () => Promise<void>
}

/**
 * 在 PluginRpcServer 上注册 tool 相关的 RPC handler。
 *
 * 注册的方法：
 * - `plugin.tools.register` — 注册工具，返回 toolKey
 * - `plugin.tools.unregister` — 注销工具，不存在的 key 静默成功
 */
export function registerToolRpcHandlers(
  rpcServer: PluginRpcServer,
  service: ToolService,
): void {
  rpcServer.registerMethod('plugin.tools.register', async (params) => {
    const pluginId = params.pluginId as string
    const name = params.name as string
    const description = (params.description as string) ?? ''
    const parameters = (params.parameters as Record<string, unknown>) ?? {}

    const toolKey = `${pluginId}:${name}`

    // 验证 name 不重复
    if (service.toolRegistry.has(toolKey)) {
      throw Object.assign(
        new Error(`Tool already registered: ${toolKey}`),
        { code: PluginRpcErrorCodes.INTERNAL_ERROR },
      )
    }

    // 存储到注册表
    service.toolRegistry.set(toolKey, {
      pluginId,
      handlerId: toolKey,
      schema: { name, description, parameters },
    })

    // 同步到 bridge
    await service.syncToolsToBridge()

    return toolKey
  })

  rpcServer.registerMethod('plugin.tools.unregister', async (params) => {
    const toolKey = params.toolKey as string
    if (service.toolRegistry.has(toolKey)) {
      service.toolRegistry.delete(toolKey)
      await service.syncToolsToBridge()
    }
  })
}

/**
 * 创建 Worker 侧 Tool API 代理对象。
 *
 * 代理对象通过 RPC 转发 tool 注册/注销请求到主线程。
 */
export function createToolApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  register(registration: ToolRegistration): Promise<string>
  unregister(toolKey: string): Promise<void>
} {
  return {
    /**
     * 注册工具，返回 toolKey。
     * toolKey 格式: `${pluginId}:${name}`
     */
    register: async (registration: ToolRegistration): Promise<string> => {
      const toolKey = `${pluginId}:${registration.name}`
      if (registration.execute) {
        const { registerToolHandler: rth } = await import('./plugin-bootstrap.js')
        rth(toolKey, registration.execute)
      }
      return rpcClient.request('plugin.tools.register', {
        pluginId,
        name: registration.name,
        description: registration.description,
        parameters: registration.parameters,
      }) as Promise<string>
    },

    /**
     * 注销工具。不存在的 toolKey 静默成功。
     */
    unregister: (toolKey: string): Promise<void> =>
      rpcClient
        .request('plugin.tools.unregister', { pluginId, toolKey })
        .then(() => {}),
  }
}
