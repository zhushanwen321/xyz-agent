import { basename } from 'node:path'
import { readFileSync, appendFileSync } from 'node:fs'
import type { WebSocket } from 'ws'
import type {
  SessionSummary,
  SessionGroup,
  SessionStatus,
  Message,
  ServerMessage,
  ThinkingBlock,
  ToolCall,
} from '@xyz-agent/shared'
import { ProcessManager } from './process-manager.js'
import type { RpcClient } from './rpc-client.js'

/** Raw message format returned by pi's get_messages command */
interface PiHistoryMessage {
  role: 'user' | 'assistant' | 'toolResult'
  content: Array<{
    type: 'text' | 'thinking' | 'toolCall' | 'tool_use'
    text?: string
    thinking?: string
    id?: string
    name?: string
    arguments?: Record<string, unknown>
  }>
  timestamp?: number
  stopReason?: string
  toolCallId?: string
  toolName?: string
  isError?: boolean
}
import { EventAdapter } from './event-adapter.js'
import { getDefaultModel } from './config-store.js'
import { scanSessions, deleteSessionFile, type ScannedSession } from './session-scanner.js'
import { lookupPiProvider } from './model-db.js'

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
  /** pi 分配的持久化 session 文件路径 */
  sessionFilePath?: string
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
  private clients = new Set<WebSocket>()

  constructor() {
    // 进程崩溃时清理对应 session
    this.pm.onSessionExit((sessionId, code) => {
      const session = this.sessions.get(sessionId)
      if (session) {
        session.adapter.detach()
        if (session.unsubUsageListener) session.unsubUsageListener()
        this.sessions.delete(sessionId)
        this.send({ type: 'session.list', payload: { groups: this.listPersistedSessions() } })
        this.send({
          type: 'message.error',
          payload: { sessionId, message: `Session process exited unexpectedly (code: ${code})` },
        })
      }
    })
  }

  // ── WebSocket binding ──────────────────────────────────────────

  addClient(ws: WebSocket): void {
    this.clients.add(ws)
  }

  removeClient(ws: WebSocket): void {
    this.clients.delete(ws)
  }

  private send(msg: ServerMessage): void {
    for (const ws of this.clients) {
      if (ws.readyState === WS_OPEN) {
        ws.send(JSON.stringify(msg))
      }
    }
  }

  // ── Session CRUD ───────────────────────────────────────────────

  async create(cwd?: string, label?: string): Promise<SessionSummary> {
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
      label: label ?? basename(sessionCwd),
      modelId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      tokenCount: 0,
      isGenerating: false,
      adapter,
      unsubUsageListener: unsubUsage,
    }
    this.sessions.set(id, session)

    // 获取 pi 分配的 session 文件路径，用于后续持久化追踪
    try {
      const stateResp = await client.sendCommand('get_state')
      const sessionFile = stateResp.payload?.sessionFile as string | undefined
      if (sessionFile) {
        session.sessionFilePath = sessionFile
        // Persist label to file so scanSessions can read it after restart
        if (session.label && session.label !== basename(sessionCwd)) {
          appendFileSync(sessionFile, JSON.stringify({ type: 'session_info', name: session.label }) + '\n')
        }
      }
    } catch (e) {
      console.warn('[session-pool] get_state failed (non-critical):', e instanceof Error ? e.message : e)
    }

    return this.toSummary(session)
  }

  async renameSession(sessionId: string, newName: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.label = newName
    }

    // 在持久化文件中追加 session_info 条目（parseSessionName 取最后一个匹配）
    const filePath = session?.sessionFilePath ?? this.findFilePathForSession(sessionId)
    if (filePath) {
      appendFileSync(filePath, JSON.stringify({ type: 'session_info', name: newName }) + '\n')
    }
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      // 活跃 session：关闭进程 + 删除持久化文件
      const filePath = session.sessionFilePath
      session.adapter.detach()
      if (session.unsubUsageListener) session.unsubUsageListener()
      await this.pm.destroySession(sessionId)
      this.sessions.delete(sessionId)
      if (filePath) {
        await deleteSessionFile(filePath)
      }
    } else {
      // 非活跃 session：直接删除持久化文件
      const scanned = scanSessions()
      const target = scanned.find(s => s.id === sessionId)
      if (!target) throw new Error(`Session ${sessionId} not found`)
      await deleteSessionFile(target.filePath)
    }
  }

  // ── Messaging ──────────────────────────────────────────────────

  async sendMessage(sessionId: string, content: string): Promise<void> {
    let client = this.pm.getClient(sessionId)

    // If session is not active, restore it from persisted file
    if (!client) {
      console.log(`[session-pool] sendMessage: session ${sessionId} not active, restoring...`)
      try {
        const summary = await this.restoreSession(sessionId)
        // restoreSession creates a new internal session; use its id
        client = this.pm.getClient(summary.id)
        if (!client) throw new Error('Restore succeeded but client not available')
        // Notify frontend of the new session id so subsequent sends work
        this.send({
          type: 'session.restored',
          payload: { oldSessionId: sessionId, newSessionId: summary.id, summary },
        })
      } catch (e) {
        const errMsg = `Failed to restore session: ${e instanceof Error ? e.message : String(e)}`
        console.error(`[session-pool] ${errMsg}`)
        this.send({ type: 'message.error', payload: { sessionId, message: errMsg } })
        return
      }
    }

    // Find the managed session (may have a different id after restore)
    const activeSession = this.findSessionByClient(client)
    if (activeSession) {
      activeSession.lastActiveAt = Date.now()
      activeSession.isGenerating = true
    }
    console.log(`[session-pool] sendMessage: sessionId=${sessionId}, contentLength=${content.length}`)
    try {
      await client.prompt(content)
      console.log(`[session-pool] prompt acknowledged: sessionId=${sessionId}`)
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.error(`[session-pool] prompt failed: sessionId=${sessionId}`, errMsg)
      if (activeSession) activeSession.isGenerating = false
      this.send({ type: 'message.error', payload: { sessionId, message: errMsg } })
    }
  }

  private findSessionByClient(client: RpcClient): ManagedSession | undefined {
    for (const session of this.sessions.values()) {
      if (this.pm.getClient(session.id) === client) return session
    }
    return undefined
  }

  async abort(sessionId: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not found`)
    await client.abort()
  }

  // ── Model switching ────────────────────────────────────────────

  async switchModel(sessionId: string, provider: string, modelId: string): Promise<string> {
    const session = this.sessions.get(sessionId)

    // 非活跃 session：不恢复进程，静默成功
    // 模型偏好会在下次 session 恢复时通过 sendMessage 的 restore 流程生效
    if (!session) return sessionId

    session.modelId = `${provider}/${modelId}`
    const client = this.pm.getClient(sessionId)
    if (client) {
      // xyz-agent 的 provider ID（如 "router"）不是 pi 认识的 provider，需要映射
      const piProvider = lookupPiProvider(modelId) ?? provider
      await client.setModel(piProvider, modelId)
    }

    return sessionId
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
    if (client) {
      // Active session: get messages from running pi process
      const result = await client.getHistory()
      const data = (result as unknown as Record<string, unknown>).data as { messages?: PiHistoryMessage[] } | undefined
      const raw = data?.messages ?? (result.payload?.messages as PiHistoryMessage[] | undefined) ?? []
      return this.convertPiHistory(raw)
    }

    // Inactive session: parse messages from session file
    return this.getHistoryFromFile(sessionId)
  }

  /** Parse messages from a persisted session file for an inactive session */
  private getHistoryFromFile(sessionId: string): Message[] {
    const scanned = scanSessions()
    const target = scanned.find(s => s.id === sessionId)
    if (!target) return []

    const content = readFileSync(target.filePath, 'utf-8')
    const lines = content.split('\n').filter(l => l.trim())
    const piMessages: PiHistoryMessage[] = []

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (entry.type === 'message' && entry.message) {
          piMessages.push(entry.message as PiHistoryMessage)
        }
      } catch { /* skip malformed lines */ }
    }

    return this.convertPiHistory(piMessages)
  }

  /** Convert pi message list, merging toolResults into their parent assistant message */
  private convertPiHistory(raw: PiHistoryMessage[]): Message[] {
    const result: Message[] = []

    for (const m of raw) {
      if (m.role === 'toolResult') {
        // Merge tool result into the last assistant message's matching toolCall
        const lastAssistant = [...result].reverse().find(r => r.role === 'assistant' && r.toolCalls?.length)
        if (lastAssistant?.toolCalls) {
          const tc = lastAssistant.toolCalls.find(t => t.id === m.toolCallId)
          if (tc) {
            const textParts = (Array.isArray(m.content) ? m.content : [])
              .filter((p: { type: string }) => p.type === 'text')
              .map((p: { text?: string }) => p.text ?? '')
              .join('\n')
            tc.output = textParts
            if (m.isError) tc.status = 'error'
          }
        }
        continue
      }

      // user or assistant
      const parts = Array.isArray(m.content) ? m.content : [{ type: 'text' as const, text: String(m.content) }]
      let textContent = ''
      const thinking: ThinkingBlock[] = []
      const toolCalls: ToolCall[] = []

      for (const part of parts) {
        if (part.type === 'text') {
          textContent += part.text ?? ''
        } else if (part.type === 'thinking') {
          thinking.push({
            id: crypto.randomUUID(),
            content: part.thinking ?? '',
            collapsed: true,
          })
        } else if (part.type === 'toolCall') {
          toolCalls.push({
            id: part.id ?? crypto.randomUUID(),
            toolName: part.name ?? '',
            input: part.arguments ?? {},
            status: 'completed',
            startTime: m.timestamp ?? Date.now(),
          })
        }
      }

      result.push({
        id: crypto.randomUUID(),
        role: m.role === 'user' ? 'user' : 'assistant',
        content: textContent,
        status: 'complete',
        ...(thinking.length > 0 && { thinking }),
        ...(toolCalls.length > 0 && { toolCalls }),
        timestamp: m.timestamp ?? Date.now(),
      })
    }

    return result
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
    // 活跃 session
    const active = Array.from(this.sessions.values()).map(s => this.toSummary(s))

    // 已持久化但未激活的 session（通过 filePath 去重）
    const activeFilePaths = new Set<string>()
    for (const s of this.sessions.values()) {
      if (s.sessionFilePath) activeFilePaths.add(s.sessionFilePath)
    }

    const persisted = scanSessions()
      .filter(s => !activeFilePaths.has(s.filePath))
      .map(s => this.scannedToSummary(s))

    return [...active, ...persisted].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  /** 合并活跃 + 持久化 session 的分组列表 */
  listPersistedSessions(): SessionGroup[] {
    return this.listGrouped()
  }

  /** 从持久化文件恢复 session：启动 pi 进程并加载已有文件 */
  async restoreSession(sessionId: string): Promise<SessionSummary> {
    const scanned = scanSessions()
    const target = scanned.find(s => s.id === sessionId)
    if (!target) throw new Error(`Persisted session ${sessionId} not found`)

    const id = crypto.randomUUID()
    const client = await this.pm.createSession(id, target.cwd)
    const adapter = new EventAdapter(id, (msg) => this.send(msg))
    adapter.attach(client)

    // 加载已有 session 文件
    await client.sendCommand('switch_session', { sessionPath: target.filePath })

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
      cwd: target.cwd,
      label: target.name ?? basename(target.cwd),
      modelId: getDefaultModel(),
      createdAt: Date.now(),
      lastActiveAt: target.lastModified,
      tokenCount: 0,
      isGenerating: false,
      adapter,
      unsubUsageListener: unsubUsage,
      sessionFilePath: target.filePath,
    }
    this.sessions.set(id, session)

    return this.toSummary(session)
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

  private findFilePathForSession(sessionId: string): string | undefined {
    return scanSessions().find(s => s.id === sessionId)?.filePath
  }

  private scannedToSummary(s: ScannedSession): SessionSummary {
    return {
      id: s.id,
      label: s.name ?? basename(s.cwd),
      cwd: s.cwd,
      status: 'idle' as SessionStatus,
      lastActiveAt: s.lastModified,
      modelId: '',
      tokenCount: 0,
    }
  }
}
