/**
 * 插件懒激活状态机
 *
 * 维护 activationEvent → pluginId 映射，在外部事件触发时
 * 按需激活匹配的插件。激活流程：assignWorker → loadPlugin → activate 消息。
 *
 * 消息回复通过 handleWorkerReply() 路由：PluginHost 收到 Worker 消息后
 * 调用本方法，Activator 解析 pending promises 完成异步等待。
 */

import { watch, type FSWatcher } from 'node:fs'
import { dirname } from 'node:path'

import type {
  ActivationEvent,
  PluginState,
  PluginDescriptor,
  PluginSource,
  PluginPermission,
  Disposable,
  WorkerToHostMessage,
} from './plugin-types.js'

/** PluginHost 的最小接口——Activator 只依赖这几个方法 */
export interface PluginHost {
  assignWorker(pluginId: string, trustLevel: 'trusted' | 'sandbox'): Promise<string>
  loadPlugin(workerId: string, pluginPath: string, trustLevel?: 'trusted' | 'sandbox'): Promise<void>
  terminateWorker(workerId: string): Promise<void>
  getWorkerHandle(pluginId: string): { workerId: string; postMessage(message: unknown): void } | undefined
}

/** Callback to broadcast plugin status changes */
export type StatusChangeCallback = (payload: {
  pluginId: string
  oldStatus: string
  newStatus: string
}) => void

const DEACTIVATE_TIMEOUT_MS = 5_000
const ACTIVATE_TIMEOUT_MS = 30_000
const PERMISSION_TIMEOUT_MS = 30_000
const HOT_RELOAD_DEBOUNCE_MS = 300
const HOT_RELOAD_DEACTIVATE_TIMEOUT_MS = 5_000

interface PendingReply {
  resolve: (success: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

interface PluginContextState {
  subscriptions: Disposable[]
}

interface ReloadContext {
  host: PluginHost
  onStatusChange: StatusChangeCallback
}

/** PermissionChecker 最小接口——Activator 只调用 getUnapproved */
export interface PermissionCheckerLike {
  getUnapproved(pluginId: string, permissions: PluginPermission[]): PluginPermission[]
}

/** Activator 构造函数选项 */
export interface ActivatorOptions {
  permissionChecker?: PermissionCheckerLike
  onPermissionRequest?: (payload: { pluginId: string; permissions: PluginPermission[] }) => void
  /** 覆盖权限审批超时（测试用） */
  permissionTimeoutMs?: number
}

interface PendingPermission {
  resolve: (approved: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

export class PluginActivator {
  private pluginStates = new Map<string, PluginState>()
  private eventMap = new Map<string, string[]>() // eventPattern → pluginIds
  private contexts = new Map<string, PluginContextState>()
  private descriptors = new Map<string, PluginDescriptor>()
  private pendingReplies = new Map<string, PendingReply>()

  /** 权限检查（可选） */
  private permissionChecker?: PermissionCheckerLike
  private onPermissionRequest?: (payload: { pluginId: string; permissions: PluginPermission[] }) => void
  private permissionTimeoutMs: number
  /** 待审批的权限请求 */
  private pendingPermissions = new Map<string, PendingPermission>()

  /** Hot-reload watchers: pluginId → FSWatcher */
  private watchers = new Map<string, FSWatcher>()
  /** Hot-reload debounce timers: pluginId → timeout handle */
  private reloadTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Reload context (host + callback) for each watched plugin */
  private reloadContexts = new Map<string, ReloadContext>()

  constructor(options?: ActivatorOptions) {
    this.permissionChecker = options?.permissionChecker
    this.onPermissionRequest = options?.onPermissionRequest
    this.permissionTimeoutMs = options?.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS
  }

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
      // 0. 权限检查（在分配 Worker 之前）
      if (this.permissionChecker && descriptor.permissions.length > 0) {
        const unapproved = this.permissionChecker.getUnapproved(pluginId, descriptor.permissions)
        if (unapproved.length > 0) {
          // 先注册 pending promise，再通知外部（避免回调中立即 resolve 时竞态）
          const approvalPromise = this.waitForPermissionApproval(pluginId)
          this.onPermissionRequest?.({ pluginId, permissions: unapproved })
          // 等待审批结果
          const approved = await approvalPromise
          if (!approved) {
            this.pluginStates.set(pluginId, 'UNLOADED')
            return
          }
        }
      }

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
   * 等待权限审批结果。
   * 返回 Promise，超时自动拒绝。
   */
  private waitForPermissionApproval(pluginId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(pluginId)
        resolve(false)
      }, this.permissionTimeoutMs)

      this.pendingPermissions.set(pluginId, { resolve, timer })
    })
  }

