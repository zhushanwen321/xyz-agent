import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { buildProviderEnv, getDefaultModel } from './config-store.js'

export interface PiMessage {
  id?: string
  type: string
  payload?: Record<string, unknown>
}

export type PiEventListener = (event: PiMessage) => void

export interface RpcClientOptions {
  cwd?: string
  provider?: string
  model?: string
  env?: Record<string, string>
}

const CMD_TIMEOUT_MS = 60_000
const KILL_TIMEOUT_MS = 2_000
const STARTUP_DELAY_MS = 100

export class RpcClient {
  private proc: ChildProcess | null = null
  private pending = new Map<string, {
    resolve: (msg: PiMessage) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private listeners = new Set<PiEventListener>()
  private msgCounter = 0
  private _exited = false

  constructor(private options: RpcClientOptions = {}) {}

  async start(): Promise<void> {
    const model = this.options.model ?? getDefaultModel()
    const providerId = this.options.provider ?? model.split('/')[0]

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...this.options.env,
    }

    if (providerId) {
      Object.assign(env, buildProviderEnv(providerId))
    }

    const args = ['--mode', 'rpc']
    if (model) args.push('--model', model)

    this.proc = spawn('pi', args, {
      cwd: this.options.cwd ?? process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const proc = this.proc

    proc.on('error', (err) => {
      console.error('[rpc] spawn error:', err)
      this.rejectAll(new Error(`Failed to spawn pi: ${err.message}`))
    })

    proc.on('exit', (code) => {
      this._exited = true
      console.log(`[rpc] process exited with code ${code}`)
      this.rejectAll(new Error(`pi process exited with code ${code}`))
    })

    // Parse stdout JSONL
    const rl = createInterface({ input: proc.stdout! })
    rl.on('line', (line) => {
      if (!line.trim()) return
      try {
        const msg: PiMessage = JSON.parse(line)
        this.handleMessage(msg)
      } catch (e) {
        console.error('[rpc] stdout parse error:', line, e)
      }
    })

    // Forward stderr to logs
    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        console.error('[rpc:stderr]', data.toString().trimEnd())
      })
    }

    // Wait briefly to confirm process didn't exit immediately
    await new Promise<void>((resolve, reject) => {
      const onExit = (code: number | null) => {
        cleanup()
        reject(new Error(`pi process exited immediately with code ${code}`))
      }
      const onError = (err: Error) => {
        cleanup()
        reject(new Error(`pi spawn error: ${err.message}`))
      }
      const cleanup = () => {
        proc.removeListener('exit', onExit)
        proc.removeListener('error', onError)
      }
      proc.on('exit', onExit)
      proc.on('error', onError)
      setTimeout(() => {
        cleanup()
        if (!this._exited) resolve()
        else reject(new Error('pi process exited during startup'))
      }, STARTUP_DELAY_MS)
    })
  }

  private handleMessage(msg: PiMessage): void {
    // If id matches a pending request, resolve it; otherwise emit as event
    if (msg.id && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id)!
      clearTimeout(entry.timer)
      this.pending.delete(msg.id)
      entry.resolve(msg)
    } else {
      for (const listener of this.listeners) {
        listener(msg)
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }

  private nextId(): string {
    return `rpc_${++this.msgCounter}_${Date.now()}`
  }

  /**
   * Send a raw command and wait for a response with matching id.
   */
  sendCommand(type: string, params: Record<string, unknown> = {}): Promise<PiMessage> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this._exited) {
        return reject(new Error('pi process is not running'))
      }

      const id = this.nextId()
      const msg = JSON.stringify({ id, type, ...params }) + '\n'

      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC command "${type}" timed out after ${CMD_TIMEOUT_MS}ms`))
      }, CMD_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })

      try {
        this.proc.stdin!.write(msg)
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`Failed to write to pi stdin: ${e}`))
      }
    })
  }

  /**
   * Register an event listener for non-response messages from pi.
   * Returns an unsubscribe function.
   */
  onEvent(listener: PiEventListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  get exited(): boolean {
    return this._exited
  }

  // ── High-level API ────────────────────────────────────────────────

  prompt(content: string): Promise<PiMessage> {
    return this.sendCommand('prompt', { content })
  }

  abort(): Promise<PiMessage> {
    return this.sendCommand('abort')
  }

  setModel(provider: string, modelId: string): Promise<PiMessage> {
    return this.sendCommand('setModel', { provider, modelId })
  }

  getAvailableModels(): Promise<PiMessage> {
    return this.sendCommand('listModels')
  }

  getHistory(): Promise<PiMessage> {
    return this.sendCommand('getHistory')
  }

  approveTool(toolCallId: string): Promise<PiMessage> {
    return this.sendCommand('toolApprove', { toolCallId })
  }

  denyTool(toolCallId: string): Promise<PiMessage> {
    return this.sendCommand('toolDeny', { toolCallId })
  }

  alwaysAllowTool(toolName: string): Promise<PiMessage> {
    return this.sendCommand('toolAlwaysAllow', { toolName })
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async kill(): Promise<void> {
    if (!this.proc || this._exited) return

    return new Promise<void>((resolve) => {
      const proc = this.proc!
      let settled = false

      const done = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }

      const killTimer = setTimeout(() => {
        console.warn('[rpc] SIGKILL after timeout')
        proc.kill('SIGKILL')
        done()
      }, KILL_TIMEOUT_MS)

      proc.on('exit', () => {
        clearTimeout(killTimer)
        done()
      })

      proc.kill('SIGTERM')
    })
  }
}
