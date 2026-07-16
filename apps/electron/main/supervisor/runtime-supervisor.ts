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
import { LivenessMonitor } from './liveness-probe.js'

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
  /** 存活探针定时器（start 成功后启动，stop 时关闭） */
  private livenessMonitor: LivenessMonitor | null = null

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

    // [HISTORICAL] W5 改动 4：spawn 成功但 waitForHealth 可能失败（进程半活）。
    // 必须包 try-catch：失败时主动 stop() 清理半活 child，
    // 否则 child 引用残留 → 下次 start 幂等守卫误判存活 → 返回死端口（应用假死）。
    try {
      await waitForHealth(port)
    } catch (e) {
      console.error(`[runtime] waitForHealth failed on port ${port}, cleaning up half-alive child`)
      // 复用 stop()：它会 markStopping + kill 进程树 + 清 child/port
      // markStopping 让 onRuntimeExit 不触发自动重启（这里是 start 路径的清理，由调用方决定下一步）
      await this.stop()
      throw e
    }

    writePortFile(port)
    this._port = port
    // 重启成功 → 记录（稳定窗口后清零计数）
    this.policy.recordSuccess()

    // [HISTORICAL] W5 改动 3：启动存活探针，监测 runtime「半活」状态。
    // 探针在 stop() 时关闭，不会泄漏 timer。连续失败达阈值调 forceRestartForLiveness。
    this.livenessMonitor = new LivenessMonitor({
      port,
      onUnhealthy: () => { void this.forceRestartForLiveness() },
    })
    this.livenessMonitor.start()

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
    // 关闭存活探针（避免 stop 后探针继续打无效端口）
    this.stopLivenessMonitor()
    await stopRuntimeProcess(this.child, timeoutMs)
    this.child = null
    this._port = null
  }

  /**
   * 强制重启「半活」进程（存活探针触发）。
   *
   * [HISTORICAL] W5 改动 3：runtime 进程未退出（exitCode===null）但 HTTP 服务卡死时，
   * 存活探针连续失败达阈值（LIVENESS_FAIL_THRESHOLD）后调用此方法。
   *
   * 关键不变量（避免重启竞态）：
   * 1. 先 markStopping：kill 触发的 exit 事件会被 onRuntimeExit 当崩溃 → 重复重启。
   *    提前 markStopping 让 onRuntimeExit 短路（视为主动停止，不重启）。
   * 2. 再 stop() kill 进程树 + 清状态（child/port=null）。
   * 3. 走 onRuntimeExit 走崩溃重启路径：scheduleRestart('crash') 编排退避重启。
   *    但因 markStopping 已设，onRuntimeExit 会短路——所以此处显式调 scheduleRestart。
   *
   * 注意：markStopping 后 scheduleRestart 的 shouldRestart() 会返回 false（stopping 短路）。
   * 因此 reset() 必须在 scheduleRestart 之前调用，清掉 stopping 标志让重启策略放行。
   * 顺序：markStopping → stop → reset（清 stopping）→ scheduleRestart。
   *
   * @returns Promise（异步 kill + 重启编排）
   */
  async forceRestartForLiveness(): Promise<void> {
    console.warn('[runtime] Liveness probe failed threshold — forcing restart of half-alive process')
    // markStopping 防止 stop 触发的 exit 被 onRuntimeExit 当崩溃重复重启
    this.policy.markStopping()
    // kill 半活进程 + 清 child/port（不触发 onRuntimeExit 的重启逻辑）
    await this.stop()
    // 清 stopping 标志：后续 scheduleRestart 才能放行（shouldRestart 不再短路）
    this.policy.reset()
    // 走与崩溃相同退避/上限/广播编排
    this.scheduleRestart('crash')
  }

  /** 关闭存活探针（幂等：未启动则无操作） */
  private stopLivenessMonitor(): void {
    if (this.livenessMonitor) {
      this.livenessMonitor.stop()
      this.livenessMonitor = null
    }
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

    this.scheduleRestart('crash')
  }

  /**
   * 重启失败后处理（start() 抛错路径，不会触发 onExit）。
   * 递归走重启判定逻辑（计数已在上次 recordCrash 递增）。
   */
  private handleRestartFailure(): void {
    this.scheduleRestart('after failure')
  }

  /**
   * 统一重启编排：shouldRestart 门 → recordCrashAndGetDelay → 广播 'runtime-restarting'
   * → setTimeout(attemptRestart)。crash 路径（onRuntimeExit）与 after-failure 路径
   * （handleRestartFailure）共用，仅入口 reason 不同（日志区分）。
   *
   * 行为不变量（与重构前逐字一致）：
   * - shouldRestart=false → 广播 'runtime-failed'（attempts + 中文 message）后返回
   * - 延迟由 policy.recordCrashAndGetDelay 给出（指数退避，计数递增）
   * - 广播 'runtime-restarting' { attempt }（前端进 restarting 态）
   * - attemptRestart 成功广播 'runtime-port'，失败递归 handleRestartFailure
   */
  private scheduleRestart(reason: 'crash' | 'after failure'): void {
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
    console.log(`[runtime] Restart attempt ${attempt} scheduled in ${delay}ms${reason === 'after failure' ? ' (after failure)' : ''}`)
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
