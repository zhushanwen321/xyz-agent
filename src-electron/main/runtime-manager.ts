import { type ChildProcess, spawn, execSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { homedir } from 'node:os'
import { BASE_PORT, MAX_PORT as MAX_PORT_CONST, ENV_WHITELIST_PREFIXES } from '@xyz-agent/shared'

/** 子进程允许继承的环境变量前缀白名单 — extends shared list with ELECTRON_ for main process */
const ENV_WHITELIST = [...ENV_WHITELIST_PREFIXES, 'ELECTRON_']

/** 构建最小权限的环境变量：只继承白名单前缀 + 额外指定变量 */
function buildSafeEnv(extras: Record<string, string | undefined>): Record<string, string> {
  const safe: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ENV_WHITELIST.some(prefix => key.startsWith(prefix) || key === prefix)) {
      safe[key] = value
    }
  }
  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined) safe[key] = value
  }
  return safe
}

/** tsup (CJS format) 输出的 runtime 入口文件名，必须与 runtime/tsup.config.ts 的 format 保持一致 */
const RUNTIME_ENTRY_FILE = 'index.cjs'

/** 管理 Agent Runtime 子进程的启停、端口发现、健康检查。 */
export class RuntimeManager {
  private child: ChildProcess | null = null
  private _port: number | null = null

  // 端口/重试常量
  // 端口范围可通过 XYZ_AGENT_PORT_OFFSET 偏移（dev 模式 +100 → 3310-3320）
  private static readonly BASE_PORT_START = BASE_PORT
  // eslint-disable-next-line no-magic-numbers -- port range size: 10 consecutive ports
  private static readonly BASE_PORT_END = BASE_PORT + 10
  private static readonly MAX_PORT = MAX_PORT_CONST
  // eslint-disable-next-line no-magic-numbers
  private static readonly KILL_WAIT_MS = 200
  // eslint-disable-next-line no-magic-numbers
  private static readonly PORT_RETRY_MS = 300
  // eslint-disable-next-line no-magic-numbers
  private static readonly HEALTH_RETRY_COUNT = 30
  // eslint-disable-next-line no-magic-numbers
  private static readonly HEALTH_INTERVAL_MS = 200
  // eslint-disable-next-line no-magic-numbers
  private static readonly CONNECT_TIMEOUT_MS = 500
  // eslint-disable-next-line no-magic-numbers
  private static readonly STOP_TIMEOUT_MS = 2000

  get port(): number | null {
    return this._port
  }

  /**
   * 安全 kill 白名单：匹配路径分隔符后的 basename。
   * macOS `ps -o comm=` 可能返回完整路径（如 `/Applications/xyz-agent.app/Contents/MacOS/xyz-agent`），
   * 所以匹配 `/` 或 `\` 或行首之后的 basename。
   */
  private static readonly SAFE_KILL_NAMES = /(?:^|[\/\\])(?:node|pi|tsx|electron|xyz-agent|bash|sh|zsh)$/i

