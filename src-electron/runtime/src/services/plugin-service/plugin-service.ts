import { PluginPermissionChecker as PermissionChecker } from './plugin-permission.js'
import type { PluginDescriptor, ToolEntry, HookEntry, HookContext, HookResult, BridgeToolExecuteRequest, BridgeToolExecuteResponse, BridgeInterceptResponse, ToolRegistration, HookType, IPluginServiceDeps } from './plugin-types.js'
import type { IPluginService } from '../../interfaces.js'
import type { IMessageBroker } from '../../interfaces.js'
import { PluginRegistry } from './plugin-registry.js'
import { PluginStorage, persistSessionData, loadSessionData, deleteSessionData } from './plugin-storage.js'
import { PluginRpcServer } from './plugin-rpc-server.js'
import { PluginHost } from './plugin-host.js'
import { PluginActivator } from './plugin-activator.js'
import { registerToolRpcHandlers } from './tool-api.js'
import { registerHookRpcHandlers } from './hook-api.js'
import { registerSessionRpcHandlers } from './api/session-api.js'
import { registerConfigRpcHandlers } from './api/config-api.js'
import { registerSessionDataRpcHandlers } from './api/session-data-api.js'
import { registerUiRpcHandlers } from './api/ui-api.js'
import { registerAgentRpcHandlers } from './api/agent-api.js'
import { registerWorkspaceRpcHandlers } from './api/workspace-api.js'
import { PluginInstaller, type InstallResult } from './plugin-installer.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'

export class PluginService implements IPluginService {
  private registry: PluginRegistry
  private storage: PluginStorage
  private rpcServer: PluginRpcServer
  private host: PluginHost
  private activator: PluginActivator
  private broker: IMessageBroker
  private initialized = false

  /** Tool 注册表，key 为 toolKey（`${pluginId}:${name}`） */
  private toolRegistry = new Map<string, ToolEntry>()

  /** Hook 注册表，key 为 hookType，value 为该类型的所有注册条目 */
  private permissionChecker: PermissionChecker
  private hookRegistry = new Map<string, HookEntry[]>()

  /** Session 数据缓存，key 为 sessionId */
  /** SessionData 内存缓存，sessionId → key → value */
  private sessionDataCache = new Map<string, Map<string, unknown>>()

  /** Dirty 跟踪：sessionId → 已修改但未 flush 的 key 集合 */
  private sessionDataDirty = new Map<string, Set<string>>()

  /** Size 跟踪：sessionId → 当前字节数 */
  private sessionDataSize = new Map<string, number>()

  /** 定时 flush 计时器 */
  private sessionDataFlushTimer: ReturnType<typeof setInterval> | null = null

  /** npm 安装器 */
  private installer: PluginInstaller

  /** 注入的外部依赖 */
  private deps: IPluginServiceDeps

  /** 当前活跃的 UI 请求 ID（串行排队） */
  private activeUiRequest: string | null = null

  /** 等待中的 UI 请求队列 */
  private uiRequestQueue: Array<{ params: Record<string, unknown>; resolve: (v: unknown) => void }> = []

