/**
 * Worker Thread 池管理器
 *
 * 负责创建/复用 Worker、加载插件、崩溃恢复和资源监控。
 * trusted 插件共享 Worker（最多 10 个），sandbox 插件独占 Worker。
 */

import { Worker } from 'node:worker_threads'
import { resolve, dirname } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { WorkerHandle, RpcRequest, RpcResponse } from './plugin-types.js'
import { PluginRpcServer } from './plugin-rpc-server.js'
import { PluginHostProcess, type PluginPoolOptions } from './plugin-host-process.js'

/**
 * 解析 plugin-host.ts 所在目录（即 dist/runtime/）。
 *
 * - CJS bundle（tsup 产物）: __dirname 是 Node.js CJS 模块变量，指向 bundle 所在目录
 * - ESM 源码（开发/测试 tsx）: import.meta.url 推导
 * - 均不可用时抛出清晰错误
 *
 * 关键：CJS 中 __dirname 是模块作用域变量，不在 globalThis 上。
 * tsup 用 esbuild 编译，__dirname 引用会原样保留到 CJS 输出。
 */
function resolvePluginHostDir(): string {
  // CJS: __dirname 是 Node.js 注入的模块局部变量，指向当前文件所在目录
  // tsup/esbuild 不转换 typeof 检查，CJS 运行时 typeof __dirname === 'string'
  const cjsDir = typeof __dirname !== 'undefined' ? __dirname : undefined
  if (cjsDir && cjsDir !== '.') {
    return cjsDir
  }

  // ESM 源码路径（开发/测试直跑 tsx）
  // 注意：tsup CJS 输出中 import.meta 被替换为 var import_meta = {}
  // 所以 import.meta.url 在生产 bundle 中为 undefined，不会误入此分支
  // fileURLToPath 用顶层 import：node:url 是内置模块，tsup platform:'node' 自动 external 化；
  // CJS bundle 编译为 require('node:url')（运行时可用），但本分支在 CJS 中不执行（import.meta.url 为 undefined）
  if (typeof import.meta !== 'undefined' && import.meta.url) {
    try {
      return dirname(fileURLToPath(import.meta.url))
    // eslint-disable-next-line taste/no-silent-catch -- ESM path detection: fallthrough to CJS path is expected
    } catch (e: unknown) {
      console.debug('[plugin-host] ESM path resolution failed:', e)
    }
  }

  throw new Error(
    '[plugin-host] Cannot resolve plugin host directory: ' +
    'both __dirname and import.meta.url are unavailable. ' +
    'Ensure this module runs in Node.js (CJS bundle or ESM).',
  )
}

/**
 * 解析并验证 plugin-bootstrap.js 的路径。
 *
 * @param filename - 要查找的文件名（默认 'plugin-bootstrap.js'）
 * @returns 验证通过的绝对路径
 * @throws 包含期望路径和目录实际文件列表的清晰错误
 *
 * 同时供 PluginHostProcess（fork 版）复用——bootstrap 文件与 host 同目录的约定两处一致。
 */
export function resolveAndValidateFile(filename: string): string {
  const hostDir = resolvePluginHostDir()
  const filePath = resolve(hostDir, filename)

  if (existsSync(filePath)) return filePath

  // 收集诊断信息
  const diagnostics: string[] = [
    `Expected: ${filePath}`,
    `hostDir: ${hostDir}`,
  ]

  // 列出 hostDir 中的 .js 文件（帮助发现 dirname 多走一级等问题）
  try {
    const files = readdirSync(hostDir)
      .filter(f => f.endsWith('.js') || f.endsWith('.cjs') || f.endsWith('.mjs'))
    diagnostics.push(
      files.length > 0
        ? `Available in hostDir: ${files.join(', ')}`
        : `No JS files in hostDir`,
    )
  } catch {
    diagnostics.push(`hostDir does not exist or is not readable`)
  }

  // 检查上一级目录（dirname 多走一级的常见错误）
  const parentDir = dirname(hostDir)
  try {
    const parentFile = resolve(parentDir, filename)
    if (existsSync(parentFile)) {
      diagnostics.push(`HINT: Found at parent directory: ${parentFile} (dirname may have gone one level too deep)`,
      )
    }
    // eslint-disable-next-line taste/no-silent-catch -- diagnostic hint: failure to check parent dir must not block validation
  } catch (e: unknown) {
    console.debug('[plugin-host] parent dir check failed:', e)
  }

  throw new Error(
    `[plugin-host] Required file not found: ${filename}\n${diagnostics.join('\n')}`,
  )
}

