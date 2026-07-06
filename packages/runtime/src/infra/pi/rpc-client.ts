import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { getSessionsDir, getPiAgentDir } from './pi-paths.js'
import { getDefaultModel } from './pi-provider-store.js'
import { ENV_WHITELIST_PREFIXES } from '@xyz-agent/shared'
import type { IPiEngine, PiRpcResponse, PiSessionStats } from '../../services/ports/pi-engine.js'
import { readRpcData } from '../../services/ports/pi-engine.js'
import { createPiSessionLog, type PiSessionLog } from '../logger.js'

/** 子进程允许继承的环境变量前缀白名单 — uses shared list */
const ENV_WHITELIST = ENV_WHITELIST_PREFIXES

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

/**
 * Generic shape of a message received from pi's JSONL stdout.
 * Broader than PiAnyIncomingMessage in types.ts — covers both RPC responses
 * (with success/error/data) and unsolicited events (with various payloads).
 * The listener API uses this wide type; consumers narrow via event.type.
 */
export interface PiMessage {
  id?: string
  type: string
  payload?: Record<string, unknown>
  /** pi RPC 响应的 data 字段（如 get_state 返回 sessionFile/sessionId） */
  data?: Record<string, unknown>
  success?: boolean
  error?: string
}

export type PiEventListener = (event: PiMessage) => void

export interface RpcClientOptions {
  cwd?: string
  model?: string
  env?: Record<string, string>
  skillPaths?: string[]
  /** pi 可执行文件路径（默认 'pi'，从 PATH 查找） */
  piCommand?: string
  /** pi 扩展路径列表，每个路径通过 --extension 参数传递 */
  extensionPaths?: string[]
  /** session id（用于命名 pi stdout 日志文件，架构约定 #4） */
  sessionId?: string
}

const CMD_TIMEOUT_MS = 60_000
const COMPACT_TIMEOUT_MS = 300_000
const KILL_TIMEOUT_MS = 2_000
const STARTUP_DELAY_MS = 100
const STDERR_BUFFER_MAX_LINES = 50
const STDERR_TAIL_LINES = 10

export class RpcClient implements IPiEngine {
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
  /** 收集 pi 进程的 stderr 输出，用于在启动失败时提供具体错误信息 */
  private stderrChunks: string[] = []
  /** pi stdout JSONL 原始流落盘（架构约定 #4，诊断 pi 卡死的决定性证据） */
  private piSessionLog: PiSessionLog | null = null

  constructor(private options: RpcClientOptions = {}) {}

  async start(): Promise<void> {
    const modelRef = getDefaultModel()
    const model = this.options.model ?? (modelRef ? `${modelRef.provider}/${modelRef.modelId}` : '')

    const env = buildSafeEnv({
      ...this.options.env,
    })

    // xyz-pi agent 目录：~/.xyz-agent/pi/agent/
    // 开发模式和打包模式统一使用此目录，不使用系统 pi 的 ~/.pi/agent/
    env.PI_CODING_AGENT_DIR = getPiAgentDir()

    const args = ['--mode', 'rpc', '--no-extensions']
    if (model) args.push('--model', model)
    if (this.options.skillPaths?.length) {
      for (const skillPath of this.options.skillPaths) {
        args.push('--skill', skillPath)
      }
    }
    if (this.options.extensionPaths?.length) {
      for (const extPath of this.options.extensionPaths) {
        args.push('--extension', extPath)
      }
    }

    // 使用 pi 的 sessions 目录
    const sessionDir = getSessionsDir()
    args.push('--session-dir', sessionDir)

    const piCmd = this.options.piCommand ?? 'pi'

    // Bun 编译的 bundled pi 用 process.execPath 定位资源（package.json、themes 等），
    // 不依赖 process.cwd() 查找 package.json。因此 spawn cwd 可以安全地设为用户项目目录。
    // 这样 pi 的初始 session、system prompt、CLAUDE.md 查找、bash 工具都基于正确的 cwd。
    // Verified: xyz-pi 0.75.5-xyz-0.1 uses process.execPath for resource resolution.
    const spawnCwd = this.options.cwd ?? process.cwd()

    console.log('[rpc] spawning pi:', piCmd, args.join(' '), 'cwd:', spawnCwd)

    this.proc = spawn(piCmd, args, {
      cwd: spawnCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // pi stdout JSONL 原始流落盘（架构约定 #4）。pi 卡死时（prompt 后零事件），
    // 这个文件是判断「pi 没发事件」vs「runtime 没转发」的决定性证据。
    // logger 未初始化时（如单元测试）返回 no-op 写入器，无副作用。
    if (this.options.sessionId) {
      this.piSessionLog = createPiSessionLog(this.options.sessionId)
    }

    const proc = this.proc

    proc.on('error', (err) => {
      console.error('[rpc] spawn error:', err)
      this.rejectAll(new Error(`Failed to spawn pi: ${err.message}`))
    })

    proc.on('exit', (code) => {
      this._exited = true
      console.log(`[rpc] process exited with code ${code}`)
      this.piSessionLog?.end()
      this.piSessionLog = null
      // Only reject pending requests on unexpected exits.
      // For normal kill flow (_killing=true), rejectAll is called in kill()
      // via a separate safety net to avoid leaving callers hanging until CMD_TIMEOUT_MS.
      if (!this._killing) {
        this.rejectAll(new Error(`pi process exited with code ${code}${this.formatStderrSuffix()}`))
        if (this.exitCallback) {
          this.exitCallback(code)
        }
      }
    })

    // Parse stdout JSONL
    const rl = createInterface({ input: proc.stdout! })
    rl.on('line', (line) => {
      if (!line.trim()) return
      // tee 原始 JSONL 到 pi session 日志（架构约定 #4，卡死诊断证据）
      this.piSessionLog?.write(line)
      try {
        const msg: PiMessage = JSON.parse(line)
        this.handleMessage(msg)
      // eslint-disable-next-line taste/no-silent-catch -- malformed line from pi process, skip and continue
      } catch (e) {
        console.error('[rpc] stdout parse error:', line, e)
      }
    })

    // 收集 stderr 用于错误诊断，同时转发到日志
    this.stderrChunks = []
    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        const text = data.toString().trimEnd()
        console.error('[rpc:stderr]', text)
        // 只保留最后 N 行，避免内存泄漏
        this.stderrChunks.push(text)
        if (this.stderrChunks.length > STDERR_BUFFER_MAX_LINES) {
          this.stderrChunks.shift()
        }
      })
    }

