/**
 * RuntimeSupervisor Facade（implements IRuntimeSupervisor）。
 *
 * 对应 spec §4.2 M2「Process Supervisor」。组合 5 个子职责模块：
 *   port-discoverer（端口探测 + stale kill）
 *   process-control（spawn / kill 进程树）
 *   health-checker（TCP 健康检查）
 *   port-file（端口文件持久化）
 *   restart-policy（崩溃重启策略，纯逻辑可单测）
 *
 * 这是「门面 + 协调者」模式：各子模块是纯函数/单一职责，Facade 负责串联
 * start/stop/restart 的完整时序，并持有 child/port 状态。
 *
 * [HISTORICAL] 不变量：
 * - start() 幂等：已有活进程则复用，不重复 spawn
 *   （实现时若 child 非空且未退出 exitCode===null，直接返回 this._port）
 * - start 完整时序：findAvailablePort → spawn → waitForHealth → writePortFile
 * - startAndNotify 消除 main.ts whenReady/activate 重复：spawn 成功发 'runtime-port'，失败发 'runtime-error'
 * - **崩溃自动重启**：onExit 回调检查 stopping 标志 → restart-policy 判定 → 退避后 start()
 *   - 主动 stop() 设 stopping=true，onExit 短路不重启
 *   - 重启用尽（MAX_RESTARTS）→ 广播 'runtime-failed'，等待用户手动重试
 *   - 重启成功 → 广播 'runtime-port'（所有窗口重连新端口）
 *   - 重启在途幂等：restartTimer 存在时不叠加（exit 事件可能重入）
 *
 * start 时序：
 * ```
 *   start():
 *     1. 若 child 活着 → return this._port（幂等）
 *     2. await stop()（先清旧的）
 *     3. port = await findAvailablePort()
 *     4. child = spawnRuntimeProcess(port, onExit)
 *     5. await waitForHealth(port)
 *     6. writePortFile(port)
 *     7. this._port = port; restartPolicy.recordSuccess(); return port
 * ```
 *
 * 依赖方向：runtime-supervisor → interfaces + 5 个子模块 + electron(BrowserWindow)
 */
import { BrowserWindow } from 'electron'
import type { ChildProcess } from 'node:child_process'
import type { IRuntimeSupervisor } from '../interfaces.js'
import { findAvailablePort, getPortOffset } from './port-discoverer.js'
import { spawnRuntimeProcess, stopRuntimeProcess } from './process-control.js'
import { waitForHealth } from './health-checker.js'
import { writePortFile } from './port-file.js'
import { RestartPolicy } from './restart-policy.js'

/**
 * RuntimeSupervisor 实现。
 *
 * 使用方法：
 * ```ts
 * const supervisor = new RuntimeSupervisor()
 * const port = await supervisor.start()
 * await supervisor.startAndNotify(mainWindow)
 * await supervisor.stop()
 * ```
 */
export class RuntimeSupervisor implements IRuntimeSupervisor {
  private child: ChildProcess | null = null
  private _port: number | null = null
  /** 重启策略（纯逻辑，可单测） */
  private readonly policy = new RestartPolicy()
  /** 重启定时器（在途幂等：存在时不叠加新重启） */
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  /** 当前监听端口（未启动为 null） */
  get port(): number | null {
    return this._port
  }

  /** 端口偏移量（dev 模式 +DEV_PORT_OFFSET），clamp 到合法范围 */
  get portOffset(): number {
    return getPortOffset()
  }

  /**
   * 启动 runtime（幂等）。
   *
   * 时序：if child 活着 → 复用 → stop（清旧）→ findAvailablePort → spawn → waitForHealth → writePortFile。
   * 重置 stopping 标志（从崩溃重启或用户手动重试进入时，清掉上次的 stopping）。
   *
   * @returns 实际监听的端口号
   */
  async start(): Promise<number> {
    // 重置停止标志（start 是新生命周期的开始，无论上次是崩溃还是主动 stop）
    this.policy.reset()

    // 幂等：已有活进程则复用，不重复 spawn
    // [HISTORICAL] 用 exitCode===null 判活而非 !killed：自然崩溃时 killed 仍为 false，
    // 仅 exitCode 由 null 变为退出码。避免崩溃后守卫误判存活、返回死端口（应用假死）。
    if (this.child && this.child.exitCode === null && this._port !== null) {
      return this._port
    }
    // 先停掉已有的，等待其真正退出
    await this.stop()

    const port = await findAvailablePort()
    console.log(`[runtime] Starting on port ${port}`)
    this.child = spawnRuntimeProcess(port, (code) => this.onRuntimeExit(code))

    await waitForHealth(port)
    writePortFile(port)
    this._port = port
    // 重启成功 → 记录（稳定窗口后清零计数）
    this.policy.recordSuccess()

    console.log(`[runtime] Ready on port ${port}`)
    return port
  }

  /**
   * 启动 runtime 并通知渲染进程端口。
   *
   * 成功：win.webContents.send('runtime-port', port)
   * 失败：win.webContents.send('runtime-error', { message })（不抛出）
   *
   * 消除 main.ts whenReady/activate 两处重复的 spawn + 通知逻辑。
   */
  async startAndNotify(win: BrowserWindow): Promise<number> {
    try {
      const port = await this.start()
      win.webContents.send('runtime-port', port)
      return port
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error(`[runtime] startAndNotify failed: ${message}`)
      win.webContents.send('runtime-error', { message })
      return 0
    }
  }

