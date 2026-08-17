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
import type { ProcessHandle } from './plugin-types.js'
import { PluginRpcServer } from './plugin-rpc-server.js'
import { resolveAndValidateFile, dispatchHostRpcMessage } from './plugin-host.js'

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
  /**
   * 为插件分配子进程。
   * @param pluginDir 插件根目录绝对路径（sandbox 必传，注入 fork env XYZ_PLUGIN_SANDBOX_DIR；
   *   ESM loader 的 initialize() 在进程启动时读该 env，缺失 fail-closed throw，
   *   故 sandbox 进程必须在 fork 前拿到 pluginDir——loadPlugin 时机太晚）。
   */
  assignProcess(pluginId: string, trustLevel: 'trusted' | 'sandbox', pluginDir?: string): Promise<string>
  loadPlugin(processId: string, pluginId: string, pluginPath: string, trustLevel?: 'trusted' | 'sandbox'): Promise<void>
  terminateProcess(processId: string): Promise<void>
  getProcessHandle(pluginId: string): { processId: string; postMessage(message: unknown): void } | undefined
}

/**
 * PluginHost / PluginHostProcess 共享的构造选项（插件池统一配置）。
 *
 * 此接口同时被两个宿主消费：
 *   - PluginHost（Worker 线程版）读 workerBootstrapOverride（trusted Worker bootstrap 注入口）
 *   - PluginHostProcess（fork 子进程版）读 bootstrapPathOverride（fork 子进程 bootstrap 注入口）
 * 两者互不影响。production 构造任一宿主时不传任何 override，各自走 resolveAndValidateFile（.cjs → .js → .ts）链。
 */
export interface PluginPoolOptions {
  /** 测试注入：fork 子进程 bootstrap 目标文件绝对路径（默认走 resolveAndValidateFile 链）。由 PluginHostProcess 消费 */
  bootstrapPathOverride?: string
  /**
   * 测试注入：trusted Worker 线程 bootstrap 的 mock 注入口，与 bootstrapPathOverride（fork 子进程 mock
   * 注入）对偶；由 PluginHost 消费。生产不传——createWorker 走原 resolveAndValidateFile
   * （'.cjs' → '.js' → '.ts'）链：生产 .cjs bundle 命中首步，测试环境（无 bundle）fallback 至 .ts
   * 但 Node Worker 不能加载 .ts，故测试场景 trusted 必须传 override 短路 resolve 链加载 mock。
   */
  workerBootstrapOverride?: string
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

  /** pluginId → processId 反向索引（D2-5：getProcessHandle O(1)，替代全进程线性扫） */
  private pluginToProcess = new Map<string, string>()

