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
 * 6. Windows 用 taskkill /PID /T /F 原子终止整棵进程树；Unix 保留上述信号时序。
 *
 * 依赖方向：process-control → node:child_process + safe-env + windows-process + electron(app)
 */
import { type ChildProcess, spawn, execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { getDataDir } from '@xyz-agent/shared/paths'
import { buildSafeEnv } from './safe-env.js'
import { terminateWindowsProcessTree } from './windows-process.js'

/** stop() 默认超时：SIGTERM 后等待 exit，超时则 SIGKILL 进程树 */
export const STOP_TIMEOUT_MS = 2000

/** kill 后代时 SIGTERM → 等 → SIGKILL 的等待时间 */
export const KILL_WAIT_MS = 200

/**
 * 打包模式 runtime stderr 兜底写流（module 级单例，lazy 创建）。
 *
 * M5（perf-quick-batch）：打包禁用 stdout/stderr 的 console 转发后，runtime 内部
 * initLogger 只覆盖 runtime 进程启动后的 console.*。启动前（模块加载/早期 throw）
 * 与原生崩溃期的 stderr 不被 tee，会丢排查证据。此流只兜底 stderr（不动 stdout，
 * stdout 高吞吐且 initLogger 已覆盖），非阻塞 append 写到 dataDir/logs/。
 *
 * dev 模式不用（dev 保留 console 转发方便终端调试）。
 */
let stderrSink: WriteStream | null = null
function getStderrSink(): WriteStream | null {
  if (!app.isPackaged) return null
  if (stderrSink) return stderrSink
  try {
    const logsDir = path.join(getDataDir(), 'logs')
    mkdirSync(logsDir, { recursive: true })
    stderrSink = createWriteStream(path.join(logsDir, 'electron-runtime-stderr.log'), { flags: 'a' })
  } catch {
    stderrSink = null
  }
  return stderrSink
}

/**
 * 显式 flush stderrSink（app quit 时调用，确保 WriteStream 内部 buffer 落盘）。
 *
 * 正常 stop 路径走 stopRuntimeProcess→done() 已 end()；但若 app 在 runtime 自然退出后
 * 通过 before-quit 直接 quit（未触发 stop 链，或 stop 链已 resolve 但 end 后又有新 spawn 写入），
 * sink 的 buffer 可能未 flush 到磁盘，丢失原生崩溃期排查证据。
 *
 * [HISTORICAL] W2：end() 是异步的（只是发 EOF 到流），返回的 Promise 等 'finish' 事件
 * （OS 层 buffer 刷盘完成）才 resolve。否则 before-quit 紧接 app.quit() 会丢尾部 stderr。
 * 调用方（main.ts before-quit handler）必须 await 此 Promise 后再 app.quit()。
 *
 * 幂等：done() 已 end() 后 stderrSink=null，再次调用为 no-op（直接 resolve）。
 *
 * @returns Promise，在 WriteStream 'finish'（或 'error'）后 resolve。
 *          超时兜底：若底层 fs 卡住 1s 内未 finish 也 resolve（不阻断退出）。
 */
export function flushStderrSink(): Promise<void> {
  if (!stderrSink) return Promise.resolve()
  const sink = stderrSink
  stderrSink = null
  // 兜底超时：极端情况底层 fs 不发 finish（如磁盘满/挂载丢失），1s 后强制 resolve
  // 避免退出被无限阻塞（stderr 仅排查证据，可接受部分丢失）。
  const FLUSH_TIMEOUT_MS = 1000
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, FLUSH_TIMEOUT_MS)
    sink.once('finish', finish)
    sink.once('error', finish)
    try {
      sink.end()
    } catch {
      // end 失败不阻断退出（stderr 仅排查证据）
      finish()
    }
  })
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** tsup(CJS) runtime 入口文件名，须与 runtime/tsup.config.ts format 一致 */
export const RUNTIME_ENTRY_FILE = 'index.cjs'

