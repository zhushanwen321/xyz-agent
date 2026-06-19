/**
 * SessionService — Facade(门面)。
 *
 * 持有 sessions Map(单写者)+ 依赖,组合 lifecycle/dispatcher/scanner 三子模块,
 * 实现 ISessionService(对外)与 ISessionServiceInternal(对内)。
 *
 * 共享 helper(initializeManagedSession/detachSession/toSummary/findScannedSession/
 * getSkillPaths/getExtensionPaths)留 Facade,子模块经 ISessionServiceInternal 调用 ——
 * 既保 sessions Map 单写者,又打断模块环(子模块 → interfaces.ts 接口 → Facade implements,单向)。
 *
 * onSessionExit 回调留构造函数:协调 lifecycle/scanner/broker 多方,不归属任一子模块。
 */
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { SessionSummary, SessionGroup, SessionStatus, Message } from '@xyz-agent/shared'
import type {
  ISessionService, ISessionServiceInternal, IProcessManager, IMessageBroker,
  IEventAdapter, IRpcClient, IExtensionService,
} from '../../interfaces.js'
import { convertPiHistory } from '../../infra/pi/message-converter.js'
import type { PiHistoryMessage } from '../../infra/pi/pi-protocol.js'
import { getDefaultModel, scanPiSessions, getSkillPaths as getPiSkillPaths } from '../../infra/pi/pi-config-bridge.js'
import { NavigateInterceptor } from '../../infra/pi/navigate-interceptor.js'
import { TreeService } from '../tree-service.js'
import { readGitInfo } from '../git-info.js'
import { getHistoryFromFile } from '../session-history.js'
import type { IManagedSessionView, ScannedSession, SendMessageHook } from './types.js'
import { SessionLifecycle } from './session-lifecycle.js'
import { MessageDispatcher } from './message-dispatcher.js'
import { SessionScanner } from './session-scanner.js'

/** Facade 内部完整 session:子模块可见视图 + 运行时句柄(adapter/interceptor/listener)。 */
interface ManagedSession extends IManagedSessionView {
  adapter: IEventAdapter
  interceptor: NavigateInterceptor
  unsubUsageListener: (() => void) | null
}

export class SessionService implements ISessionService, ISessionServiceInternal {
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly restoringSessions = new Set<string>()
  private extensionPath = ''
  private readonly lifecycle: SessionLifecycle
  private readonly dispatcher: MessageDispatcher
  private readonly scanner: SessionScanner

  constructor(
    private readonly pm: IProcessManager,
    private readonly broker: IMessageBroker,
    private readonly adapterFactory: (sessionId: string, interceptor: NavigateInterceptor) => IEventAdapter,
    private readonly projectRoot: string,
    private readonly treeService: TreeService,
    private readonly extensionService: IExtensionService,
  ) {
    // 打包模式:extension 在 Resources 根;开发模式:在 repo root(src-electron/ 父目录)
    this.extensionPath = process.env.XYZ_AGENT_PACKAGED === '1'
      ? resolve(process.cwd(), 'xyz-agent-extension.js')
      : resolve(resolve(this.projectRoot, '..'), 'xyz-agent-extension.js')

    // 子模块注入 this(Facade 半构造时仅存引用,其方法在 Facade 完全构造后才被调用)
    this.lifecycle = new SessionLifecycle(this, this.pm, this.treeService)
    this.dispatcher = new MessageDispatcher(this, this.pm, this.broker)
    this.scanner = new SessionScanner(this)

    // 进程崩溃清理:协调 adapter detach / Map 删 / tree 注销 / 列表刷新 / error 广播
    this.pm.onSessionExit((sessionId, code) => {
      const session = this.sessions.get(sessionId)
      if (!session) return
      session.adapter.detach()
      if (session.unsubUsageListener) session.unsubUsageListener()
      this.sessions.delete(sessionId)
      this.treeService.unregisterSession(sessionId)
      this.broker.broadcast({ type: 'session.list', payload: { groups: this.listPersistedSessions() } })
      this.broker.broadcast({ type: 'message.error', payload: { sessionId, message: `Session process exited unexpectedly (code: ${code})` } })
    })
  }

  // ── ISessionService:纯委托(lifecycle / dispatcher / scanner)─────

