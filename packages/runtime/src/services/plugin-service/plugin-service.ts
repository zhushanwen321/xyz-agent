import { PluginPermissionChecker as PermissionChecker } from './plugin-permission.js'
import type { PluginDescriptor, ToolEntry, HookEntry, HookContext, HookResult, BridgeToolExecuteRequest, BridgeToolExecuteResponse, BridgeInterceptResponse, BridgeSyncPayload, ToolRegistration, IPluginServiceDeps } from './plugin-types.js'
import type { StatusBarItem, PluginInfo } from '@xyz-agent/shared'
import type { IPluginService, ISessionService } from '../../interfaces.js'
import type { IMessageBroker } from '../../interfaces.js'
import type { ServerMessage } from '@xyz-agent/shared'
import { PluginRegistry } from './plugin-registry.js'
import { PluginStorage } from './plugin-storage.js'
import { SessionDataStore } from './session-data-store.js'
import { PluginRpcServer } from './plugin-rpc-server.js'
import { PluginHost } from './plugin-host.js'
import { PluginActivator } from './plugin-activator.js'
import { registerAllRpcMethods } from './plugin-rpc-setup.js'
import { bootstrapPluginService } from './plugin-lifecycle.js'
import { ActiveSessionResolver } from './api/session-api.js'
import type { InstallResult } from '../ports/plugin-installer.js'
import { handleBridgeToolExecute, handleBridgeEvent, handleBridgeIntercept, BridgeToolCache } from './bridge-interop.js'
import { toConfigKey, fromConfigKey, isConfigKey } from './api/config-api.js'
import { HookPipeline } from './hook-pipeline.js'
import { UiRequestQueue } from './ui-request-queue.js'
import { StatusBarRegistry } from './status-bar-registry.js'
import { PermissionStorage } from './plugin-permission-storage.js'
import { join } from 'node:path'
import { toErrorMessage } from '../../utils/errors.js'


const COMMAND_EXECUTE_TIMEOUT_MS = 10_000

/**
 * PluginService — 纯门面 + 初始化编排（ADR-0012/0013/0014/0023/0001）。
 *
 * 5 个原交职责已下沉到内聚模块，本类仅保留：
 *  (a) initialize 编排（9 步生命周期装配）；
 *  (b) 协作者装配（registry/storage/rpcServer/host/activator/...）；
 *  (c) 薄门面方法：委托 HookPipeline / UiRequestQueue / StatusBarRegistry /
 *      bridge-interop。
 */
export class PluginService implements IPluginService {
  private registry: PluginRegistry
  private storage: PluginStorage
  rpcServer: PluginRpcServer
  host: PluginHost
  private activator: PluginActivator
  private broker: IMessageBroker
  private initialized = false

  /** Tool 注册表，key 为 toolKey（`${pluginId}:${name}`） */
  private toolRegistry = new Map<string, ToolEntry>()

  /** Hook 执行管道（持有 hookRegistry、共享 host/rpcServer 引用） */
  readonly hookPipeline: HookPipeline

  /** Status bar 注册表（持有 items，广播交由注入回调） */
  readonly statusBarRegistry: StatusBarRegistry

  /** UI 请求串行队列（独立状态机，广播交由注入回调） */
  readonly uiRequestQueue: UiRequestQueue

  /** SessionData 内存缓存 + flush + 持久化编排 */
  private readonly sessionDataStore: SessionDataStore

  /** 注入的外部依赖 */
  private deps: IPluginServiceDeps

  /** xyz-agent 配置根（~/.xyz-agent/），plugin/session-data 持久化根。组合根注入。 */
  private readonly configDir: string

  /** bridge 工具 schema 缓存 + sync 负载塑形（P5：职责收口到 bridge-interop） */
  private readonly bridgeToolCache = new BridgeToolCache()

  private permissionChecker: PermissionChecker

  /** 活跃 session 解析器（P6：取代 plugin-rpc-setup 模块级全局缓存，随实例生命周期） */
  private readonly activeSessionResolver: ActiveSessionResolver

