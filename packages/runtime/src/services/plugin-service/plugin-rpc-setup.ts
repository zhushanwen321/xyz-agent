/**
 * Plugin RPC 方法注册
 *
 * 从 PluginService.registerRpcMethods() 提取，注册所有 plugin RPC handler。
 * 包含：tool、hook、storage、notify、session、config、sessionData、ui、agent、workspace。
 */

import type { StatusBarItem, ProviderId } from '@xyz-agent/shared'
import type { PluginRpcServer } from './plugin-rpc-server.js'
import type { PluginStorage } from './plugin-storage.js'
import type { StatusBarItemOptions, IPluginServiceDeps } from './plugin-types.js'
import type { SessionDataStore } from './session-data-store.js'
import { registerToolRpcHandlers } from './tool-api.js'
import { registerHookRpcHandlers } from './hook-api.js'
import { registerSessionRpcHandlers, ActiveSessionResolver } from './api/session-api.js'
import { registerConfigRpcHandlers, toConfigKey, fromConfigKey, isConfigKey } from './api/config-api.js'
import { registerStorageRpcHandlers, storageHandlersFrom } from './api/storage-api.js'
import { registerNotifyRpcHandler, notifyHandlersFrom, broadcastPluginNotification } from './api/notify-api.js'
import { registerSessionDataRpcHandlers } from './api/session-data-api.js'
import { registerUiRpcHandlers } from './api/ui-api.js'
import { registerAgentRpcHandlers } from './api/agent-api.js'
import { registerWorkspaceRpcHandlers } from './api/workspace-api.js'
import { registerCommandRpcHandlers } from './api/commands-api.js'
import type { CommandRegistration } from './api/commands-api.js'
import { registerViewRpcHandlers } from './api/views-api.js'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import type { ToolEntry } from './plugin-types.js'

const MAX_FIND_FILES_RESULTS = 1000
const DEFAULT_STATUS_BAR_PRIORITY = 100
const MIN_MODEL_PARTS = 2

/**
 * 向后兼容的 test helper（P6 后为 no-op）。
 *
 * 活跃 session 缓存已从模块级全局状态收口为 `ActiveSessionResolver` 实例（每个
 * PluginService 持有自己的 resolver，缓存随实例生灭）。测试每个 beforeEach 创建
 * 新 service，resolver 天然干净，故此 helper 不再需要真正清理——保留导出仅为不破坏
 * 既有测试 import（plugin-agent-real.test.ts）。
 */
export function clearActiveSessionCache(): void {
  /* no-op: cache is now per-resolver-instance, see ActiveSessionResolver */
}

// Re-export：测试与外部仍可拿到 resolver 类型
export { ActiveSessionResolver }

export interface RpcSetupContext {
  rpcServer: PluginRpcServer
  storage: PluginStorage
  toolRegistry: Map<string, ToolEntry>
  hookRegistry: Map<string, import('./plugin-types.js').HookEntry[]>
  statusBarItems: Map<string, StatusBarItem>
  deps: IPluginServiceDeps
  broadcastStatusBarItems: () => void
  handleUiRequest: (method: string, params: Record<string, unknown>, pluginId: string) => Promise<unknown>
  syncToolsToBridge: () => Promise<void>
  getDescriptor: (pluginId: string) => import('./plugin-types.js').PluginDescriptor | undefined
  sessionDataStore: SessionDataStore
  /** 活跃 session 解析器（P6：替代模块级全局 _activeSessionCache） */
  activeSessionResolver: ActiveSessionResolver
  /** 命令注册表（commandId→CommandRegistration），PluginService 实例字段注入 */
  commandRegistry: Map<string, CommandRegistration>
  /** 挂载点集合（renderer 经 plugin.mountPoints.sync 上报的副本，AC10） */
  mountPoints: string[]
  /**
   * views.update 的广播出口（wave:perf-w08，02 文档 D1-1）：PluginService 实现的
   * bus 定向发布（transient）/ 全局广播兜底分流，见 publishViewUpdate 实现。
   */
  publishViewUpdate: PluginServiceLike['publishViewUpdate']
}

/** 仅用于 RpcSetupContext.publishViewUpdate 的类型（避免 rpc-setup 反向 import plugin-service 成环） */
interface PluginServiceLike {
  publishViewUpdate(payload: {
    sessionId: string
    viewId: string
    pluginId: string
    guiTree: GuiComponent[]
    updatedAt: number
  }): void
}

