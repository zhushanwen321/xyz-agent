/**
 * SessionService — extracted from session-pool.ts.
 *
 * Manages session lifecycle: creation, deletion, messaging, history,
 * model switching, compaction, and persistence.
 */
import { basename, resolve, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
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
import { getDefaultModel, scanPiSessions, refreshAll } from '../pi-config-bridge.js'
import * as piBridge from '../pi-config-bridge.js'
import { trash } from '../trash.js'
import { NavigateInterceptor } from '../navigate-interceptor.js'
import { TreeService } from './tree-service.js'

// session-scanner 已删除，直接用 pi-config-bridge 的返回类型
type ScannedSession = Awaited<ReturnType<typeof scanPiSessions>>[number]

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
  interceptor: NavigateInterceptor
  unsubUsageListener: (() => void) | null
  sessionFilePath?: string
}

export class SessionService implements ISessionService {
  private sessions = new Map<string, ManagedSession>()
  private restoringSessions = new Set<string>()
  private extensionPath: string = ''

  constructor(
    private pm: IProcessManager,
    private broker: IMessageBroker,
    private adapterFactory: (sessionId: string, interceptor: NavigateInterceptor) => IEventAdapter,
    private projectRoot: string,
    readonly treeService: TreeService,
  ) {
    // 打包模式：extension 在 Resources 根目录（由 electron-builder.yml extraResources 打包）
    // 开发模式：extension 在 repo root（src-electron/ 的父目录）
    if (process.env.XYZ_AGENT_PACKAGED === '1') {
      this.extensionPath = resolve(process.cwd(), 'xyz-agent-extension.js')
    } else {
      const repoRoot = resolve(this.projectRoot, '..')
      this.extensionPath = resolve(repoRoot, 'xyz-agent-extension.js')
    }
    // 进程崩溃时清理对应 session
    this.pm.onSessionExit((sessionId, code) => {
      const session = this.sessions.get(sessionId)
      if (session) {
        session.adapter.detach()
        if (session.unsubUsageListener) session.unsubUsageListener()
        this.sessions.delete(sessionId)
        this.treeService.unregisterSession(sessionId)
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

    // 启动 pi 前检查 model 配置，避免 pi 因无 model 直接 exit(1)
    if (!getDefaultModel()) {
      throw new Error('No model configured. Please configure a provider and model in Settings before starting a session.')
    }

    const client = await this.pm.createSession(tempId, sessionCwd, {
      skillPaths: this.getSkillPaths(sessionCwd),
      extensionPaths: this.getExtensionPaths(),
    })

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

    const session = await this.initializeManagedSession(
      id, client, sessionCwd, label ?? basename(sessionCwd), sessionFilePath,
    )
    refreshAll()
    return this.toSummary(session)
  }

  async renameSession(sessionId: string, newName: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.label = newName
    }

    refreshAll()
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      this.detachSession(session)
      await this.pm.destroySession(sessionId)
      this.sessions.delete(sessionId)
      this.treeService.unregisterSession(sessionId)
      if (session.sessionFilePath && existsSync(session.sessionFilePath)) {
        await trash(session.sessionFilePath)
      }
    } else {
      const target = this.findScannedSession(sessionId)
      if (!target) throw new Error(`Session ${sessionId} not found`)
      if (existsSync(target.filePath)) await trash(target.filePath)
    }
    refreshAll()
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
        // 不在这里广播 message.error，让 server.ts 的外层 catch 统一发送 handler_error
        throw e
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

  /** 构造 subagent 隐藏标记并发送 prompt */
  async sendSubagentMessage(sessionId: string, agent: string, task: string, content?: string): Promise<void> {
    const payload = JSON.stringify({ agent, task })
    const encoded = Buffer.from(payload, 'utf-8').toString('base64')
    const marker = `<!-- xyz-agent-force-subagent:${encoded} -->`
    const promptText = content || `Execute task using agent '${agent}'`
    await this.sendMessage(sessionId, `${marker}\n${promptText}`)
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

    const persisted = scanPiSessions()
      .filter(s => !activeFilePaths.has(s.filePath))
      .map(s => this.scannedToSummary(s))

    return [...active, ...persisted].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  /** 从持久化文件恢复 session */
  async restoreSession(sessionId: string): Promise<SessionSummary> {
    const target = this.findScannedSession(sessionId)
    if (!target) throw new Error(`Persisted session ${sessionId} not found`)

    // 启动 pi 前检查 model 配置
    if (!getDefaultModel()) {
      throw new Error('No model configured. Please configure a provider and model in Settings before restoring a session.')
    }
    const existing = this.sessions.get(sessionId)
    if (existing) {
      this.detachSession(existing)
      await this.pm.destroySession(sessionId).catch(() => {})
      this.sessions.delete(sessionId)
    }
    const id = sessionId
    const client = await this.pm.createSession(id, target.cwd, {
      skillPaths: this.getSkillPaths(target.cwd),
      extensionPaths: this.getExtensionPaths(),
    })

    try {
      await client.sendCommand('switch_session', { sessionPath: target.filePath })
    } catch (e) {
      // switch_session 失败时清理已创建的资源，避免子进程/监听器泄漏
      await this.pm.destroySession(id).catch(() => {})
      throw e
    }

    const session = await this.initializeManagedSession(
      id, client, target.cwd, target.name ?? basename(target.cwd), target.filePath,
    )
    return this.toSummary(session)
  }

  getSummary(sessionId: string): SessionSummary | undefined {
    const session = this.sessions.get(sessionId)
    return session ? this.toSummary(session) : undefined
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  async destroyAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      this.treeService.unregisterSession(session.id)
      this.detachSession(session)
    }
    await this.pm.destroyAll()
    this.sessions.clear()
  }

  // ── Internal ───────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface requires cwd param
  private getSkillPaths(_cwd: string): string[] {
    return piBridge.getSkillPaths().filter((p) => {
      if (existsSync(p)) return true
      console.warn(`[session-service] skill path not found, skipping: ${p}`)
      return false
    })
  }

  /** 返回有效的 extension 路径列表（跳过不存在的文件） */
  private getExtensionPaths(): string[] {
    const paths: string[] = []

    // xyz-agent 自定义 extension
    if (this.extensionPath && existsSync(this.extensionPath)) {
      paths.push(this.extensionPath)
    } else if (this.extensionPath) {
      console.warn(`[session-service] extension file not found: ${this.extensionPath}, skipping`)
    }

    // 从 agent dir 发现 bundled pi extensions（subagent, goal, todo 等）
    // 这些会通过 --extension 显式传递，配合 --no-extensions 避免与项目本地/全局 pi extensions 冲突
    const agentDir = this.getAgentDir()
    const bundledExtDir = join(agentDir, 'extensions')
    if (existsSync(bundledExtDir)) {
      try {
        for (const entry of readdirSync(bundledExtDir)) {
          const entryPath = join(bundledExtDir, entry)
          let stat
          try { stat = statSync(entryPath) } catch { continue }
          if (!stat.isDirectory()) continue
          // 查找 index.ts 或 index.js
          const indexTs = join(entryPath, 'index.ts')
          const indexJs = join(entryPath, 'index.js')
          if (existsSync(indexTs)) {
            paths.push(indexTs)
          } else if (existsSync(indexJs)) {
            paths.push(indexJs)
          }
        }
      } catch (e) {
        console.warn(`[session-service] failed to read bundled extensions dir: ${bundledExtDir}`, e)
      }
    }

    return paths
  }

  /** 获取 pi agent 目录（打包模式用 bundled 路径，开发模式用 ~/.pi/agent） */
  private getAgentDir(): string {
    if (process.env.XYZ_AGENT_PACKAGED === '1') {
      return join(process.cwd(), 'pi', 'agent')
    }
    return join(homedir(), '.pi', 'agent')
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
    return scanPiSessions().find(s => s.id === sessionId)
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

  // ── Shared session helpers (消除 create/restoreSession 重复) ───

  /**
   * 初始化 ManagedSession：创建 interceptor/adapter、注册监听、存入 sessions Map、查询 commands。
   * create() 和 restoreSession() 共享此方法。
   */
  private async initializeManagedSession(
    id: string,
    client: IRpcClient,
    cwd: string,
    label: string,
    sessionFilePath?: string,
  ): Promise<ManagedSession> {
    const interceptor = new NavigateInterceptor((msg) => this.broker.broadcast(msg))
    const adapter = this.adapterFactory(id, interceptor)
    adapter.attach(client)

    const unsubUsage = this.attachUsageListener(id, client)

    const modelRef = getDefaultModel()
    const modelId = modelRef ? `${modelRef.provider}/${modelRef.modelId}` : ''

    const session: ManagedSession = {
      id,
      cwd,
      label,
      modelId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      tokenCount: 0,
      isGenerating: false,
      adapter,
      interceptor,
      unsubUsageListener: unsubUsage,
      sessionFilePath,
    }
    this.sessions.set(id, session)

    await this.fetchAndBroadcastCommands(id, client, interceptor)
    return session
  }

  /** Attach agent_end listener to track token usage and isGenerating state. */
  private attachUsageListener(id: string, client: IRpcClient): () => void {
    return client.onEvent((event) => {
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
  }

  /** Query pi for extension commands and register navigate capability. */
  private async fetchAndBroadcastCommands(id: string, client: IRpcClient, interceptor: NavigateInterceptor): Promise<void> {
    try {
      const commands = await client.getCommands() as Array<{ name: string; description?: string; source: string }>
      console.log(`[session-service] getCommands returned ${commands.length} commands:`, commands.map(c => c.name))
      this.broker.broadcast({ type: 'session.commands', payload: { sessionId: id, commands } })
      const navCapable = commands.some(c => c.name === 'xyz-navigate' && c.source === 'extension')
      this.treeService.registerSession(id, interceptor)
      this.treeService.setNavigateCapable(id, navCapable)
      if (!navCapable) {
        console.warn('[session-service] xyz-navigate extension not found, navigate will be unavailable')
      }
    } catch (e) {
      console.warn('[session-service] getCommands failed:', e)
    }
  }

  /** Detach adapter and unsubscribe usage listener. */
  private detachSession(session: ManagedSession): void {
    session.adapter.detach()
    if (session.unsubUsageListener) session.unsubUsageListener()
  }
}
