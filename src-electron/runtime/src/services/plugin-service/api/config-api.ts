/**
 * Config API 模块
 *
 * 提供插件配置读写的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerConfigRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.config.get / getAll / set 三个 RPC 方法。
 *
 * Worker 侧：createConfigApi() 返回代理对象，通过 RPC 转发到主线程。
 *
 * 配置存储使用 PluginStateStorage（与 plugin.storage.* 共享同一持久层）。
 * 为区分配置与通用存储，key 加入 'config:' 前缀。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'

/** Config 服务依赖（主线程侧） */
export interface ConfigHandlers {
  get(pluginId: string, key: string): Promise<unknown>
  getAll(pluginId: string): Promise<Record<string, unknown>>
  set(pluginId: string, key: string, value: unknown): Promise<void>
}

export function registerConfigRpcHandlers(
  rpcServer: PluginRpcServer,
  deps: ConfigHandlers,
): void {
  rpcServer.registerMethod('plugin.config.get', async (params) => {
    const pluginId = params.pluginId as string
    const key = params.key as string
    return deps.get(pluginId, key)
  })

  rpcServer.registerMethod('plugin.config.getAll', async (params) => {
    const pluginId = params.pluginId as string
    return deps.getAll(pluginId)
  })

  rpcServer.registerMethod('plugin.config.set', async (params) => {
    const pluginId = params.pluginId as string
    const key = params.key as string
    const value = params.value
    await deps.set(pluginId, key, value)
  })
}

export function createConfigApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  get(key: string): Promise<unknown>
  getAll(): Promise<Record<string, unknown>>
  set(key: string, value: unknown): Promise<void>
} {
  return {
    get: (key: string) =>
      rpcClient.request('plugin.config.get', { pluginId, key }),

    getAll: () =>
      rpcClient.request('plugin.config.getAll', { pluginId }).then(v => (v as Record<string, unknown>) ?? {}),

    set: (key: string, value: unknown) =>
      rpcClient.request('plugin.config.set', { pluginId, key, value }).then(() => {}),
  }
}