  constructor(rpcServer: PluginRpcServer, options?: PluginPoolOptions) {
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
   * - sandbox: 每个插件独占一个子进程（pluginDir 注入 fork env XYZ_PLUGIN_SANDBOX_DIR，
   *   供 ESM loader initialize() 在进程启动时读取——晚于 fork 的 loadPlugin 时机无法注入）
   * - trusted: 查找有空位的 trusted 子进程（≤10），没有则新建
   */
  async assignProcess(pluginId: string, trustLevel: 'trusted' | 'sandbox', pluginDir?: string): Promise<string> {
    if (trustLevel === 'sandbox') {
      const processId = `sandbox-${pluginId}`
      const existing = this.processes.get(processId)
      if (existing && existing.status === 'active') {
        // M6a-06：复用分支去重——deactivate 不 terminate 进程，每次重激活都会命中
        // 此分支，重复 push 会让 pluginIds 随激活次数累积（崩溃回调收到重复 id）
        if (!existing.pluginIds.includes(pluginId)) {
          existing.pluginIds.push(pluginId)
        }
        this.pluginToProcess.set(pluginId, processId)
        return processId
      }
      return this.createProcess(processId, 'sandbox', pluginId, pluginDir).processId
    }

    // trusted: 复用空闲子进程
    for (const [, handle] of this.processes) {
      if (
        handle.trustLevel === 'trusted' &&
        handle.status === 'active' &&
        handle.pluginIds.length < MAX_PLUGINS_PER_TRUSTED_PROCESS
      ) {
        handle.pluginIds.push(pluginId)
        this.pluginToProcess.set(pluginId, handle.processId)
        return handle.processId
      }
    }

    this.trustedCounter++
    const processId = `trusted-${this.trustedCounter}`
    return this.createProcess(processId, 'trusted', pluginId).processId
  }

  /**
   * 向指定子进程发送 load 指令，等待 loaded/error 响应。
   *
   * pluginId 必须显式传入（F1 修复链路）：load 消息的 pluginId 是子进程
   * loadedModules 的分区键，activate 消息按真实 pluginId 查找。旧实现从
   * pluginPath 末段推导（目录时代假设），pluginPath 改为入口文件后 pop 出
   * 'index.js' 之类文件名 → loadedModules 键失配 → activate 报 Module not loaded。
   * 超时（loadTimeoutMs）后 reject 并清理该子进程（E2：宿主清理）。
   */
  async loadPlugin(processId: string, pluginId: string, pluginPath: string, trustLevel?: 'trusted' | 'sandbox'): Promise<void> {
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
        pluginId,
        pluginPath,
        trustLevel: trustLevel ?? this.inferTrustLevel(processId),
      })
    })
  }

  /**
   * 终止子进程并清理注册。
   * 先置 status='terminated' 再 graceful kill（SIGTERM→SHUTDOWN_KILL_TIMEOUT_MS→SIGKILL），
   * 与 shutdown() 升级链对称——避免恶意/卡死子进程抵抗 SIGTERM 导致 orphan 泄漏
   *（MF-3：hot-reload/deactivate 路径的旧版子进程残留）。kill 后 exit/disconnect 事件
   * 到达时被幂等守卫拦截，不会误触发 crash 回调（R3）。
   */
  async terminateProcess(processId: string): Promise<void> {
    const child = this.processInstances.get(processId)
    if (!child) return

    const handle = this.processes.get(processId)
    if (handle) {
      handle.status = 'terminated'
      this.removeIndexEntries(processId, handle.pluginIds)
    }

    this.rpcServer.unregisterWorker(processId)
    this.processInstances.delete(processId)
    this.processes.delete(processId)

    await this.killChildGracefully(child)
  }

  /**
   * 满足 PluginHostProcessContract：按 pluginId 查找子进程，返回带 postMessage 的句柄。
   * 反向索引 O(1) 命中（D2-5），索引与 processes Map 同步维护。
   */
  getProcessHandle(pluginId: string): { processId: string; postMessage(message: unknown): void } | undefined {
    const processId = this.pluginToProcess.get(pluginId)
    if (processId === undefined) return undefined
    const child = this.processInstances.get(processId)
    return {
      processId,
      postMessage: (message: unknown) => {
        try {
          child?.send(message as Serializable)
        } catch (e: unknown) {
          // IPC channel 已关闭（子进程崩溃/terminated 后的 in-flight 消息）不抛
          console.debug(`[plugin-host-process] send failed for ${processId}:`, e)
        }
      },
    }
  }

  /** 反向索引删除（带归属守卫：只删当前映射仍指向 processId 的条目，防误删重建后的新映射） */
  private removeIndexEntries(processId: string, pluginIds: string[]): void {
    for (const pid of pluginIds) {
      if (this.pluginToProcess.get(pid) === processId) {
        this.pluginToProcess.delete(pid)
      }
    }
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
    // 对齐 terminateProcess 的 pre-mark（与 Worker 版 plugin-host.shutdown 同款）：
    // SIGTERM kill 触发的 exit(code=null)/disconnect 先到时，status='terminated'
    // 幂等守卫拦截，不把正常关停误报为崩溃
    for (const handle of this.processes.values()) handle.status = 'terminated'
    const children = [...this.processInstances.values()]
    await Promise.allSettled(
      children.map((child) => this.killChildGracefully(child)),
    )
    this.processInstances.clear()
    this.processes.clear()
    this.pluginToProcess.clear()
    this.rpcServer.dispose()
  }

  /**
   * 优雅终止子进程：SIGTERM → 等待 exit（最多 SHUTDOWN_KILL_TIMEOUT_MS）→ SIGKILL 兜底。
   *
   * terminateProcess 与 shutdown 共用此升级链（MF-3：消除不对称，防 SIGTERM 抵抗导致 orphan）。
   * timer.unref() 避免兜底定时器阻塞 runtime 退出。
   */
  private killChildGracefully(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch (e: unknown) {
          // best-effort：进程可能刚退出，kill 抛错不阻塞清理
          console.debug(`[plugin-host-process] SIGKILL escalation failed:`, e)
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
        // best-effort：进程可能已退出，kill 抛错不阻塞清理
        console.debug(`[plugin-host-process] kill failed:`, e)
      }
    })
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
    pluginDir?: string,
  ): ProcessHandle {
    // M6a-03：覆盖同 processId 前先清理残留句柄（崩溃→重建竞态防护）。
    // 崩溃（handleProcessCrash 不 kill 不删 map）后重激活走 createProcess 直接 set 覆盖，
    // 旧 child 的 exit/disconnect/error/message 监听全部残留——旧 child 晚到的 exit（code≠0）
    // 会命中新 handle，健康进程被误标 crashed + RPC 反注册。此处 kill 旧 child + off 全部
    // 监听 + 删 map + 反注册，使旧进程的任何晚到事件都无法再触碰新 handle。
    const staleChild = this.processInstances.get(processId)
    if (staleChild) {
      const staleHandle = this.processes.get(processId)
      if (staleHandle) this.removeIndexEntries(processId, staleHandle.pluginIds)
      this.processInstances.delete(processId)
      this.processes.delete(processId)
      staleChild.removeAllListeners()
      try {
        staleChild.kill()
      } catch (e: unknown) {
        // kill 失败（进程已死/权限）不阻塞重建
        console.debug(`[plugin-host-process] kill stale child failed for ${processId}:`, e)
      }
      // rpcServer 反注册旧 worker（下方 createProcess 会重新注册新 worker）
      this.rpcServer.unregisterWorker(processId)
    }

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

    // MF-1：sandbox fork 前断言 execArgv 含 --import（ESM loader 注入口）。loader 缺失时
    // resolveEsmLoaderExecArgv 返回 undefined → execArgv 为空 → 此处 fail-closed throw，
    // 拒绝创建无 ESM 防护的 sandbox 进程（否则外部插件 await import('node:fs') 即 RCE）。
    // trusted 不受影响（走 Worker 线程不经此路径，不需要 ESM loader）。
    if (trustLevel === 'sandbox' && !this.execArgv.includes('--import')) {
      throw new Error(
        `[plugin-host-process] SANDBOX_LOADER_MISSING: cannot fork sandbox process without ESM loader ` +
        `(execArgv missing --import; resolveEsmLoaderExecArgv returned no loader). ` +
        `Refusing to create sandbox process without ESM import guard (RCE risk).`,
      )
    }

    // sandbox 子进程 env：注入 XYZ_PLUGIN_SANDBOX_DIR（ESM loader initialize() 读此 env
    // 做路径边界判定，缺失则 fail-closed throw）。trusted 不需要（ESM loader 仅 sandbox
    // 进程经 execArgv --import 注入；trusted 走 Worker 线程不经此 fork 路径）。
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    if (trustLevel === 'sandbox' && pluginDir) {
      env.XYZ_PLUGIN_SANDBOX_DIR = pluginDir
    }

    let child: ChildProcess
    try {
      child = fork(bootstrapPath, [], {
        // 打包约束（AGENTS.md #12）：必须 process.execPath + ELECTRON_RUN_AS_NODE=1
        // （打包后无独立 node；node 环境该 env 无害被忽略）
        execPath: process.execPath,
        env,
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
    this.pluginToProcess.set(pluginId, processId)
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
        // 子进程发来的 RPC 消息格式与 Worker 版一致——统一分发单一真相（Fix-3，
        // 原 TR1「分发逻辑复制，独立维护」改为与 plugin-host / e2e 共享实现）
        dispatchHostRpcMessage(this.rpcServer, processId, m)
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
    this.removeIndexEntries(processId, pluginIds)

    // M6a-03：kill 兜底——fatal_error 消息路径子进程可能仍存活（发完消息不退出 = 进程
    // 泄漏）。崩溃时强制终止。kill 后晚到的 exit 被上方 status='crashed' 幂等守卫拦截，
    // 且重建时 createProcess 的残留清理会 removeAllListeners，不会命中新 handle。
    const child = this.processInstances.get(processId)
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill()
      } catch (e: unknown) {
        // best-effort：进程可能已退出，kill 抛错不阻塞崩溃通知
        console.debug(`[plugin-host-process] kill failed for crashed process ${processId}:`, e)
      }
    }

    this.onCrash?.(processId, pluginIds, error)
  }
}
