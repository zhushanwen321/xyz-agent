/**
 * Worker Thread 池管理器
 *
 * 负责创建/复用 Worker、加载插件、崩溃恢复和资源监控。
 * trusted 插件共享 Worker（最多 10 个），sandbox 插件独占 Worker。
 */

import { Worker } from 'node:worker_threads'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkerHandle, RpcRequest } from './plugin-types.js'
import type { PluginHost as ActivatorHost } from './plugin-activator.js'
import { PluginRpcServer } from './plugin-rpc-server.js'

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

  constructor(rpcServer: PluginRpcServer) {
    this.rpcServer = rpcServer
  }

  setCrashCallback(cb: CrashCallback): void {
    this.onCrash = cb
  }

  /** 设置 Worker 生命周期回复的回调（activated/deactivated/error） */
  setReplyCallback(cb: ReplyCallback): void {
    this.onReply = cb
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
    // 编译后的 bootstrap 脚本与 plugin-host.js 同目录
    const bootstrapPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      'plugin-bootstrap.js',
    )

    let worker: Worker
    try {
      worker = new Worker(bootstrapPath, {
        name: workerId,
      })
    } catch (err: unknown) {
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
        // RPC 请求/通知：转发给 PluginRpcServer
        this.rpcServer.dispatch(workerId, m as unknown as RpcRequest)
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
    this.rpcServer.unregisterWorker(workerId)

    // TODO (Phase 2): 如果是 trusted Worker，标记为需要重建，
    // 等待下次 assignWorker 时自动重新创建。
    // Phase 1 先不实现重建逻辑，仅清理状态。
    if (handle.trustLevel === 'trusted') {
      this.workerInstances.delete(workerId)
      this.workers.delete(workerId)
    }

    this.onCrash?.(workerId, pluginIds, error)
  }
}