const MAX_PLUGINS_PER_TRUSTED_WORKER = 10
const LOAD_PLUGIN_TIMEOUT_MS = 10_000
const MEMORY_MONITOR_DEFAULT_INTERVAL_MS = 30_000
const MAX_REBUILD_ATTEMPTS = 3
const REBUILD_COOLDOWN_MS = 5_000

/**
 * Host 侧收到 Worker/子进程 `{type:'rpc'}` 消息后的统一分发（单一真相，Fix-3）。
 *
 * Worker 发来的 RPC 消息可能有三种格式：
 * 1. `{ type: 'rpc', response: RpcResponse }` — 对 invoke 的响应（plugin-bootstrap postRpcResponse）
 * 2. `{ type: 'rpc', request: RpcRequest }` — Worker 主动发来的请求
 * 3. 扁平格式 `{ type: 'rpc', method, params, id }` — PluginRpcClient
 *
 * 消费方：PluginHost（Worker 版）、PluginHostProcess（fork 版）、e2e 测试 hostMessagePump
 * ——三处复用同一实现，主线程分发链变更时 e2e 即时覆盖。
 * 非 rpc 消息（fatal_error / activated / deactivated / error）由各宿主自行处理
 * （crash / reply 回调在两宿主指向不同实现）。
 */
export function dispatchHostRpcMessage(
  rpcServer: Pick<PluginRpcServer, 'handleResponse' | 'dispatch'>,
  workerId: string,
  msg: Record<string, unknown>,
): void {
  if (msg.response && typeof (msg.response as Record<string, unknown>).id !== 'undefined') {
    // 嵌套 response 格式: { type: 'rpc', response: RpcResponse }
    rpcServer.handleResponse(msg.response as unknown as RpcResponse)
  } else if (('result' in msg || 'error' in msg) && typeof msg.id === 'number') {
    // 扁平 response 格式: { type: 'rpc', id, result/error }
    rpcServer.handleResponse(msg as unknown as RpcResponse)
  } else if (msg.request && typeof (msg.request as Record<string, unknown>).method === 'string') {
    // Incoming RPC request from Worker
    void rpcServer.dispatch(workerId, msg.request as unknown as RpcRequest)
  } else if (typeof msg.method === 'string') {
    // Direct RpcRequest-style message
    void rpcServer.dispatch(workerId, msg as unknown as RpcRequest)
  }
}

type CrashCallback = (workerId: string, pluginIds: string[], error: string) => void
type ReplyCallback = (msg: unknown) => void

/**
 * PluginHost 的最小接口契约（P8 收口）。
 *
 * 此前该接口定义在 plugin-activator.ts（消费方），由本类（供应商）实现，构成
 * 「消费方拥有供应商契约」的坏味道 + 仅类型层的循环依赖。现收口到供应商本文件，
 * 由实现者拥有自己的契约。plugin-activator.ts 通过 re-export 以 `PluginHost` 之名
 * 继续对外暴露，保持所有现有导入（NON-BREAKING）。
 */
export interface PluginHostContract {
  /**
   * 为插件分配 Worker。
   * @param pluginDir 插件根目录绝对路径（sandbox 经此注入 fork 子进程 env XYZ_PLUGIN_SANDBOX_DIR；
   *   trusted 走 Worker 线程，忽略此参数）
   */
  assignWorker(pluginId: string, trustLevel: 'trusted' | 'sandbox', pluginDir?: string): Promise<string>
  /** pluginId 显式传入：load 消息的 pluginId 是子进程/Worker loadedModules 分区键，
   *  activate 按真实 pluginId 查找——从 pluginPath 推导在入口文件语义下会失配。 */
  loadPlugin(workerId: string, pluginId: string, pluginPath: string, trustLevel?: 'trusted' | 'sandbox'): Promise<void>
  terminateWorker(workerId: string): Promise<void>
  getWorkerHandle(pluginId: string): { workerId: string; postMessage(message: unknown): void } | undefined
}