  constructor(registry: PluginRegistry, broker: IMessageBroker, deps?: IPluginServiceDeps) {
    this.registry = registry
    this.broker = broker
    this.deps = deps ?? {}
    // configDir 注入：plugin 切片经此拿配置根（~/.xyz-agent/），不再直连 infra（design.md
    // T5 切片自治）。生产由 index.ts 注入；缺省回退 process.cwd() 仅供单测。
    const configDir = this.deps.configDir ?? process.cwd()
    this.configDir = configDir
    const pluginsDir = join(configDir, 'plugins')
    this.storage = new PluginStorage()
    this.rpcServer = new PluginRpcServer()
    this.host = new PluginHost(this.rpcServer)
    this.sessionDataStore = new SessionDataStore(configDir)
    this.permissionChecker = new PermissionChecker(registry, new PermissionStorage(pluginsDir))

    // 活跃 session 解析器：持有同一 deps 引用（setSessionService 后续 mutate 可见）
    this.activeSessionResolver = new ActiveSessionResolver(this.deps)

    // Hook 管道：持有共享 hookRegistry（rpc-setup 注册侧与本类消费侧同一实例），
    // 复用 host / rpcServer 引用。
    this.hookPipeline = new HookPipeline({
      hookRegistry: new Map<string, HookEntry[]>(),
      host: this.host,
      rpcServer: this.rpcServer,
    })

    // UI 请求队列：广播走 broadcastFn（优先）或 broker.broadcast（回退），与原实现一致。
    this.uiRequestQueue = new UiRequestQueue((type, payload) => this.broadcastOrBroker(type, `ui_${payload.requestId}`, payload))

    // Status bar 注册表：广播保持 `plugin:statusBarUpdate` 契约（ADR-0023）。
    this.statusBarRegistry = new StatusBarRegistry((payload) => this.broker.broadcast({
      type: 'plugin:statusBarUpdate', id: `sb_${Date.now()}`, payload,
    } as ServerMessage))

    this.activator = new PluginActivator({
      permissionChecker: this.permissionChecker,
      onPermissionRequest: (payload) =>
        this.broadcastOrBroker('plugin:permissionRequest', `perm_${payload.pluginId}`, payload),
    })
  }

  /** 广播优先走 broadcastFn，否则回退 broker.broadcast（广播契约不变） */
  private broadcastOrBroker(type: string, id: string, payload: unknown): void {
    if (this.deps.broadcastFn) {
      this.deps.broadcastFn(type, payload)
    } else {
      this.broker.broadcast({ type, id, payload } as ServerMessage)
    }
  }

  /** Wire sessionService after construction (breaks circular dependency at creation time) */
  setSessionService(sessionService: ISessionService): void {
    this.deps.sessionService = sessionService
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    // Worker 回调（crash/rebuilt/reply）紧耦合多个私有协作者（activator/broker/
    // registry/host），搬出会引入更宽的注入缝，故作为委托缝留在本类（P4 PARTIAL）。
    this.registerWorkerCallbacks()

    // 9 步顺序启动装配委托 plugin-lifecycle（god-orchestrator 收口）。
    await bootstrapPluginService({
      registry: this.registry,
      storage: this.storage,
      rpcServer: this.rpcServer,
      host: this.host,
      activator: this.activator,
      permissionChecker: this.permissionChecker,
      sessionDataStore: this.sessionDataStore,
      configDir: this.configDir,
      registerRpcMethods: () => this.registerRpcMethods(),
      broadcastPluginList: () => this.broadcastPluginList(),
      watchExternalIfActive: (desc) => this.watchExternalIfActive(desc),
      registerSendMessageHook: () => this.registerSendMessageHook(),
    })

    this.initialized = true
  }

