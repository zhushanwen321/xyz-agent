import { RpcClient, type RpcClientOptions } from './rpc-client.js'

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

  /**
   * Spawn a new pi subprocess for the given session.
   * If a process already exists for this sessionId it is killed first.
   */
  async createSession(sessionId: string, cwd: string, options?: RpcClientOptions): Promise<RpcClient> {
    if (this.processes.has(sessionId)) {
      await this.destroySession(sessionId)
    }

    const client = new RpcClient({ cwd, ...options })
    await client.start()

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
    await proc.client.kill()
    this.processes.delete(sessionId)
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

  /** Number of active processes. */
  get size(): number {
    return this.processes.size
  }
}
