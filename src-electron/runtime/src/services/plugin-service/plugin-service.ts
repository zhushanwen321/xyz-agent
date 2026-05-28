import { PluginPermissionChecker as PermissionChecker } from './plugin-permission.js'
import type { PluginDescriptor, ToolEntry, HookEntry, HookContext, HookResult, HookBlockedResult, BridgeToolExecuteRequest, BridgeToolExecuteResponse, BridgeInterceptResponse, ToolRegistration, HookType } from './plugin-types.js'
import type { IPluginService } from '../../interfaces.js'
import type { IMessageBroker } from '../../interfaces.js'
import { PluginRegistry } from './plugin-registry.js'
import { PluginStorage } from './plugin-storage.js'
import { PluginRpcServer } from './plugin-rpc-server.js'
import { PluginHost } from './plugin-host.js'
import { PluginActivator } from './plugin-activator.js'
import { registerToolRpcHandlers } from './tool-api.js'
import { registerHookRpcHandlers } from './hook-api.js'
import { registerSessionRpcHandlers } from './api/session-api.js'
import type { SessionHandlers } from './api/session-api.js'
import { registerConfigRpcHandlers } from './api/config-api.js'
import type { ConfigHandlers } from './api/config-api.js'
import { registerSessionDataRpcHandlers } from './api/session-data-api.js'
import type { SessionDataHandlers } from './api/session-data-api.js'
import { registerUiRpcHandlers } from './api/ui-api.js'
import type { UiHandlers } from './api/ui-api.js'
import { registerAgentRpcHandlers } from './api/agent-api.js'
import type { AgentHandlers } from './api/agent-api.js'
import { registerWorkspaceRpcHandlers } from './api/workspace-api.js'
import type { WorkspaceHandlers } from './api/workspace-api.js'

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

  constructor(registry: PluginRegistry, broker: IMessageBroker) {
    this.registry = registry
    this.broker = broker
    this.storage = new PluginStorage()
    this.rpcServer = new PluginRpcServer()
    this.host = new PluginHost(this.rpcServer)
    this.activator = new PluginActivator()
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
      // TODO (Phase 2): trusted Worker 崩溃后自动重建 + 重新加载插件
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

    this.initialized = true
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

    if (enabled) {
      // 启用：尝试立即激活
      await this.activator.handleEvent(
        { type: 'onStartupFinished' },
        this.host,
      )
    } else {
      // 禁用
      await this.activator.deactivatePlugin(pluginId, this.host)
    }

    this.broadcastPluginList()
    return this.getDiscoveredPlugins()
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return
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
      listSessions: () => [],
      getSession: (_id: string) => undefined,
      getActiveSession: () => undefined,
      sendMessage: async (_sessionId: string | undefined, _role: string, _content: string) => {
        // Phase 2: session 消息发送需要 ISessionService，暂为 stub
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
      appendEntry: async (_sessionId: string, _key: string, _value: unknown) => {
        // Phase 2: bridge:append_entry 持久化，暂为 stub（缓存已更新）
      },
    })

    // ── UI RPC handlers ─────────────────────────────────────
    registerUiRpcHandlers(this.rpcServer, {
      showSelect: async (_title: string, _options: string[], _pluginId: string) => {
        // Phase 2: stub — 返回 undefined
        return undefined
      },
      showConfirm: async (_title: string, _message: string, _pluginId: string) => {
        // Phase 2: stub — 返回 true
        return true
      },
      showInput: async (_title: string, _defaultValue: string | undefined, _pluginId: string) => {
        // Phase 2: stub — 返回 undefined
        return undefined
      },
      notify: async (pluginId: string, level: string, message: string) => {
        this.broker.broadcast({
          type: 'plugin:notification',
          id: `notify_${Date.now()}`,
          payload: { pluginId, level, message },
        })
      },
      updateStatusBarItem: async () => {
        // Phase 2: stub
      },
    })

    // ── Agent RPC handlers ──────────────────────────────────
    registerAgentRpcHandlers(this.rpcServer, {
      getModel: () => '',
      setModel: () => {},
      getThinkingLevel: () => '',
      setThinkingLevel: () => {},
      getActiveTools: () => [],
    })

    // ── Workspace RPC handlers ──────────────────────────────
    registerWorkspaceRpcHandlers(this.rpcServer, {
      getRootPath: () => process.cwd(),
      getName: () => {
        const cwd = process.cwd()
        return cwd.split(/[/\\]/).pop() ?? ''
      },
      findFiles: async (_pattern: string) => {
        // Phase 2: stub — 文件查找需要 glob 库
        return []
      },
    })
  }

  /** bridge 轮询缓存的工具 schema 列表 */
  private bridgeToolSchemas: ToolRegistration[] = []

  /**
   * 执行指定 hookType 的钩子管道。
   *
   * 从 hookRegistry 获取 handlers，按 priority 排序后依次执行。
   *
   * 简化的 Phase 2 实现：通过 PluginRpcServer broadcast 通知所有 Worker，
   * 不等待各 Worker 的 invoke 结果（详细的 synchronous RPC 通信在 Phase 2 末期完善）。
   *
   * @param hookType - hook 类型（如 'onBeforeSendMessage'）
   * @param context - Hook 执行上下文
   * @returns HookResult（简化版本默认不阻塞）
   */
  async executeHooks(hookType: string, context: HookContext): Promise<HookResult> {
    const entries = this.hookRegistry.get(hookType)
    if (!entries || entries.length === 0) return { blocked: false }

    // 按 priority 排序（低数值先执行）
    const sorted = [...entries].sort((a, b) => a.priority - b.priority)

    // broadcast invoke 通知给所有 Worker
    this.rpcServer.broadcast('plugin.hooks.invoke', {
      hookType,
      context,
    })

    // 简化实现：不等待 Worker 的 invoke 结果，默认返回未阻塞
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
   * 在 toolRegistry 中查找对应的插件工具，返回 stubbed 结果。
   * TODO (Phase 2 BG4): 实现实际的 RPC 路由到注册插件的工具 handler
   */
  async handleBridgeToolExecute(request: BridgeToolExecuteRequest): Promise<BridgeToolExecuteResponse> {
    const toolKey = request.toolName
    const entry = this.toolRegistry.get(toolKey)
    if (!entry) {
      return { content: `Tool not found: ${toolKey}`, isError: true }
    }
    // Stubbed 结果 — 实际工具执行在后续实现
    return { content: JSON.stringify({ success: true }), isError: false }
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

    await this.executeHooks(eventName, context)

    // 简化实现：插件可注入的消息暂不聚合（Phase 2 末期完善）
    return { injectedMessages: [] }
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