    // Wait briefly to confirm process didn't exit immediately
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const onExit = (code: number | null) => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(`pi process exited immediately with code ${code}${this.formatStderrSuffix()}`))
      }
      const onError = (err: Error) => {
        if (settled) return
        settled = true
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
        if (settled) return
        cleanup()
        if (!this._exited) resolve()
        else reject(new Error(`pi process exited during startup${this.formatStderrSuffix()}`))
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
          // Check if the response indicates failure (PiMessage.success / .error 已声明类型)
          if (msg.success === false) {
            reject(new Error(msg.error ?? `RPC command "${type}" failed`))
          } else {
            resolve(msg)
          }
        },
        reject,
        timer,
      })

      try {
        console.log('[rpc] send: type=' + type)
        const ok = this.proc.stdin!.write(msg)
        if (!ok) {
          this.proc.stdin!.once('drain', () => {})
        }
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

  /** 将收集到的 pi stderr 格式化为可读后缀，附到错误消息末尾 */
  private formatStderrSuffix(): string {
    if (this.stderrChunks.length === 0) return ''
    const last = this.stderrChunks.slice(-STDERR_TAIL_LINES)
    return `\n\npi stderr (last ${last.length} lines):\n${last.join('\n')}`
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

  steer(content: string): Promise<PiMessage> {
    return this.sendCommand('steer', { message: content })
  }

  followUp(content: string): Promise<PiMessage> {
    return this.sendCommand('follow_up', { message: content })
  }

  setModel(provider: string, modelId: string): Promise<PiMessage> {
    return this.sendCommand('set_model', { provider, modelId })
  }

  setThinkingLevel(level: string): Promise<PiMessage> {
    return this.sendCommand('set_thinking_level', { level })
  }

  getHistory(): Promise<PiMessage> {
    return this.sendCommand('get_messages')
  }

  compact(customInstructions?: string): Promise<PiMessage> {
    return this.sendCommand('compact', customInstructions ? { customInstructions } : {}, COMPACT_TIMEOUT_MS)
  }

  /**
   * Clear is not directly supported by pi RPC. Use new_session instead.
   * Kept for API compatibility — creates a new session.
   */
  clear(): Promise<PiMessage> {
    return this.sendCommand('new_session')
  }

  async getCommands(): Promise<Array<{ name: string; description?: string; source: string }>> {
    const data = readRpcData(await this.sendCommand('get_commands') as PiRpcResponse)
    return (data?.commands as Array<{ name: string; description?: string; source: string }>) ?? []
  }

  async getSessionStats(): Promise<PiSessionStats> {
    const data = readRpcData(await this.sendCommand('get_session_stats') as PiRpcResponse)
    return (data ?? {}) as PiSessionStats
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
        // Safety net: clean up any pending requests that weren't rejected
        // by the unexpected-exit handler (because _killing=true skips it).
        // Without this, callers await until their own CMD_TIMEOUT_MS (60s).
        this.rejectAll(new Error('pi process killed'))
        done()
      })

      proc.kill('SIGTERM')
    })
  }
}