  /**
   * 注册 Worker 生命周期回调（crash / rebuilt / reply）。
   *
   * P4：这三个回调紧耦合 activator.markCrashed、broker.broadcast、
   * registry.getDescriptor、host.loadPlugin、activator.activatePlugin 等
   * 私有协作者，搬出 plugin-service 会引入更宽的注入缝，故作为委托缝留在本类。
   */
  private registerWorkerCallbacks(): void {
    // 4. Worker crash callback
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

    // 4a. Worker 重建后的重新加载回调
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
        // eslint-disable-next-line taste/no-silent-catch -- worker reload: error logged, other plugins unaffected
        } catch (err: unknown) {
          console.error(`[plugin-service] failed to reload plugin ${pluginId}:`, err)
        }
      }
    })

    // 4b. Worker 生命周期回复回调（activated/deactivated/error）
    this.host.setReplyCallback((msg) => {
      this.activator.handleWorkerReply(msg as import('./plugin-types.js').WorkerToHostMessage)
    })
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

  getDiscoveredPlugins(): PluginInfo[] {
    return this.toPluginInfos(this.registry.getAllDescriptors())
  }

  async togglePlugin(pluginId: string, enabled: boolean): Promise<PluginInfo[]> {
    const descriptor = this.registry.getDescriptor(pluginId)
    if (!descriptor) throw new Error(`Plugin not found: ${pluginId}`)

    try {
      if (enabled) {
        // 启用：只激活目标插件（非全部）
        await this.activator.activatePlugin(pluginId, { type: 'onStartupFinished' }, this.host)
        // 激活成功后，对外部插件启动热重载监听
        this.watchExternalIfActive(descriptor)
      } else {
        // 禁用
        await this.activator.deactivatePlugin(pluginId, this.host)
        this.activator.stopWatching(pluginId) // 停止热重载监听
        this.statusBarRegistry.clearForPlugin(pluginId) // 清理 status bar items
      }
     
    } catch (err: unknown) {
      console.error(`[plugin-service] togglePlugin(${pluginId}, ${enabled}) failed:`, toErrorMessage(err))
      // 激活/停用失败仍然返回当前插件列表（允许前端回滚 UI）
    }

    this.broadcastPluginList()
    return this.getDiscoveredPlugins()
  }

  /** external 且已 ACTIVE 的插件启动 hot-reload 监听（重复逻辑统一） */
  private watchExternalIfActive(descriptor: PluginDescriptor): void {
    if (descriptor.source !== 'external' || this.activator.getState(descriptor.pluginId) !== 'ACTIVE') return
    this.activator.watchAndReload(descriptor.pluginId, descriptor.pluginPath, descriptor.source, this.host, (payload) => {
      this.broker.broadcast({ type: 'plugin:statusChange', id: `watch_${payload.pluginId}_${Date.now()}`, payload })
    })
  }

  async uninstallPlugin(pluginId: string): Promise<PluginInfo[]> {
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
    for (const [hookType, entries] of this.hookPipeline.registry) {
      this.hookPipeline.registry.set(hookType, entries.filter(e => e.pluginId !== pluginId))
    }

    // 清理 status bar items
    this.statusBarRegistry.clearForPlugin(pluginId)

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
      this.watchExternalIfActive(descriptor)
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
      COMMAND_EXECUTE_TIMEOUT_MS,
    )
  }

  async getPluginConfig(pluginId: string, key?: string): Promise<unknown> {
    if (key === undefined || key === '__all__') {
      // Return all config（key 前缀约定委托 config-api，P7 收口）
      const allKeys = this.storage.keys(pluginId)
      const configKeys = allKeys.filter(isConfigKey)
      const result: Record<string, unknown> = {}
      for (const configKey of configKeys) {
        result[fromConfigKey(configKey)] = this.storage.get(pluginId, configKey)
      }
      return result
    }
    return this.storage.get(pluginId, toConfigKey(key))
  }

  async setPluginConfig(pluginId: string, key: string, value: unknown): Promise<void> {
    this.storage.set(pluginId, toConfigKey(key), value)
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return
    this.sessionDataStore.stopFlushTimer()
    this.activator.stopAllWatchers()
    await this.activator.deactivateAll(this.host)
    this.storage.flushAll()
    await this.host.shutdown()
    this.rpcServer.dispose()
    this.initialized = false
  }

  private registerRpcMethods(): void {
    registerAllRpcMethods({
      rpcServer: this.rpcServer,
      storage: this.storage,
      toolRegistry: this.toolRegistry,
      hookRegistry: this.hookPipeline.registry,
      statusBarItems: this.statusBarRegistry.items,
      deps: this.deps,
      broadcastStatusBarItems: () => this.statusBarRegistry.broadcastAll(),
      handleUiRequest: (method, params, pluginId) => this.uiRequestQueue.handleRequest(method, params, pluginId),
      syncToolsToBridge: () => this.syncToolsToBridge(),
      getDescriptor: (pluginId) => this.registry.getDescriptor(pluginId),
      sessionDataStore: this.sessionDataStore,
      activeSessionResolver: this.activeSessionResolver,
    })
  }

  /** 执行 hookType 的钩子管道（委托 HookPipeline：排序/串行/5s 超时/block/transform） */
  async executeHooks(hookType: string, context: HookContext): Promise<HookResult> {
    return this.hookPipeline.execute(hookType, context)
  }

  /** 同步 toolRegistry schema 到 bridge 轮询缓存（委托 bridge-interop） */
  async syncToolsToBridge(): Promise<void> {
    this.bridgeToolCache.syncFrom(this.toolRegistry)
  }

  /** 获取 bridge 轮询缓存的工具 schema（委托 bridge-interop） */
  getToolSchemas(): ToolRegistration[] {
    return this.bridgeToolCache.getSchemas()
  }

  /**
   * 构造 bridge:sync 同步负载（工具 schema 塑形下沉 bridge-interop，transport 只 reply）。
   */
  getBridgeSyncPayload(): BridgeSyncPayload {
    return this.bridgeToolCache.getSyncPayload()
  }

  /**
   * 处理 bridge 发起的工具执行请求（ADR-0012 契约不变）。委托 bridge-interop。
   */
  async handleBridgeToolExecute(request: BridgeToolExecuteRequest): Promise<BridgeToolExecuteResponse> {
    return handleBridgeToolExecute(request, this.toolRegistry, this.host, this.rpcServer)
  }

  handleBridgeEvent(eventName: string, data: unknown, sessionId: string): void {
    handleBridgeEvent(eventName, data, sessionId, (hookType, context) => this.executeHooks(hookType, context))
  }

  /**
   * 处理 bridge 拦截请求。
   *
   * 仅 before_agent_start 事件需拦截（域能力：哪些事件可被拦截）。该判定下沉到 service，
   * transport 不再做事件名白名单过滤。非拦截事件返回空响应，保留原协议行为。
   */
  async handleBridgeIntercept(eventName: string, data: unknown, sessionId: string): Promise<BridgeInterceptResponse> {
    if (eventName !== 'before_agent_start') {
      return { injectedMessages: [] }
    }
    return handleBridgeIntercept(eventName, data, sessionId, (hookType, context) => this.executeHooks(hookType, context))
  }

  async installPlugin(packageSpecifier: string): Promise<InstallResult> {
    const installer = this.deps.pluginInstaller
    if (!installer) {
      return { success: false, error: 'Plugin installer not configured (pluginInstaller deps missing)' }
    }
    const result = await installer.install(packageSpecifier)
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
    this.sessionDataStore.flushAll()
  }

  /** flush 指定 session 的 dirty 数据（deactivate/关闭时调用） */
  async flushSessionDataForSession(sessionId: string): Promise<void> {
    this.sessionDataStore.flushSession(sessionId)
  }

  /** 清理指定 session 的数据缓存、dirty 跟踪和 size 记录 */
  clearSessionData(sessionId: string): void {
    this.sessionDataStore.clearSession(sessionId)
  }

  /** 处理前端返回的 UI 响应（供 server.ts 调用）。委托 UiRequestQueue。 */
  handleUiResponse(requestId: string, result: unknown): void {
    this.uiRequestQueue.handleResponse(requestId, result)
  }

  private broadcastPluginList(): void {
    const plugins = this.getDiscoveredPlugins()
    this.broker.broadcast({
      type: 'config.plugins',
      id: `plugins_${Date.now()}`,
      payload: { plugins },
    })
  }

  /** Get all current status bar items */
  getStatusBarItems(): StatusBarItem[] {
    return this.statusBarRegistry.getItems()
  }

  /** 将内部 PluginState（UPPER_CASE）映射为协议层展示状态（lower_case） */
  private mapStateForProtocol(state: string): PluginInfo['status'] {
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

  /**
   * PluginDescriptor（runtime 内部，PluginInfo 超集）→ PluginInfo（WS 协议契约）。
   *
   * 字段挑选 + status 经 mapStateForProtocol 转 lower_case + enabled 推导。
   * 这是 config.plugins 协议债的正式收口点：之前 transport 层用 `as unknown as PluginInfo[]`
   * 强转（仅类型缝合、不改运行时序列化），现在下沉到 service 做真实的字段裁剪。
   *
   * enabled 语义：runtime 无独立「启用」持久化（togglePlugin 直接驱动激活/停用），
   * 故以激活态推导——ACTIVE 视为 enabled，其余 disabled。
   */
  private toPluginInfo(descriptor: PluginDescriptor): PluginInfo {
    const status = this.mapStateForProtocol(descriptor.status)
    return {
      pluginId: descriptor.pluginId,
      version: descriptor.version,
      displayName: descriptor.displayName,
      description: descriptor.description,
      status,
      trustLevel: descriptor.trustLevel,
      enabled: status === 'active',
    }
  }

  private toPluginInfos(descriptors: PluginDescriptor[]): PluginInfo[] {
    return descriptors.map(d => this.toPluginInfo(d))
  }
}
