/**
 * Worker Thread 池管理器
 *
 * 负责创建/复用 Worker、加载插件、崩溃恢复和资源监控。
 * trusted 插件共享 Worker（最多 10 个），sandbox 插件独占 Worker。
 */

import { Worker } from 'node:worker_threads'
import { resolve, dirname } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import type { WorkerHandle, RpcRequest } from './plugin-types.js'
import type { PluginHost as ActivatorHost } from './plugin-activator.js'
import { PluginRpcServer } from './plugin-rpc-server.js'

/**
 * 解析 plugin-host.ts 所在目录。
 *
 * - CJS bundle（tsup 产物）: __dirname 由 tsup 注入
 * - ESM 源码（开发/测试）: 通过 import.meta.url 推导
 * - 均不可用时抛出清晰错误
 */
function resolvePluginHostDir(): string {
  // __dirname 在 tsup CJS bundle 中由运行时注入，ESM 源码直跑时为 undefined
  // 用 globalThis 访问避免 @ts-expect-error/@ts-ignore 的 tsc vs eslint 冲突
  const dir = (globalThis as Record<string, unknown>).__dirname
  if (typeof dir === 'string' && dir) {
    // 开发模式下交叉验证 import.meta.url（仅在两者都可用时）
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- 动态 require 避免顶层 import 在 CJS bundle 中报错
        const { fileURLToPath } = require('node:url') as typeof import('node:url')
        const metaDir = dirname(fileURLToPath(import.meta.url))
        if (metaDir !== dir) {
          console.warn(
            `[plugin-host] path divergence detected: __dirname=${dir} vs import.meta.url→${metaDir}. ` +
            `Using __dirname (CJS bundle path).`,
          )
        }
      } catch {
        // fileURLToPath 不可用则跳过交叉验证
      }
    }
    return dir
  }

  // ESM 源码路径（开发/测试直跑 tsx）
  if (typeof import.meta !== 'undefined' && import.meta.url) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- 动态 require 避免顶层 import 在 CJS bundle 中报错
      const { fileURLToPath } = require('node:url') as typeof import('node:url')
      return dirname(fileURLToPath(import.meta.url))
    } catch {
      // fallthrough
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
 */
function resolveAndValidateFile(filename: string): string {
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
  } catch {
    // ignore
  }

  throw new Error(
    `[plugin-host] Required file not found: ${filename}\n${diagnostics.join('\n')}`,
  )
}

type CrashCallback = (workerId: string, pluginIds: string[], error: string) => void
type ReplyCallback = (msg: unknown) => void

export class PluginHost implements ActivatorHost {
  private workers = new Map<string, WorkerHandle>()
  private workerInstances = new Map<string, Worker>()
  private rpcServer: PluginRpcServer
  private onCrash: CrashCallback | null = null
  private onReply: ReplyCallback | null = null
  private memoryMonitorTimer: ReturnType<typeof setInterval> | null = null
  private trustedCounter = 0

  /** Per-plugin crash counter */
  private crashCounts = new Map<string, number>()
  /** Saved pluginIds from crashed trusted workers for rebuild */
  private crashedTrustedWorkers = new Map<string, { pluginIds: string[]; trustLevel: 'trusted' }>()

  private static readonly MAX_REBUILD_ATTEMPTS = 3
  private rebuildCooldownMs = 5_000

