/**
 * 插件懒激活状态机
 *
 * 维护 activationEvent → pluginId 映射，在外部事件触发时
 * 按需激活匹配的插件。激活流程：assignWorker → loadPlugin → activate 消息。
 *
 * 消息回复通过 handleWorkerReply() 路由：PluginHost 收到 Worker 消息后
 * 调用本方法，Activator 解析 pending promises 完成异步等待。
 */

import type {
  ActivationEvent,
  PluginState,
  PluginDescriptor,
  Disposable,
  WorkerToHostMessage,
} from './plugin-types.js'

/** PluginHost 的最小接口——Activator 只依赖这几个方法 */
export interface PluginHost {
  assignWorker(pluginId: string, trustLevel: 'trusted' | 'sandbox'): Promise<string>
  loadPlugin(workerId: string, pluginPath: string): Promise<void>
  terminateWorker(workerId: string): Promise<void>
  getWorkerHandle(pluginId: string): { workerId: string; postMessage(message: unknown): void } | undefined
}

const DEACTIVATE_TIMEOUT_MS = 5_000
const ACTIVATE_TIMEOUT_MS = 30_000

interface PendingReply {
  resolve: (success: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

interface PluginContextState {
  subscriptions: Disposable[]
}

export class PluginActivator {
  private pluginStates = new Map<string, PluginState>()
  private eventMap = new Map<string, string[]>() // eventPattern → pluginIds
  private contexts = new Map<string, PluginContextState>()
  private descriptors = new Map<string, PluginDescriptor>()
  private pendingReplies = new Map<string, PendingReply>()

  /** 注册插件描述符，构建 activationEvent 索引 */
  registerDescriptors(descriptors: PluginDescriptor[]): void {
    for (const desc of descriptors) {
      this.descriptors.set(desc.pluginId, desc)
      this.pluginStates.set(desc.pluginId, desc.status)

      for (const eventPattern of desc.activationEvents) {
        const existing = this.eventMap.get(eventPattern)
        if (existing) {
          if (!existing.includes(desc.pluginId)) {
            existing.push(desc.pluginId)
          }
        } else {
          this.eventMap.set(eventPattern, [desc.pluginId])
        }
      }
    }
  }

  /**
   * 处理外部事件，匹配并激活对应插件。
   *
   * 匹配规则：
   * - 'onSlashCommand:xxx' → 精确匹配 event.command
   * - 'onStartupFinished' → 精确匹配
   * - 其他事件模式 → 精确匹配 event.type
   */
  async handleEvent(
    event: ActivationEvent,
    host: PluginHost,
  ): Promise<void> {
    const candidates = this.resolveCandidates(event)
    const tasks = candidates
      .filter(pid => {
        const state = this.pluginStates.get(pid)
        return state !== 'ACTIVE' && state !== 'ACTIVATING'
      })
      .map(pid => this.activatePlugin(pid, event, host))
    await Promise.allSettled(tasks)
  }

  /**
   * 激活单个插件。
   *
   * 流程：ACTIVATING → assignWorker → loadPlugin → postMessage('activate') → 等待回复
   */
  async activatePlugin(
    pluginId: string,
    event: ActivationEvent,
    host: PluginHost,
  ): Promise<void> {
    const descriptor = this.descriptors.get(pluginId)
    if (!descriptor) return

    // 幂等：已在激活中或已激活，跳过
    const currentState = this.pluginStates.get(pluginId)
    if (currentState === 'ACTIVE' || currentState === 'ACTIVATING') return

    this.pluginStates.set(pluginId, 'ACTIVATING')

    try {
      // 1. 分配 Worker
      const workerId = await host.assignWorker(pluginId, descriptor.trustLevel)

      // 2. 加载插件模块到 Worker
      await host.loadPlugin(workerId, descriptor.pluginPath)

      // 3. 发送 activate 消息并等待 Worker 回复
      const handle = host.getWorkerHandle(pluginId)
      if (!handle) {
        this.pluginStates.set(pluginId, 'UNLOADED')
        return
      }

      const success = await this.sendAndWaitReply(
        handle,
        { type: 'activate', pluginId, pluginDir: descriptor.pluginPath, event },
        pluginId,
        ACTIVATE_TIMEOUT_MS,
      )

      if (success) {
        this.contexts.set(pluginId, { subscriptions: [] })
        this.pluginStates.set(pluginId, 'ACTIVE')
      } else {
        this.pluginStates.set(pluginId, 'UNLOADED')
      }
    } catch (err: unknown) {
      console.error(`[plugin-activator] failed to activate ${pluginId}:`, err)
      this.pluginStates.set(pluginId, 'UNLOADED')
    }
  }

  /**
   * 停用单个插件。
   *
   * 流程：DEACTIVATING → postMessage('deactivate') → 等待回复或超时 → dispose subscriptions
   */
  async deactivatePlugin(pluginId: string, host: PluginHost): Promise<void> {
    const currentState = this.pluginStates.get(pluginId)
    if (!currentState || currentState === 'UNLOADED' || currentState === 'DEACTIVATING') return

    this.pluginStates.set(pluginId, 'DEACTIVATING')

    const handle = host.getWorkerHandle(pluginId)
    if (handle) {
      await this.sendAndWaitReply(
        handle,
        { type: 'deactivate', pluginId },
        pluginId,
        DEACTIVATE_TIMEOUT_MS,
      )
    }

    // dispose subscriptions
    this.disposeContext(pluginId)
    this.pluginStates.set(pluginId, 'UNLOADED')
  }

  /** 停用所有已激活的插件 */
  async deactivateAll(host: PluginHost): Promise<void> {
    const activeIds = this.getActivePlugins()
    await Promise.allSettled(activeIds.map(pid => this.deactivatePlugin(pid, host)))
  }

  getActivePlugins(): string[] {
    const result: string[] = []
    for (const [pid, state] of this.pluginStates) {
      if (state === 'ACTIVE') result.push(pid)
    }
    return result
  }

  getState(pluginId: string): PluginState | undefined {
    return this.pluginStates.get(pluginId)
  }

  /** 将插件状态标记为 CRASHED（由 PluginService crash callback 调用） */
  markCrashed(pluginId: string): void {
    this.pluginStates.set(pluginId, 'CRASHED')
  }

  /**
   * PluginHost 在收到 Worker 消息时调用，解析 pending promises。
   *
   * 处理 activated / deactivated / error 三种回复类型。
   */
  handleWorkerReply(msg: WorkerToHostMessage): void {
    if (!('pluginId' in msg) || typeof msg.pluginId !== 'string') return

    const pending = this.pendingReplies.get(msg.pluginId)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pendingReplies.delete(msg.pluginId)

    if (msg.type === 'activated' || msg.type === 'deactivated') {
      pending.resolve(true)
    } else if (msg.type === 'error') {
      pending.resolve(false)
    }
  }

  // ── Private helpers ─────────────────────────────────────────────

  /** 根据 ActivationEvent 解析匹配的 pluginId 列表 */
  private resolveCandidates(event: ActivationEvent): string[] {
    const matched = new Set<string>()

    // 精确匹配事件类型（如 onStartupFinished）
    const byType = this.eventMap.get(event.type)
    if (byType) {
      for (const pid of byType) matched.add(pid)
    }

    // onSlashCommand:xxx 精确匹配 command
    if (event.type === 'onSlashCommand' && event.command) {
      const byCommand = this.eventMap.get(`onSlashCommand:${event.command}`)
      if (byCommand) {
        for (const pid of byCommand) matched.add(pid)
      }
    }

    return [...matched]
  }

  /**
   * 发送消息并注册 pending promise，等待 handleWorkerReply() 解析。
   * 超时自动 resolve(false)。
   */
  private sendAndWaitReply(
    handle: { workerId: string; postMessage(message: unknown): void },
    message: unknown,
    pluginId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(pluginId)
        resolve(false)
      }, timeoutMs)

      this.pendingReplies.set(pluginId, { resolve, timer })
      handle.postMessage(message)
    })
  }

  /** dispose 插件的 subscriptions 并清理 context */
  private disposeContext(pluginId: string): void {
    const ctx = this.contexts.get(pluginId)
    if (ctx) {
      for (const sub of ctx.subscriptions) {
        try { sub.dispose() } catch { /* best effort */ }
      }
      this.contexts.delete(pluginId)
    }
  }
}
