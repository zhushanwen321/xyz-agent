import { type ChildProcess, spawn, execSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { homedir } from 'node:os'

/** 管理 Agent Runtime 子进程的启停、端口发现、健康检查。 */
export class RuntimeManager {
  private child: ChildProcess | null = null
  private _port: number | null = null

  // 端口/重试常量
  // eslint-disable-next-line no-magic-numbers
  private static readonly PORT_START = 3210
  // eslint-disable-next-line no-magic-numbers
  private static readonly PORT_END = 3220
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
   * 用 lsof 查找占用端口的进程并 kill。
   * 先 SIGTERM，等 200ms 后再 SIGKILL，和 Rust 版行为一致。
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
   * 在 3210-3220 范围内寻找可用端口。
   * 如果被占用则尝试 kill stale process，等 300ms 后重试。
   */
  private async findAvailablePort(): Promise<number> {
    for (let port = RuntimeManager.PORT_START; port <= RuntimeManager.PORT_END; port++) {
      const inUse = await this.isPortInUse(port)
      if (!inUse) return port

      // 端口被占用，尝试 kill stale
      this.killStaleProcessOnPort(port)
      await this.sleep(RuntimeManager.PORT_RETRY_MS)

      const stillInUse = await this.isPortInUse(port)
      if (!stillInUse) return port
    }
    throw new Error('No available port in range 3210-3220')
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

  /** 将端口写入 ~/.xyz-agent/runtime.port，供 cold-start 场景发现 */
  private writePortFile(port: number): void {
    try {
      const dir = path.join(homedir(), '.xyz-agent')
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'runtime.port'), String(port))
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
        'index.cjs',
      )
      if (!existsSync(runtimeDist)) {
        throw new Error(`Runtime bundle not found at ${runtimeDist}`)
      }
      cmd = 'node'
      args = [runtimeDist, `--port=${port}`]
      console.log(`[runtime] node ${runtimeDist} --port=${port}`)
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
    this.child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    })

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

  /** 停止 runtime 子进程，等待退出或超时 */
  stop(timeoutMs = RuntimeManager.STOP_TIMEOUT_MS): Promise<void> {
    return new Promise((resolve) => {
      if (!this.child || this.child.killed) {
        this.child = null
        this._port = null
        resolve()
        return
      }
      const child = this.child
      let resolved = false
      const done = () => {
        if (resolved) return
        resolved = true
        this.child = null
        this._port = null
        resolve()
      }
      child.once('exit', done)
      child.kill('SIGTERM')
      // 超时后强制 SIGKILL
      setTimeout(() => {
        child.removeListener('exit', done)
        if (!child.killed) {
          try { child.kill('SIGKILL') }
          // eslint-disable-next-line taste/no-silent-catch -- 进程可能已退出
          catch { /* ignore */ }
        }
        done()
      }, timeoutMs)
    })
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
