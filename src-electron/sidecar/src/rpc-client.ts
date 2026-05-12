import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
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
const COMPACT_TIMEOUT_MS = 5 * 60_000
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
  private _killing = false
  private exitCallback: ((code: number | null) => void) | null = null

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

    // 使用独立的 session 目录，避免和 pi 本身的数据混合
    const sessionDir = join(homedir(), '.xyz-agent', 'sessions')
    mkdirSync(sessionDir, { recursive: true })
    args.push('--session-dir', sessionDir)

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
      if (this.exitCallback && !this._killing) {
        this.exitCallback(code)
      }
    })

    // Parse stdout JSONL
    const rl = createInterface({ input: proc.stdout! })
    rl.on('line', (line) => {
      if (!line.trim()) return
      try {
        const msg: PiMessage = JSON.parse(line)
        this.handleMessage(msg)
      // eslint-disable-next-line taste/no-silent-catch -- malformed line from pi process, skip and continue
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = msg as any
      console.log('[rpc] resolved pending:', msg.id, msg.type, m.success === false ? '(FAILED)' : '(ok)')
      entry.resolve(msg)
    } else {
      console.log('[rpc] event:', msg.type, '(listeners:', this.listeners.size, ')')
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
   * If the response indicates failure (success: false), the promise is rejected.
   */
  sendCommand(type: string, params: Record<string, unknown> = {}, timeout = CMD_TIMEOUT_MS): Promise<PiMessage> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this._exited) {
        return reject(new Error('pi process is not running'))
      }

      const id = this.nextId()
      const msg = JSON.stringify({ id, type, ...params }) + '\n'

      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC command "${type}" timed out after ${timeout}ms`))
      }, timeout)

      this.pending.set(id, {
        resolve: (msg) => {
          // Check if the response indicates failure
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi response has dynamic shape
          const resp = msg as any
          if (resp.success === false) {
            reject(new Error(resp.error ?? `RPC command "${type}" failed`))
          } else {
            resolve(msg)
          }
        },
        reject,
        timer,
      })

      try {
        console.log('[rpc] send: type=' + type + ', id=' + id)
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
  /** Register a callback for when the pi process exits unexpectedly. */
  onExit(callback: (code: number | null) => void): void {
    this.exitCallback = callback
  }

  onEvent(listener: PiEventListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  get exited(): boolean {
    return this._exited
  }

  // ── High-level API ────────────────────────────────────────────────

  /**
   * Send a user message to pi. The returned promise resolves when
   * pi acknowledges receipt (not when generation completes).
   * Actual content arrives via onEvent() listeners as text_delta etc.
   *
   * Note: pi RPC protocol uses "message" field, not "content".
   */
  prompt(content: string): Promise<PiMessage> {
    return this.sendCommand('prompt', { message: content })
  }

  abort(): Promise<PiMessage> {
    return this.sendCommand('abort')
  }

  setModel(provider: string, modelId: string): Promise<PiMessage> {
    return this.sendCommand('set_model', { provider, modelId })
  }

  getAvailableModels(): Promise<PiMessage> {
    return this.sendCommand('get_available_models')
  }

  /**
   * List models available for the current provider.
   * Alias for getAvailableModels().
   */
  getModels(): Promise<PiMessage> {
    return this.getAvailableModels()
  }

  getHistory(): Promise<PiMessage> {
    return this.sendCommand('get_messages')
  }

  compact(): Promise<PiMessage> {
    return this.sendCommand('compact', {}, COMPACT_TIMEOUT_MS)
  }

  /**
   * Clear is not directly supported by pi RPC. Use new_session instead.
   * Kept for API compatibility — creates a new session.
   */
  clear(): Promise<PiMessage> {
    return this.sendCommand('new_session')
  }

  /**
   * Tool approval commands. pi RPC mode handles tool approvals
   * internally via extension_ui_request/extension_ui_response protocol.
   * These are kept as no-ops for API compatibility.
   */
  approveTool(_toolCallId: string): Promise<PiMessage> {
    // pi handles tool approvals via extension UI protocol, not direct commands
    void _toolCallId
    return Promise.resolve({
      type: 'response',
      command: 'toolApprove',
      success: true,
    })
  }

  denyTool(_toolCallId: string): Promise<PiMessage> {
    void _toolCallId
    return Promise.resolve({
      type: 'response',
      command: 'toolDeny',
      success: true,
    })
  }

  alwaysAllowTool(_toolName: string): Promise<PiMessage> {
    void _toolName
    return Promise.resolve({
      type: 'response',
      command: 'toolAlwaysAllow',
      success: true,
    })
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async kill(): Promise<void> {
    if (!this.proc || this._exited) return

    this._killing = true

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