export class PluginHost implements PluginHostContract {
  private workers = new Map<string, WorkerHandle>()
  private workerInstances = new Map<string, Worker>()
  private rpcServer: PluginRpcServer
  private onCrash: CrashCallback | null = null
  private onReply: ReplyCallback | null = null
  private memoryMonitorTimer: ReturnType<typeof setInterval> | null = null
  private trustedCounter = 0

  /**
   * pluginId → workerId 反向索引（D2-5：getWorkerHandle O(1)，替代全 worker 线性扫）。
   * assign/terminate/crash/rebuild/shutdown 同步维护；sandbox 插件不进此索引
   * （getWorkerHandle 未命中时转调子进程宿主）。
   */
  private pluginToWorker = new Map<string, string>()

  /** sandbox 插件子进程宿主（fork 版，惰性创建；无 sandbox 插件时不创建） */
  private processHost: PluginHostProcess | null = null
  private readonly processHostOptions?: PluginPoolOptions
  /** trusted Worker bootstrap mock 注入口（测试专用，由 PluginPoolOptions.workerBootstrapOverride 传入；详见该接口注释） */
  private readonly workerBootstrapOverride?: string

  /** Per-plugin crash counter */
  private crashCounts = new Map<string, number>()
  /** Saved pluginIds from crashed trusted workers for rebuild */
  private crashedTrustedWorkers = new Map<string, { pluginIds: string[]; trustLevel: 'trusted' }>()

  private static readonly MAX_REBUILD_ATTEMPTS = MAX_REBUILD_ATTEMPTS
  private static readonly REBUILD_COOLDOWN_MS = REBUILD_COOLDOWN_MS
  private rebuildCooldownMs = PluginHost.REBUILD_COOLDOWN_MS

  constructor(rpcServer: PluginRpcServer, processHostOptions?: PluginPoolOptions) {
    this.rpcServer = rpcServer
    this.processHostOptions = processHostOptions
    this.workerBootstrapOverride = processHostOptions?.workerBootstrapOverride
  }

  /** 设置 crash callback（含 Worker 重建后的重新加载） */
  setCrashCallback(cb: CrashCallback): void {
    this.onCrash = cb
  }

  /** 设置 Worker 重建后的重新加载回调 */
  private onRebuilt: ((newWorkerId: string, pluginIds: string[]) => void) | null = null

  /** 设置 Worker 重建回调（由 PluginService 调用） */
  setRebuiltCallback(cb: (newWorkerId: string, pluginIds: string[]) => void): void {
    this.onRebuilt = cb
  }

  /** 设置 Worker 生命周期回复的回调（activated/deactivated/error） */
  setReplyCallback(cb: ReplyCallback): void {
    this.onReply = cb
  }

  /**
   * 惰性创建子进程宿主（sandbox 插件首次分配时）。
   * crash/reply 回调转发到 PluginHost 自己的回调——sandbox 崩溃不计数不 rebuild
   * （rebuild 仅 trusted 语义，见 handleWorkerCrash）；幂等守卫在 PluginHostProcess 内部。
   */
  private ensureProcessHost(): PluginHostProcess {
    if (this.processHost) return this.processHost
    const host = new PluginHostProcess(this.rpcServer, this.processHostOptions)
    host.setCrashCallback((processId, pluginIds, error) => {
      this.onCrash?.(processId, pluginIds, error)
    })
    host.setReplyCallback((msg) => {
      this.onReply?.(msg)
    })
    this.processHost = host
    return host
  }

  /** 覆盖重建冷却时间（测试用） */
  setRebuildCooldownMs(ms: number): void {
    this.rebuildCooldownMs = ms
  }

  /** 获取指定插件的 crash 次数（测试用） */
  getCrashCount(pluginId: string): number {
    return this.crashCounts.get(pluginId) ?? 0
  }

