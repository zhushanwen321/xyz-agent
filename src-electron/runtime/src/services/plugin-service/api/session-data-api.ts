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
 *   set → 容量检查 → 更新内存缓存 → 标记 dirty → 更新 size
 *        → 不等待 bridge flush（由定时器批量刷新）
 *   get → 直接从内存缓存读取
 *   delete → 更新 size → 移除 dirty → 从缓存删除
 *
 * 内存缓存作为快速读取层，定时 flush 将 dirty entries 批量持久化到 bridge。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import { PluginRpcErrorCodes } from '../plugin-types.js'

const BYTES_PER_KB = 1024
const MB = BYTES_PER_KB * BYTES_PER_KB
const TEN = 10
const DEFAULT_MAX_SESSION_DATA_BYTES = TEN * MB // 10MB

/** SessionData 服务依赖（主线程侧） */
export interface SessionDataHandlers {
  /** 获取内存缓存 (sessionId → key → value) */
  getCache(): Map<string, Map<string, unknown>>
  /** 获取 dirty 跟踪器 (sessionId → dirty keys) */
  getDirty(): Map<string, Set<string>>
  /** 获取 size 跟踪器 (sessionId → 字节数) */
  getSizeTracker(): Map<string, number>
  /**
   * 通过 bridge 持久化 sessionData（保留接口兼容，set 不再直接调用）。
   */
  appendEntry(sessionId: string, key: string, value: unknown): Promise<void>
  /** 单 session 最大字节数，默认 10MB */
  maxSizeBytes?: number
}

export function registerSessionDataRpcHandlers(
  rpcServer: PluginRpcServer,
  deps: SessionDataHandlers,
): void {
  const maxSize = deps.maxSizeBytes ?? DEFAULT_MAX_SESSION_DATA_BYTES

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

    const cache = deps.getCache()
    const dirty = deps.getDirty()
    const sizeTracker = deps.getSizeTracker()

    // 1. 容量检查：计算新值大小和增量
    const newSerialized = JSON.stringify(value)
    const newSize = newSerialized.length

    const oldSessionCache = cache.get(sessionId)
    const oldValue = oldSessionCache?.get(key)
    const oldSize = oldValue !== undefined ? JSON.stringify(oldValue).length : 0
    const delta = newSize - oldSize
    const currentTotal = sizeTracker.get(sessionId) ?? 0
    const newTotal = currentTotal + delta

    if (newTotal > maxSize) {
      const err = new Error(`Session data storage full for session ${sessionId} (${newTotal} > ${maxSize} bytes)`)
      ;(err as { code?: number }).code = PluginRpcErrorCodes.STORAGE_FULL
      throw err
    }

    // 2. 更新内存缓存
    let sessionCache = cache.get(sessionId)
    if (!sessionCache) {
      sessionCache = new Map()
      cache.set(sessionId, sessionCache)
    }
    sessionCache.set(key, value)

    // 3. 标记 dirty
    let dirtyKeys = dirty.get(sessionId)
    if (!dirtyKeys) {
      dirtyKeys = new Set()
      dirty.set(sessionId, dirtyKeys)
    }
    dirtyKeys.add(key)

    // 4. 更新 size
    sizeTracker.set(sessionId, newTotal)
  })

  rpcServer.registerMethod('plugin.sessionData.delete', async (params) => {
    const sessionId = params.sessionId as string
    const key = params.key as string
    const cache = deps.getCache()
    const dirty = deps.getDirty()
    const sizeTracker = deps.getSizeTracker()
    const sessionCache = cache.get(sessionId)

    if (sessionCache) {
      // 更新 size：减去被删除值的大小
      const oldValue = sessionCache.get(key)
      if (oldValue !== undefined) {
        const oldSize = JSON.stringify(oldValue).length
        const currentTotal = sizeTracker.get(sessionId) ?? 0
        sizeTracker.set(sessionId, Math.max(0, currentTotal - oldSize))
      }

      // 从 dirty 中移除（不再需要 flush 已删除的 key）
      const dirtyKeys = dirty.get(sessionId)
      if (dirtyKeys) {
        dirtyKeys.delete(key)
      }

      // 从缓存中删除
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
