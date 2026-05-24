/**
 * SessionService — extracted from session-pool.ts.
 *
 * Manages session lifecycle: creation, deletion, messaging, history,
 * model switching, compaction, and persistence.
 */
import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import type {
  SessionSummary,
  SessionGroup,
  SessionStatus,
  Message,
} from '@xyz-agent/shared'
import type { ISessionService, IProcessManager, IMessageBroker, IEventAdapter } from '../interfaces.js'
import type { IRpcClient } from '../interfaces.js'
import type { PiMessage } from '../rpc-client.js'
import { convertPiHistory } from '../message-converter.js'
import type { PiHistoryMessage } from '../types.js'
import { getDefaultModel } from '../pi-config-bridge.js'
import * as piBridge from '../pi-config-bridge.js'
import { scanSessions, deleteSessionFile, refreshSessions, type ScannedSession } from '../session-scanner.js'

interface ManagedSession {
  id: string
  cwd: string
  label: string
  modelId: string
  createdAt: number
  lastActiveAt: number
  tokenCount: number
  isGenerating: boolean
  adapter: IEventAdapter
  unsubUsageListener: (() => void) | null
  sessionFilePath?: string
}

export class SessionService implements ISessionService {
  private sessions = new Map<string, ManagedSession>()
  private restoringSessions = new Set<string>()

  constructor(
    private pm: IProcessManager,
    private broker: IMessageBroker,
    private adapterFactory: (sessionId: string) => IEventAdapter,
    private projectRoot: string,
  ) {
    // 进程崩溃时清理对应 session
    this.pm.onSessionExit((sessionId, code) => {
      const session = this.sessions.get(sessionId)
      if (session) {
        session.adapter.detach()
        if (session.unsubUsageListener) session.unsubUsageListener()
        this.sessions.delete(sessionId)
        this.broker.broadcast({ type: 'session.list', payload: { groups: this.listPersistedSessions() } })
        this.broker.broadcast({
          type: 'message.error',
          payload: { sessionId, message: `Session process exited unexpectedly (code: ${code})` },
        })
      }
    })
  }

  // ── Session CRUD ───────────────────────────────────────────────

  async create(cwd?: string, label?: string): Promise<SessionSummary> {
    const tempId = crypto.randomUUID()
    const sessionCwd = cwd ?? process.cwd()
    const modelRef = getDefaultModel()
    const modelId = modelRef ? `${modelRef.provider}/${modelRef.modelId}` : ''

    const client = await this.pm.createSession(tempId, sessionCwd, { skillPaths: this.getSkillPaths(sessionCwd) })

    // 从 pi 获取真实 session ID
    let piSessionId: string
    let sessionFilePath: string | undefined
    try {
      const stateResp = await client.sendCommand('get_state') as PiMessage
      const stateData = stateResp.data ?? stateResp.payload
      piSessionId = (stateData?.sessionId as string) ?? ''
      sessionFilePath = stateData?.sessionFile as string | undefined
    } catch (e) {
      await this.pm.destroySession(tempId).catch(() => {})
      throw new Error(`Failed to get session state from pi: ${e instanceof Error ? e.message : e}`)
    }

    if (!piSessionId) {
      await this.pm.destroySession(tempId).catch(() => {})
      throw new Error('pi did not return a session ID')
    }

    // 用 pi 的真实 ID 替换临时 ID
    const id = piSessionId
    if (id !== tempId) {
      this.pm.rekey(tempId, id)
    }

    const adapter = this.adapterFactory(id)
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

    refreshSessions()

    // 获取 pi 的可用命令列表并推送给前端
    try {
      const commands = await (client as IRpcClient).getCommands() as Array<{ name: string; description?: string; source: string }>
      console.log(`[session-service] getCommands returned ${commands.length} commands:`, commands.map(c => c.name))
      this.broker.broadcast({ type: 'session.commands', payload: { sessionId: id, commands } })
    } catch (e) {
      console.warn('[session-service] getCommands failed:', e)
    }

    return this.toSummary(session)
  }

  async renameSession(sessionId: string, newName: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.label = newName
    }

