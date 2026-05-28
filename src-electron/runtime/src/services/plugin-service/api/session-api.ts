/**
 * Session API 模块
 *
 * 提供 Session 查询/操作的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerSessionRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.sessions.list / get / getActive / sendMessage 四个 RPC 方法。
 *
 * Worker 侧：createSessionApi() 返回代理对象，通过 RPC 转发到主线程。
 *   onDidCreateSession / onDidDestroySession 通过通知机制订阅 session 事件。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import type { SessionInfo, Disposable } from '../plugin-types.js'

/** Session 服务依赖（主线程侧） */
export interface SessionHandlers {
  listSessions(): SessionInfo[] | Promise<SessionInfo[]>
  getSession(id: string): SessionInfo | undefined | Promise<SessionInfo | undefined>
  getActiveSession(): SessionInfo | undefined | Promise<SessionInfo | undefined>
  sendMessage(sessionId: string | undefined, role: string, content: string): Promise<void>
}

export function registerSessionRpcHandlers(
  rpcServer: PluginRpcServer,
  deps: SessionHandlers,
): void {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  rpcServer.registerMethod('plugin.sessions.list', async (_params) => {
    return deps.listSessions()
  })

  rpcServer.registerMethod('plugin.sessions.get', async (params) => {
    const sessionId = params.sessionId as string
    return deps.getSession(sessionId)
  })

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  rpcServer.registerMethod('plugin.sessions.getActive', async (_params) => {
    return deps.getActiveSession()
  })

  rpcServer.registerMethod('plugin.sessions.sendMessage', async (params) => {
    const sessionId = params.sessionId as string | undefined
    const role = params.role as string
    const content = params.content as string
    await deps.sendMessage(sessionId, role, content)
  })
}

let sessionCounter = 0

export function createSessionApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  list(): Promise<SessionInfo[]>
  get(id: string): Promise<SessionInfo | undefined>
  getActive(): Promise<SessionInfo | undefined>
  sendMessage(params: { sessionId?: string; role: 'user' | 'system'; content: string }): Promise<void>
  onDidCreateSession(handler: (session: SessionInfo) => void): Disposable
  onDidDestroySession(handler: (session: SessionInfo) => void): Disposable
} {
  const createHandlers = new Map<string, (session: SessionInfo) => void>()
  const destroyHandlers = new Map<string, (session: SessionInfo) => void>()

  // 监听主线程广播的 session 创建/销毁通知
  rpcClient.onNotification('plugin.sessions.didCreate', (params: unknown) => {
    const p = params as { handlerId: string; session: SessionInfo }
    const handler = createHandlers.get(p.handlerId)
    if (handler) {
      handler(p.session)
    }
  })

  rpcClient.onNotification('plugin.sessions.didDestroy', (params: unknown) => {
    const p = params as { handlerId: string; session: SessionInfo }
    const handler = destroyHandlers.get(p.handlerId)
    if (handler) {
      handler(p.session)
    }
  })

  return {
    list: () =>
      rpcClient.request('plugin.sessions.list', { pluginId }).then(v => (v as SessionInfo[]) ?? []),

    get: (id: string) =>
      rpcClient.request('plugin.sessions.get', { sessionId: id }).then(v => v as SessionInfo | undefined),

    getActive: () =>
      rpcClient.request('plugin.sessions.getActive', { pluginId }).then(v => v as SessionInfo | undefined),

    sendMessage: (params: { sessionId?: string; role: 'user' | 'system'; content: string }) =>
      rpcClient.request('plugin.sessions.sendMessage', { pluginId, ...params }).then(() => {}),

    onDidCreateSession: (handler: (session: SessionInfo) => void): Disposable => {
      const handlerId = `session_create_${pluginId}_${++sessionCounter}`
      createHandlers.set(handlerId, handler)
      rpcClient.request('plugin.sessions.registerCreate', { pluginId, handlerId }).catch(() => {})
      return {
        dispose: () => {
          createHandlers.delete(handlerId)
          rpcClient.request('plugin.sessions.unregisterCreate', { handlerId }).catch(() => {})
        },
      }
    },

    onDidDestroySession: (handler: (session: SessionInfo) => void): Disposable => {
      const handlerId = `session_destroy_${pluginId}_${++sessionCounter}`
      destroyHandlers.set(handlerId, handler)
      rpcClient.request('plugin.sessions.registerDestroy', { pluginId, handlerId }).catch(() => {})
      return {
        dispose: () => {
          destroyHandlers.delete(handlerId)
          rpcClient.request('plugin.sessions.unregisterDestroy', { handlerId }).catch(() => {})
        },
      }
    },
  }
}
