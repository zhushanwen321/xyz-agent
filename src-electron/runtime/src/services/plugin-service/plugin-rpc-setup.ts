/**
 * Plugin RPC 方法注册
 *
 * 从 PluginService.registerRpcMethods() 提取，注册所有 plugin RPC handler。
 * 包含：tool、hook、storage、notify、session、config、sessionData、ui、agent、workspace。
 */

import type { StatusBarItem } from '@xyz-agent/shared'
import type { PluginRpcServer } from './plugin-rpc-server.js'
import type { PluginStorage } from './plugin-storage.js'
import type { StatusBarItemOptions, IPluginServiceDeps } from './plugin-types.js'
import { registerToolRpcHandlers } from './tool-api.js'
import { registerHookRpcHandlers } from './hook-api.js'
import { registerSessionRpcHandlers } from './api/session-api.js'
import { registerConfigRpcHandlers } from './api/config-api.js'
import { registerSessionDataRpcHandlers } from './api/session-data-api.js'
import { registerUiRpcHandlers } from './api/ui-api.js'
import { registerAgentRpcHandlers } from './api/agent-api.js'
import { registerWorkspaceRpcHandlers } from './api/workspace-api.js'
import type { ToolEntry } from './plugin-types.js'

const MAX_FIND_FILES_RESULTS = 1000
const DEFAULT_STATUS_BAR_PRIORITY = 100
const MIN_MODEL_PARTS = 2

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
  sessionDataCache: Map<string, Map<string, unknown>>
  sessionDataDirty: Map<string, Set<string>>
  sessionDataSize: Map<string, number>
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

  // Storage RPC methods — global scope
  rpcServer.registerMethod('plugin.storage.global.get', async (params) => {
    return storage.get(params.pluginId as string, params.key as string)
  })
  rpcServer.registerMethod('plugin.storage.global.set', async (params) => {
    await storage.set(params.pluginId as string, params.key as string, params.value)
  })
  rpcServer.registerMethod('plugin.storage.global.delete', async (params) => {
    await storage.delete(params.pluginId as string, params.key as string)
  })
  rpcServer.registerMethod('plugin.storage.global.keys', async (params) => {
    return storage.keys(params.pluginId as string)
  })

  // Storage RPC methods — workspace scope
  rpcServer.registerMethod('plugin.storage.workspace.get', async (params) => {
    return storage.get(params.pluginId as string, params.key as string, 'workspace')
  })
  rpcServer.registerMethod('plugin.storage.workspace.set', async (params) => {
    await storage.set(params.pluginId as string, params.key as string, params.value, 'workspace')
  })
  rpcServer.registerMethod('plugin.storage.workspace.delete', async (params) => {
    await storage.delete(params.pluginId as string, params.key as string, 'workspace')
  })
  rpcServer.registerMethod('plugin.storage.workspace.keys', async (params) => {
    return storage.keys(params.pluginId as string, 'workspace')
  })

  // Notify RPC method
  rpcServer.registerMethod('plugin.notify', async (params) => {
    // Notify 是 fire-and-forget，直接通过 broadcastFn 或 broker 广播
    const payload = {
      pluginId: params.pluginId as string,
      level: params.level as string,
      message: params.message as string,
    }
    if (deps.broadcastFn) {
      deps.broadcastFn('plugin:notification', payload)
    }
  })

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
      if (!deps.sessionService) return undefined
      const groups = deps.sessionService.listPersistedSessions()
      const allSessions = groups.flatMap(g => g.sessions)
      const active = allSessions.find(s => s.status === 'active')
      if (!active) return undefined
      return { id: active.id, label: active.label, cwd: active.cwd, status: active.status, createdAt: 0, lastActiveAt: active.lastActiveAt }
    },
    sendMessage: async (sessionId: string | undefined, _role: string, content: string) => {
      if (!deps.sessionService || !sessionId) return
      await deps.sessionService.sendMessage(sessionId, content)
    },
  })

  // ── Config RPC handlers ──────────────────────────────────
  registerConfigRpcHandlers(rpcServer, {
    get: async (pluginId: string, key: string) => {
      return storage.get(pluginId, `config:${key}`)
    },
    getAll: async (pluginId: string) => {
      const allKeys = await storage.keys(pluginId)
      const configKeys = allKeys.filter(k => k.startsWith('config:'))
      const result: Record<string, unknown> = {}
      for (const key of configKeys) {
        const rawKey = key.replace('config:', '')
        result[rawKey] = await storage.get(pluginId, key)
      }
      return result
    },
    set: async (pluginId: string, key: string, value: unknown) => {
      await storage.set(pluginId, `config:${key}`, value)
    },
  })

  // ── SessionData RPC handlers ─────────────────────────────
  registerSessionDataRpcHandlers(rpcServer, {
    getCache: () => ctx.sessionDataCache,
    getDirty: () => ctx.sessionDataDirty,
    getSizeTracker: () => ctx.sessionDataSize,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    appendEntry: async (_sessionId: string, _key: string, _value: unknown) => {
      // bridge:append_entry 保留接口兼容，set handler 不再直接调用
    },
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
      // Notify via broadcastFn
      if (deps.broadcastFn) {
        deps.broadcastFn('plugin:notification', { pluginId, level, message })
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
      const groups = deps.sessionService.listPersistedSessions()
      const active = groups.flatMap(g => g.sessions).find(s => s.status === 'active')
      return active?.modelId ?? ''
    },
    setModel: (model: string) => {
      if (!deps.sessionService) return
      const groups = deps.sessionService.listPersistedSessions()
      const active = groups.flatMap(g => g.sessions).find(s => s.status === 'active')
      if (!active) return
      const parts = model.split('/')
      if (parts.length < MIN_MODEL_PARTS) return
      const provider = parts[0]
      const modelId = parts.slice(1).join('/')
      void deps.sessionService.switchModel(active.id, provider, modelId)
    },
    getThinkingLevel: () => 'high',
    setThinkingLevel: () => {},
    getActiveTools: () => {
      return Array.from(toolRegistry.values()).map(e => e.schema.name)
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