  /** 等待前端响应的 UI 请求 */
  private pendingUiRequests = new Map<string, { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>()

  /** 清理指定 session 的数据缓存、dirty 跟踪和 size 记录 */
  clearSessionData(sessionId: string): void {
    this.sessionDataCache.delete(sessionId)
    this.sessionDataDirty.delete(sessionId)
    this.sessionDataSize.delete(sessionId)

    // Also delete from disk
    void deleteSessionData(join(homedir(), '.xyz-agent'), sessionId).catch(() => {})
  }

  constructor(registry: PluginRegistry, broker: IMessageBroker, deps?: IPluginServiceDeps) {
    this.registry = registry
    this.broker = broker
    this.deps = deps ?? {}
    this.storage = new PluginStorage()
    this.rpcServer = new PluginRpcServer()
    this.host = new PluginHost(this.rpcServer)
    this.installer = new PluginInstaller()
    this.activator = new PluginActivator({
      permissionChecker: this.permissionChecker,
      onPermissionRequest: (payload) => {
        if (this.deps.broadcastFn) {
          this.deps.broadcastFn('plugin:permissionRequest', payload)
        } else {
          this.broker.broadcast({ type: 'plugin:permissionRequest', id: `perm_${payload.pluginId}`, payload })
        }
      },
    })
    this.permissionChecker = new PermissionChecker(registry)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    // 1. 扫描插件
    const descriptors = await this.registry.scan()
    this.activator.registerDescriptors(descriptors)

    // 2. 初始化存储
    const { homedir } = await import('node:os')
    const { join } = await import('node:path')
    const baseDir = join(homedir(), '.xyz-agent')
    await this.storage.init(baseDir, process.cwd())

    // 3. 注册 RPC 方法
    this.registerRpcMethods()

    // 3b. 加载权限
    await this.permissionChecker.load()

    // 3c. 设置 RPC 权限检查
    this.rpcServer.setPermissionChecker((pluginId, method) => {
      return this.permissionChecker.check(pluginId, method)
    })

    // 4. 设置 Worker crash callback
    this.host.setCrashCallback((workerId, pluginIds, error) => {
      for (const pluginId of pluginIds) {
        this.activator.markCrashed(pluginId)
      }
      for (const pluginId of pluginIds) {
        this.broker.broadcast({
          type: 'plugin:crashed',
          id: `crash_${pluginId}_${Date.now()}`,
          payload: { pluginId, workerId, error },
        })
      }
      // Trusted Worker 崩溃后通过 rebuildWorker 自动重建
    })

    // 4a. 设置 Worker 重建后的重新加载回调
    this.host.setRebuiltCallback((newWorkerId, pluginIds) => {
      for (const pluginId of pluginIds) {
        try {
          const descriptor = this.registry.getDescriptor(pluginId)
          if (descriptor) {
            this.host.loadPlugin(newWorkerId, descriptor.pluginPath, 'trusted').then(() => {
              // Re-activate the plugin after loading
              return this.activator.activatePlugin(pluginId, { type: 'onStartupFinished' }, this.host)
            }).catch((err: unknown) => {
              console.error(`[plugin-service] failed to reload plugin ${pluginId}:`, err)
            })
          }
        } catch (err: unknown) {
          console.error(`[plugin-service] failed to reload plugin ${pluginId}:`, err)
        }
      }
    })

    // 4b. 设置 Worker 生命周期回复回调（activated/deactivated/error）
    this.host.setReplyCallback((msg) => {
      this.activator.handleWorkerReply(msg as import('./plugin-types.js').WorkerToHostMessage)
    })

    // 5. 启动内存监控
    this.host.startMemoryMonitor()

    // 6. 触发 onStartupFinished
    await this.activator.handleEvent(
      { type: 'onStartupFinished' },
      this.host,
    )

    // 7. 广播插件列表
    this.broadcastPluginList()

    // 8. 启动 sessionData flush 定时器
    this.startFlushTimer()

    // 8b. Restore sessionData from disk
    try {
      const sessionDataDir = join(homedir(), '.xyz-agent', 'session-data')
      const files = await readdir(sessionDataDir)
      for (const file of files) {
        if (file.endsWith('.json')) {
          const sessionId = file.replace('.json', '')
          const data = await loadSessionData(join(homedir(), '.xyz-agent'), sessionId)
          if (data.size > 0) {
            this.sessionDataCache.set(sessionId, data)
          }
        }
      }
    } catch {
      // Directory doesn't exist yet, that's fine
    }

    // 9. 为 external 已激活插件启动 hot-reload 监听
    for (const desc of this.registry.getAllDescriptors()) {
      if (desc.source === 'external' && this.activator.getState(desc.pluginId) === 'ACTIVE') {
        this.activator.watchAndReload(
          desc.pluginId,
          desc.pluginPath,
          desc.source,
          this.host,
          (payload) => {
            this.broker.broadcast({
              type: 'plugin:statusChange',
              id: `reload_${payload.pluginId}_${Date.now()}`,
              payload,
            })
          },
        )
      }
    }

    this.initialized = true

    // 注册 onBeforeSendMessage hook
    this.registerSendMessageHook()
  }

  /**
   * 由 initialize() 调用，确保 session 创建时 hook 已就绪。
   */
  private registerSendMessageHook(): void {
    if (this.deps?.sessionService) {
      this.deps.sessionService.setSendMessageHook(async (sessionId, content) => {
        const result = await this.executeHooks('onBeforeSendMessage', {
          sessionId,
          content,
          pluginId: '',
          hookType: 'onBeforeSendMessage' as import('./plugin-types.js').HookType,
          data: { content },
          timestamp: Date.now(),
        })
        if (result.blocked) return { blocked: true, reason: result.reason }
        return null
      })
    }
  }

  getDiscoveredPlugins(): PluginDescriptor[] {
    return this.registry.getAllDescriptors().map(p => ({
      ...p,
      status: this.mapStateForProtocol(p.status) as PluginDescriptor['status'],
    }))
  }

  async togglePlugin(pluginId: string, enabled: boolean): Promise<PluginDescriptor[]> {
    const descriptor = this.registry.getDescriptor(pluginId)
    if (!descriptor) throw new Error(`Plugin not found: ${pluginId}`)

    try {
      if (enabled) {
        // 启用：只激活目标插件（非全部）
        await this.activator.activatePlugin(
          pluginId,
          { type: 'onStartupFinished' },
          this.host,
        )
        // 激活成功后，对外部插件启动热重载监听
        if (descriptor.source === 'external' && this.activator.getState(pluginId) === 'ACTIVE') {
          this.activator.watchAndReload(pluginId, descriptor.pluginPath, descriptor.source, this.host, (payload) => {
            this.broker.broadcast({ type: 'plugin:statusChange', id: `toggle_${payload.pluginId}_${Date.now()}`, payload })
          })
        }
      } else {
        // 禁用
        await this.activator.deactivatePlugin(pluginId, this.host)
        // 停止热重载监听
        this.activator.stopWatching(pluginId)
      }
    } catch (err: unknown) {
      console.error(`[plugin-service] togglePlugin(${pluginId}, ${enabled}) failed:`, err instanceof Error ? err.message : String(err))
      // 激活/停用失败仍然返回当前插件列表（允许前端回滚 UI）
    }

    this.broadcastPluginList()
    return this.getDiscoveredPlugins()
  }

  async uninstallPlugin(pluginId: string): Promise<PluginDescriptor[]> {
    // 停用插件
    await this.activator.deactivatePlugin(pluginId, this.host)

    // 从注册表中移除
    this.registry.removeDescriptor(pluginId)

    // 清理工具和 hook 注册
    for (const [key, entry] of this.toolRegistry) {
      if (entry.pluginId === pluginId) {
        this.toolRegistry.delete(key)
      }
    }
    for (const [hookType, entries] of this.hookRegistry) {
      this.hookRegistry.set(hookType, entries.filter(e => e.pluginId !== pluginId))
    }

    await this.syncToolsToBridge()
    this.broadcastPluginList()
    return this.getDiscoveredPlugins()
  }

  async approvePermissions(pluginId: string, permissions: string[]): Promise<void> {
    const descriptor = this.registry.getDescriptor(pluginId)
    if (!descriptor) throw new Error(`Plugin not found: ${pluginId}`)

    // Update descriptor permissions
    descriptor.permissions = [...new Set([...descriptor.permissions, ...permissions])]
    // Update permission checker's granted map
    this.permissionChecker.grant(pluginId, permissions)
    await this.permissionChecker.save()

    // If plugin was waiting for permissions, try to activate it
    if (this.activator.getState(pluginId) !== 'ACTIVE') {
      await this.activator.activatePlugin(pluginId, { type: 'onStartupFinished' }, this.host)
      if (descriptor.source === 'external' && this.activator.getState(pluginId) === 'ACTIVE') {
        this.activator.watchAndReload(pluginId, descriptor.pluginPath, descriptor.source, this.host, (payload) => {
          this.broker.broadcast({ type: 'plugin:statusChange', id: `perms_${payload.pluginId}_${Date.now()}`, payload })
        })
      }
    }
  }

  async revokePermissions(pluginId: string): Promise<void> {
    const descriptor = this.registry.getDescriptor(pluginId)
    if (!descriptor) throw new Error(`Plugin not found: ${pluginId}`)

    descriptor.permissions = []
    this.permissionChecker.revoke(pluginId)
    await this.permissionChecker.save()
  }

  async executeCommand(pluginId: string, commandId: string, args?: Record<string, unknown>): Promise<void> {
    const descriptor = this.registry.getDescriptor(pluginId)
    if (!descriptor) throw new Error(`Plugin not found: ${pluginId}`)

    const handle = this.host.getWorkerHandle(pluginId)
    if (!handle) throw new Error(`Plugin worker not available: ${pluginId}`)

    await this.rpcServer.invoke(
      handle.workerId,
      'plugin.command.execute',
      { pluginId, commandId, args: args ?? {} },
      10_000,
    )
  }

  async getPluginConfig(pluginId: string, key?: string): Promise<unknown> {
    if (key === undefined || key === '__all__') {
      // Return all config
      const allKeys = await this.storage.keys(pluginId)
      const configKeys = allKeys.filter(k => k.startsWith('config:'))
      const result: Record<string, unknown> = {}
      for (const configKey of configKeys) {
        const rawKey = configKey.replace('config:', '')
        result[rawKey] = await this.storage.get(pluginId, configKey)
      }
      return result
    }
    return this.storage.get(pluginId, `config:${key}`)
  }

  async setPluginConfig(pluginId: string, key: string, value: unknown): Promise<void> {
    await this.storage.set(pluginId, `config:${key}`, value)
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return
    this.stopFlushTimer()
    this.activator.stopAllWatchers()
    await this.activator.deactivateAll(this.host)
    await this.storage.flushAll()
    await this.host.shutdown()
    this.rpcServer.dispose()
    this.initialized = false
  }

  private registerRpcMethods(): void {
    // Tool RPC handlers
    registerToolRpcHandlers(this.rpcServer, {
      toolRegistry: this.toolRegistry,
      syncToolsToBridge: () => this.syncToolsToBridge(),
    })

    // Hook RPC handlers
    registerHookRpcHandlers(this.rpcServer, {
      hookRegistry: this.hookRegistry,
      getDescriptor: (pluginId) => this.registry.getDescriptor(pluginId),
    })

    // Storage RPC methods — global scope
    this.rpcServer.registerMethod('plugin.storage.global.get', async (params) => {
      return this.storage.get(params.pluginId as string, params.key as string)
    })
    this.rpcServer.registerMethod('plugin.storage.global.set', async (params) => {
      await this.storage.set(params.pluginId as string, params.key as string, params.value)
    })
    this.rpcServer.registerMethod('plugin.storage.global.delete', async (params) => {
      await this.storage.delete(params.pluginId as string, params.key as string)
    })
    this.rpcServer.registerMethod('plugin.storage.global.keys', async (params) => {
      return this.storage.keys(params.pluginId as string)
    })

    // Storage RPC methods — workspace scope
    this.rpcServer.registerMethod('plugin.storage.workspace.get', async (params) => {
      return this.storage.get(params.pluginId as string, params.key as string, 'workspace')
    })
    this.rpcServer.registerMethod('plugin.storage.workspace.set', async (params) => {
      await this.storage.set(params.pluginId as string, params.key as string, params.value, 'workspace')
    })
    this.rpcServer.registerMethod('plugin.storage.workspace.delete', async (params) => {
      await this.storage.delete(params.pluginId as string, params.key as string, 'workspace')
    })
    this.rpcServer.registerMethod('plugin.storage.workspace.keys', async (params) => {
      return this.storage.keys(params.pluginId as string, 'workspace')
    })

    // Notify RPC method
    this.rpcServer.registerMethod('plugin.notify', async (params) => {
      this.broker.broadcast({
        type: 'plugin:notification',
        id: `notify_${Date.now()}`,
        payload: {
          pluginId: params.pluginId as string,
          level: params.level as string,
          message: params.message as string,
        },
      })
    })

    // ── Sessions RPC handlers ────────────────────────────────
    registerSessionRpcHandlers(this.rpcServer, {
      listSessions: () => {
        if (!this.deps.sessionService) return []
        const groups = this.deps.sessionService.listPersistedSessions()
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
        if (!this.deps.sessionService) return undefined
        const s = this.deps.sessionService.getSummary(id)
        if (!s) return undefined
        return { id: s.id, label: s.label, cwd: s.cwd, status: s.status, createdAt: 0, lastActiveAt: s.lastActiveAt }
      },
      getActiveSession: () => {
        if (!this.deps.sessionService) return undefined
        const groups = this.deps.sessionService.listPersistedSessions()
        const allSessions = groups.flatMap(g => g.sessions)
        const active = allSessions.find(s => s.status === 'active')
        if (!active) return undefined
        return { id: active.id, label: active.label, cwd: active.cwd, status: active.status, createdAt: 0, lastActiveAt: active.lastActiveAt }
      },
      sendMessage: async (sessionId: string | undefined, _role: string, content: string) => {
        if (!this.deps.sessionService || !sessionId) return
        await this.deps.sessionService.sendMessage(sessionId, content)
      },
    })

    // ── Config RPC handlers ──────────────────────────────────
    registerConfigRpcHandlers(this.rpcServer, {
      get: async (pluginId: string, key: string) => {
        return this.storage.get(pluginId, `config:${key}`)
      },
      getAll: async (pluginId: string) => {
        const allKeys = await this.storage.keys(pluginId)
        const configKeys = allKeys.filter(k => k.startsWith('config:'))
        const result: Record<string, unknown> = {}
        for (const key of configKeys) {
          const rawKey = key.replace('config:', '')
          result[rawKey] = await this.storage.get(pluginId, key)
        }
        return result
      },
      set: async (pluginId: string, key: string, value: unknown) => {
        await this.storage.set(pluginId, `config:${key}`, value)
      },
    })

    // ── SessionData RPC handlers ─────────────────────────────
    registerSessionDataRpcHandlers(this.rpcServer, {
      getCache: () => this.sessionDataCache,
      getDirty: () => this.sessionDataDirty,
      getSizeTracker: () => this.sessionDataSize,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      appendEntry: async (_sessionId: string, _key: string, _value: unknown) => {
        // bridge:append_entry 保留接口兼容，set handler 不再直接调用
      },
    })

    // ── UI RPC handlers ─────────────────────────────────────
    registerUiRpcHandlers(this.rpcServer, {
      showSelect: (title: string, options: string[], pluginId: string) =>
        this.handleUiRequest('select', { title, options }, pluginId) as Promise<string | undefined>,
      showConfirm: (title: string, message: string, pluginId: string) =>
        this.handleUiRequest('confirm', { title, message }, pluginId) as Promise<boolean>,
      showInput: (title: string, _defaultValue: string | undefined, pluginId: string) =>
        this.handleUiRequest('input', { title }, pluginId) as Promise<string | undefined>,
      notify: async (pluginId: string, level: string, message: string) => {
        this.broker.broadcast({
          type: 'plugin:notification',
          id: `notify_${Date.now()}`,
          payload: { pluginId, level, message },
        })
      },
      updateStatusBarItem: async (pluginId: string, id: string, text: string) => {
        this.broker.broadcast({
          type: 'plugin:statusBarUpdate',
          id: `sb_${pluginId}_${Date.now()}`,
          payload: { items: [{ id, pluginId, text, priority: 100 }] },
        })
      },
    })

    // ── Agent RPC handlers ──────────────────────────────────
    registerAgentRpcHandlers(this.rpcServer, {
      getModel: () => {
        if (!this.deps.sessionService) return ''
        const groups = this.deps.sessionService.listPersistedSessions()
        const active = groups.flatMap(g => g.sessions).find(s => s.status === 'active')
        return active?.modelId ?? ''
      },
      setModel: (model: string) => {
        if (!this.deps.sessionService) return
        const groups = this.deps.sessionService.listPersistedSessions()
        const active = groups.flatMap(g => g.sessions).find(s => s.status === 'active')
        if (!active) return
        const parts = model.split('/')
        if (parts.length < 2) return
        const provider = parts[0]
        const modelId = parts.slice(1).join('/')
        void this.deps.sessionService.switchModel(active.id, provider, modelId)
      },
      getThinkingLevel: () => 'high',
      setThinkingLevel: () => {},
      getActiveTools: () => {
        return Array.from(this.toolRegistry.values()).map(e => e.schema.name)
      },
    })

    // ── Workspace RPC handlers ──────────────────────────────
    registerWorkspaceRpcHandlers(this.rpcServer, {
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
          return entries.slice(0, 1000)
        } catch {
          return []
        }
      },
    })
  }

  /** bridge 轮询缓存的工具 schema 列表 */
  private bridgeToolSchemas: ToolRegistration[] = []

  /**
   * 执行指定 hookType 的钩子管道。
   *
   * 从 hookRegistry 获取 handlers，按 priority 排序后串行执行。
   * 支持 block（proceed === false 终止链路）和 content transform（modifiedData 传递）。
   * 每个 handler 超时 5s，超时视为放行。
   * Worker crashed → skip 该 handler。
   *
   * @param hookType - hook 类型（如 'onBeforeSendMessage'）
   * @param context - Hook 执行上下文
   * @returns HookResult
   */
  async executeHooks(hookType: string, context: HookContext): Promise<HookResult> {
    const entries = this.hookRegistry.get(hookType)
    if (!entries || entries.length === 0) return { blocked: false }

    // 按 priority 排序：built-in (0) → trusted (100) → sandbox (200)
    const sorted = [...entries].sort((a, b) => a.priority - b.priority)

    // 串行执行：await 每个 handler，支持 transform 和 block
    for (const entry of sorted) {
      const handle = this.host.getWorkerHandle(entry.pluginId)
      if (!handle) continue // Worker crashed → skip

      try {
        const result = await this.rpcServer.invoke(
          handle.workerId,
          'plugin.hooks.invoke',
          {
            handlerId: entry.handlerId,
            hookType,
            context,
          },
          5_000, // 每个 handler 5s 超时
        ) as Record<string, unknown>

        // 检查是否被阻止
        if (result && typeof result === 'object' && 'proceed' in result && result.proceed === false) {
          return {
            blocked: true,
            reason: (result.reason as string) ?? `Blocked by plugin ${entry.pluginId}`,
            blockedBy: entry.pluginId,
          }
        }

        // 检查是否需要转换内容
        if (result && typeof result === 'object' && 'modifiedData' in result && result.modifiedData !== undefined) {
          context = {
            ...context,
            data: result.modifiedData,
          }
        }
      } catch (err: unknown) {
        // 超时或错误 → 视为放行（不阻止链路）
        console.warn(
          `[plugin-service] hook handler ${entry.handlerId} failed/timed out:`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    return { blocked: false }
  }

  /**
   * 同步工具注册表到 bridge 层。
   * 收集 toolRegistry 中的 schema，供 bridge:sync 轮询获取。
   */
  async syncToolsToBridge(): Promise<void> {
    this.bridgeToolSchemas = Array.from(this.toolRegistry.values()).map(e => e.schema)
  }

  /** 获取 bridge 轮询缓存的工具 schema */
  getToolSchemas(): ToolRegistration[] {
    return this.bridgeToolSchemas
  }

  /**
   * 处理 bridge 发起的工具执行请求。
   *
   * 通过 toolRegistry 查找工具所属插件 → 获取 Worker handle
   * → 通过 RPC 调用 Worker 中的 tool handler → 返回结果。
   */
  async handleBridgeToolExecute(request: BridgeToolExecuteRequest): Promise<BridgeToolExecuteResponse> {
    // 1. 按 schema.name 匹配（toolRegistry key 是 pluginId:name 格式）
    const entry = Array.from(this.toolRegistry.values())
      .find(e => e.schema.name === request.toolName)
    if (!entry) {
      return { content: `Tool not found: ${request.toolName}`, isError: true }
    }

    // 2. 获取工具所属插件的 Worker handle
    const handle = this.host.getWorkerHandle(entry.pluginId)
    if (!handle) {
      return { content: 'Plugin worker crashed', isError: true }
    }

    // 3. 通过 RPC 调用 Worker 执行工具（超时 30s）
    try {
      const result = await this.rpcServer.invoke(
        handle.workerId,
        'plugin.tool.execute',
        {
          pluginId: entry.pluginId,
          toolName: request.toolName,
          arguments: request.parameters,
          sessionId: request.sessionId,
          toolCallId: request.toolCallId,
        },
        30_000,
      )
      return result as BridgeToolExecuteResponse
    } catch (err: unknown) {
      // 超时 → isError
      if (err instanceof Error && err.message.includes('RPC timeout')) {
        return { content: 'Plugin tool execution timed out', isError: true }
      }
      // Worker crash / 其他错误
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Plugin tool execution failed: ${msg}`, isError: true }
    }
  }

  /**
   * 广播 bridge 事件给所有注册了对应 hookType 的 Worker。
   * 用于 observer 类型事件的 fire-and-forget 通知。
   */
  handleBridgeEvent(eventName: string, data: unknown, sessionId: string): void {
    const context: HookContext = {
      pluginId: '',
      hookType: eventName as HookType,
      data: { eventName, data, sessionId },
      timestamp: Date.now(),
    }
    this.executeHooks(eventName, context).catch((err: unknown) => {
      console.error(`[plugin-service] handleBridgeEvent error:`, err)
    })
  }

  /**
   * 处理 bridge 拦截请求。
   * 调用 executeHooks 获取插件注入的消息，返回拦截响应。
   */
  async handleBridgeIntercept(eventName: string, data: unknown, sessionId: string): Promise<BridgeInterceptResponse> {
    const context: HookContext = {
      pluginId: '',
      hookType: eventName as HookType,
      data: { eventName, data, sessionId },
      timestamp: Date.now(),
    }

    const hookResult = await this.executeHooks(eventName, context)

    if (hookResult.blocked) {
      return { blocked: true, reason: hookResult.reason ?? `Blocked by ${hookResult.blockedBy}`, injectedMessages: [] }
    }

    return { injectedMessages: [] }
  }

  async installPlugin(packageSpecifier: string): Promise<InstallResult> {
    const result = await this.installer.install(packageSpecifier)
    if (result.success && result.pluginId) {
      // Re-scan registry to pick up the new plugin
      await this.registry.reload()
      // Re-register descriptors with activator
      const descriptors = this.registry.getAllDescriptors()
      this.activator.registerDescriptors(descriptors)
      this.broadcastPluginList()
    }
    return result
  }

  /** 将所有 dirty sessionData 批量 flush（由定时器调用） */
  async flushSessionData(): Promise<void> {
    for (const [sessionId, dirtyKeys] of this.sessionDataDirty) {
      if (dirtyKeys.size === 0) continue
      const cache = this.sessionDataCache.get(sessionId)
      if (!cache) continue

      // 快照 dirty 数据
      const dirtySnapshot = new Map<string, unknown>()
      for (const key of dirtyKeys) {
        const val = cache.get(key)
        if (val !== undefined) dirtySnapshot.set(key, val)
      }

      // 先清除 dirty（让 timer 测试能正确验证）
      dirtyKeys.clear()

      // 异步持久化；失败时恢复 dirty
      try {
        await persistSessionData(join(homedir(), '.xyz-agent'), sessionId, cache)
      } catch (err: unknown) {
        console.warn(`[plugin-service] sessionData flush failed for ${sessionId}:`, err instanceof Error ? err.message : String(err))
        // 恢复 dirty 标记
        for (const key of dirtySnapshot.keys()) {
          dirtyKeys.add(key)
        }
      }
    }
  }

  /** flush 指定 session 的 dirty 数据（deactivate/关闭时调用） */
  async flushSessionDataForSession(sessionId: string): Promise<void> {
    const dirtyKeys = this.sessionDataDirty.get(sessionId)
    if (!dirtyKeys || dirtyKeys.size === 0) return

    const cache = this.sessionDataCache.get(sessionId)
    if (!cache) return

    try {
      await persistSessionData(join(homedir(), '.xyz-agent'), sessionId, cache)
      dirtyKeys.clear()
    } catch (err: unknown) {
      console.warn(`[plugin-service] sessionData flush failed for ${sessionId}:`, err instanceof Error ? err.message : String(err))
    }
  }

  /** 启动 sessionData 定时 flush（每 5s） */
  private startFlushTimer(): void {
    this.sessionDataFlushTimer = setInterval(() => {
      this.flushSessionData().catch((err: unknown) => {
        console.error('[plugin-service] sessionData flush error:', err)
      })
    }, 5_000)
  }

  /** 停止 sessionData 定时 flush */
  private stopFlushTimer(): void {
    if (this.sessionDataFlushTimer) {
      clearInterval(this.sessionDataFlushTimer)
      this.sessionDataFlushTimer = null
    }
  }

  /**
   * 处理 UI 弹窗请求（串行排队）。
   * 同时只允许一个弹窗显示在前端，后续请求排队等待。
   * 超时 60s 自动 resolve 为默认值。
   */
  private async handleUiRequest(method: string, params: Record<string, unknown>, pluginId: string): Promise<unknown> {
    const requestId = `${pluginId}_${Date.now()}_${Math.random().toString(36).slice(2)}`
    return new Promise<unknown>((resolve) => {
      if (this.activeUiRequest !== null) {
        this.uiRequestQueue.push({ params: { ...params, requestId, method, pluginId }, resolve })
        return
      }
      this.activeUiRequest = requestId
      this.dispatchUiRequest(requestId, method, params, pluginId, resolve)
    })
  }

  /** 发送 UI 请求到前端，设置超时计时器 */
  private dispatchUiRequest(
    requestId: string,
    method: string,
    params: Record<string, unknown>,
    pluginId: string,
    resolve: (v: unknown) => void,
  ): void {
    const UI_REQUEST_TIMEOUT_MS = 60_000

    // 超时默认值
    const defaultResult = method === 'confirm' ? false : undefined

    const timer = setTimeout(() => {
      this.pendingUiRequests.delete(requestId)
      this.processNextUiRequest()
      resolve(defaultResult)
    }, UI_REQUEST_TIMEOUT_MS)

    this.pendingUiRequests.set(requestId, { resolve, timer })

    // 通过 broadcastFn 或 broker 广播
    const broadcastPayload = {
      requestId,
      pluginId,
      method,
      ...params,
    }
    if (this.deps.broadcastFn) {
      this.deps.broadcastFn('plugin:uiRequest', broadcastPayload)
    } else {
      this.broker.broadcast({
        type: 'plugin:uiRequest',
        id: `ui_${requestId}`,
        payload: broadcastPayload,
      })
    }
  }

  /** 处理前端返回的 UI 响应（供 server.ts 调用） */
  handleUiResponse(requestId: string, result: unknown): void {
    const pending = this.pendingUiRequests.get(requestId)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pendingUiRequests.delete(requestId)
    pending.resolve(result)
    this.processNextUiRequest()
  }

  /** 处理队列中的下一个 UI 请求 */
  private processNextUiRequest(): void {
    if (this.uiRequestQueue.length === 0) {
      this.activeUiRequest = null
      return
    }
    const next = this.uiRequestQueue.shift()!
    this.activeUiRequest = next.params.requestId as string
    this.dispatchUiRequest(
      next.params.requestId as string,
      next.params.method as string,
      next.params,
      next.params.pluginId as string,
      next.resolve,
    )
  }

  private broadcastPluginList(): void {
    const plugins = this.getDiscoveredPlugins()
    this.broker.broadcast({
      type: 'config.plugins',
      id: `plugins_${Date.now()}`,
      payload: { plugins },
    })
  }

  /** 将内部 PluginState（UPPER_CASE）映射为协议层展示状态（lower_case） */
  private mapStateForProtocol(state: string): string {
    switch (state) {
      case 'ACTIVE': return 'active'
      case 'CRASHED': return 'crashed'
      case 'LOADING':
      case 'UNLOADED':
        return 'discovered'
      default:
        return 'inactive'
    }
  }
}
