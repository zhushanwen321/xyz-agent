import type { PluginDescriptor } from './plugin-types.js'
import type { IPluginService } from '../../interfaces.js'
import type { IMessageBroker } from '../../interfaces.js'
import { PluginRegistry } from './plugin-registry.js'
import { PluginStorage } from './plugin-storage.js'
import { PluginRpcServer } from './plugin-rpc-server.js'
import { PluginHost } from './plugin-host.js'
import { PluginActivator } from './plugin-activator.js'

export class PluginService implements IPluginService {
  private registry: PluginRegistry
  private storage: PluginStorage
  private rpcServer: PluginRpcServer
  private host: PluginHost
  private activator: PluginActivator
  private broker: IMessageBroker
  private initialized = false

  constructor(registry: PluginRegistry, broker: IMessageBroker) {
    this.registry = registry
    this.broker = broker
    this.storage = new PluginStorage()
    this.rpcServer = new PluginRpcServer()
    this.host = new PluginHost(this.rpcServer)
    this.activator = new PluginActivator()
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

    // Sessions list RPC method (stub for Phase 1)
    this.rpcServer.registerMethod('plugin.sessions.list', async () => {
      return []
    })
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
