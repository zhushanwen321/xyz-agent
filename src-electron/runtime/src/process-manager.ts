import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter as pathDelimiter, join } from 'node:path'
import { execSync } from 'node:child_process'
import { RpcClient, type RpcClientOptions } from './rpc-client.js'

// Find pi executable path (cross-platform). Search order:
// 1. PATH (which/where pi)
// 2. nvm managed node installations
// 3. Common locations
function findPiExecutable(): string {
  // Packaged mode: use bundled pi binary from resources
  if (process.env.XYZ_AGENT_PACKAGED === '1') {
    const platform = process.platform  // 'darwin' | 'win32' | 'linux'
    const arch = process.arch          // 'arm64' | 'x64'

    const binaryName = platform === 'win32'
      ? `pi-windows-${arch}.exe`
      : `pi-${platform}-${arch}`

    // Sidecar's cwd = process.resourcesPath (set by runtime-manager.ts)
    const bundledPi = join(process.cwd(), 'pi', binaryName)

    if (!existsSync(bundledPi)) {
      throw new Error(
        `Bundled pi binary not found at ${bundledPi}. `
        + `Expected binary: ${binaryName}. `
        + 'The application installation may be corrupted.',
      )
    }

    console.log(`[process-manager] using bundled pi: ${bundledPi}`)
    return bundledPi
  }

  // Development mode: original discovery logic
  const isWindows = process.platform === 'win32'

  // 1. Try PATH
  try {
    const whichCmd = isWindows ? 'where pi' : 'which pi'
    const which = execSync(whichCmd, { encoding: 'utf-8' }).trim()
    // Windows 'where' may return multiple lines, take first
    const firstMatch = which.split('\n')[0].trim()
    if (firstMatch && existsSync(firstMatch)) return firstMatch
  } catch {
    // expected: pi not in PATH
    void 0
  }

  // 2. Try nvm managed node installations
  if (isWindows) {
    // nvm-windows stores versions in %APPDATA%\nvm
    const nvmDir = join(process.env.APPDATA ?? '', 'nvm')
    try {
      const versions = readdirSync(nvmDir)
      for (const ver of versions) {
        const piPath = join(nvmDir, ver, 'pi.cmd')
        if (existsSync(piPath)) return piPath
        const piExe = join(nvmDir, ver, 'pi.exe')
        if (existsSync(piExe)) return piExe
      }
    } catch {
      // expected: directory not found, skip
      void 0
    }
  } else {
    const nvmDir = join(homedir(), '.nvm', 'versions', 'node')
    try {
      const versions = readdirSync(nvmDir)
      for (const ver of versions) {
        const piPath = join(nvmDir, ver, 'bin', 'pi')
        if (existsSync(piPath)) return piPath
      }
    } catch {
      // expected: directory not found, skip
      void 0
    }
  }

  // 3. Common locations
  const commonPaths = isWindows
    ? [
      join(process.env.APPDATA ?? '', 'npm', 'pi.cmd'),
      join(process.env.APPDATA ?? '', 'npm', 'pi.exe'),
    ]
    : [
      '/usr/local/bin/pi',
      join(homedir(), 'bin', 'pi'),
    ]
  for (const p of commonPaths) {
    if (existsSync(p)) return p
  }

  // Fallback to bare 'pi' (will fail with clear error)
  return 'pi'
}

interface ManagedProcess {
  client: RpcClient
  cwd: string
  createdAt: number
}

/**
 * Manages pi subprocess lifecycles. Each session gets its own
 * isolated pi process spawned via `pi --mode rpc`.
 */
export class ProcessManager {
  private processes = new Map<string, ManagedProcess>()
  private clientToId = new Map<RpcClient, string>()
  private exitCallbacks = new Set<(sessionId: string, code: number | null) => void>()
  private piPath: string | null = null
  private piPathPromise: Promise<string> | null = null

  constructor() {
    // 懒初始化：不在构造函数中执行同步 I/O，避免阻塞事件循环
    // piPath 在首次 createSession 时才解析
  }

