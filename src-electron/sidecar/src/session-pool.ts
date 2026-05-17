import { basename, dirname, join } from 'node:path'
import { appendFileSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
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
import { getDefaultModel, loadSkills } from './config-store.js'
import { scanSessions, deleteSessionFile, invalidateScanCache, type ScannedSession } from './session-scanner.js'
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
    const tempId = crypto.randomUUID()
    const sessionCwd = cwd ?? process.cwd()
    const modelId = getDefaultModel()

    const client = await this.pm.createSession(tempId, sessionCwd, { skillPaths: this.getSkillPaths(sessionCwd) })

    // 从 pi 获取真实 session ID（pi 在启动时创建 session 并分配 ID）
    let piSessionId: string = tempId
    let sessionFilePath: string | undefined
    try {
      const stateResp = await client.sendCommand('get_state')
      const stateData = stateResp.data ?? stateResp.payload
      piSessionId = (stateData?.sessionId as string) ?? tempId
      sessionFilePath = stateData?.sessionFile as string | undefined
    } catch (e) {
      console.warn('[session-pool] get_state failed, using temp ID:', e instanceof Error ? e.message : e)
    }

    // 用 pi 的真实 ID 替换临时 ID
    const id = piSessionId
    if (id !== tempId) {
      this.pm.rekey(tempId, id)
    }

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
      sessionFilePath,
    }
    this.sessions.set(id, session)

    // Persist label to file so scanSessions can read it after restart
    if (sessionFilePath && session.label && session.label !== basename(sessionCwd)) {
      appendFileSync(sessionFilePath, JSON.stringify({ type: 'session_info', name: session.label }) + '\n')
    }
    invalidateScanCache()

    return this.toSummary(session)
  }

  async renameSession(sessionId: string, newName: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.label = newName
    }

    // 在持久化文件中追加 session_info 条目（parseSessionName 取最后一个匹配）
    const filePath = session?.sessionFilePath ?? this.findScannedSession(sessionId)?.filePath
    if (filePath) {
      appendFileSync(filePath, JSON.stringify({ type: 'session_info', name: newName }) + '\n')
    }
    invalidateScanCache()
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      // 活跃 session：关闭进程 + 删除持久化文件
      session.adapter.detach()
      if (session.unsubUsageListener) session.unsubUsageListener()
      await this.pm.destroySession(sessionId)
      this.sessions.delete(sessionId)
      if (session.sessionFilePath) {
        await deleteSessionFile(session.sessionFilePath)
      }
    } else {
      // 非活跃 session：直接删除持久化文件
      const target = this.findScannedSession(sessionId)
      if (!target) throw new Error(`Session ${sessionId} not found`)
      await deleteSessionFile(target.filePath)
    }
    invalidateScanCache()
  }

  // ── Messaging ──────────────────────────────────────────────────

  async sendMessage(sessionId: string, content: string): Promise<void> {
    let client = this.pm.getClient(sessionId)

    // If session is not active, restore it from persisted file
    if (!client) {
      console.log(`[session-pool] sendMessage: session ${sessionId} not active, restoring...`)
      try {
        await this.restoreSession(sessionId)
        client = this.pm.getClient(sessionId)
        if (!client) throw new Error('Restore succeeded but client not available')
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
    console.log(`[session-pool] sendMessage: sessionId=${sessionId}`)
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
    const id = this.pm.getSessionIdByClient(client)
    return id ? this.sessions.get(id) : undefined
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
    return await this.getHistoryFromFile(sessionId)
  }

  /** Parse messages from a persisted session file for an inactive session */
  private async getHistoryFromFile(sessionId: string): Promise<Message[]> {
    const target = this.findScannedSession(sessionId)
    if (!target) return []

    const content = await readFile(target.filePath, 'utf-8')
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
    let lastAssistantWithToolCalls = -1

    for (const m of raw) {
      if (m.role === 'toolResult') {
        // Merge tool result into the last assistant message's matching toolCall
        if (lastAssistantWithToolCalls >= 0) {
          const lastAssistant = result[lastAssistantWithToolCalls]
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

      const msg: Message = {
        id: crypto.randomUUID(),
        role: m.role === 'user' ? 'user' : 'assistant',
        content: textContent,
        status: 'complete',
        ...(thinking.length > 0 && { thinking }),
        ...(toolCalls.length > 0 && { toolCalls }),
        timestamp: m.timestamp ?? Date.now(),
      }
      result.push(msg)
      if (toolCalls.length > 0) {
        lastAssistantWithToolCalls = result.length - 1
      }
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
    const target = this.findScannedSession(sessionId)
    if (!target) throw new Error(`Persisted session ${sessionId} not found`)

    // Detach existing adapter if present (race: rapid sends to cold session)
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

  private findScannedSession(sessionId: string): ScannedSession | undefined {
    return scanSessions().find(s => s.id === sessionId)
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
