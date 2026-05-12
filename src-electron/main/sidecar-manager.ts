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
          } catch {
            // 进程可能已退出
          }
          // 等待 200ms 后补 SIGKILL
          setTimeout(() => {
            try {
              process.kill(pid, 'SIGKILL')
            } catch {
              // 已经死了
            }
          }, 200)
        }
      }
    } catch {
      // lsof 没找到进程，正常情况
    }
  }

  /**
   * 在 3210-3220 范围内寻找可用端口。
   * 如果被占用则尝试 kill stale process，等 300ms 后重试。
   */
  private async findAvailablePort(): Promise<number> {
    for (let port = 3210; port <= 3220; port++) {
      const inUse = await this.isPortInUse(port)
      if (!inUse) return port

      // 端口被占用，尝试 kill stale
      this.killStaleProcessOnPort(port)
      await this.sleep(300)

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
    for (let i = 0; i < 30; i++) {
      if (!await this.isPortInUse(port)) {
        await this.sleep(200)
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

    // 定位项目根目录（src-electron/）
    const projectRoot = app.getAppPath()
    const tsxPath = path.join(projectRoot, 'node_modules', '.bin', 'tsx')
    const sidecarEntry = path.join(projectRoot, 'sidecar', 'src', 'index.ts')

    if (!existsSync(tsxPath)) {
      throw new Error(`tsx not found at ${tsxPath}. Run: npm install`)
    }
    if (!existsSync(sidecarEntry)) {
      throw new Error(`Sidecar entry not found at ${sidecarEntry}`)
    }

    console.log(`[sidecar] node ${tsxPath} ${sidecarEntry} --port=${port}`)

    this.child = spawn('node', [tsxPath, sidecarEntry, `--port=${port}`], {
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
