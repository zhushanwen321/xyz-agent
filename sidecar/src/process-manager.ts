import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { RpcClient, type RpcClientOptions } from './rpc-client.js'

// Find pi executable path. Search order:
// 1. PATH (which pi)
// 2. ~/.nvm/versions/node/*/bin/pi
// 3. /usr/local/bin/pi
// 4. ~/bin/pi
function findPiExecutable(): string {
  // 1. Try PATH
  try {
    const which = execSync('which pi', { encoding: 'utf-8' }).trim()
    if (which && existsSync(which)) return which
  } catch {
    // not in PATH
  }

  // 2. Try nvm managed node installations
  const nvmDir = join(homedir(), '.nvm', 'versions', 'node')
  try {
    const versions = readdirSync(nvmDir)
    for (const ver of versions) {
      const piPath = join(nvmDir, ver, 'bin', 'pi')
      if (existsSync(piPath)) return piPath
    }
  } catch {
    // nvm dir not found
  }

  // 3. Common locations
  const commonPaths = [
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
  private exitCallback: ((sessionId: string, code: number | null) => void) | null = null
  private piPath: string

  constructor() {
    this.piPath = findPiExecutable()
    if (this.piPath !== 'pi') {
      console.log(`[process-manager] using pi at: ${this.piPath}`)
    } else {
      console.warn('[process-manager] pi not found in common locations, relying on PATH')
    }
  }

  /**
   * Spawn a new pi subprocess for the given session.
   * If a process already exists for this sessionId it is killed first.
   */
  async createSession(sessionId: string, cwd: string, options?: RpcClientOptions): Promise<RpcClient> {
    if (this.processes.has(sessionId)) {
      await this.destroySession(sessionId)
    }

    // Inject discovered pi directory into PATH so spawn('pi', ...) resolves
    const piDir = this.piPath !== 'pi' ? join(this.piPath, '..') : undefined
    const pathEnv: Record<string, string> = {}
    if (piDir) {
      pathEnv.PATH = `${piDir}:${process.env.PATH ?? ''}`
    }

    const client = new RpcClient({ cwd, ...options, env: { ...pathEnv, ...options?.env } })
    try {
      await client.start()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('spawn') || msg.includes('ENOENT')) {
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
      if (this.exitCallback) {
        this.exitCallback(sessionId, code)
      }
    })

    this.processes.set(sessionId, {
      client,
      cwd,
      createdAt: Date.now(),
    })

    return client
  }

  /**
   * Kill the pi subprocess for a session.
   */
  async destroySession(sessionId: string): Promise<void> {
    const proc = this.processes.get(sessionId)
    if (!proc) return
    // 先删除 entry，防止 onExit 回调中 processes.has() 误触发 exitCallback
    this.processes.delete(sessionId)
    await proc.client.kill()
  }

  /**
   * Get the RpcClient for a session (or undefined if not running).
   */
  getClient(sessionId: string): RpcClient | undefined {
    return this.processes.get(sessionId)?.client
  }

  /**
   * Kill all managed subprocesses.
   */
  async destroyAll(): Promise<void> {
    const ids = Array.from(this.processes.keys())
    await Promise.allSettled(ids.map(id => this.destroySession(id)))
  }

  /**
   * Validate that a provider configuration works by spawning a
   * temporary pi process and attempting to list models.
   */
  async validateProvider(
    providerId: string,
    apiKey: string,
    baseUrl?: string,
  ): Promise<boolean> {
    const env: Record<string, string> = {}
    const prefix = providerId.toUpperCase().replace(/-/g, '_')
    env[`${prefix}_API_KEY`] = apiKey
    if (baseUrl) env[`${prefix}_BASE_URL`] = baseUrl

    const client = new RpcClient({ provider: providerId, env })
    try {
      await client.start()
      const result = await client.getAvailableModels()
      return result.type !== 'error'
    } catch {
      return false
    } finally {
      await client.kill()
    }
  }

  /** Check if the subprocess for a session is still running. */
  isAlive(sessionId: string): boolean {
    const proc = this.processes.get(sessionId)
    return !!proc && !proc.client.exited
  }

  /** Register a callback for when a session's process exits unexpectedly. */
  onSessionExit(callback: (sessionId: string, code: number | null) => void): void {
    this.exitCallback = callback
  }

  /** Number of active processes. */
  get size(): number {
    return this.processes.size
  }
}
