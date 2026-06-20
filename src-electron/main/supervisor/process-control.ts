/**
 * 进程生命周期控制（spawn / kill 进程树）。
 *
 * 对应 spec §4.2 M2 子职责「进程生命周期」+「stop 时序」。
 * 这是 supervisor 内部最危险的块——P3 已深化，含完整时序图。
 *
 * [HISTORICAL] 不变量（违反必出 bug）：
 *
 * 1. spawn 方式分两种：
 *    - 打包模式：process.execPath + ELECTRON_RUN_AS_NODE=1 运行 app.asar.unpacked/dist/runtime/index.cjs
 *    - 开发模式：node + tsx 运行 runtime/src/index.ts
 *    - cwd：打包后用 process.resourcesPath（app.getAppPath 返回 asar 虚拟路径，不能用）
 *
 * 2. ENV 注入（buildSafeEnv）：
 *    - ELECTRON_RUN_AS_NODE=1 仅打包模式
 *    - XYZ_AGENT_PACKAGED / XYZ_AGENT_DATA_DIR / XYZ_AGENT_PORT_OFFSET 必须透传（实例隔离）
 *
 * 3. **stop() 时序（最危险路径，跨 SIGTERM/SIGKILL + 进程树）**：
 *    ```
 *    T0: 记录 descendantPids ← [HISTORICAL] 必须在 SIGTERM 前！
 *        原因：runtime 退出后 pi 的 PPID 变为 1，pgrep -P 查不到
 *    T1: child.kill('SIGTERM')
 *    T2: 等 child 'exit' 事件 或 timeout(STOP_TIMEOUT_MS=2000)
 *         ├─ exit 先到 → done():
 *         │    ├─ SIGTERM 残留后代（pi 等）
 *         │    ├─ sleep(KILL_WAIT_MS=200ms) 同步等待
 *         │    └─ SIGKILL 仍残留的后代
 *         └─ timeout 先到 → killProcessTree(倒序: 孙→子→根) → done()
 *    T3: done(): 清 child/port=null，resolve
 *    ```
 *
 * 4. **PID 复用防护**：done() 在 SIGTERM 后才补 SIGKILL 残留后代，
 *    避免异步 setTimeout 在 resolve 后误杀 PID 复用的新进程。
 *
 * 5. 进程树 kill 顺序：先杀后代（倒序：孙→子），再杀根。
 *
 * 6. TODO(Windows): 全部依赖 Unix 命令（pgrep/lsof/ps/SIGTERM/SIGKILL/bin/bash），
 *    Windows 不工作。需抽象 platform 层（详见 main 进程 CLAUDE.md）。
 *
 * 依赖方向：process-control → node:child_process + safe-env + electron(app)
 */
import { type ChildProcess, spawn, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { buildSafeEnv } from './safe-env.js'

/** stop() 默认超时：SIGTERM 后等待 exit，超时则 SIGKILL 进程树 */
export const STOP_TIMEOUT_MS = 2000

/** kill 后代时 SIGTERM → 等 → SIGKILL 的等待时间 */
export const KILL_WAIT_MS = 200

/** ms → sec 转换因子（execSync('sleep N') 需要 sec） */
export const MS_PER_SEC = 1000

/** tsup(CJS) runtime 入口文件名，须与 runtime/tsup.config.ts format 一致 */
export const RUNTIME_ENTRY_FILE = 'index.cjs'

/**
 * 启动 runtime 子进程（按打包状态选 spawn 方式）。
 *
 * 打包：process.execPath + ELECTRON_RUN_AS_NODE=1 运行 unpacked 的 index.cjs
 * 开发：node + tsx 运行 runtime/src/index.ts
 *
 * @param port runtime 监听端口
 * @returns ChildProcess 实例（已绑定 stdout/stderr/exit 事件）
 * @throws runtime 入口文件不存在
 */
export function spawnRuntimeProcess(port: number): ChildProcess {
  void port
  void spawn; void existsSync; void path; void app; void buildSafeEnv
  void RUNTIME_ENTRY_FILE
  throw new Error('not implemented: spawnRuntimeProcess')
}

/**
 * 递归获取指定 PID 的所有后代进程 PID（广度优先，按代排列：子→孙→...）。
 *
 * [HISTORICAL] 仅支持 macOS/Linux（依赖 pgrep -P）。
 * 必须在 SIGTERM runtime 之前调用——否则 runtime 退出后 pi 的 PPID 变 1，查不到。
 *
 * @param parentPid 根进程 PID
 * @returns 后代 PID 数组（不含 parentPid 本身）
 */
export function getDescendantPids(parentPid: number): number[] {
  void parentPid
  void execSync
  throw new Error('not implemented: getDescendantPids')
}

/**
 * 强制杀掉整棵进程树（父进程 + 所有后代）。
 * 用于 stop() 超时后的强制清理。
 *
 * 顺序：先杀后代（倒序：孙→子），再杀根。全部用 SIGKILL。
 *
 * @param rootPid 根进程 PID
 * @param precomputedDescendants 可选预计算的后代 PID（避免重复查询）
 */
export function killProcessTree(rootPid: number, precomputedDescendants?: number[]): void {
  void rootPid; void precomputedDescendants
  void KILL_WAIT_MS
  throw new Error('not implemented: killProcessTree')
}

/**
 * 优雅停止 runtime 进程树（SIGTERM → 等 → SIGKILL 残留后代）。
 *
 * 时序见文件顶部 [HISTORICAL] 注释。关键：先预记录后代 PID 再 SIGTERM。
 *
 * @param child runtime 子进程（null 直接 resolve）
 * @param timeoutMs SIGTERM 后等 exit 的超时，超时则 SIGKILL 进程树
 * @returns 全部子进程退出后 resolve
 */
export function stopRuntimeProcess(child: ChildProcess | null, timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
  void child; void timeoutMs
  void MS_PER_SEC
  throw new Error('not implemented: stopRuntimeProcess')
}