  async create(cwd?: string, label?: string): Promise<SessionSummary> { return this.lifecycle.create(cwd, label) }
  async delete(sessionId: string): Promise<void> { return this.lifecycle.delete(sessionId) }
  async renameSession(sessionId: string, newName: string): Promise<void> { return this.lifecycle.renameSession(sessionId, newName) }
  async restoreSession(sessionId: string): Promise<SessionSummary> { return this.lifecycle.restoreSession(sessionId) }
  async rebindAfterFork(oldSessionId: string, newSessionId: string, label: string, sessionFilePath?: string): Promise<void> {
    return this.lifecycle.rebindAfterFork(oldSessionId, newSessionId, label, sessionFilePath)
  }
  async sendMessage(sessionId: string, content: string): Promise<void> { return this.dispatcher.sendMessage(sessionId, content) }
  async sendSubagentMessage(sessionId: string, agent: string, task: string, content?: string): Promise<void> {
    return this.dispatcher.sendSubagentMessage(sessionId, agent, task, content)
  }
  async abort(sessionId: string): Promise<void> { return this.dispatcher.abort(sessionId) }
  async steerMessage(sessionId: string, content: string): Promise<void> { return this.dispatcher.steerMessage(sessionId, content) }
  async followUpMessage(sessionId: string, content: string): Promise<void> { return this.dispatcher.followUpMessage(sessionId, content) }
  async compact(sessionId: string): Promise<void> { return this.dispatcher.compact(sessionId) }
  setSendMessageHook(hook: SendMessageHook): void { this.dispatcher.setSendMessageHook(hook) }
  listPersistedSessions(): SessionGroup[] { return this.scanner.listPersistedSessions() }

  // ── ISessionService:Facade 直接实现(查 sessions / 经 rpc,轻量)─────

  async switchModel(sessionId: string, provider: string, modelId: string): Promise<string> {
    const session = this.sessions.get(sessionId)
    if (!session) return sessionId
    const newModelId = `${provider}/${modelId}`
    const client = this.pm.getClient(sessionId)
    if (client) {
      try {
        await client.setModel(provider, modelId)
      } catch (e) {
        console.error(`[session-service] switchModel RPC failed: sessionId=${sessionId}, model=${newModelId}`, e)
        throw e
      }
    }
    session.modelId = newModelId
    return sessionId
  }

