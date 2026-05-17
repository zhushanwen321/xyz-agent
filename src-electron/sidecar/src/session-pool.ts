import { basename, dirname, join } from 'node:path'
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
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
import { homedir } from 'node:os'
import { EventAdapter } from './event-adapter.js'
import { getDefaultModel, loadSkills } from './config-store.js'
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
  /** pi 分配的 session ID（与 xyz-agent 的 id 不同） */
  piSessionId?: string
}

const WS_OPEN = 1

/**
 * Manages a pool of pi subprocess sessions, each with its own
 * RpcClient and EventAdapter. Binds to a single WebSocket for
 * pushing events to the TUI client.
 */
const INDEX_FILE = join(homedir(), '.xyz-agent', 'session-index.json')

interface SessionIndex {
  /** xyz-agent sessionId → pi session 文件路径 */
  sessionFiles: Record<string, string>
  /** xyz-agent sessionId → pi sessionId */
  piSessionIds: Record<string, string>
}

function loadIndex(): SessionIndex {
  try {
    if (existsSync(INDEX_FILE)) {
      const raw = readFileSync(INDEX_FILE, 'utf-8')
      return JSON.parse(raw) as SessionIndex
    }
  } catch { /* corrupted index, start fresh */ }
  return { sessionFiles: {}, piSessionIds: {} }
}

function saveIndex(index: SessionIndex): void {
  try {
    const dir = join(homedir(), '.xyz-agent')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2))
  } catch (e) {
    console.warn('[session-pool] failed to persist session index:', e instanceof Error ? e.message : e)
  }
}

export class SessionPool {
  private sessions = new Map<string, ManagedSession>()
  /** xyz-agent sessionId → pi 的 session 文件路径 */
  private sessionFileIndex = new Map<string, string>()
  /** xyz-agent sessionId → pi 的 session ID */
  private piSessionIdIndex = new Map<string, string>()
  private pm = new ProcessManager()
  private clients = new Set<WebSocket>()

