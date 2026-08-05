/**
 * 子进程池管理器（fork 版，PluginHostProcess）
 *
 * 负责创建/复用子进程（child_process.fork）、加载插件、崩溃检测与清理。
 * 与 PluginHost（Worker 版）职责同构，接口对齐 PluginHostContract（wiring 层无痛切换）：
 * - sandbox 插件独占子进程；trusted 插件共享（≤10 插件/进程）
 * - IPC 走 fork 默认 channel（child.send/process.on('message')），经 WorkerPort 适配
 *   （{ postMessage: child.send }）注册进 PluginRpcServer——HostToWorkerMessage 消息族零改动复用
 * - 崩溃检测：exit（非 0）/ error / disconnect / fatal_error 消息 → crash 回调（status 幂等守卫）
 *
 * 打包约束（AGENTS.md #12）：
 * - fork 必须用 process.execPath + env ELECTRON_RUN_AS_NODE='1'（打包后无独立 node）
 * - bootstrap 路径经 resolveAndValidateFile 验证（与 plugin-bootstrap.cjs 同目录约定）
 */

import { fork, type ChildProcess, type Serializable } from 'node:child_process'
import type { ProcessHandle, RpcRequest, RpcResponse } from './plugin-types.js'
import { PluginRpcServer } from './plugin-rpc-server.js'
import { resolveAndValidateFile } from './plugin-host.js'

const MAX_PLUGINS_PER_TRUSTED_PROCESS = 10
const LOAD_PLUGIN_TIMEOUT_MS = 10_000
/** shutdown 等待子进程退出的上限（超过则 SIGKILL） */
const SHUTDOWN_KILL_TIMEOUT_MS = 2000

type CrashCallback = (processId: string, pluginIds: string[], error: string) => void
type ReplyCallback = (msg: unknown) => void

/**
 * PluginHostProcess 的最小接口契约（对齐 PluginHostContract，wiring 层无痛接入）。
 * 由本文件拥有契约，plugin-lifecycle/plugin-service 通过 re-export 消费。
 */
export interface PluginHostProcessContract {
  assignProcess(pluginId: string, trustLevel: 'trusted' | 'sandbox'): Promise<string>
  loadPlugin(processId: string, pluginPath: string, trustLevel?: 'trusted' | 'sandbox'): Promise<void>
  terminateProcess(processId: string): Promise<void>
  getProcessHandle(pluginId: string): { processId: string; postMessage(message: unknown): void } | undefined
}

export interface PluginHostProcessOptions {
  /** 测试注入：fork 目标文件绝对路径（默认走 resolveAndValidateFile 链） */
  bootstrapPathOverride?: string
  /** fork execArgv（ESM loader 经 --import 注入点；默认空，不继承父进程 flags） */
  execArgv?: string[]
  /** loadPlugin 超时（测试注入短超时用；默认 10s） */
  loadTimeoutMs?: number
}

export class PluginHostProcess implements PluginHostProcessContract {
  private processes = new Map<string, ProcessHandle>()
  private processInstances = new Map<string, ChildProcess>()
  private rpcServer: PluginRpcServer
  private onCrash: CrashCallback | null = null
  private onReply: ReplyCallback | null = null
  private trustedCounter = 0
  private readonly bootstrapPathOverride?: string
  private readonly execArgv: string[]
  private readonly loadTimeoutMs: number

  constructor(rpcServer: PluginRpcServer, options?: PluginHostProcessOptions) {
    this.rpcServer = rpcServer
    this.bootstrapPathOverride = options?.bootstrapPathOverride
    this.execArgv = options?.execArgv ?? []
    this.loadTimeoutMs = options?.loadTimeoutMs ?? LOAD_PLUGIN_TIMEOUT_MS
  }

  /** 设置 crash callback（子进程崩溃时触发，含 pluginIds） */
  setCrashCallback(cb: CrashCallback): void {
    this.onCrash = cb
  }