  /**
   * 手动重启 runtime（用户从「runtime 不可用」状态条点击重试时调）。
   *
   * 场景：崩溃后自动重启用尽，前端展示 runtime-failed 状态条 + 重试按钮。
   * 用户点击 → 前端调 restartRuntime IPC → 此方法。
   * - runtime 已存活：幂等，直接广播端口（用户误点）
   * - runtime 已死：重置策略计数，走 start()，成功广播端口，失败广播 failed
   */
  async restartRuntime(): Promise<void> {
    // runtime 存活 → 幂等，直接广播当前端口
    if (this.child && this.child.exitCode === null && this._port !== null) {
      console.log(`[runtime] restartRuntime: already running on ${this._port}, broadcast port`)
      this.broadcastToAllWindows('runtime-port', this._port)
      return
    }
    // 重置策略：手动重试给一个新的 5 次配额（清停止标志 + 计数）
    this.policy.clearForManualRestart()
    this.clearRestartTimer()
    await this.attemptRestart()
  }

  /**
   * 停止 runtime 进程树（SIGTERM → 等 → SIGKILL 残留）。
   *
   * 时序见 process-control.ts 的 [HISTORICAL] 注释。关键：先预记录后代 PID 再 SIGTERM。
   * 幂等：child 为空或已 killed 时直接 resolve。
   *
   * 标记 stopping=true：onExit 回调检查此标志，主动 stop 不触发崩溃重启。
   */
  async stop(timeoutMs?: number): Promise<void> {
    // 标记主动停止，阻止后续 onExit 触发重启
    this.policy.markStopping()
    // 取消在途的重启定时器（正在退避等待的重启不再执行）
    this.clearRestartTimer()
    await stopRuntimeProcess(this.child, timeoutMs)
    this.child = null
    this._port = null
  }

  /**
   * runtime 子进程退出处理（自然崩溃路径）。
   *
   * [HISTORICAL] 核心重启编排：
   * 1. 清 child/port（幂等守卫不再误判存活）
   * 2. stopping 检查（主动退出短路）
   * 3. restart-policy 判定（计数上限）
   * 4. 退避后 start()（重启在途幂等）
   * 5. 重启用尽 → 广播 runtime-failed
   *
   * @param code 子进程退出码（null=被信号杀死）
   */
  private onRuntimeExit(code: number | null): void {
    // 清状态（幂等守卫据此判定无活进程）
    this.child = null
    this._port = null

    // 主动停止：不重启（stop() 已 markStopping）
    if (this.policy.stopping) {
      console.log(`[runtime] Process exited (code ${code}) during graceful stop — no restart`)
      return
    }

    console.log(`[runtime] Process exited unexpectedly (code ${code}) — evaluating restart`)

    // 重启在途幂等：已有定时器则不叠加（exit 事件可能重入）
    if (this.restartTimer) {
      console.log('[runtime] Restart already scheduled — skip')
      return
    }

    // 重启策略判定
    if (!this.policy.shouldRestart()) {
      console.error(`[runtime] Restart attempts exhausted (${this.policy.count}). Broadcasting runtime-failed.`)
      this.broadcastToAllWindows('runtime-failed', {
        attempts: this.policy.count,
        message: `runtime 崩溃后已重试 ${this.policy.count} 次仍失败`,
      })
      return
    }

    const delay = this.policy.recordCrashAndGetDelay()
    const attempt = this.policy.count
    console.log(`[runtime] Restart attempt ${attempt} scheduled in ${delay}ms`)

    // 广播重启中状态（前端进 restarting 态，展示状态条）
    this.broadcastToAllWindows('runtime-restarting', { attempt })

    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null
      try {
        const newPort = await this.start()
        console.log(`[runtime] Restart succeeded on port ${newPort}`)
        // 广播新端口（所有窗口重连）
        this.broadcastToAllWindows('runtime-port', newPort)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        console.error(`[runtime] Restart attempt ${attempt} failed: ${message}`)
        // 重启失败 → 当作又一次崩溃，递归走 onRuntimeExit 逻辑（但 child 已 null，
        // 需手动触发判定。start() 失败不会触发 exit 事件，故直接再判定一次）
        this.handleRestartFailure()
      }
    }, delay)
  }

  /**
   * 重启失败后处理（start() 抛错路径，不会触发 onExit）。
   * 递归走 onRuntimeExit 的判定逻辑（计数已在上次 recordCrash 递增）。
   */
  private handleRestartFailure(): void {
    if (!this.policy.shouldRestart()) {
      console.error(`[runtime] Restart attempts exhausted (${this.policy.count}). Broadcasting runtime-failed.`)
      this.broadcastToAllWindows('runtime-failed', {
        attempts: this.policy.count,
        message: `runtime 崩溃后已重试 ${this.policy.count} 次仍失败`,
      })
      return
    }
    const delay = this.policy.recordCrashAndGetDelay()
    const attempt = this.policy.count
    console.log(`[runtime] Restart attempt ${attempt} scheduled in ${delay}ms (after failure)`)
    this.broadcastToAllWindows('runtime-restarting', { attempt })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.attemptRestart()
    }, delay)
  }

  /**
   * 执行一次重启尝试（start + 广播端口 / 失败递归 handleRestartFailure）。
   * 从 handleRestartFailure 和手动重试（restartRuntime）共用。
   */
  private async attemptRestart(): Promise<void> {
    try {
      const newPort = await this.start()
      console.log(`[runtime] Restart succeeded on port ${newPort}`)
      this.broadcastToAllWindows('runtime-port', newPort)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error(`[runtime] Restart failed: ${message}`)
      this.handleRestartFailure()
    }
  }

  /** 清除在途重启定时器 */
  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  /**
   * 广播事件到所有存活窗口（复用 broadcastWindowList 模式）。
   * 不存窗口引用（避免悬垂），每次实时 getAllWindows + isDestroyed 守卫。
   */
  private broadcastToAllWindows(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    }
  }
}
