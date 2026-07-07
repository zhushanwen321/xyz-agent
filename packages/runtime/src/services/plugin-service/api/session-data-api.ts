/**
 * SessionData API 模块
 *
 * 提供 per-session KV 存取的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerSessionDataRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.sessionData.get / set / delete / keys 四个 RPC 方法。
 *
 * Worker 侧：createSessionDataApi() 返回代理对象，通过 RPC 转发到主线程。
 *
 * 数据流（P0-1 C6 后）：
 *   set → SessionDataStore.set（容量检查 + 内存写 + dirty + debounce flush）
 *   get → SessionDataStore.get（内存读）
 *   delete → SessionDataStore.delete
 *   底层缓存 + dirty + size + flush 由 WriteBackCache 统一管理。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'

/** SessionData 服务依赖（主线程侧）——经 SessionDataStore 的 KV 方法操作。 */
export interface SessionDataHandlers {
  get(sessionId: string, key: string): unknown | undefined
  set(sessionId: string, key: string, value: unknown): void
  delete(sessionId: string, key: string): void
  keys(sessionId: string): string[]
}

export function registerSessionDataRpcHandlers(
  rpcServer: PluginRpcServer,
  deps: SessionDataHandlers,
): void {
  rpcServer.registerMethod('plugin.sessionData.get', async (params) => {
    return deps.get(params.sessionId as string, params.key as string)
  })

  rpcServer.registerMethod('plugin.sessionData.set', async (params) => {
    deps.set(params.sessionId as string, params.key as string, params.value)
  })

  rpcServer.registerMethod('plugin.sessionData.delete', async (params) => {
    deps.delete(params.sessionId as string, params.key as string)
  })

  rpcServer.registerMethod('plugin.sessionData.keys', async (params) => {
    return deps.keys(params.sessionId as string)
  })
}

export function createSessionDataApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  get(sessionId: string, key: string): Promise<unknown>
  set(sessionId: string, key: string, value: unknown): Promise<void>
  delete(sessionId: string, key: string): Promise<void>
  keys(sessionId: string): Promise<string[]>
} {
  return {
    get: (sessionId: string, key: string) =>
      rpcClient.request('plugin.sessionData.get', { pluginId, sessionId, key }),

    set: (sessionId: string, key: string, value: unknown) =>
      rpcClient.request('plugin.sessionData.set', { pluginId, sessionId, key, value }).then(() => {}),

    delete: (sessionId: string, key: string) =>
      rpcClient.request('plugin.sessionData.delete', { pluginId, sessionId, key }).then(() => {}),

    keys: (sessionId: string) =>
      rpcClient.request('plugin.sessionData.keys', { pluginId, sessionId }).then(v => (v as string[]) ?? []),
  }
}

