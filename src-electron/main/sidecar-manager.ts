import { type ChildProcess, spawn, execSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { homedir } from 'node:os'

/** 管理 sidecar 子进程的启停、端口发现、健康检查。移植自 src-tauri/src/sidecar.rs */
export class SidecarManager {
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

  get port(): number | null {
    return this._port
  }

  /**
   * 用 lsof 查找占用端口的进程并 kill。
   * 先 SIGTERM，等 200ms 后再 SIGKILL，和 Rust 版行为一致。
   */
  private killStaleProcessOnPort(port: number): void {
    try {
      const output = execSync(`lsof -ti :${port} -sTCP:LISTEN`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      for (const line of output.trim().split('\n')) {
        const pid = Number(line.trim())
        if (!Number.isNaN(pid) && pid > 0) {
          console.log(`[sidecar] Killing stale process ${pid} on port ${port}`)
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
          }, SidecarManager.KILL_WAIT_MS)
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
    for (let port = SidecarManager.PORT_START; port <= SidecarManager.PORT_END; port++) {
      const inUse = await this.isPortInUse(port)
      if (!inUse) return port

      // 端口被占用，尝试 kill stale
      this.killStaleProcessOnPort(port)
      await this.sleep(SidecarManager.PORT_RETRY_MS)

      const stillInUse = await this.isPortInUse(port)
      if (!stillInUse) return port
    }
    throw new Error('No available port in range 3210-3220')
  }

  private isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ port, host: '127.0.0.1' }, () => {
        socket.destroy()
        resolve(true)
      })
      socket.on('error', () => resolve(false))
    })
  }

  /** 将端口写入 ~/.xyz-agent/sidecar.port，供 cold-start 场景发现 */
  private writePortFile(port: number): void {
    const dir = path.join(homedir(), '.xyz-agent')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'sidecar.port'), String(port))
  }

  /**
   * TCP 健康检查：最多 30 次重试，每次间隔 200ms。
   * 总等待时间约 6s。
   */
  private async healthCheck(port: number): Promise<void> {
    for (let i = 0; i < SidecarManager.HEALTH_RETRY_COUNT; i++) {
      if (!await this.isPortInUse(port)) {
        await this.sleep(SidecarManager.HEALTH_INTERVAL_MS)
        continue
      }
      // 能连上说明 sidecar 已经在监听
      return
    }
    throw new Error(`Sidecar health check timed out on port ${port}`)
  }

  /**
   * 启动 sidecar：找端口 → spawn 进程 → 健康检查 → 写端口文件。
   * 返回实际使用的端口号。
   */
  async start(): Promise<number> {
    // 先停掉已有的
    this.stop()

    const port = await this.findAvailablePort()
    console.log(`[sidecar] Starting on port ${port}`)

    // 根据打包状态选择 sidecar 启动方式
    const projectRoot = app.getAppPath()
    let cmd: string
    let args: string[]

    if (app.isPackaged) {
      // 生产环境：运行 asar unpack 后的预编译 JS
      // asarUnpack 将 dist/sidecar 解压到 app.asar.unpacked/
      const sidecarDist = path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'dist',
        'sidecar',
        'index.js',
      )
      if (!existsSync(sidecarDist)) {
        throw new Error(`Sidecar bundle not found at ${sidecarDist}`)
      }
      cmd = 'node'
      args = [sidecarDist, `--port=${port}`]
      console.log(`[sidecar] node ${sidecarDist} --port=${port}`)
    } else {
      // 开发环境：tsx 运行 TS 源码
      const tsxPath = path.join(projectRoot, 'node_modules', '.bin', 'tsx')
      const sidecarEntry = path.join(projectRoot, 'sidecar', 'src', 'index.ts')

      if (!existsSync(tsxPath)) {
        throw new Error(`tsx not found at ${tsxPath}. Run: npm install`)
      }
      if (!existsSync(sidecarEntry)) {
        throw new Error(`Sidecar entry not found at ${sidecarEntry}`)
      }

      cmd = 'node'
      args = [tsxPath, sidecarEntry, `--port=${port}`]
      console.log(`[sidecar] node ${tsxPath} ${sidecarEntry} --port=${port}`)
    }

    this.child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: projectRoot,
    })

    // sidecar 日志转发：只用 console（dev 模式方便调试）。
    // 安装全局 EPIPE 兜底防止 pipe 断开时崩溃
    this.child.stdout?.on('data', (data: Buffer) => {
      console.log(`[sidecar:out] ${data.toString().trimEnd()}`)
    })
    this.child.stderr?.on('data', (data: Buffer) => {
      console.error(`[sidecar:err] ${data.toString().trimEnd()}`)
    })
    this.child.on('exit', (code) => {
      console.log(`[sidecar] Process exited with code ${code}`)
      this.child = null
    })

    await this.healthCheck(port)
    this.writePortFile(port)
    this._port = port

    console.log(`[sidecar] Ready on port ${port}`)
    return port
  }

  /** 停止 sidecar 子进程 */
  stop(): void {
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM')
      this.child = null
    }
    this._port = null
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