  /**
   * 为插件分配 Worker。
   *
   * - sandbox: 每个插件独占一个子进程（pluginDir 注入 fork env，ESM loader 边界判定依赖）
   * - trusted: 查找有空位的 trusted Worker（≤10），没有则新建（pluginDir 忽略）
   */
  async assignWorker(pluginId: string, trustLevel: 'trusted' | 'sandbox', pluginDir?: string): Promise<string> {
    if (trustLevel === 'sandbox') {
      // sandbox 插件走子进程宿主（fork 隔离），不进 workers Map。
      // 进程复用由 PluginHostProcess.assignProcess 内部处理（sandbox 独占进程）。
      // pluginDir 注入 fork env XYZ_PLUGIN_SANDBOX_DIR（ESM loader initialize() 读此 env）。
      return this.ensureProcessHost().assignProcess(pluginId, 'sandbox', pluginDir)
    }

    // trusted: 复用空闲 Worker
    for (const [, handle] of this.workers) {
      if (
        handle.trustLevel === 'trusted' &&
        handle.status === 'active' &&
        handle.pluginIds.length < MAX_PLUGINS_PER_TRUSTED_WORKER
      ) {
        handle.pluginIds.push(pluginId)
        this.pluginToWorker.set(pluginId, handle.workerId)
        return handle.workerId
      }
    }

    this.trustedCounter++
    const workerId = `trusted-${this.trustedCounter}`
    return this.createWorker(workerId, 'trusted', pluginId).workerId
  }