  /** 获取或解析 pi 可执行文件路径（只执行一次） */
  private getPiPath(): Promise<string> {
    if (this.piPath) return Promise.resolve(this.piPath)
    if (this.piPathPromise) return this.piPathPromise
    this.piPathPromise = Promise.resolve().then(() => {
      const resolved = findPiExecutable()
      this.piPath = resolved
      if (resolved !== 'pi') {
        console.log(`[process-manager] using pi at: ${resolved}`)
      } else {
        console.warn('[process-manager] pi not found in common locations, relying on PATH')
      }
      return resolved
    })
    return this.piPathPromise
  }

  /**
   * Spawn a new pi subprocess for the given session.
   * If a process already exists for this sessionId it is killed first.
   */
  async createSession(sessionId: string, cwd: string, options?: RpcClientOptions): Promise<RpcClient> {
    if (this.processes.has(sessionId)) {
      await this.destroySession(sessionId)
    }

    const piPath = await this.getPiPath()

    // Inject discovered pi directory into PATH so spawn('pi', ...) resolves
    const piDir = piPath !== 'pi' ? join(piPath, '..') : undefined
    const pathEnv: Record<string, string> = {}
    if (piDir) {
      pathEnv.PATH = `${piDir}${pathDelimiter}${process.env.PATH ?? ''}`
    }

    const client = new RpcClient({ cwd, ...options, env: { ...pathEnv, ...options?.env }, piCommand: piPath !== 'pi' ? piPath : undefined })
    try {
      await client.start()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('spawn') || msg.includes('ENOENT')) {
        if (process.env.XYZ_AGENT_PACKAGED === '1') {
          throw new Error(
            `Failed to start bundled pi process. The application installation may be corrupted. `
            + `Attempted binary: ${piPath}. Original error: ${msg}`,
          )
        }
        throw new Error(
          `Failed to start pi process. Ensure pi is installed globally (npm i -g @mariozechner/pi-coding-agent). `
          + `Searched: PATH, ~/.nvm/versions/*/bin/pi, /usr/local/bin/pi. `
          + `Original error: ${msg}`,
        )
      }
      throw e
    }

    // Listen for unexpected exits to notify upper layer
    client.onExit((code) => {
      // If processes no longer has this sessionId, it was destroyed intentionally
      if (!this.processes.has(sessionId)) return
      console.warn(`[process-manager] session ${sessionId} process exited unexpectedly (code: ${code})`)
      this.processes.delete(sessionId)
      this.clientToId.delete(client)
      for (const cb of this.exitCallbacks) {
        cb(sessionId, code)
      }
    })

    this.processes.set(sessionId, {
      client,
      cwd,
      createdAt: Date.now(),
    })
    this.clientToId.set(client, sessionId)

    return client
  }

  /**
   * Kill the pi subprocess for a session.
   */
  async destroySession(sessionId: string): Promise<void> {
    const proc = this.processes.get(sessionId)
    if (!proc) return
    this.processes.delete(sessionId)
    this.clientToId.delete(proc.client)
    await proc.client.kill()
  }

  /**
   * Get the RpcClient for a session (or undefined if not running).
   */
  getClient(sessionId: string): RpcClient | undefined {
    return this.processes.get(sessionId)?.client
  }

  /** Get session ID by client instance (O(1) reverse lookup). */
  getSessionIdByClient(client: RpcClient): string | undefined {
    return this.clientToId.get(client)
  }

  hasClient(sessionId: string): boolean {
    return this.processes.has(sessionId)
  }

  /**
   * Kill all managed subprocesses.
   */
  async destroyAll(): Promise<void> {
    const ids = Array.from(this.processes.keys())
    await Promise.allSettled(ids.map(id => this.destroySession(id)))
  }

  /** Check if the subprocess for a session is still running. */
  isAlive(sessionId: string): boolean {
    const proc = this.processes.get(sessionId)
    return !!proc && !proc.client.exited
  }

  /** Rekey a process entry after learning the real session ID. */
  rekey(oldId: string, newId: string): void {
    const entry = this.processes.get(oldId)
    if (!entry) return
    this.processes.delete(oldId)
    this.processes.set(newId, entry)
    this.clientToId.set(entry.client, newId)
  }

  /** Register a callback for when a session's process exits unexpectedly. Returns unsubscribe function. */
  onSessionExit(callback: (sessionId: string, code: number | null) => void): () => void {
    this.exitCallbacks.add(callback)
    return () => { this.exitCallbacks.delete(callback) }
  }

  /** Number of active processes. */
  get size(): number {
    return this.processes.size
  }
}