  /**
   * 外部调用以解决权限审批请求。
   * @param pluginId 插件 ID
   * @param approved true 通过，false 拒绝
   */
  resolvePermissionApproval(pluginId: string, approved: boolean): void {
    const pending = this.pendingPermissions.get(pluginId)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pendingPermissions.delete(pluginId)
    pending.resolve(approved)
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

  // ── Dependency Management ────────────────────────────────────────

  /**
   * 对插件列表进行拓扑排序（Kahn's algorithm）。
   *
   * 按 extensionDependencies 建立有向无环图，输出依赖顺序的插件列表。
   * 依赖在前，依赖者在后。
   *
   * @param descriptors - 待排序的插件列表
   * @returns 按拓扑顺序排列的插件列表
   */
  topologicalSort(descriptors: PluginDescriptor[]): PluginDescriptor[] {
    const inDegree = new Map<string, number>()
    const adjList = new Map<string, string[]>()
    const descMap = new Map<string, PluginDescriptor>()

    for (const desc of descriptors) {
      const deps = desc.extensionDependencies ?? []
      inDegree.set(desc.pluginId, deps.length)
      // 不要覆盖 adjList：该 pluginId 可能已在依赖遍历时被添加
      if (!adjList.has(desc.pluginId)) {
        adjList.set(desc.pluginId, [])
      }
      descMap.set(desc.pluginId, desc)

      for (const dep of deps) {
        if (!adjList.has(dep)) adjList.set(dep, [])
        adjList.get(dep)!.push(desc.pluginId)
      }
    }

    const queue: string[] = []
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id)
    }

    const result: PluginDescriptor[] = []
    while (queue.length > 0) {
      const id = queue.shift()!
      result.push(descMap.get(id)!)

      for (const neighbor of adjList.get(id) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1
        inDegree.set(neighbor, newDegree)
        if (newDegree === 0) queue.push(neighbor)
      }
    }

