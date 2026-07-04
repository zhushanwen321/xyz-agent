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
 * 为区分配置与通用存储，key 加入 'config:' 前缀——该前缀约定（toConfigKey /
 * fromConfigKey / isConfigKey）在此导出，作为 config 域单一真相源（P7 收口）。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'

/**
 * 配置 key 前缀约定（P7 收口）。
 *
 * 配置与通用存储共享同一持久层（PluginStorage），为区分二者，配置 key 统一加
 * 'config:' 前缀。此前该约定在 plugin-service.ts 与 plugin-rpc-setup.ts 各自重复
 * 实现，现收口到 config-api（配置域的天然归属），两侧均委托此处。
 */
const CONFIG_KEY_PREFIX = 'config:'

/** 把用户态 key 加上 'config:' 前缀（存储层用） */
export function toConfigKey(key: string): string {
  return `${CONFIG_KEY_PREFIX}${key}`
}

/** 从带前缀的存储 key 还原用户态 key */
export function fromConfigKey(storedKey: string): string {
  return storedKey.replace(CONFIG_KEY_PREFIX, '')
}

/** 判断存储 key 是否属于配置（带 'config:' 前缀） */
export function isConfigKey(storedKey: string): boolean {
  return storedKey.startsWith(CONFIG_KEY_PREFIX)
}

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
