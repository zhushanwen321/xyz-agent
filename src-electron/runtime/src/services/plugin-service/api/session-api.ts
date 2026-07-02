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
import type { IPluginServiceDeps } from '../plugin-types.js'
import type { SessionSummary } from '../../../../../shared/src/session.js'
import { registerHandler, dispatchHandler } from '../handler-registry.js'

// eslint-disable-next-line no-magic-numbers -- 2 seconds TTL for active session cache
const ACTIVE_SESSION_CACHE_TTL_MS = 2 * 1000

/**
 * 活跃 session 解析器（P6 收口：消除 plugin-rpc-setup.ts 的模块级可变全局状态）。
 *
 * 此前 `_activeSessionCache` 是 plugin-rpc-setup.ts 的隐藏模块全局——跨 service
 * 实例共享、测试间泄漏、无法注入。现收口为可注入实例：每个 PluginService 持有
 * 自己的 resolver，缓存随实例生命周期生灭。
 *
 * 提供 TTL 缓存：命中时按缓存 sessionId 查 summary（避免全盘扫描），过期或失效
 * 则回退全盘扫描并刷新缓存。
 */
export class ActiveSessionResolver {
  private cache: { sessionId: string; ts: number } | null = null

  constructor(private readonly deps: IPluginServiceDeps) {}

  /** 清除缓存（测试在 beforeEach 调用以保证干净起点） */
  clear(): void {
    this.cache = null
  }

  /**
   * 查找当前活跃 session。返回 SessionSummary 或 undefined。
   * 命中 TTL 缓存时按缓存 id 查 summary；否则全盘扫描。
   */
  resolve(): SessionSummary | undefined {
    if (!this.deps.sessionService) return undefined
    const now = Date.now()
    if (this.cache && (now - this.cache.ts) < ACTIVE_SESSION_CACHE_TTL_MS) {
      // Cache hit — look up session summary by cached ID (no full disk scan)
      const summary = this.deps.sessionService.getSummary(this.cache.sessionId)
      if (summary) return summary
      // Cached session no longer valid — fall through to full scan
      this.cache = null
    }
    // Cache miss or expired — do the full scan
    const groups = this.deps.sessionService.listPersistedSessions()
    const active = groups.flatMap(g => g.sessions).find(s => s.status === 'active')
    if (active) {
      this.cache = { sessionId: active.id, ts: now }
    } else {
      this.cache = null
    }
    return active
  }
}

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

  // 监听主线程广播的 session 创建/销毁通知（C8: dispatchHandler 统一 onNotification 派发骨架）
  rpcClient.onNotification('plugin.sessions.didCreate', (params: unknown) => {
    const p = params as { handlerId: string; session: SessionInfo }
    dispatchHandler(createHandlers, p, h => h(p.session))
  })

  rpcClient.onNotification('plugin.sessions.didDestroy', (params: unknown) => {
    const p = params as { handlerId: string; session: SessionInfo }
    dispatchHandler(destroyHandlers, p, h => h(p.session))
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
      rpcClient.request('plugin.sessions.registerCreate', { pluginId, handlerId }).catch(() => {})
      return registerHandler(createHandlers, handlerId, handler, () => {
        rpcClient.request('plugin.sessions.unregisterCreate', { handlerId }).catch(() => {})
      })
    },

    onDidDestroySession: (handler: (session: SessionInfo) => void): Disposable => {
      const handlerId = `session_destroy_${pluginId}_${++sessionCounter}`
      rpcClient.request('plugin.sessions.registerDestroy', { pluginId, handlerId }).catch(() => {})
      return registerHandler(destroyHandlers, handlerId, handler, () => {
        rpcClient.request('plugin.sessions.unregisterDestroy', { handlerId }).catch(() => {})
      })
    },
  }
}
