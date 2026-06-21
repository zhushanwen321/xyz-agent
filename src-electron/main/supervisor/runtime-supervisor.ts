/**
 * RuntimeSupervisor Facade（implements IRuntimeSupervisor）。
 *
 * 对应 spec §4.2 M2「Process Supervisor」。组合 4 个子职责模块：
 *   port-discoverer（端口探测 + stale kill）
 *   process-control（spawn / kill 进程树）
 *   health-checker（TCP 健康检查）
 *   port-file（端口文件持久化）
 *
 * 这是「门面 + 协调者」模式：各子模块是纯函数/单一职责，Facade 负责串联
 * start/stop 的完整时序，并持有 child/port 状态。
 *
 * [HISTORICAL] 不变量：
 * - start() 幂等：已有活进程则复用，不重复 spawn
 *   （实现时若 child 非空且未退出 exitCode===null，直接返回 this._port）
 * - start 完整时序：findAvailablePort → spawn → waitForHealth → writePortFile
 * - startAndNotify 消除 main.ts whenReady/activate 重复：spawn 成功发 'runtime-port'，失败发 'runtime-error'
 *
 * start 时序：
 * ```
 *   start():
 *     1. 若 child 活着 → return this._port（幂等）
 *     2. await stop()（先清旧的）
 *     3. port = await findAvailablePort()
 *     4. child = spawnRuntimeProcess(port)
 *     5. await waitForHealth(port)
 *     6. writePortFile(port)
 *     7. this._port = port; return port
 * ```
 *
 * 依赖方向：runtime-supervisor → interfaces + 4 个子模块 + electron(BrowserWindow)
 */
import type { BrowserWindow } from 'electron'
import type { ChildProcess } from 'node:child_process'
import type { IRuntimeSupervisor } from '../interfaces.js'
import { findAvailablePort, getPortOffset } from './port-discoverer.js'
import { spawnRuntimeProcess, stopRuntimeProcess } from './process-control.js'
import { waitForHealth } from './health-checker.js'
import { writePortFile } from './port-file.js'

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
   *
   * @returns 实际监听的端口号
   */
  async start(): Promise<number> {
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
    this.child = spawnRuntimeProcess(port, () => {
      // [HISTORICAL] 子进程自然退出（崩溃）时清 child/port，恢复旧 runtime-manager 语义：
      // 否则下次 start() 幂等守卫误判存活 → 返回死端口 → 前端 WS 永连不上 → 应用假死
      this.child = null
      this._port = null
    })

    await waitForHealth(port)
    writePortFile(port)
    this._port = port

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
   * 停止 runtime 进程树（SIGTERM → 等 → SIGKILL 残留）。
   *
   * 时序见 process-control.ts 的 [HISTORICAL] 注释。关键：先预记录后代 PID 再 SIGTERM。
   * 幂等：child 为空或已 killed 时直接 resolve。
   */
  async stop(timeoutMs?: number): Promise<void> {
    await stopRuntimeProcess(this.child, timeoutMs)
    this.child = null
    this._port = null
  }
}
