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
 *   （实现时若 this.child 非空且未 killed，直接返回 this._port）
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
// TODO(B类): 完整 start/stop 实现需 import 以下子模块：
//   findAvailablePort, getPortOffset from './port-discoverer.js'
//   spawnRuntimeProcess, stopRuntimeProcess from './process-control.js'
//   waitForHealth from './health-checker.js'
//   writePortFile from './port-file.js'

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

  /** 端口偏移量（dev 模式 +DEV_PORT_OFFSET） */
  get portOffset(): number {
    // 最小可运行实现：内联读 env（避免依赖 port-discoverer.getPortOffset 的 throw 骨架）。
    // 完整实现应委托 port-discoverer.getPortOffset()（含 clamp），待 B 类填充时替换。
    const raw = parseInt(process.env.XYZ_AGENT_PORT_OFFSET ?? '0', 10) || 0
    return Math.max(0, raw)
  }

  /**
   * 启动 runtime（幂等）。
   *
   * ⚠️ 最小可运行实现：当前不 spawn 子进程。mock 模式（XYZ_MOCK=1）下正确；
   * 非 mock 模式调用此方法会静默返回 0（runtime 未真实启动）。
   * 完整实现（findAvailablePort → spawn → waitForHealth → writePortFile）待 B 类填充。
   *
   * @returns 实际监听的端口号（mock 模式返回 0）
   */
  async start(): Promise<number> {
    // mock 模式：runtime 不启动，_port 保持 null
    // TODO(B类): 实现完整 start 时序（见文件顶部注释）
    return 0
  }

  /**
   * 启动 runtime 并通知渲染进程端口。
   *
   * ⚠️ 最小可运行实现：mock 模式下不 spawn 也不通知（renderer 走 VITE_MOCK，不需要端口）。
   * 成功：win.webContents.send('runtime-port', port)
   * 失败：win.webContents.send('runtime-error', { message })
   *
   * 消除 main.ts whenReady/activate 两处重复的 spawn + 通知逻辑。
   */
  async startAndNotify(win: BrowserWindow): Promise<number> {
    // mock 模式：跳过 spawn，不发送 runtime-port（renderer mock 不消费此事件）
    // TODO(B类): 实现真实 spawn + webContents.send('runtime-port'/'runtime-error')
    void win
    return 0
  }

  /**
   * 停止 runtime 进程树（SIGTERM → 等 → SIGKILL 残留）。
   *
   * ⚠️ 最小可运行实现：child 为 null（mock 模式未 spawn），直接 resolve。
   * 完整实现（预记录后代 PID → SIGTERM → 超时 SIGKILL 进程树）待 B 类填充。
   * 幂等：child 为空或已 killed 时直接 resolve。
   */
  async stop(timeoutMs?: number): Promise<void> {
    // mock 模式：child 为 null，无需 kill
    // TODO(B类): 实现完整 stop 时序（见 process-control.ts 的 [HISTORICAL] 注释）
    void timeoutMs
    this.child = null
    this._port = null
  }
}