export function registerAllRpcMethods(ctx: RpcSetupContext): void {
  const { rpcServer, storage, toolRegistry, hookRegistry, statusBarItems, deps } = ctx

  // Tool RPC handlers
  registerToolRpcHandlers(rpcServer, {
    toolRegistry,
    syncToolsToBridge: ctx.syncToolsToBridge,
  })

  // Hook RPC handlers
  registerHookRpcHandlers(rpcServer, {
    hookRegistry,
    getDescriptor: ctx.getDescriptor,
  })

  // Storage RPC handlers — P6 收口到 api/storage-api.ts（与其它域一致）
  registerStorageRpcHandlers(rpcServer, storageHandlersFrom(storage))

  // Notify RPC handler — P6 收口到 api/notify-api.ts（fire-and-forget via broadcastFn）
  registerNotifyRpcHandler(rpcServer, notifyHandlersFrom(deps.broadcastFn))

  // ── Sessions RPC handlers ────────────────────────────────
  registerSessionRpcHandlers(rpcServer, {
    listSessions: () => {
      if (!deps.sessionService) return []
      const groups = deps.sessionService.listPersistedSessions()
      return groups.flatMap(g => g.sessions.map(s => ({
        id: s.id,
        label: s.label,
        cwd: s.cwd,
        status: s.status,
        createdAt: 0,
        lastActiveAt: s.lastActiveAt,
      })))
    },
    getSession: (id: string) => {
      if (!deps.sessionService) return undefined
      const s = deps.sessionService.getSummary(id)
      if (!s) return undefined
      return { id: s.id, label: s.label, cwd: s.cwd, status: s.status, createdAt: 0, lastActiveAt: s.lastActiveAt }
    },
    getActiveSession: () => {
      const active = ctx.activeSessionResolver.resolve()
      if (!active) return undefined
      return { id: active.id, label: active.label, cwd: active.cwd, status: active.status, createdAt: 0, lastActiveAt: active.lastActiveAt }
    },
    sendMessage: async (sessionId: string | undefined, _role: string, content: string) => {
      if (!deps.sessionService || !sessionId) return
      await deps.sessionService.sendMessage(sessionId, content)
    },
  })

  // ── Config RPC handlers ──────────────────────────────────
  // key 前缀约定委托 config-api（P7 收口），与 plugin-service.ts 共用单一真相源。
  registerConfigRpcHandlers(rpcServer, {
    get: async (pluginId: string, key: string) => {
      return storage.get(pluginId, toConfigKey(key))
    },
    getAll: async (pluginId: string) => {
      const allKeys = storage.keys(pluginId)
      const configKeys = allKeys.filter(isConfigKey)
      const result: Record<string, unknown> = {}
      for (const key of configKeys) {
        result[fromConfigKey(key)] = storage.get(pluginId, key)
      }
      return result
    },
    set: async (pluginId: string, key: string, value: unknown) => {
      storage.set(pluginId, toConfigKey(key), value)
    },
  })

  // ── SessionData RPC handlers ─────────────────────────────
  registerSessionDataRpcHandlers(rpcServer, {
    get: (sessionId, key) => ctx.sessionDataStore.get(sessionId, key),
    set: (sessionId, key, value) => ctx.sessionDataStore.set(sessionId, key, value),
    delete: (sessionId, key) => ctx.sessionDataStore.delete(sessionId, key),
    keys: (sessionId) => ctx.sessionDataStore.keys(sessionId),
  })

  // ── UI RPC handlers ─────────────────────────────────────
  registerUiRpcHandlers(rpcServer, {
    showSelect: (title: string, options: string[], pluginId: string) =>
      ctx.handleUiRequest('select', { title, options }, pluginId) as Promise<string | undefined>,
    showConfirm: (title: string, message: string, pluginId: string) =>
      ctx.handleUiRequest('confirm', { title, message }, pluginId) as Promise<boolean>,
    showInput: (title: string, _defaultValue: string | undefined, pluginId: string) =>
      ctx.handleUiRequest('input', { title }, pluginId) as Promise<string | undefined>,
    notify: async (pluginId: string, level: string, message: string) => {
      // Notify via broadcastFn —— 委托 notify-api 的单一广播真相源（P1 去重）
      // 文案与重构前逐字一致（commit 8dd3034f 父版本）
      if (!broadcastPluginNotification(deps.broadcastFn, pluginId, level, message)) {
        console.warn('[plugin-rpc-setup] ui-api notify dropped: no broadcastFn configured')
      }
    },
    updateStatusBarItem: async (pluginId: string, id: string, text: string, options?: StatusBarItemOptions) => {
      const itemKey = `${pluginId}:${id}`
      // Empty text = remove item
      if (text === '') {
        statusBarItems.delete(itemKey)
      } else {
        const item: StatusBarItem = {
          id,
          pluginId,
          text,
          tooltip: options?.tooltip,
          commandId: options?.commandId,
          priority: options?.priority ?? DEFAULT_STATUS_BAR_PRIORITY,
          scope: options?.scope ?? 'global',
          sessionId: options?.sessionId,
        }
        statusBarItems.set(itemKey, item)
      }
      ctx.broadcastStatusBarItems()
    },
  })

  // ── Agent RPC handlers ──────────────────────────────────
  registerAgentRpcHandlers(rpcServer, {
    getModel: () => {
      if (!deps.sessionService) return ''
      const active = ctx.activeSessionResolver.resolve()
      return active?.modelId ?? ''
    },
    setModel: async (model: string) => {
      if (!deps.sessionService) return
      const active = ctx.activeSessionResolver.resolve()
      if (!active) return
      const parts = model.split('/')
      if (parts.length < MIN_MODEL_PARTS) return
      // 复合串切分边界（design D5）：parts[0] 是 provider id，从插件传入的 "providerId/modelId" 切出
      const provider = parts[0] as ProviderId
      const modelId = parts.slice(1).join('/')
      // Unified entry: persist + broadcast included
      if (deps.modelService) {
        await deps.modelService.switchModel(active.id, provider, modelId)
      } else {
        // Fallback: session-only (no persist/broadcast)
        await deps.sessionService.switchModel(active.id, provider, modelId)
      }
    },
    getThinkingLevel: () => {
      if (!deps.sessionService) return 'off'
      const active = ctx.activeSessionResolver.resolve()
      return active?.thinkingLevel ?? 'off'
    },
    setThinkingLevel: async (level: string) => {
      if (!deps.sessionService) return
      const active = ctx.activeSessionResolver.resolve()
      if (!active) return
      if (deps.modelService) {
        await deps.modelService.setThinkingLevel(active.id, level)
      } else {
        await deps.sessionService.setThinkingLevel(active.id, level)
      }
    },
    getActiveTools: () => {
      return Array.from(toolRegistry.values()).map(e => e.schema.name)
    },
  })

  // ── Commands RPC handlers ────────────────────────────────
  // 主线程侧命令注册表（register 建表 + 下行广播 plugin:commandRegistered）。
  // worker 侧 invoke 监听在 createCommandsApi（plugin-bootstrap），主线程发送段
  // （查 commandId→pluginId 映射 → 向 worker 发 plugin.commands.invoke）归后续 wave。
  registerCommandRpcHandlers(rpcServer, {
    registry: ctx.commandRegistry,
    broadcastRegistered: (reg) => {
      if (deps.broadcastFn) {
        deps.broadcastFn('plugin:commandRegistered', reg)
      } else {
        console.warn('[plugin-rpc-setup] commands.register broadcast dropped: no broadcastFn configured')
      }
    },
  })

  // ── Views RPC handlers ───────────────────────────────────
  // views.update → handleViewUpdate（ES2：无活跃 session 丢弃广播 + warning）；
  // listMountPoints → 读挂载点集合副本（AC10：sync 注入→查询一致）。
  // wave:perf-w08（02 文档 D1-1，R-06）：广播出口改 ctx.publishViewUpdate——
  // bus 已装配时按 payload.sessionId 定向 publish（plugin:viewUpdate 归 transient 类，
  // 不占 seq 不入 ring），不再全局 broadcast。
  registerViewRpcHandlers(rpcServer, {
    mountPoints: ctx.mountPoints,
    handleViewUpdate: (pluginId: string, viewId: string, guiTree: GuiComponent[]) => {
      const active = ctx.activeSessionResolver.resolve()
      if (!active) {
        // ES2: 无活跃 session 时丢弃广播 + warning（含 pluginId+viewId）
        console.warn(`[plugin-rpc-setup] views.update dropped: no active session (plugin=${pluginId}, view=${viewId})`)
        return
      }
      ctx.publishViewUpdate({
        sessionId: active.id,
        viewId,
        pluginId,
        guiTree,
        updatedAt: Date.now(),
      })
    },
  })

  // ── Workspace RPC handlers ──────────────────────────────
  registerWorkspaceRpcHandlers(rpcServer, {
    getRootPath: () => process.cwd(),
    getName: () => {
      const cwd = process.cwd()
      return cwd.split(/[/\\]/).pop() ?? ''
    },
    findFiles: async (pattern: string) => {
      try {
        const fastGlob = (await import('fast-glob')).default
        const entries = await fastGlob(pattern, {
          cwd: process.cwd(),
          ignore: ['**/node_modules/**', '**/.git/**'],
          absolute: true,
        }) as string[]
        return entries.slice(0, MAX_FIND_FILES_RESULTS)
      } catch {
        return []
      }
    },
  })
}