    refreshSessions()
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.adapter.detach()
      if (session.unsubUsageListener) session.unsubUsageListener()
      await this.pm.destroySession(sessionId)
      this.sessions.delete(sessionId)
      if (session.sessionFilePath) {
        await deleteSessionFile(session.sessionFilePath)
      }
    } else {
      const target = this.findScannedSession(sessionId)
      if (!target) throw new Error(`Session ${sessionId} not found`)
      await deleteSessionFile(target.filePath)
    }
    refreshSessions()
  }

  // ── Messaging ──────────────────────────────────────────────────

  async sendMessage(sessionId: string, content: string): Promise<void> {
    let client = this.pm.getClient(sessionId)

    if (!client) {
      console.log(`[session-service] sendMessage: session ${sessionId} not active, restoring...`)
      if (this.restoringSessions.has(sessionId)) return
      this.restoringSessions.add(sessionId)
      try {
        await this.restoreSession(sessionId)
        client = this.pm.getClient(sessionId)
        if (!client) throw new Error('Restore succeeded but client not available')
      } catch (e) {
        const errMsg = `Failed to restore session: ${e instanceof Error ? e.message : String(e)}`
        console.error(`[session-service] ${errMsg}`)
        this.broker.broadcast({ type: 'message.error', payload: { sessionId, message: errMsg } })
        return
      } finally {
        this.restoringSessions.delete(sessionId)
      }
    }

    const activeSession = this.findSessionByClient(client)
    if (activeSession) {
      activeSession.lastActiveAt = Date.now()
      activeSession.isGenerating = true
    }
    console.log(`[session-service] sendMessage: sessionId=${sessionId}`)
    try {
      await client.prompt(content)
      console.log(`[session-service] prompt acknowledged: sessionId=${sessionId}`)
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.error(`[session-service] prompt failed: sessionId=${sessionId}`, errMsg)
      if (activeSession) activeSession.isGenerating = false
      this.broker.broadcast({ type: 'message.error', payload: { sessionId, message: errMsg } })
    }
  }

  private findSessionByClient(client: IRpcClient): ManagedSession | undefined {
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

    if (!session) return sessionId

    session.modelId = `${provider}/${modelId}`
    const client = this.pm.getClient(sessionId)
    if (client) {
      await client.setModel(provider, modelId)
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
      console.error('[session-service] compact: session not found, sessionId=' + sessionId)
      throw new Error(`Session ${sessionId} not found`)
    }

    console.log('[session-service] compact: start, sessionId=' + sessionId)
    this.broker.broadcast({
      type: 'session.compacting',
      payload: { sessionId, status: 'compacting' },
    })
    try {
      await client.compact()
      console.log('[session-service] compact: complete, sessionId=' + sessionId + ', elapsed=' + (Date.now() - startTime) + 'ms')
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.error('[session-service] compact: failed, sessionId=' + sessionId + ', error=' + errMsg + ', elapsed=' + (Date.now() - startTime) + 'ms')
      this.broker.broadcast({
        type: 'session.compacted',
        payload: { sessionId, status: 'compacted', error: errMsg },
      })
      throw e
    }
    this.broker.broadcast({
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
      const result = await client.getHistory() as PiMessage
      const data = result.data as { messages?: PiHistoryMessage[] } | undefined
      const raw = data?.messages ?? (result.payload?.messages as PiHistoryMessage[] | undefined) ?? []
      return convertPiHistory(raw)
    }

    return await this.getHistoryFromFile(sessionId)
  }

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
      } catch {
        void 0
      }
    }

    return convertPiHistory(piMessages)
  }

  // ── Listing ────────────────────────────────────────────────────

  listPersistedSessions(): SessionGroup[] {
    return this.listGrouped()
  }

  private listGrouped(): SessionGroup[] {
    const summaries = this.listAll()
    const groups = new Map<string, SessionSummary[]>()
    for (const s of summaries) {
      const list = groups.get(s.cwd) ?? []
      list.push(s)
      groups.set(s.cwd, list)
    }
    return Array.from(groups.entries()).map(([cwd, sessions]) => ({ cwd, sessions }))
  }

  private listAll(): SessionSummary[] {
    const active = Array.from(this.sessions.values()).map(s => this.toSummary(s))

    const activeFilePaths = new Set<string>()
    for (const s of this.sessions.values()) {
      if (s.sessionFilePath) activeFilePaths.add(s.sessionFilePath)
    }

    const persisted = scanSessions()
      .filter(s => !activeFilePaths.has(s.filePath))
      .map(s => this.scannedToSummary(s))

    return [...active, ...persisted].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  /** 从持久化文件恢复 session */
  async restoreSession(sessionId: string): Promise<SessionSummary> {
    const target = this.findScannedSession(sessionId)
    if (!target) throw new Error(`Persisted session ${sessionId} not found`)

    const existing = this.sessions.get(sessionId)
    if (existing) {
      existing.adapter.detach()
      if (existing.unsubUsageListener) existing.unsubUsageListener()
      await this.pm.destroySession(sessionId).catch(() => {})
      this.sessions.delete(sessionId)
    }
    const id = sessionId
    const client = await this.pm.createSession(id, target.cwd, { skillPaths: this.getSkillPaths(target.cwd) })
    const adapter = this.adapterFactory(id)
    adapter.attach(client)

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

    const modelRef = getDefaultModel()
    const modelId = modelRef ? `${modelRef.provider}/${modelRef.modelId}` : ''

    const session: ManagedSession = {
      id,
      cwd: target.cwd,
      label: target.name ?? basename(target.cwd),
      modelId,
      createdAt: Date.now(),
      lastActiveAt: target.lastModified,
      tokenCount: 0,
      isGenerating: false,
      adapter,
      unsubUsageListener: unsubUsage,
      sessionFilePath: target.filePath,
    }
    this.sessions.set(id, session)

    // 获取 pi 的可用命令列表并推送给前端
    try {
      const commands = await (client as IRpcClient).getCommands() as Array<{ name: string; description?: string; source: string }>
      this.broker.broadcast({ type: 'session.commands', payload: { sessionId: id, commands } })
    } catch (e) {
      console.warn('[session-service] getCommands failed:', e)
    }

    return this.toSummary(session)
  }

  getSummary(sessionId: string): SessionSummary | undefined {
    const session = this.sessions.get(sessionId)
    return session ? this.toSummary(session) : undefined
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface requires cwd param
  private getSkillPaths(_cwd: string): string[] {
    return piBridge.getSkillPaths()
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