  constructor(rpcServer: PluginRpcServer) {
    this.rpcServer = rpcServer
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
   * - sandbox: 每个插件独占一个 Worker
   * - trusted: 查找有空位的 trusted Worker（≤10），没有则新建
   */
  async assignWorker(pluginId: string, trustLevel: 'trusted' | 'sandbox'): Promise<string> {
    if (trustLevel === 'sandbox') {
      const workerId = `sandbox-${pluginId}`
      const existing = this.workers.get(workerId)
      if (existing && existing.status === 'active') {
        existing.pluginIds.push(pluginId)
        return workerId
      }
      return this.createWorker(workerId, 'sandbox', pluginId).workerId
    }

    // trusted: 复用空闲 Worker
    for (const [, handle] of this.workers) {
      if (
        handle.trustLevel === 'trusted' &&
        handle.status === 'active' &&
        handle.pluginIds.length < 10
      ) {
        handle.pluginIds.push(pluginId)
        return handle.workerId
      }
    }

    this.trustedCounter++
    const workerId = `trusted-${this.trustedCounter}`
    return this.createWorker(workerId, 'trusted', pluginId).workerId
  }

  /**
   * 向指定 Worker 发送 load 指令，等待 loaded/error 响应。
   * 超时 10 秒后 reject。
   */
  async loadPlugin(workerId: string, pluginPath: string, trustLevel?: 'trusted' | 'sandbox'): Promise<void> {
    const worker = this.workerInstances.get(workerId)
    if (!worker) throw new Error(`Worker not found: ${workerId}`)

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`loadPlugin timeout for worker ${workerId}`))
      }, 10_000)

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
        pluginId: pluginPath.split('/').pop() ?? 'unknown',
        pluginPath,
        trustLevel: trustLevel ?? this.inferTrustLevel(workerId),
      })
    })
  }

  async terminateWorker(workerId: string): Promise<void> {
    const worker = this.workerInstances.get(workerId)
    if (!worker) return

    this.rpcServer.unregisterWorker(workerId)
    await worker.terminate()
    this.workerInstances.delete(workerId)
    this.workers.delete(workerId)
  }

  /**
   * 满足 ActivatorHost 接口：按 pluginId 查找 Worker，返回带 postMessage 的句柄。
   */
  getWorkerHandle(pluginId: string): { workerId: string; postMessage(message: unknown): void } | undefined {
    for (const handle of this.workers.values()) {
      if (handle.pluginIds.includes(pluginId)) {
        const worker = this.workerInstances.get(handle.workerId)
        return {
          workerId: handle.workerId,
          postMessage: (message: unknown) => worker?.postMessage(message),
        }
      }
    }
    return undefined
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
  startMemoryMonitor(intervalMs: number = 30_000): void {
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
    await Promise.all(
      [...this.workerInstances.values()].map(w => w.terminate()),
    )
    this.workerInstances.clear()
    this.workers.clear()
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
    // plugin-bootstrap.js 与本文件（plugin-host）同目录
    // resolveAndValidateFile 在文件不存在时抛出含诊断信息的错误
    const bootstrapPath = resolveAndValidateFile('plugin-bootstrap.js')

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
    this.rpcServer.registerWorker(workerId, worker)

    worker.on('message', (msg: unknown) => {
      const m = msg as Record<string, unknown>
      if (m.type === 'rpc') {
        // Worker 发来的 RPC 消息可能有三种格式：
        // 1. { type: 'rpc', response: RpcResponse } — 对 invoke 的响应（plugin-bootstrap postRpcResponse）
        // 2. { type: 'rpc', request: RpcRequest } — Worker 主动发来的请求
        // 3. 扁平格式 { type: 'rpc', method, params, id } — PluginRpcClient
        const rpcMsg = m as Record<string, unknown>
        if (rpcMsg.response && typeof (rpcMsg.response as Record<string, unknown>).id !== 'undefined') {
          // 嵌套 response 格式: { type: 'rpc', response: RpcResponse }
          this.rpcServer.handleResponse(rpcMsg.response as unknown as import('./plugin-types.js').RpcResponse)
        } else if (('result' in rpcMsg || 'error' in rpcMsg) && typeof rpcMsg.id === 'number') {
          // 扁平 response 格式: { type: 'rpc', id, result/error }
          this.rpcServer.handleResponse(rpcMsg as unknown as import('./plugin-types.js').RpcResponse)
        } else if (rpcMsg.request && typeof (rpcMsg.request as Record<string, unknown>).method === 'string') {
          // Incoming RPC request from Worker
          this.rpcServer.dispatch(workerId, (rpcMsg.request as unknown as RpcRequest))
        } else if (typeof rpcMsg.method === 'string') {
          // Direct RpcRequest-style message
          this.rpcServer.dispatch(workerId, m as unknown as RpcRequest)
        }
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
    }

    console.log(`[plugin-host] rebuilt trusted worker ${oldWorkerId} as ${newWorkerId} for plugins: ${pluginIds.join(',')}`)

    // Notify listener to reload plugins into the new worker
    this.onRebuilt?.(newWorkerId, pluginIds)
  }
}