    return result
  }

  /**
   * 检测插件依赖图中的循环依赖。
   *
   * 利用 Kahn's algorithm 的特性：拓扑排序结果长度小于输入列表时，
   * 未被排序的节点参与循环。
   *
   * @param descriptors - 待检测的插件列表
   * @returns 参与循环的 pluginId 数组，无循环则返回 null
   */
  detectCycle(descriptors: PluginDescriptor[]): string[] | null {
    const sorted = this.topologicalSort(descriptors)
    if (sorted.length === descriptors.length) return null

    const sortedIds = new Set(sorted.map(d => d.pluginId))
    return descriptors
      .map(d => d.pluginId)
      .filter(id => !sortedIds.has(id))
  }

  /**
   * 按依赖顺序激活插件列表。
   *
   * 流程：
   * 1. 检查缺失依赖（extensionDependencies 引用了不存在的插件）
   * 2. 检测循环依赖
   * 3. 拓扑排序
   * 4. 按序逐个激活
   *
   * @param descriptors - 待激活的插件列表
   * @param host - PluginHost 实例
   * @throws 当存在缺失依赖或循环依赖时抛出 Error
   */
  async activateWithDeps(
    descriptors: PluginDescriptor[],
    host: PluginHost,
  ): Promise<void> {
    // 0. 注册描述符到内部状态（使激活流程能找到插件）
    this.registerDescriptors(descriptors)

    // 1. 检查缺失依赖
    const availableIds = new Set(descriptors.map(d => d.pluginId))
    const missingDeps = new Set<string>()

    for (const desc of descriptors) {
      for (const dep of desc.extensionDependencies ?? []) {
        if (!availableIds.has(dep)) {
          missingDeps.add(dep)
        }
      }
    }

    if (missingDeps.size > 0) {
      throw new Error(`Missing plugin dependencies: ${[...missingDeps].join(', ')}`)
    }

    // 2. 检测循环依赖
    const cycled = this.detectCycle(descriptors)
    if (cycled) {
      throw new Error(`Circular dependencies detected: ${cycled.join(' -> ')}`)
    }

    // 3. 拓扑排序 + 顺序激活
    const sorted = this.topologicalSort(descriptors)

    for (const desc of sorted) {
      await this.activatePlugin(desc.pluginId, { type: 'onStartupFinished' }, host)
    }
  }

  // ── Hot Reload ────────────────────────────────────────────────────

  /**
   * Watch an external plugin's directory for changes and auto-reload.
   * Built-in plugins (source === 'built-in') are excluded.
   */
  watchAndReload(
    pluginId: string,
    pluginPath: string,
    source: PluginSource,
    host: PluginHost,
    onStatusChange: StatusChangeCallback,
  ): void {
    // Built-in plugins: never watch
    if (source === 'built-in') return

    // Don't double-watch
    if (this.watchers.has(pluginId)) return

    // Store reload context for later use by debounce timer
    this.reloadContexts.set(pluginId, { host, onStatusChange })

    const watchDir = dirname(pluginPath)
    const watcher = watch(watchDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return

      // Only watch for JS/TS file changes
      if (!filename.endsWith('.js') && !filename.endsWith('.ts')) return

      // Debounce: 300ms
      const existing = this.reloadTimers.get(pluginId)
      if (existing) clearTimeout(existing)

      this.reloadTimers.set(pluginId, setTimeout(async () => {
        this.reloadTimers.delete(pluginId)
        const ctx = this.reloadContexts.get(pluginId)
        if (ctx) {
          await this.performReload(pluginId, ctx.host, ctx.onStatusChange)
        }
      }, HOT_RELOAD_DEBOUNCE_MS))
    })

    this.watchers.set(pluginId, watcher)
  }

  /**
   * Perform a hot reload: deactivate → activate → broadcast status change.
   */
  async performReload(
    pluginId: string,
    host: PluginHost,
    onStatusChange: StatusChangeCallback,
  ): Promise<void> {
    const currentState = this.pluginStates.get(pluginId)
    if (currentState !== 'ACTIVE') return // Only reload active plugins

    const oldStatus = 'active'

    // 1. Deactivate (timeout 5s)
    try {
      await Promise.race([
        this.deactivatePlugin(pluginId, host),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('deactivate timeout')), HOT_RELOAD_DEACTIVATE_TIMEOUT_MS)
        ),
      ])
    } catch {
      // Deactivate timeout → force terminate Worker
      console.warn(`[plugin-activator] hot reload: force terminate for ${pluginId}`)
      const handle = host.getWorkerHandle(pluginId)
      if (handle) await host.terminateWorker(handle.workerId)
      this.disposeContext(pluginId)
      this.pluginStates.set(pluginId, 'UNLOADED')
    }

    // 2. Re-activate
    await this.activatePlugin(pluginId, { type: 'onStartupFinished' }, host)

    // 3. Notify frontend of status change
    const newStatus = this.pluginStates.get(pluginId) === 'ACTIVE' ? 'active' : 'crashed'
    onStatusChange({ pluginId, oldStatus, newStatus })
  }

  /** Stop watching a specific plugin */
  stopWatching(pluginId: string): void {
    const watcher = this.watchers.get(pluginId)
    if (watcher) {
      watcher.close()
      this.watchers.delete(pluginId)
    }
    const timer = this.reloadTimers.get(pluginId)
    if (timer) {
      clearTimeout(timer)
      this.reloadTimers.delete(pluginId)
    }
  }

  /** Stop all watchers (used during shutdown) */
  stopAllWatchers(): void {
    for (const pluginId of this.watchers.keys()) {
      this.stopWatching(pluginId)
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