/**
 * spawn 'error' 事件哨兵退出码（W5 改动 5）。
 *
 * [HISTORICAL] spawn 失败（命令不存在/权限不足等）不会产生真实退出码，
 * 用 -1 表示「spawn 失败」走与 exit 相同的清理路径（onExit(-1)）。
 * 真实进程退出码 >= 0，-1 不会与之冲突。
 */
export const SPAWN_ERROR_EXIT_CODE = -1

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

  // [HISTORICAL] W5 改动 5：spawn 'error' 事件（如命令不存在/权限不足）必须走与 exit 相同的清理路径。
  // 旧实现仅 console.error 记日志，supervisor 收不到通知 → child 引用残留 →
  // 下次 start 幂等守卫误判存活（exitCode 此时仍是 null）→ 返回死端口（应用假死）。
  // 改为调 onExit(SPAWN_ERROR_EXIT_CODE) 哨兵退出码（真实 exit 不会产生负退出码），
  // 让 supervisor 清 child/port。
  child.on('error', (err) => {
    console.error(`[runtime] Spawn error: ${err.message}`)
    onExit?.(SPAWN_ERROR_EXIT_CODE)
  })

  // M5（perf-quick-batch）：runtime 日志转发按打包状态分流。
  // - dev：stdout + stderr 全量 console 转发（终端调试可见）
  // - prod：stdout 不转发（runtime initLogger 已 tee 落盘，console 转发会阻塞主进程）；
  //         stderr 保留非阻塞文件兜底（覆盖 runtime 启动前 + 原生崩溃期，initLogger 不覆盖）
  if (!app.isPackaged) {
    child.stdout?.on('data', (data: Buffer) => {
      console.log(`[runtime:out] ${data.toString().trimEnd()}`)
    })
    child.stderr?.on('data', (data: Buffer) => {
      console.error(`[runtime:err] ${data.toString().trimEnd()}`)
    })
  } else {
    const sink = getStderrSink()
    if (sink) {
      // W6 背压保护：累计写入字节超 1MB 后丢弃（pi 崩溃循环高频 stderr 时不撑爆磁盘）。
      // 用累计字节计数器替代 sink.writableLength（后者只反映 WriteStream 内部 buffer，
      // 不反映 OS 级 page cache + 已 drain 部分，保护效果有限）。stderr 仅用于排查证据，
      // 部分丢失可接受。计数器在 spawnRuntimeProcess 函数作用域内，每次 spawn 重置。
      // eslint-disable-next-line no-magic-numbers -- 1MB stderr 背压上限（非业务常量）
      const WRITE_BUFFER_LIMIT = 1024 * 1024
      let stderrBytes = 0
      child.stderr?.on('data', (data: Buffer) => {
        if (stderrBytes > WRITE_BUFFER_LIMIT) return
        stderrBytes += data.length
        sink.write(data)
      })
    }
  }
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
  if (process.platform === 'win32' || !parentPid || isNaN(parentPid)) return []
  const result: number[] = []
  const queue = [parentPid]
  while (queue.length > 0) {
    const pid = queue.shift()!
    try {
      // execFileSync 不经 shell（pid 已是 number 无注入风险，但更稳健——避免 shell 解析/路径差异）。
      // 原实现用 `pgrep -P ${pid} 2>/dev/null || true` + shell:true 吞 stderr 和 exit code 1；
      // execFileSync 不支持 shell 重定向，需在 catch 里处理 pgrep 无匹配时 exit code 1。
      const output = execFileSync('pgrep', ['-P', String(pid)], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      if (output) {
        const childPids = output.split('\n').map(Number).filter(n => !isNaN(n) && n > 0)
        result.push(...childPids)
        queue.push(...childPids)
      }
    } catch (e) {
      // pgrep 无子进程时 exit code 1（execFileSync 会抛）属正常，静默 continue；
      // ENOENT（pgrep 不存在，极少见）也不阻断 stop 流程；其他真实错误才 warn。
      // execFileSync 抛出的错误对象带 status（exit code）/ code（spawn 错误如 ENOENT）字段。
      const status = (e && typeof e === 'object' && 'status' in e) ? e.status : undefined
      const code = (e && typeof e === 'object' && 'code' in e) ? e.code : undefined
      if (status !== 1 && code !== 'ENOENT') {
        console.warn(`[runtime] getDescendantPids failed for PID ${pid}:`, e instanceof Error ? e.message : String(e))
      }
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
  if (process.platform === 'win32') {
    terminateWindowsProcessTree(rootPid)
    return
  }
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
    if (process.platform === 'win32') {
      // taskkill /T /F handles descendants atomically and is safe to repeat when the tree already exited.
      terminateWindowsProcessTree(childPid)
      void flushStderrSink().finally(resolve)
      return
    }

    let resolved = false

    // [HISTORICAL] 在发 SIGTERM 之前记录所有后代 PID
    // （runtime 退出后 pi 的 PPID 变为 1，pgrep -P 查不到）
    const descendantPids = getDescendantPids(childPid)

    // [HISTORICAL] timer 在 done 闭包外具名持有，done() 顶部 clearTimeout。
    // 否则 exit 先到 → done() resolve → 2s 后 timer 仍执行 killProcessTree，
    // 此时 PID 可能已被 OS 复用 → 误杀无关进程。
    let timer: ReturnType<typeof setTimeout> | null = null

    const done = async () => {
      if (resolved) return
      resolved = true
      // 双重保险：clearTimeout 防止 exit/timeout 竞态后 timer 仍触发 killProcessTree。
      // （timer 回调进入 done 时 resolved=true 会短路，但 clearTimeout 后连短路判断都不必走）
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      // 杀掉残留的后代进程（pi 等），同步完成后再 resolve
      // 避免异步 setTimeout 在 resolve 后误杀 PID 复用的新进程
      for (const pid of descendantPids) {
        // eslint-disable-next-line taste/no-silent-catch -- process may have already exited
        try { process.kill(pid, 'SIGTERM') } catch { /* 可能已随 runtime 退出 */ }
      }
      // M6（perf-quick-batch）：非阻塞等待后补 SIGKILL。
      // 旧实现 execSync('sleep 0.2') 同步阻塞主进程 200ms（KILL_WAIT_MS），
      // stop/restart 路径冻结主进程事件循环。改 await delay 后时长不变（INVAR-M6-1），
      // 时序不变（INVAR-M6-2：SIGTERM→等→SIGKILL），事件循环畅通（INVAR-M6-6）。
      await delay(KILL_WAIT_MS)
      for (const pid of descendantPids) {
        // eslint-disable-next-line taste/no-silent-catch -- process may have already exited
        try { process.kill(pid, 'SIGKILL') } catch { /* 可能已退出 */ }
      }
      // 子进程树已全部 kill，stderr 不再有新数据 → flush 并关闭 sink，
      // 防止 app.quit() 前 WriteStream 内部 buffer 未落盘丢失崩溃期证据。
      // done() 可能在 exit/timeout 两条路径触发，flushStderrSink 内置幂等（stderrSink=null 后 no-op）。
      // [HISTORICAL] W2：必须 await 等 'finish' 落盘，否则 stop() resolve 后 before-quit
      // 紧接 app.quit() 可能丢尾部 stderr。
      await flushStderrSink()
      resolve()
    }
    child.once('exit', done)
    child.kill('SIGTERM')
    // 超时后强制 SIGKILL（先杀整棵进程树）。done() 顶部 clearTimeout 保证 exit 先到时
    // 此 timer 不会在 2s 后误杀 PID 复用的新进程。
    timer = setTimeout(() => {
      child.removeListener('exit', done)
      // 强制杀进程树：runtime + 所有子进程
      killProcessTree(childPid, descendantPids)
      done()
    }, timeoutMs)
  })
}