  constructor() {
    // 从磁盘加载持久化索引（进程重启后恢复 ID 映射）
    const saved = loadIndex()
    for (const [k, v] of Object.entries(saved.sessionFiles)) this.sessionFileIndex.set(k, v)
    for (const [k, v] of Object.entries(saved.piSessionIds)) this.piSessionIdIndex.set(k, v)

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
        try {
          ws.send(JSON.stringify(msg))
        } catch (e) {
          console.error('[session-pool] send error, removing client:', e)
          ws.close()
          this.clients.delete(ws)
        }
      }
    }
  }

  // ── Session CRUD ───────────────────────────────────────────────

  async create(cwd?: string, label?: string): Promise<SessionSummary> {
    const id = crypto.randomUUID()
    const sessionCwd = cwd ?? process.cwd()
    const modelId = getDefaultModel()

    const client = await this.pm.createSession(id, sessionCwd, { skillPaths: this.getSkillPaths(sessionCwd) })
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
      const stateData = stateResp.data ?? stateResp.payload
      const sessionFile = stateData?.sessionFile as string | undefined
      const piSessionId = stateData?.sessionId as string | undefined
      if (sessionFile) {
        session.sessionFilePath = sessionFile
        // Persist label to file so scanSessions can read it after restart
        if (session.label && session.label !== basename(sessionCwd)) {
          appendFileSync(sessionFile, JSON.stringify({ type: 'session_info', name: session.label }) + '\n')
        }
      }
      if (piSessionId) {
        session.piSessionId = piSessionId
        this.piSessionIdIndex.set(id, piSessionId)
      }
      if (sessionFile) {
        this.sessionFileIndex.set(id, sessionFile)
      }
      // 持久化索引到磁盘，确保进程重启后可恢复
      if (piSessionId || sessionFile) this.persistIndex()
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
      const filePath = this.findFilePathForSession(sessionId)
      if (!filePath) throw new Error(`Session ${sessionId} not found`)
      await deleteSessionFile(filePath)
    }
    // 清理索引
    this.sessionFileIndex.delete(sessionId)
    this.piSessionIdIndex.delete(sessionId)
    this.persistIndex()
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

  hasActiveSession(sessionId: string): boolean {
    return this.pm.hasClient(sessionId)
  }

  // ── Compact & Clear ────────────────────────────────────────────

  async compact(sessionId: string): Promise<void> {
    const startTime = Date.now()
    const client = this.pm.getClient(sessionId)
    if (!client) {
      console.error('[session-pool] compact: session not found, sessionId=' + sessionId)
      throw new Error(`Session ${sessionId} not found`)
    }

    console.log('[session-pool] compact: start, sessionId=' + sessionId)
    this.send({
      type: 'session.compacting',
      payload: { sessionId, status: 'compacting' },
    })
    // pi compact 内部会 _disconnectFromAgent + abort，不会产生 agent 事件
    // EventAdapter 不转发 compaction_start/compaction_end，无需 detach
    try {
      await client.compact()
      console.log('[session-pool] compact: complete, sessionId=' + sessionId + ', elapsed=' + (Date.now() - startTime) + 'ms')
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.error('[session-pool] compact: failed, sessionId=' + sessionId + ', error=' + errMsg + ', elapsed=' + (Date.now() - startTime) + 'ms')
      // 无论成功与否都必须通知前端结束 compacting，否则 UI 永久禁用
      this.send({
        type: 'session.compacted',
        payload: { sessionId, status: 'compacted', error: errMsg },
      })
      throw e
    }
    this.send({
      type: 'session.compacted',
      payload: { sessionId, status: 'compacted' },
    })
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
      const data = result.data as { messages?: PiHistoryMessage[] } | undefined
      const raw = data?.messages ?? (result.payload?.messages as PiHistoryMessage[] | undefined) ?? []
      return this.convertPiHistory(raw)
    }

    // Inactive session: parse messages from session file
    return this.getHistoryFromFile(sessionId)
  }

  /** Parse messages from a persisted session file for an inactive session */
  private getHistoryFromFile(sessionId: string): Message[] {
    const scanned = scanSessions()
    const piSid = this.piSessionIdIndex.get(sessionId)
    let target = piSid ? scanned.find(s => s.id === piSid) : undefined
    if (!target) target = scanned.find(s => s.id === sessionId)
    if (!target) {
      const cachedPath = this.sessionFileIndex.get(sessionId)
      if (cachedPath) target = scanned.find(s => s.filePath === cachedPath)
    }
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
    // 优先用 pi 的 session ID 查找（xyz-agent ID 和 pi ID 不同）
    const piSid = this.piSessionIdIndex.get(sessionId)
    let target = piSid ? scanned.find(s => s.id === piSid) : undefined
    // fallback: 用 xyz-agent ID 直接查（restoreSession 内部复用原始 sessionId 时可能匹配）
    if (!target) target = scanned.find(s => s.id === sessionId)
    // fallback: 用缓存的 sessionFilePath 查找
    if (!target) {
      const cachedPath = this.sessionFileIndex.get(sessionId)
      if (cachedPath) target = scanned.find(s => s.filePath === cachedPath)
    }
    if (!target) throw new Error(`Persisted session ${sessionId} not found`)

    // Reuse original sessionId to avoid frontend-sidecar ID mismatch
    // Also detach existing adapter if present (race: rapid sends to cold session)
    const existing = this.sessions.get(sessionId)
    if (existing) {
      existing.adapter.detach()
      existing.unsubUsageListener?.()
    }
    const id = sessionId
    const client = await this.pm.createSession(id, target.cwd, { skillPaths: this.getSkillPaths(target.cwd) })
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

  /** Collect enabled skill directory paths for passing to pi as --skill args */
  /** 收集当前 enabled skill 的目录路径，传给 pi --skill 参数。
   *  cwd 用于定位 .xyz-agent/skills.json（项目级配置），
   *  restore 时用原始 session 的 cwd，确保读取原始项目的 skill 配置。 */
  private getSkillPaths(cwd: string): string[] {
    return loadSkills(cwd ?? process.cwd())
      .filter(s => s.enabled && s.sourcePath)
      .map(s => dirname(s.sourcePath!))
      .filter(p => existsSync(p) && existsSync(join(p, 'SKILL.md')))
  }

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
    // 优先用 pi 的 session ID 查找
    const piSid = this.piSessionIdIndex.get(sessionId)
    const scanned = scanSessions()
    if (piSid) {
      const found = scanned.find(s => s.id === piSid)
      if (found) return found.filePath
    }
    // fallback: 用缓存的 sessionFilePath
    const cachedPath = this.sessionFileIndex.get(sessionId)
    if (cachedPath && existsSync(cachedPath)) return cachedPath
    // fallback: 用 xyz-agent ID 直接查
    return scanned.find(s => s.id === sessionId)?.filePath
  }

  /** 将内存索引持久化到磁盘 */
  private persistIndex(): void {
    saveIndex({
      sessionFiles: Object.fromEntries(this.sessionFileIndex),
      piSessionIds: Object.fromEntries(this.piSessionIdIndex),
    })
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