  async setThinkingLevel(sessionId: string, level: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) session.thinkingLevel = level
    const client = this.pm.getClient(sessionId)
    if (client) await client.setThinkingLevel(level)
  }

  hasActiveSession(sessionId: string): boolean { return this.pm.hasClient(sessionId) }
  getRpcClient(sessionId: string): IRpcClient | undefined { return this.pm.getClient(sessionId) }

  /** 确保会话活跃;不存在则自动 restore。并发 restore 时去重拒绝。 */
  async ensureActive(sessionId: string): Promise<IRpcClient> {
    const existing = this.pm.getClient(sessionId)
    if (existing) return existing
    if (this.restoringSessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} is already being restored`)
    }
    this.restoringSessions.add(sessionId)
    try {
      console.log(`[session-service] ensureActive: restoring ${sessionId}...`)
      await this.restoreSession(sessionId)
      const client = this.pm.getClient(sessionId)
      if (!client) throw new Error('Restore succeeded but client not available')
      return client
    } finally {
      this.restoringSessions.delete(sessionId)
    }
  }

  async getHistory(sessionId: string): Promise<Message[]> {
    const client = this.pm.getClient(sessionId)
    if (client) {
      try {
        const result = await client.getHistory() as { data?: { messages?: PiHistoryMessage[] }; payload?: { messages?: PiHistoryMessage[] } }
        const data = result.data
        const raw = data?.messages ?? (result.payload?.messages) ?? []
        if (raw.length > 0) return convertPiHistory(raw)
        // RPC 返回空时,仅闲置 session fallback 到磁盘(生成中磁盘可能未持久化最新消息)
        const session = this.sessions.get(sessionId)
        if (session && !session.isGenerating) {
          console.warn(`[session-service] getHistory via RPC returned empty for idle session ${sessionId}, falling back to file read`)
          return await getHistoryFromFile(sessionId)
        }
        return []
      } catch (e) {
        console.warn(`[session-service] getHistory via RPC failed: ${e instanceof Error ? e.message : e}, falling back to file read`)
        return await getHistoryFromFile(sessionId)
      }
    }
    return await getHistoryFromFile(sessionId)
  }

  getSummary(sessionId: string): SessionSummary | undefined {
    const session = this.sessions.get(sessionId)
    return session ? this.toSummary(session) : undefined
  }

  async destroyAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      this.treeService.unregisterSession(session.id)
      session.adapter.detach()
      if (session.unsubUsageListener) session.unsubUsageListener()
    }
    await this.pm.destroyAll()
    this.sessions.clear()
  }

  // ── ISessionServiceInternal:子模块经此访问 sessions / 共享 helper ──

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface requires cwd param
  getSkillPaths(_cwd: string): string[] {
    return getPiSkillPaths().filter((p) => {
      if (existsSync(p)) return true
      console.warn(`[session-service] skill path not found, skipping: ${p}`)
      return false
    })
  }

  async getExtensionPaths(): Promise<string[]> {
    try {
      return await this.extensionService.getExtensionPaths()
    } catch (e) {
      console.warn('[session-service] getExtensionPaths failed:', e)
      return []
    }
  }

  findScannedSession(sessionId: string): ScannedSession | undefined {
    return scanPiSessions().find(s => s.id === sessionId)
  }

  toSummary(s: IManagedSessionView): SessionSummary {
    const git = readGitInfo(s.cwd)
    return {
      id: s.id, label: s.label, cwd: s.cwd,
      gitBranch: git?.branch, gitIsWorktree: git?.isWorktree,
      status: s.isGenerating ? ('active' as SessionStatus) : ('idle' as SessionStatus),
      lastActiveAt: s.lastActiveAt, modelId: s.modelId,
      thinkingLevel: s.thinkingLevel, tokenCount: s.tokenCount,
    }
  }

  getSession(sessionId: string): IManagedSessionView | undefined { return this.sessions.get(sessionId) }
  removeSessionEntry(sessionId: string): void { this.sessions.delete(sessionId) }

  getSessionByClient(client: IRpcClient): IManagedSessionView | undefined {
    const id = this.pm.getSessionIdByClient(client)
    return id ? this.sessions.get(id) : undefined
  }

  detachSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.adapter.detach()
    if (session.unsubUsageListener) session.unsubUsageListener()
  }

  getActiveSummaries(): SessionSummary[] {
    return Array.from(this.sessions.values()).map(s => this.toSummary(s))
  }

  getActiveFilePaths(): Set<string> {
    const filePaths = new Set<string>()
    for (const s of this.sessions.values()) {
      if (s.sessionFilePath) filePaths.add(s.sessionFilePath)
    }
    return filePaths
  }

  /** 初始化 ManagedSession:建 interceptor/adapter、注册监听、入 Map、查 commands。 */
  async initializeManagedSession(
    id: string, client: IRpcClient, cwd: string, label: string, sessionFilePath?: string,
  ): Promise<IManagedSessionView> {
    const interceptor = new NavigateInterceptor((msg) => this.broker.broadcast(msg))
    const adapter = this.adapterFactory(id, interceptor)
    adapter.attach(client)
    const unsubUsage = this.attachUsageListener(id, client)
    const modelRef = getDefaultModel()
    const session: ManagedSession = {
      id, cwd, label,
      modelId: modelRef ? `${modelRef.provider}/${modelRef.modelId}` : '',
      createdAt: Date.now(), lastActiveAt: Date.now(),
      tokenCount: 0, isGenerating: false,
      adapter, interceptor, unsubUsageListener: unsubUsage, sessionFilePath,
    }
    this.sessions.set(id, session)
    await this.fetchAndBroadcastCommands(id, client, interceptor)
    return session
  }

  // ── 私有协作者 ────────────────────────────────────────────────

  /** Attach agent_end listener:track token usage + isGenerating。 */
  private attachUsageListener(id: string, client: IRpcClient): () => void {
    return client.onEvent((event) => {
      const e = event as Record<string, unknown>
      if (e.type === 'agent_end') {
        const s = this.sessions.get(id)
        if (!s) return
        s.isGenerating = false
        const payload = e.payload as Record<string, unknown> | undefined
        const usage = payload?.usage as
          { outputTokens?: number; inputTokens?: number; totalTokens?: number } | undefined
        if (usage) s.tokenCount = (usage.totalTokens ?? usage.outputTokens ?? 0) as number
      }
    })
  }

  /** Query pi extension commands + register navigate capability。失败不阻塞 session。 */
  private async fetchAndBroadcastCommands(id: string, client: IRpcClient, interceptor: NavigateInterceptor): Promise<void> {
    try {
      const commands = await client.getCommands() as Array<{ name: string; description?: string; source: string }>
      console.log(`[session-service] getCommands returned ${commands.length} commands:`, commands.map(c => c.name))
      this.broker.broadcast({ type: 'session.commands', payload: { sessionId: id, commands } })
      const navCapable = commands.some(c => c.name === 'xyz-navigate' && c.source === 'extension')
      this.treeService.registerSession(id, interceptor)
      this.treeService.setNavigateCapable(id, navCapable)
      if (!navCapable) console.warn('[session-service] xyz-navigate extension not found, navigate will be unavailable')
    // eslint-disable-next-line taste/no-silent-catch -- getCommands failure must not block session
    } catch (e) {
      console.warn('[session-service] getCommands failed:', e)
    }
  }
}