  /** 设置生命周期回复的回调（activated/deactivated/error） */
  setReplyCallback(cb: ReplyCallback): void {
    this.onReply = cb
  }

  /**
   * 为插件分配子进程。
   *
   * - sandbox: 每个插件独占一个子进程
   * - trusted: 查找有空位的 trusted 子进程（≤10），没有则新建
   */
  async assignProcess(pluginId: string, trustLevel: 'trusted' | 'sandbox'): Promise<string> {
    if (trustLevel === 'sandbox') {
      const processId = `sandbox-${pluginId}`
      const existing = this.processes.get(processId)
      if (existing && existing.status === 'active') {
        existing.pluginIds.push(pluginId)
        return processId
      }
      return this.createProcess(processId, 'sandbox', pluginId).processId
    }

    // trusted: 复用空闲子进程
    for (const [, handle] of this.processes) {
      if (
        handle.trustLevel === 'trusted' &&
        handle.status === 'active' &&
        handle.pluginIds.length < MAX_PLUGINS_PER_TRUSTED_PROCESS
      ) {
        handle.pluginIds.push(pluginId)
        return handle.processId
      }
    }

    this.trustedCounter++
    const processId = `trusted-${this.trustedCounter}`
    return this.createProcess(processId, 'trusted', pluginId).processId
  }

