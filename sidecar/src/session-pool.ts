import { basename } from 'node:path'
import type { WebSocket } from 'ws'
import type {
  SessionSummary,
  SessionGroup,
  SessionStatus,
  Message,
  ServerMessage,
} from '@xyz-agent/shared'
import { ProcessManager } from './process-manager.js'
import { EventAdapter } from './event-adapter.js'
import { getDefaultModel } from './config-store.js'

interface ManagedSession {
  id: string
  cwd: string
  label: string
  modelId: string
  createdAt: number
  lastActiveAt: number
  tokenCount: number
  isGenerating: boolean
  adapter: EventAdapter
  unsubUsageListener: (() => void) | null
}

const WS_OPEN = 1

/**
 * Manages a pool of pi subprocess sessions, each with its own
 * RpcClient and EventAdapter. Binds to a single WebSocket for
 * pushing events to the TUI client.
 */
export class SessionPool {
  private sessions = new Map<string, ManagedSession>()
  private pm = new ProcessManager()
  private ws: WebSocket | null = null

  constructor() {
    // 进程崩溃时清理对应 session
    this.pm.onSessionExit((sessionId, code) => {
      const session = this.sessions.get(sessionId)
      if (session) {
        session.adapter.detach()
        this.sessions.delete(sessionId)
        if (this.ws && this.ws.readyState === WS_OPEN) {
          this.send({ type: 'session.list', payload: { groups: this.listGrouped() } })
          this.send({
            type: 'message.error',
            payload: { sessionId, message: `Session process exited unexpectedly (code: ${code})` },
          })
        }
      }
    })
  }

  // ── WebSocket binding ──────────────────────────────────────────

  bindWebSocket(ws: WebSocket): void {
    this.ws = ws
  }

  unbindWebSocket(): void {
    this.ws = null
  }

  private send(msg: ServerMessage): void {
    if (this.ws?.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  // ── Session CRUD ───────────────────────────────────────────────

  async create(cwd?: string): Promise<SessionSummary> {
    const id = crypto.randomUUID()
    const sessionCwd = cwd ?? process.cwd()
    const modelId = getDefaultModel()

    const client = await this.pm.createSession(id, sessionCwd)
    const adapter = new EventAdapter(id, (msg) => this.send(msg))
    adapter.attach(client)

    // 从 agent_end 事件中提取 token 使用量
    const unsubUsage = client.onEvent((event) => {
      if (event.type === 'agent_end') {
        const s = this.sessions.get(id)
        if (s) {
          s.isGenerating = false
          const usage = event.payload?.usage as
            { outputTokens?: number; inputTokens?: number; totalTokens?: number } | undefined
          if (usage) {
            s.tokenCount = (usage.totalTokens ?? usage.outputTokens ?? 0) as number
          }
        }
      }
    })

    const session: ManagedSession = {
      id,
      cwd: sessionCwd,
      label: basename(sessionCwd),
      modelId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      tokenCount: 0,
      isGenerating: false,
      adapter,
      unsubUsageListener: unsubUsage,
    }
    this.sessions.set(id, session)

    return this.toSummary(session)
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    session.adapter.detach()
    if (session.unsubUsageListener) session.unsubUsageListener()
    await this.pm.destroySession(sessionId)
    this.sessions.delete(sessionId)
  }

  // ── Messaging ──────────────────────────────────────────────────

  async sendMessage(sessionId: string, content: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not found`)
    const session = this.sessions.get(sessionId)!
    session.lastActiveAt = Date.now()
    session.isGenerating = true
    try {
      await client.prompt(content)
    } catch (e) {
      // prompt 失败（进程崩溃等），重置生成状态
      session.isGenerating = false
      throw e
    }
  }

  async abort(sessionId: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not found`)
    await client.abort()
  }

  // ── Model switching ────────────────────────────────────────────

  async switchModel(sessionId: string, provider: string, modelId: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not found`)
    const session = this.sessions.get(sessionId)!
    session.modelId = `${provider}/${modelId}`
    await client.setModel(provider, modelId)
  }

  // ── Compact & Clear ────────────────────────────────────────────

  async compact(sessionId: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not found`)
    // 通知前端正在压缩
    this.send({
      type: 'session.compacting',
      payload: { sessionId, status: 'compacting' },
    })
    await client.compact()
  }

  async clear(sessionId: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not found`)
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    await client.clear()
    session.lastActiveAt = Date.now()
  }

  // ── History ────────────────────────────────────────────────────

  async getHistory(sessionId: string): Promise<Message[]> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not found`)
    const result = await client.getHistory()
    return (result.payload?.messages ?? []) as Message[]
  }

  // ── Listing ────────────────────────────────────────────────────

  listGrouped(): SessionGroup[] {
    const summaries = this.listAll()
    const groups = new Map<string, SessionSummary[]>()
    for (const s of summaries) {
      const list = groups.get(s.cwd) ?? []
      list.push(s)
      groups.set(s.cwd, list)
    }
    return Array.from(groups.entries()).map(([cwd, sessions]) => ({ cwd, sessions }))
  }

  listAll(): SessionSummary[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .map(s => this.toSummary(s))
  }

  getSummary(sessionId: string): SessionSummary | undefined {
    const session = this.sessions.get(sessionId)
    return session ? this.toSummary(session) : undefined
  }

  // ── Tool approval (exposed for server routing) ─────────────────

  async approveTool(sessionId: string, toolCallId: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not found`)
    await client.approveTool(toolCallId)
  }

  async denyTool(sessionId: string, toolCallId: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not found`)
    await client.denyTool(toolCallId)
  }

  async alwaysAllowTool(sessionId: string, toolName: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not found`)
    await client.alwaysAllowTool(toolName)
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  async destroyAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.adapter.detach()
      if (session.unsubUsageListener) session.unsubUsageListener()
    }
    await this.pm.destroyAll()
    this.sessions.clear()
  }

  // ── Internal ───────────────────────────────────────────────────

  private toSummary(s: ManagedSession): SessionSummary {
    return {
      id: s.id,
      label: s.label,
      cwd: s.cwd,
      status: s.isGenerating ? ('active' as SessionStatus) : ('idle' as SessionStatus),
      lastActiveAt: s.lastActiveAt,
      modelId: s.modelId,
      tokenCount: s.tokenCount,
    }
  }
}
