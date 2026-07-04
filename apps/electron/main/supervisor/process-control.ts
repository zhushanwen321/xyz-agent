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
 * [HISTORICAL] onExit 回调：子进程自然退出（崩溃）时 supervisor 必须清 child/port，
 * 否则幂等守卫误判存活、start() 返回死端口，前端 WS 永连不上（应用假死）。
 * 旧 runtime-manager 的 child.on('exit') 会 this.child=null，重构拆出自由函数后由 onExit 传递。
 *
 * @param port runtime 监听端口
 * @param onExit 子进程退出回调（传入 code），supervisor 用它清理状态
 * @returns ChildProcess 实例（已绑定 stdout/stderr/exit 事件）
 * @throws runtime 入口文件不存在
 */
export function spawnRuntimeProcess(port: number, onExit?: (code: number | null) => void): ChildProcess {
  // 根据打包状态选择 runtime 启动方式
  const projectRoot = app.getAppPath()
  let cmd: string
  let args: string[]

  if (app.isPackaged) {
    // 生产环境：运行 asar unpack 后的预编译 JS
    // asarUnpack 将 dist/runtime 解压到 app.asar.unpacked/
    const runtimeDist = path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'dist',
      'runtime',
      RUNTIME_ENTRY_FILE,
    )
    if (!existsSync(runtimeDist)) {
      throw new Error(`Runtime bundle not found at ${runtimeDist}`)
    }
    cmd = process.execPath
    args = [runtimeDist, `--port=${port}`]
    console.log(`[runtime] ${cmd} ${runtimeDist} --port=${port}`)
  } else {
    // 开发环境：tsx 运行 TS 源码
    // projectRoot = app.getAppPath() = apps/electron。
    // pnpm workspace + node-linker=hoisted 下，tsx 提升到 repo root 的 node_modules/.bin；
    // runtime 源码在 packages/runtime/src/（与 apps/electron 平级）。
    // repo root 相对 apps/electron 是 ../..
    const repoRoot = path.join(projectRoot, '..', '..')
    const tsxPath = path.join(repoRoot, 'node_modules', '.bin', 'tsx')
    const runtimeEntry = path.join(repoRoot, 'packages', 'runtime', 'src', 'index.ts')

    if (!existsSync(tsxPath)) {
      throw new Error(`tsx not found at ${tsxPath}. Run: pnpm install`)
    }
    if (!existsSync(runtimeEntry)) {
      throw new Error(`Runtime entry not found at ${runtimeEntry}`)
    }

    cmd = 'node'
    args = [tsxPath, runtimeEntry, `--port=${port}`]
    console.log(`[runtime] node ${tsxPath} ${runtimeEntry} --port=${port}`)
  }

  // 打包后 app.getAppPath() 返回 app.asar（虚拟路径），不能作为 cwd
  const cwd = app.isPackaged ? process.resourcesPath : projectRoot
  // eslint-disable-next-line no-magic-numbers -- TypeScript tuple index, not a business constant
  const spawnOptions: Parameters<typeof spawn>[2] = {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    // 打包后用 ELECTRON_RUN_AS_NODE 让 Electron 二进制以纯 Node 运行 sidecar；
    // 开发模式也显式设置 env 确保行为一致
    env: buildSafeEnv({
      ELECTRON_RUN_AS_NODE: app.isPackaged ? '1' : undefined,
      XYZ_AGENT_PACKAGED: app.isPackaged ? '1' : undefined,
      // 透传实例隔离 env var，使 runtime 子进程使用隔离的数据目录
      XYZ_AGENT_DATA_DIR: process.env.XYZ_AGENT_DATA_DIR,
      XYZ_AGENT_PORT_OFFSET: process.env.XYZ_AGENT_PORT_OFFSET,
    }),
  }
  const child = spawn(cmd, args, spawnOptions)

  child.on('error', (err) => {
    console.error(`[runtime] Spawn error: ${err.message}`)
  })

  // runtime 日志转发：只用 console（dev 模式方便调试）
  child.stdout?.on('data', (data: Buffer) => {
    console.log(`[runtime:out] ${data.toString().trimEnd()}`)
  })
  child.stderr?.on('data', (data: Buffer) => {
    console.error(`[runtime:err] ${data.toString().trimEnd()}`)
  })
  child.on('exit', (code) => {
    console.log(`[runtime] Process exited with code ${code}`)
    // 通知 supervisor 清理 child/port 状态（自然退出/崩溃路径）
    onExit?.(code)
  })

  return child
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
  if (!parentPid || isNaN(parentPid)) return []
  const result: number[] = []
  const queue = [parentPid]
  while (queue.length > 0) {
    const pid = queue.shift()!
    try {
      const output = execSync(`pgrep -P ${pid} 2>/dev/null || true`, {
        encoding: 'utf-8',
        shell: '/bin/bash',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      if (output) {
        const childPids = output.split('\n').map(Number).filter(n => !isNaN(n) && n > 0)
        result.push(...childPids)
        queue.push(...childPids)
      }
    // eslint-disable-next-line taste/no-silent-catch -- pgrep 失败（进程已退出）非关键
    } catch (e) {
      console.warn(`[runtime] getDescendantPids failed for PID ${pid}:`, e instanceof Error ? e.message : String(e))
    }
  }
  return result
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
  const pids = precomputedDescendants ?? getDescendantPids(rootPid)
  // 先杀后代（倒序：孙→子）
  for (const pid of pids.reverse()) {
    // eslint-disable-next-line taste/no-silent-catch -- process may have already exited
    try { process.kill(pid, 'SIGKILL') } catch { /* 可能已退出 */ }
  }
  // 再杀根进程
  // eslint-disable-next-line taste/no-silent-catch -- process may have already exited
  try { process.kill(rootPid, 'SIGKILL') } catch { /* 可能已退出 */ }
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
  return new Promise((resolve) => {
    if (!child || child.killed) {
      resolve()
      return
    }
    const childPid = child.pid
    if (!childPid || isNaN(childPid)) {
      resolve()
      return
    }
    let resolved = false

    // [HISTORICAL] 在发 SIGTERM 之前记录所有后代 PID
    // （runtime 退出后 pi 的 PPID 变为 1，pgrep -P 查不到）
    const descendantPids = getDescendantPids(childPid)

    const done = () => {
      if (resolved) return
      resolved = true
      // 杀掉残留的后代进程（pi 等），同步完成后再 resolve
      // 避免异步 setTimeout 在 resolve 后误杀 PID 复用的新进程
      for (const pid of descendantPids) {
        // eslint-disable-next-line taste/no-silent-catch -- process may have already exited
        try { process.kill(pid, 'SIGTERM') } catch { /* 可能已随 runtime 退出 */ }
      }
      // 同步等待后补 SIGKILL
      try {
        execSync(`sleep ${KILL_WAIT_MS / MS_PER_SEC}`, { stdio: 'ignore' })
      // eslint-disable-next-line taste/no-silent-catch -- sleep failure is non-critical
      } catch { /* sleep 失败不影响 */ }
      for (const pid of descendantPids) {
        // eslint-disable-next-line taste/no-silent-catch -- process may have already exited
        try { process.kill(pid, 'SIGKILL') } catch { /* 可能已退出 */ }
      }
      resolve()
    }
    child.once('exit', done)
    child.kill('SIGTERM')
    // 超时后强制 SIGKILL（先杀整棵进程树）
    setTimeout(() => {
      child.removeListener('exit', done)
      // 强制杀进程树：runtime + 所有子进程
      killProcessTree(childPid, descendantPids)
      done()
    }, timeoutMs)
  })
}
