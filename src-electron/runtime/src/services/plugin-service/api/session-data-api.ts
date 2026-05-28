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
 * 数据流：
 *   set → 更新内存缓存 Map<sessionId, Map<key, value>>
 *        → 向 sidecar 发 extension_ui_request（bridge:append_entry）持久化
 *   get → 直接从内存缓存读取
 *
 * 内存缓存作为快速读取层，bridge:append_entry 异步持久化到 pi session 文件。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'

/** SessionData 服务依赖（主线程侧） */
export interface SessionDataHandlers {
  /** 获取内存缓存 (sessionId → key → value) */
  getCache(): Map<string, Map<string, unknown>>
  /**
   * 通过 bridge 持久化 sessionData。
   * 发 extension_ui_request({ method: 'bridge:append_entry', ... })
   * Phase 2 中可以是 stub（不报错即可）。
   */
  appendEntry(sessionId: string, key: string, value: unknown): Promise<void>
}

export function registerSessionDataRpcHandlers(
  rpcServer: PluginRpcServer,
  deps: SessionDataHandlers,
): void {
  rpcServer.registerMethod('plugin.sessionData.get', async (params) => {
    const sessionId = params.sessionId as string
    const key = params.key as string
    const cache = deps.getCache()
    const sessionCache = cache.get(sessionId)
    return sessionCache?.get(key)
  })

  rpcServer.registerMethod('plugin.sessionData.set', async (params) => {
    const sessionId = params.sessionId as string
    const key = params.key as string
    const value = params.value

    // 1. 更新内存缓存
    const cache = deps.getCache()
    let sessionCache = cache.get(sessionId)
    if (!sessionCache) {
      sessionCache = new Map()
      cache.set(sessionId, sessionCache)
    }
    sessionCache.set(key, value)

    // 2. 通过 bridge 持久化（异步，不等待）
    deps.appendEntry(sessionId, key, value).catch(() => {
      // bridge 未就绪时静默失败（缓存已更新）
    })
  })

  rpcServer.registerMethod('plugin.sessionData.delete', async (params) => {
    const sessionId = params.sessionId as string
    const key = params.key as string
    const cache = deps.getCache()
    const sessionCache = cache.get(sessionId)
    if (sessionCache) {
      sessionCache.delete(key)
      if (sessionCache.size === 0) {
        cache.delete(sessionId)
      }
    }
  })

  rpcServer.registerMethod('plugin.sessionData.keys', async (params) => {
    const sessionId = params.sessionId as string
    const cache = deps.getCache()
    const sessionCache = cache.get(sessionId)
    if (!sessionCache) return []
    return [...sessionCache.keys()]
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