  /**
   * 用 lsof 查找占用端口的进程并 kill。
   * 先 SIGTERM，等 200ms 后再 SIGKILL，和 Rust 版行为一致。
   * 只 kill 进程名匹配 node/pi/tsx 等的进程，防止误杀无关服务。
   */
  private killStaleProcessOnPort(port: number): void {
    try {
      // 注意：-sTCP:LISTEN 在 Linux 上不可用，用兼容方案
      const output = execSync(`lsof -n -P -i :${port} 2>/dev/null | grep LISTEN | awk '{print $2}' || true`, {
        encoding: 'utf-8',
        shell: '/bin/bash',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      for (const line of output.trim().split('\n')) {
        const pid = Number(line.trim())
        if (!Number.isNaN(pid) && pid > 0) {
          // 验证进程名，只 kill 已知的 agent 相关进程
          if (!this.isSafeToKill(pid)) {
            console.warn(`[runtime] Port ${port} occupied by PID ${pid} but process name not in allowlist, skipping kill`)
            continue
          }
          console.log(`[runtime] Killing stale process ${pid} on port ${port}`)
          try {
            process.kill(pid, 'SIGTERM')
          // eslint-disable-next-line taste/no-silent-catch
          } catch {
            // 进程可能已退出，非关键错误
          }
          // 等待后补 SIGKILL
          setTimeout(() => {
            try {
              process.kill(pid, 'SIGKILL')
            // eslint-disable-next-line taste/no-silent-catch
            } catch {
              // 已经死了，非关键错误
            }
          }, RuntimeManager.KILL_WAIT_MS)
        }
      }
    // eslint-disable-next-line taste/no-silent-catch
    } catch {
      // lsof 没找到进程，正常情况，无需处理
    }
  }

  /**
   * 检查进程名是否在安全 kill 列表中。
   * 正则匹配路径分隔符后的 basename，兼容 macOS 返回完整路径或 basename。
   */
  private isSafeToKill(pid: number): boolean {
    try {
      const name = execSync(`ps -p ${pid} -o comm= 2>/dev/null || true`, {
        encoding: 'utf-8',
        shell: '/bin/bash',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      if (!name) return false
      return RuntimeManager.SAFE_KILL_NAMES.test(name)
    } catch {
      return false
    }
  }

  /** 端口偏移量（供 IPC handler 读取） */
  get portOffset(): number { return this.getPortOffset() }

  /** 获取端口偏移（默认 0，dev 模式 +100），clamp 到 [0, 65535-BASE_PORT_START] */
  private getPortOffset(): number {
    const raw = parseInt(process.env.XYZ_AGENT_PORT_OFFSET ?? '0', 10) || 0
    return Math.max(0, Math.min(raw, RuntimeManager.MAX_PORT - RuntimeManager.BASE_PORT_START))
  }

  /** 获取动态端口范围的起止 */
  private getPortRange(): { start: number; end: number } {
    const offset = this.getPortOffset()
    return {
      start: RuntimeManager.BASE_PORT_START + offset,
      end: RuntimeManager.BASE_PORT_END + offset,
    }
  }

  /**
   * 在动态端口范围内寻找可用端口（默认 3210-3220，dev 3310-3320）。
   * 如果被占用则尝试 kill stale process，等 300ms 后重试。
   *
   * 合并了之前的 cleanupStaleProcessesInRange 逻辑：扫描时遇占用端口直接 kill，
   * 避免两次遍历整个端口范围的延迟。
   */
  private async findAvailablePort(): Promise<number> {
    const { start, end } = this.getPortRange()
    let cleanedAny = false
    for (let port = start; port <= end; port++) {
      const inUse = await this.isPortInUse(port)
      if (!inUse) {
        // 如果之前清理了其他端口，这里多等一下让 kill 生效
        if (cleanedAny) await this.sleep(RuntimeManager.PORT_RETRY_MS)
        return port
      }

      // 端口被占用，尝试 kill stale
      console.log(`[runtime] Port ${port} in use, cleaning up stale process`)
      this.killStaleProcessOnPort(port)
      cleanedAny = true
      await this.sleep(RuntimeManager.PORT_RETRY_MS)

      const stillInUse = await this.isPortInUse(port)
      if (!stillInUse) return port
    }
    throw new Error(`No available port in range ${start}-${end}`)
  }

  private isPortInUse(port: number, timeoutMs = RuntimeManager.CONNECT_TIMEOUT_MS): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ port, host: '127.0.0.1' }, () => {
        socket.destroy()
        resolve(true)
      })
      socket.on('error', () => resolve(false))
      socket.setTimeout(timeoutMs, () => {
        socket.destroy()
        resolve(false)
      })
    })
  }

  /** 将端口写入 \$XYZ_AGENT_DATA_DIR/runtime.port（默认 ~/.xyz-agent/runtime.port） */
  private writePortFile(port: number): void {
    try {
      const dataDir = process.env.XYZ_AGENT_DATA_DIR ?? path.join(homedir(), '.xyz-agent')
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(path.join(dataDir, 'runtime.port'), String(port))
    // eslint-disable-next-line taste/no-silent-catch -- 端口文件非关键，失败不阻塞主流程
    } catch (err) {
      console.error('[runtime] Failed to write port file:', err)
    }
  }

  /**
   * TCP 健康检查：最多 30 次重试，每次间隔 200ms。
   * 总等待时间约 6s。
   */
  private async healthCheck(port: number): Promise<void> {
    for (let i = 0; i < RuntimeManager.HEALTH_RETRY_COUNT; i++) {
      if (!await this.isPortInUse(port)) {
        await this.sleep(RuntimeManager.HEALTH_INTERVAL_MS)
        continue
      }
      // 能连上说明 runtime 已经在监听
      return
    }
    throw new Error(`Runtime health check timed out on port ${port}`)
  }

  /**
   * 启动 runtime：找端口 → spawn 进程 → 健康检查 → 写端口文件。
   * 返回实际使用的端口号。
   */
  async start(): Promise<number> {
    // 先停掉已有的，等待其真正退出
    await this.stop()

    const port = await this.findAvailablePort()
    console.log(`[runtime] Starting on port ${port}`)

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
      const tsxPath = path.join(projectRoot, 'node_modules', '.bin', 'tsx')
      const runtimeEntry = path.join(projectRoot, 'runtime', 'src', 'index.ts')

      if (!existsSync(tsxPath)) {
        throw new Error(`tsx not found at ${tsxPath}. Run: npm install`)
      }
      if (!existsSync(runtimeEntry)) {
        throw new Error(`Runtime entry not found at ${runtimeEntry}`)
      }

      cmd = 'node'
      args = [tsxPath, runtimeEntry, `--port=${port}`]
      console.log(`[runtime] node ${tsxPath} ${runtimeEntry} --port=${port}`)
    }

    // 打包后 app.getAppPath() 返回 app.asar（文件），不能作为 cwd
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
    this.child = spawn(cmd, args, spawnOptions)

    this.child.on('error', (err) => {
      console.error(`[runtime] Spawn error: ${err.message}`)
    })

    // runtime 日志转发：只用 console（dev 模式方便调试）。
    // 安装全局 EPIPE 兜底防止 pipe 断开时崩溃
    this.child.stdout?.on('data', (data: Buffer) => {
      console.log(`[runtime:out] ${data.toString().trimEnd()}`)
    })
    this.child.stderr?.on('data', (data: Buffer) => {
      console.error(`[runtime:err] ${data.toString().trimEnd()}`)
    })
    this.child.on('exit', (code) => {
      console.log(`[runtime] Process exited with code ${code}`)
      this.child = null
    })

    await this.healthCheck(port)
    this.writePortFile(port)
    this._port = port

    console.log(`[runtime] Ready on port ${port}`)
    return port
  }

  /** 停止 runtime 子进程及其子进程树（包括 pi），等待退出或超时 */
  stop(timeoutMs = RuntimeManager.STOP_TIMEOUT_MS): Promise<void> {
    return new Promise((resolve) => {
      if (!this.child || this.child.killed) {
        this.child = null
        this._port = null
        resolve()
        return
      }
      const child = this.child
      const childPid = child.pid!
      let resolved = false

      // 在发 SIGTERM 之前记录所有后代 PID
      // （runtime 退出后 pi 的 PPID 变为 1，pgrep -P 查不到）
      const descendantPids = this.getDescendantPids(childPid)

      const done = () => {
        if (resolved) return
        resolved = true
        // 杀掉残留的后代进程（pi 等）
        for (const pid of descendantPids) {
          try { process.kill(pid, 'SIGTERM') } catch { /* 可能已随 runtime 退出 */ }
        }
        // 短暂等待后补 SIGKILL
        setTimeout(() => {
          for (const pid of descendantPids) {
            try { process.kill(pid, 'SIGKILL') } catch { /* 可能已退出 */ }
          }
        }, RuntimeManager.KILL_WAIT_MS)
        this.child = null
        this._port = null
        resolve()
      }
      child.once('exit', done)
      child.kill('SIGTERM')
      // 超时后强制 SIGKILL（先杀整棵进程树）
      setTimeout(() => {
        child.removeListener('exit', done)
        // 强制杀进程树：runtime + 所有子进程
        this.killProcessTree(childPid, descendantPids)
        done()
      }, timeoutMs)
    })
  }

  /**
   * 强制杀掉整棵进程树（父进程 + 所有后代）。
   * 用于 stop() 超时后的强制清理。
   */
  private killProcessTree(rootPid: number, precomputedDescendants?: number[]): void {
    const pids = precomputedDescendants ?? this.getDescendantPids(rootPid)
    // 先杀后代（倒序：孙→子）
    for (const pid of pids.reverse()) {
      try { process.kill(pid, 'SIGKILL') } catch { /* 可能已退出 */ }
    }
    // 再杀根进程
    try { process.kill(rootPid, 'SIGKILL') } catch { /* 可能已退出 */ }
  }

  /**
   * 递归获取指定 PID 的所有后代进程 PID（广度优先，返回按代排列：子→孙→...）。
   */
  private getDescendantPids(parentPid: number): number[] {
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
      } catch (e) {
        // pgrep 失败（进程已退出），非关键
        console.warn(`[runtime] getDescendantPids failed for PID ${pid}:`, e instanceof Error ? e.message : String(e))
      }
    }
    return result
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