  /**
   * 向指定子进程发送 load 指令，等待 loaded/error 响应。
   * 超时（loadTimeoutMs）后 reject 并清理该子进程（E2：宿主清理）。
   */
  async loadPlugin(processId: string, pluginPath: string, trustLevel?: 'trusted' | 'sandbox'): Promise<void> {
    const child = this.processInstances.get(processId)
    if (!child) throw new Error(`Process not found: ${processId}`)

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`loadPlugin timeout for process ${processId}`))
        // E2: 超时后宿主清理该子进程（kill + unregister）
        this.terminateProcess(processId).catch((e: unknown) => {
          console.debug(`[plugin-host-process] cleanup after load timeout failed for ${processId}:`, e)
        })
      }, this.loadTimeoutMs)

      const onMessage = (msg: unknown) => {
        const m = msg as Record<string, unknown>
        if (m.type === 'loaded' || m.type === 'error') {
          clearTimeout(timeout)
          child.off('message', onMessage)
          if (m.type === 'loaded') resolve()
          else reject(new Error(String(m.error ?? 'load failed')))
        }
      }
      child.on('message', onMessage)
      child.send({
        type: 'load',
        pluginId: pluginPath.split('/').pop() ?? 'unknown',
        pluginPath,
        trustLevel: trustLevel ?? this.inferTrustLevel(processId),
      })
    })
  }

  /**
   * 终止子进程并清理注册。
   * 先置 status='terminated' 再 kill——kill 后 exit/disconnect 事件到达时被幂等守卫拦截，
   * 不会误触发 crash 回调（R3）。
   */
  async terminateProcess(processId: string): Promise<void> {
    const child = this.processInstances.get(processId)
    if (!child) return

    const handle = this.processes.get(processId)
    if (handle) handle.status = 'terminated'

    this.rpcServer.unregisterWorker(processId)
    this.processInstances.delete(processId)
    this.processes.delete(processId)

    try {
      child.kill()
    } catch (e: unknown) {
      // kill 失败（进程已死/权限）不阻塞清理
      console.debug(`[plugin-host-process] kill failed for ${processId}:`, e)
    }
  }

  /** 满足 PluginHostProcessContract：按 pluginId 查找子进程，返回带 postMessage 的句柄 */
  getProcessHandle(pluginId: string): { processId: string; postMessage(message: unknown): void } | undefined {
    for (const handle of this.processes.values()) {
      if (handle.pluginIds.includes(pluginId)) {
        const child = this.processInstances.get(handle.processId)
        return {
          processId: handle.processId,
          postMessage: (message: unknown) => {
            try {
              child?.send(message as Serializable)
            } catch (e: unknown) {
              // IPC channel 已关闭（子进程崩溃/terminated 后的 in-flight 消息）不抛
              console.debug(`[plugin-host-process] send failed for ${handle.processId}:`, e)
            }
          },
        }
      }
    }
    return undefined
  }

  /** 按 processId 查找 ProcessHandle（内部和测试用） */
  getProcessHandleById(processId: string): ProcessHandle | undefined {
    return this.processes.get(processId)
  }

  getAllProcesses(): ProcessHandle[] {
    return [...this.processes.values()]
  }

  /** 关闭所有子进程并释放 rpcServer */
  async shutdown(): Promise<void> {
    const children = [...this.processInstances.values()]
    await Promise.allSettled(
      children.map((child) => {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
        return new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch (e: unknown) {
              // best-effort：进程可能刚退出，kill 抛错不阻塞 shutdown
              console.debug(`[plugin-host-process] SIGKILL failed for shutdown:`, e)
            }
            resolve()
          }, SHUTDOWN_KILL_TIMEOUT_MS)
          timer.unref?.()
          child.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
          try {
            child.kill()
          } catch (e: unknown) {
            // best-effort：进程可能已退出，kill 抛错不阻塞 shutdown
            console.debug(`[plugin-host-process] kill failed during shutdown:`, e)
          }
        })
      }),
    )
    this.processInstances.clear()
    this.processes.clear()
    this.rpcServer.dispose()
  }

  // ── Private ──────────────────────────────────────────────────────

  /** 从 processId 推断 trustLevel（用于 loadPlugin 未显式指定时） */
  private inferTrustLevel(processId: string): 'trusted' | 'sandbox' {
    const handle = this.processes.get(processId)
    return handle?.trustLevel ?? 'sandbox'
  }

  private createProcess(
    processId: string,
    trustLevel: 'trusted' | 'sandbox',
    pluginId: string,
  ): ProcessHandle {
    // bootstrap 路径：测试 override 优先；生产走 resolveAndValidateFile 链
    // （plugin-bootstrap-process.cjs → .js → .ts，与 plugin-host 的 .cjs/.js/.ts 同约定）
    let bootstrapPath: string
    if (this.bootstrapPathOverride) {
      bootstrapPath = this.bootstrapPathOverride
    } else {
      try {
        bootstrapPath = resolveAndValidateFile('plugin-bootstrap-process.cjs')
      } catch {
        try {
          bootstrapPath = resolveAndValidateFile('plugin-bootstrap-process.js')
        } catch {
          bootstrapPath = resolveAndValidateFile('plugin-bootstrap-process.ts')
        }
      }
    }

    let child: ChildProcess
    try {
      child = fork(bootstrapPath, [], {
        // 打包约束（AGENTS.md #12）：必须 process.execPath + ELECTRON_RUN_AS_NODE=1
        // （打包后无独立 node；node 环境该 env 无害被忽略）
        execPath: process.execPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        // R2：stdout/stderr 显式 pipe 接管（防污染 runtime JSONL 事件流），数据转发 logger 落盘
        // 注意：fork 要求 stdio 含 'ipc'（默认自动追加，显式覆盖时必须保留）
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        // C3：ESM loader 经 --import 注入点（默认空，不继承父进程 flags 保持子进程干净）
        execArgv: this.execArgv,
      })
    } catch (err: unknown) {
      console.error(`[plugin-host-process] failed to fork process ${processId}:`, err)
      throw new Error(`FORK_FAILED for ${processId}: ${String(err)}`)
    }

    // 子进程输出转发 runtime logger（console 已由 logger monkey-patch 落盘）
    child.stdout?.on('data', (d: Buffer) => {
      const line = String(d).trimEnd()
      if (line) console.log(`[plugin-process:${processId}] ${line}`)
    })
    child.stderr?.on('data', (d: Buffer) => {
      const line = String(d).trimEnd()
      if (line) console.error(`[plugin-process:${processId}] ${line}`)
    })

    const handle: ProcessHandle = {
      processId,
      pid: child.pid ?? -1,
      trustLevel,
      pluginIds: [pluginId],
      status: 'active',
      lastActiveAt: Date.now(),
    }

    this.processes.set(processId, handle)
    this.processInstances.set(processId, child)
    // WorkerPort 适配：child.send → postMessage（IPC channel 与 Worker postMessage 语义同构）
    this.rpcServer.registerWorker(processId, {
      postMessage: (message: unknown) => {
        try {
          child.send(message as Serializable)
        } catch (e: unknown) {
          // best-effort：子进程已崩溃/terminated 时 IPC channel 关闭，send 抛错属预期，不传播
          console.debug(`[plugin-host-process] send failed for ${processId}:`, e)
        }
      },
    })

    child.on('message', (msg: unknown) => {
      const m = msg as Record<string, unknown>
      if (m.type === 'rpc') {
        // 子进程发来的 RPC 消息格式与 Worker 版一致（TR1：分发逻辑复制，独立维护）：
        // 1. { type: 'rpc', response: RpcResponse } — 对 invoke 的响应
        // 2. { type: 'rpc', request: RpcRequest } — 子进程主动发来的请求
        // 3. 扁平格式 { type: 'rpc', method, params, id }
        const rpcMsg = m as Record<string, unknown>
        if (rpcMsg.response && typeof (rpcMsg.response as Record<string, unknown>).id !== 'undefined') {
          this.rpcServer.handleResponse(rpcMsg.response as unknown as RpcResponse)
        } else if (('result' in rpcMsg || 'error' in rpcMsg) && typeof rpcMsg.id === 'number') {
          this.rpcServer.handleResponse(rpcMsg as unknown as RpcResponse)
        } else if (rpcMsg.request && typeof (rpcMsg.request as Record<string, unknown>).method === 'string') {
          this.rpcServer.dispatch(processId, rpcMsg.request as unknown as RpcRequest)
        } else if (typeof rpcMsg.method === 'string') {
          this.rpcServer.dispatch(processId, m as unknown as RpcRequest)
        }
      } else if (m.type === 'fatal_error') {
        this.handleProcessCrash(processId, String(m.error ?? 'unknown'))
      } else if (
        m.type === 'activated' ||
        m.type === 'deactivated' ||
        m.type === 'error'
      ) {
        // 生命周期回复：转发给 Activator
        this.onReply?.(msg)
        if (m.type === 'error') {
          console.error(`[plugin-host-process] plugin error: ${(m as { pluginId?: string }).pluginId}: ${m.error}`)
        }
      }
    })

    child.on('error', (err: Error) => {
      console.error(`[plugin-host-process] process ${processId} error:`, err.message)
      this.handleProcessCrash(processId, err.message)
    })

    // disconnect 先于 exit 到达（R3）：统一走 crash 处理，幂等守卫拦截正常 terminate 场景
    child.on('disconnect', () => {
      this.handleProcessCrash(processId, 'Child process IPC channel disconnected')
    })

    child.on('exit', (code: number | null, signal: string | null) => {
      if (code !== 0) {
        console.error(`[plugin-host-process] process ${processId} exited with code ${code} signal ${signal}`)
        this.handleProcessCrash(processId, `Child process exited with code ${code}`)
      }
    })

    return handle
  }

  /**
   * 崩溃统一处理：status 幂等守卫（crashed/terminated 不重复触发）。
   * 对齐 handleWorkerCrash 语义；重启 outOfScope（C5，由上层 wiring 决定）。
   */
  private handleProcessCrash(processId: string, error: string): void {
    const handle = this.processes.get(processId)
    if (!handle || handle.status === 'crashed' || handle.status === 'terminated') return

    handle.status = 'crashed'
    const pluginIds = [...handle.pluginIds]
    this.rpcServer.unregisterWorker(processId)

    this.onCrash?.(processId, pluginIds, error)
  }
}
