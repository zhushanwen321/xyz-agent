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
 * 活跃 session 解析器（P6 收口：消除 plugin-rpc-setup.ts 的模块级可变全局状态；
 * P7 per-client 化：resolve 绑 clientId，从 P5 activeSessions Map 取 per-client session）。
 *
 * 此前 `_activeSessionCache` 是 plugin-rpc-setup.ts 的隐藏模块全局——跨 service
 * 实例共享、测试间泄漏、无法注入。现收口为可注入实例：每个 PluginService 持有
 * 自己的 resolver，缓存随实例生命周期生灭。
 *
 * P7 改造（spec §2.1）：
 * - resolve 签名加 clientId（undefined 走全局 fallback，零回归）
 * - 数据源：有 clientId 时优先 connectionManager.getActiveSession(clientId)（P5 activeSessions Map）
 *   → leaseManager.getBusySession(clientId)（lease fallback）→ 全局 active（扫描 isGenerating）→ undefined
 * - TTL cache 改为 per-key（Map<clientId|'global', {sessionId, ts}>），避免客户端间污染
 *
 * 复用 P5 已交付基础设施（activeSessions Map + lease busyOwnerId），零新机制。
 */
export class ActiveSessionResolver {
  /**
   * per-key TTL cache：key = clientId 或 'global'（clientId undefined 时）。
   * 替换原全局单值 cache——多客户端各自的 active session 独立缓存，避免污染。
   */
  private readonly cache = new Map<string, { sessionId: string; ts: number }>()

  constructor(private readonly deps: IPluginServiceDeps) {}

  /**
   * 清除缓存。
   * @param clientId 指定则只清该 clientId 的 cache key；不传则清整个 Map（测试 beforeEach 用）。
   */
  clear(clientId?: string): void {
    if (clientId === undefined) {
      this.cache.clear()
    } else {
      this.cache.delete(clientId)
    }
  }

  /**
   * 查找当前活跃 session（P7 per-clientId）。
   *
   * 四级 fallback（spec D3）：
   * ① 有 clientId → connectionManager.getActiveSession(clientId)（P5 Map 命中，setActive 过）
   * ② lease fallback → leaseManager.getBusySession(clientId)（busyOwnerId=clientId，刚连上未 setActive 但正操作）
   * ③ 全局 active → findGlobalActiveSession（扫描 isGenerating，现状行为；clientId undefined 时直接走此级）
   * ④ 都 miss → undefined
   *
   * clientId undefined（hook/定时器/生命周期触发，ALS 无 store）时直接走第三级，与现状行为等价（D7 例外）。
   * 命中 per-key TTL 缓存时按 sessionId 查 summary（O(1)），过期则重算并刷新该 key。
   *
   * @returns SessionSummary 或 undefined（四级 fallback 都 miss）
   */
  resolve(clientId: string | undefined): SessionSummary | undefined {
    if (!this.deps.sessionService) return undefined
    const now = Date.now()
    const cacheKey = clientId ?? 'global'
    const cached = this.cache.get(cacheKey)
    if (cached && (now - cached.ts) < ACTIVE_SESSION_CACHE_TTL_MS) {
      // Cache hit — look up session summary by cached ID (no full scan)
      const summary = this.deps.sessionService.getSummary(cached.sessionId)
      if (summary) return summary
      // Cached session no longer valid — fall through to fallback chain
      this.cache.delete(cacheKey)
    }

    // D3 四级 fallback
    let sessionId: string | undefined
    if (clientId) {
      // ① P5 activeSessions Map 命中（setActive 过）。null（主动取消选中）和 undefined（从未 setActive）都视为 miss。
      const fromMap = this.deps.connectionManager?.getActiveSession(clientId)
      if (fromMap) {
        sessionId = fromMap
      } else {
        // ② lease fallback（busyOwnerId=clientId）
        sessionId = this.deps.leaseManager?.getBusySession(clientId)?.sessionId
      }
    }
    // ③ 无 clientId（D7 例外）或 per-client 链路都 miss → 全局 active fallback（现状行为）
    if (!sessionId) {
      sessionId = this.findGlobalActiveSession()
    }
    // ④ 仍无 → undefined
    if (!sessionId) return undefined

    this.cache.set(cacheKey, { sessionId, ts: now })
    return this.deps.sessionService.getSummary(sessionId) ?? undefined
  }

  /**
   * 全局 active session 扫描（现状 resolve() 的扫描逻辑，D3 第三级 fallback 复用）。
   * 扫描 listPersistedSessions 找第一个 status==='active'（即 isGenerating）。
   */
  private findGlobalActiveSession(): string | undefined {
    if (!this.deps.sessionService) return undefined
    const groups = this.deps.sessionService.listPersistedSessions()
    const active = groups.flatMap(g => g.sessions).find(s => s.status === 'active')
    return active?.id
  }
}

/** Session 服务依赖（主线程侧） */
export interface SessionHandlers {
  listSessions(): SessionInfo[] | Promise<SessionInfo[]>
  getSession(id: string): SessionInfo | undefined | Promise<SessionInfo | undefined>
  /**
   * P7：clientId 透传给 ActiveSessionResolver.resolve(clientId)。
   * clientId undefined（ALS 无 store）时走全局 fallback。
   */
  getActiveSession(clientId?: string): SessionInfo | undefined | Promise<SessionInfo | undefined>
  sendMessage(sessionId: string | undefined, role: string, content: string): Promise<void>
}

export function registerSessionRpcHandlers(
  rpcServer: PluginRpcServer,
  deps: SessionHandlers,
): void {
   
  rpcServer.registerMethod('plugin.sessions.list', async (_params) => {
    return deps.listSessions()
  })

  rpcServer.registerMethod('plugin.sessions.get', async (params) => {
    const sessionId = params.sessionId as string
    return deps.getSession(sessionId)
  })

   
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