  /**
   * 向指定 Worker 发送 load 指令，等待 loaded/error 响应。
   * pluginId 显式传入（loadedModules 分区键，见 PluginHostContract.loadPlugin 注释）。
   * 超时 10 秒后 reject。
   */
  async loadPlugin(workerId: string, pluginId: string, pluginPath: string, trustLevel?: 'trusted' | 'sandbox'): Promise<void> {
    if (workerId.startsWith('sandbox-')) {
      await this.ensureProcessHost().loadPlugin(workerId, pluginId, pluginPath, trustLevel ?? 'sandbox')
      return
    }
    const worker = this.workerInstances.get(workerId)
    if (!worker) throw new Error(`Worker not found: ${workerId}`)

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`loadPlugin timeout for worker ${workerId}`))
      }, LOAD_PLUGIN_TIMEOUT_MS)

      const onMessage = (msg: unknown) => {
        const m = msg as Record<string, unknown>
        if (m.type === 'loaded' || m.type === 'error') {
          clearTimeout(timeout)
          worker.off('message', onMessage)
          if (m.type === 'loaded') resolve()
          else reject(new Error(String(m.error ?? 'load failed')))
        }
      }
      worker.on('message', onMessage)
      worker.postMessage({
        type: 'load',
        pluginId,
        pluginPath,
        trustLevel: trustLevel ?? this.inferTrustLevel(workerId),
      })
    })
  }

  async terminateWorker(workerId: string): Promise<void> {
    if (workerId.startsWith('sandbox-')) {
      await this.ensureProcessHost().terminateProcess(workerId)
      return
    }
    const worker = this.workerInstances.get(workerId)
    if (!worker) return

    const handle = this.workers.get(workerId)
    // 预期终止先置状态：运行中 Worker 被 terminate() 时 exit code=1，
    // 不标记会被 exit handler 误判为崩溃（对齐 plugin-host-process 的 terminated 范式）
    if (handle) handle.status = 'terminated'
    if (handle) this.removeIndexEntries(workerId, handle.pluginIds)

    this.rpcServer.unregisterWorker(workerId)
    await worker.terminate()
    this.workerInstances.delete(workerId)
    this.workers.delete(workerId)
  }

  /**
   * 满足 PluginHostContract 接口：按 pluginId 查找 Worker，返回带 postMessage 的句柄。
   * 反向索引 O(1) 命中（D2-5）；未命中转调子进程宿主（sandbox 插件）。
   */
  getWorkerHandle(pluginId: string): { workerId: string; postMessage(message: unknown): void } | undefined {
    const workerId = this.pluginToWorker.get(pluginId)
    if (workerId !== undefined) {
      const worker = this.workerInstances.get(workerId)
      return {
        workerId,
        postMessage: (message: unknown) => worker?.postMessage(message),
      }
    }
    // sandbox 插件：转调子进程宿主（字段映射 processId → workerId，activator 消费 handle.workerId）
    const processHandle = this.processHost?.getProcessHandle(pluginId)
    if (processHandle) {
      return {
        workerId: processHandle.processId,
        postMessage: processHandle.postMessage,
      }
    }
    return undefined
  }

  /** 反向索引删除（带归属守卫：只删当前映射仍指向 workerId 的条目，防误删重建后的新映射） */
  private removeIndexEntries(workerId: string, pluginIds: string[]): void {
    for (const pid of pluginIds) {
      if (this.pluginToWorker.get(pid) === workerId) {
        this.pluginToWorker.delete(pid)
      }
    }
  }

  /** 按 workerId 查找 WorkerHandle（内部和测试用） */
  getWorkerHandleById(workerId: string): WorkerHandle | undefined {
    return this.workers.get(workerId)
  }

  getAllWorkers(): WorkerHandle[] {
    return [...this.workers.values()]
  }

  getWorkerInstance(workerId: string): Worker | undefined {
    return this.workerInstances.get(workerId)
  }

  /**
   * 定期刷新 Worker handle 的 lastActiveAt。
   * 未来可扩展为从 /proc 或 process.memoryUsage() 采集实际内存。
   */
  startMemoryMonitor(intervalMs: number = MEMORY_MONITOR_DEFAULT_INTERVAL_MS): void {
    if (this.memoryMonitorTimer) clearInterval(this.memoryMonitorTimer)
    this.memoryMonitorTimer = setInterval(() => {
      for (const [workerId] of this.workerInstances) {
        const handle = this.workers.get(workerId)
        if (!handle) continue
        handle.lastActiveAt = Date.now()
      }
    }, intervalMs)
  }

  async shutdown(): Promise<void> {
    if (this.memoryMonitorTimer) {
      clearInterval(this.memoryMonitorTimer)
      this.memoryMonitorTimer = null
    }
    // 子进程宿主先关（内部也 dispose rpcServer——dispose 幂等，重复调用无害）
    await this.processHost?.shutdown()
    // 同 terminateWorker：先统一置 terminated，terminate() 触发的 exit code=1 不误判崩溃
    for (const handle of this.workers.values()) handle.status = 'terminated'
    await Promise.allSettled(
      [...this.workerInstances.values()].map(w => w.terminate()),
    )
    this.workerInstances.clear()
    this.workers.clear()
    this.pluginToWorker.clear()
    this.rpcServer.dispose()
  }

  // ── Private ──────────────────────────────────────────────────────

  /** 从 workerId 推断 trustLevel（用于 loadPlugin 未显式指定时） */
  private inferTrustLevel(workerId: string): 'trusted' | 'sandbox' {
    const handle = this.workers.get(workerId)
    return handle?.trustLevel ?? 'sandbox'
  }

  private createWorker(
    workerId: string,
    trustLevel: 'trusted' | 'sandbox',
    pluginId: string,
  ): WorkerHandle {
    // 注意：本函数仅 trusted 路径调用（assignWorker 的 sandbox 分支已转调子进程宿主），
    // trustLevel 参数保留用于 handle 记录；sandbox 不会经过 new Worker。
    // plugin-bootstrap.js 与本文件（plugin-host）同目录
    // resolveAndValidateFile 在文件不存在时抛出含诊断信息的错误
    // 生产环境（CJS bundle）用 .cjs，开发/测试（JS 源码直跑）用 .js，
    // 测试场景经 workerBootstrapOverride 注入 mock（短路下方 resolve 链，不再写 src 目录）
    let bootstrapPath: string
    if (this.workerBootstrapOverride) {
      // 测试注入：短路 resolve 链，直接加载 mock（生产不传，走下方 .cjs → .js → .ts 链）
      bootstrapPath = this.workerBootstrapOverride
    } else {
      // 生产路径：.cjs（tsup bundle）命中首步；.js/.ts 为兜底——
      // .js 历史由测试 IO 写入（已移除），.ts Node Worker 无法直接加载，两者保留作兜底
      try {
        bootstrapPath = resolveAndValidateFile('plugin-bootstrap.cjs')
      } catch {
        try {
          bootstrapPath = resolveAndValidateFile('plugin-bootstrap.js')
        } catch {
          bootstrapPath = resolveAndValidateFile('plugin-bootstrap.ts')
        }
      }
    }

    let worker: Worker
    try {
      worker = new Worker(bootstrapPath, {
        name: workerId,
      })
    } catch (err: unknown) {
      // 区分路径错误 vs Worker 创建错误
      if (err instanceof Error && err.message.startsWith('[plugin-host] Required file not found')) {
        throw err // 路径验证错误，已包含完整诊断信息
      }
      console.error(`[plugin-host] failed to create worker ${workerId}:`, err)
      throw err
    }

    const handle: WorkerHandle = {
      workerId,
      threadId: worker.threadId,
      trustLevel,
      pluginIds: [pluginId],
      status: 'active',
      lastActiveAt: Date.now(),
      memoryUsage: undefined,
    }

    this.workers.set(workerId, handle)
    this.workerInstances.set(workerId, worker)
    this.pluginToWorker.set(pluginId, workerId)
    this.rpcServer.registerWorker(workerId, worker)

    worker.on('message', (msg: unknown) => {
      const m = msg as Record<string, unknown>
      if (m.type === 'rpc') {
        // 三种 RPC 消息格式的统一分发（Fix-3：与 plugin-host-process / e2e 共享单一真相）
        dispatchHostRpcMessage(this.rpcServer, workerId, m)
      } else if (m.type === 'fatal_error') {
        this.handleWorkerCrash(workerId, String(m.error ?? 'unknown'))
      } else if (
        m.type === 'activated' ||
        m.type === 'deactivated' ||
        m.type === 'error'
      ) {
        // 生命周期回复：转发给 Activator
        this.onReply?.(msg)
        if (m.type === 'error') {
          console.error(`[plugin-host] plugin error: ${(m as { pluginId?: string }).pluginId}: ${m.error}`)
        }
      }
    })

    worker.on('error', (err: Error) => {
      console.error(`[plugin-host] worker ${workerId} error:`, err.message)
      this.handleWorkerCrash(workerId, err.message)
    })

    worker.on('exit', (code: number) => {
      if (code !== 0) {
        console.error(`[plugin-host] worker ${workerId} exited with code ${code}`)
        this.handleWorkerCrash(workerId, `Worker exited with code ${code}`)
      }
    })

    return handle
  }

  private handleWorkerCrash(workerId: string, error: string): void {
    const handle = this.workers.get(workerId)
    if (!handle || handle.status === 'crashed' || handle.status === 'terminated') return

    handle.status = 'crashed'
    const pluginIds = [...handle.pluginIds]
    const trustLevel = handle.trustLevel
    this.rpcServer.unregisterWorker(workerId)
    this.removeIndexEntries(workerId, pluginIds)

    if (trustLevel === 'trusted') {
      // Save plugin info for potential rebuild before cleanup
      this.crashedTrustedWorkers.set(workerId, { pluginIds, trustLevel })
      this.workerInstances.delete(workerId)
      this.workers.delete(workerId)

      // Increment crash counts per plugin
      for (const pluginId of pluginIds) {
        const count = (this.crashCounts.get(pluginId) ?? 0) + 1
        this.crashCounts.set(pluginId, count)
      }

      // Schedule rebuild attempt
      const maxAttempts = PluginHost.MAX_REBUILD_ATTEMPTS
      const exceeded = pluginIds.some(pid => (this.crashCounts.get(pid) ?? 0) > maxAttempts)
      if (!exceeded) {
        setTimeout(() => {
          this.rebuildWorker(workerId, pluginIds).catch((err: unknown) => {
            console.error(`[plugin-host] rebuild failed for ${workerId}:`, err)
          })
        }, this.rebuildCooldownMs)
      } else {
        console.warn(`[plugin-host] ${pluginIds.join(',')} exceeded max rebuild attempts (${maxAttempts})`)
      }
    }

    this.onCrash?.(workerId, pluginIds, error)
  }

  /**
   * Rebuild a crashed trusted worker.
   * Creates a new Worker and re-assigns the same plugins.
   */
  private async rebuildWorker(oldWorkerId: string, pluginIds: string[]): Promise<void> {
    const info = this.crashedTrustedWorkers.get(oldWorkerId)
    if (!info) return

    this.crashedTrustedWorkers.delete(oldWorkerId)

    // Create a new trusted worker with the first plugin
    if (pluginIds.length === 0) return

    this.trustedCounter++
    const newWorkerId = `trusted-${this.trustedCounter}`
    const primaryPluginId = pluginIds[0]

    const handle = this.createWorker(newWorkerId, 'trusted', primaryPluginId)

    // Add remaining plugins to the shared worker
    for (let i = 1; i < pluginIds.length; i++) {
      handle.pluginIds.push(pluginIds[i])
      this.pluginToWorker.set(pluginIds[i], newWorkerId)
    }

    console.log(`[plugin-host] rebuilt trusted worker ${oldWorkerId} as ${newWorkerId} for plugins: ${pluginIds.join(',')}`)

    // Notify listener to reload plugins into the new worker
    this.onRebuilt?.(newWorkerId, pluginIds)
  }
}
