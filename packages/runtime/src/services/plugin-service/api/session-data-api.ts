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
 *
 * [SEC-A5 路径注入防御] sessionId 会 join 进持久化文件名（${sessionId}.json），
 * 此前 `params.sessionId as string` 零校验，`../../` 可越出数据目录。
 * 现全部 RPC 方法入口对 sessionId / key 过 asSafeKey 白名单（字符集 +
 * 1-128 上限），拒绝即抛 INVALID_SESSION_ID / INVALID_KEY 结构化错误；
 * store 层另有 path.resolve 深度防御兜底。key 的长度上限取 SAFE_KEY 的
 * 128 字符（现有实现对 key 无显式上限，此处统一到标识符白名单，防超长
 * 键名进入 JSON 键位与 WriteBackCache size 跟踪）。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import { asSafeKey } from '../validation.js'

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
    return deps.get(asSafeKey(params.sessionId, 'sessionId'), asSafeKey(params.key, 'key'))
  })

  rpcServer.registerMethod('plugin.sessionData.set', async (params) => {
    deps.set(asSafeKey(params.sessionId, 'sessionId'), asSafeKey(params.key, 'key'), params.value)
  })

  rpcServer.registerMethod('plugin.sessionData.delete', async (params) => {
    deps.delete(asSafeKey(params.sessionId, 'sessionId'), asSafeKey(params.key, 'key'))
  })

  rpcServer.registerMethod('plugin.sessionData.keys', async (params) => {
    return deps.keys(asSafeKey(params.sessionId, 'sessionId'))
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

