/* eslint-disable max-lines */
/**
 * SessionService — extracted from session-pool.ts.
 *
 * Manages session lifecycle: creation, deletion, messaging, history,
 * model switching, compaction, and persistence.
 */
import { basename, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type {
  SessionSummary,
  SessionGroup,
  SessionStatus,
  Message,
} from '@xyz-agent/shared'
import type { ISessionService, IProcessManager, IMessageBroker, IEventAdapter } from '../interfaces.js'
import type { IRpcClient } from '../interfaces.js'
import type { IExtensionService } from '../interfaces.js'
import type { PiMessage } from '../rpc-client.js'
import { convertPiHistory } from '../message-converter.js'
import type { PiHistoryMessage } from '../types.js'
import { getDefaultModel, scanPiSessions, refreshAll, getPiAgentDir, persistSessionName, ensureSessionFile, patchSessionCwd } from '../pi-config-bridge.js'
import * as piBridge from '../pi-config-bridge.js'
import { trash } from '../trash.js'
import { NavigateInterceptor } from '../navigate-interceptor.js'
import { TreeService } from './tree-service.js'
import { readGitInfo, pruneGitInfoCache } from './git-info.js'
import { getHistoryFromFile } from './session-history.js'

/** SendMessage hook 类型：在消息发送前触发，可阻止发送 */
export type SendMessageHook = (sessionId: string, content: string) => Promise<{ blocked: boolean; reason?: string } | null>

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
  thinkingLevel?: string
  adapter: IEventAdapter
  interceptor: NavigateInterceptor
  unsubUsageListener: (() => void) | null
  sessionFilePath?: string
}

export class SessionService implements ISessionService {
  private sessions = new Map<string, ManagedSession>()
  private restoringSessions = new Set<string>()
  private extensionPath: string = ''
  private sendMessageHook: SendMessageHook | null = null

  constructor(
    private pm: IProcessManager,
    private broker: IMessageBroker,
    private adapterFactory: (sessionId: string, interceptor: NavigateInterceptor) => IEventAdapter,
    private projectRoot: string,
    readonly treeService: TreeService,
    private extensionService: IExtensionService,
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

    // Collect extension paths: built-in + user-installed + file-type
    const allExtPaths = await this.getExtensionPaths()
    const client = await this.pm.createSession(tempId, sessionCwd, {
      skillPaths: this.getSkillPaths(sessionCwd),
      extensionPaths: allExtPaths,
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

    // pi 延迟写入：session 文件在首次 assistant 消息前可能不存在。
    // 主动创建最小文件确保 scanPiSessions 能找到该 session，
    // 避免空对话 session 在重启后消失。
    if (sessionFilePath) {
      ensureSessionFile(sessionFilePath, id, sessionCwd, label)
    }

    refreshAll()
    return this.toSummary(session)
  }

  async renameSession(sessionId: string, newName: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.label = newName
      // 活跃 session：写入 sessionFilePath 使重启后保留
      if (session.sessionFilePath) {
        persistSessionName(session.sessionFilePath, newName, session.id, session.cwd)
      }
    } else {
      // 非 active session：从磁盘查找 jsonl 文件并写入
      const target = this.findScannedSession(sessionId)
      if (target) {
        persistSessionName(target.filePath, newName, target.id, target.cwd)
      }
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

  /**
   * 设置消息发送前 hook。
   * 由 PluginService 在初始化时调用，实现 beforeSend 拦截。
   */
  setSendMessageHook(hook: SendMessageHook): void {
    this.sendMessageHook = hook
  }

  // ── Messaging ──────────────────────────────────────────────────

  async sendMessage(sessionId: string, content: string): Promise<void> {
    // ── BeforeSend hook 执行点 ───────────────────────────────────
    try {
      if (this.sendMessageHook) {
        const hookResult = await this.sendMessageHook(sessionId, content)
        if (hookResult?.blocked) {
          this.broker.broadcast({
            type: 'message.error',
            payload: { sessionId, message: hookResult.reason ?? 'Message blocked by plugin hook' },
          })
          return
        }
      }
    } catch (e) {
      console.error('[session-service] sendMessage hook error:', e)
      this.broker.broadcast({
        type: 'message.error',
        payload: { sessionId, message: 'Plugin hook error: ' + (e instanceof Error ? e.message : String(e)) },
      })
      return
    }

    let client: IRpcClient
    try {
      client = await this.ensureActive(sessionId)
    } catch (e) {
      const errMsg = `Failed to restore session: ${e instanceof Error ? e.message : String(e)}`
      console.error(`[session-service] ${errMsg}`)
      // 不在这里广播 message.error，让 server.ts 的外层 catch 统一发送 handler_error
      throw e
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

    // Ensure session is active first (consistent with sendMessage execution order),
    // then run hook check against the active session.
    let client: IRpcClient
    try {
      client = await this.ensureActive(sessionId)
    } catch (e) {
      const errMsg = `Failed to restore session: ${e instanceof Error ? e.message : String(e)}`
      console.error(`[session-service] ${errMsg}`)
      throw e
    }

    // Hook 审核用户原始输入，marker 仅在发送给 pi 时注入
    try {
      if (this.sendMessageHook) {
        const hookResult = await this.sendMessageHook(sessionId, promptText)
        if (hookResult?.blocked) {
          this.broker.broadcast({
            type: 'message.error',
            payload: { sessionId, message: hookResult.reason ?? 'Message blocked by plugin hook' },
          })
          return
        }
      }
    } catch (e) {
      console.error('[session-service] sendSubagentMessage hook error:', e)
      this.broker.broadcast({
        type: 'message.error',
        payload: { sessionId, message: 'Plugin hook error: ' + (e instanceof Error ? e.message : String(e)) },
      })
      return
    }

    const activeSession = this.findSessionByClient(client)
    if (activeSession) {
      activeSession.lastActiveAt = Date.now()
      activeSession.isGenerating = true
    }
    console.log(`[session-service] sendSubagentMessage: sessionId=${sessionId}`)
    try {
      await client.prompt(`${marker}\n${promptText}`)
      console.log(`[session-service] subagent prompt acknowledged: sessionId=${sessionId}`)
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.error(`[session-service] subagent prompt failed: sessionId=${sessionId}`, errMsg)
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

  async steerMessage(sessionId: string, content: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`[session-service] steer: session ${sessionId} not active`)
    await client.steer(content)
  }

  async followUpMessage(sessionId: string, content: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`[session-service] followUp: session ${sessionId} not active`)
    await client.followUp(content)
  }

  // ── Model switching ────────────────────────────────────────────

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

    // RPC 成功后才更新缓存
    session.modelId = newModelId
    return sessionId
  }

  async setThinkingLevel(sessionId: string, level: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) session.thinkingLevel = level
    const client = this.pm.getClient(sessionId)
    if (client) {
      await client.setThinkingLevel(level)
    }
  }

  hasActiveSession(sessionId: string): boolean {
    return this.pm.hasClient(sessionId)
  }

  getRpcClient(sessionId: string): IRpcClient | undefined {
    return this.pm.getClient(sessionId)
  }

  /**
   * Ensure a session is active. If not, auto-restore it.
   * Centralizes the "check active → restore if needed" pattern used by
   * sendMessage, session.switch, and compact.
   */
  async ensureActive(sessionId: string): Promise<IRpcClient> {
    const existing = this.pm.getClient(sessionId)
    if (existing) return existing

    // Dedup: if another call is already restoring this session, bail out
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

  // ── History ────────────────────────────────────────────────────

  async getHistory(sessionId: string): Promise<Message[]> {
    const client = this.pm.getClient(sessionId)
    if (client) {
      try {
        const result = await client.getHistory() as PiMessage
        const data = result.data as { messages?: PiHistoryMessage[] } | undefined
        const raw = data?.messages ?? (result.payload?.messages as PiHistoryMessage[] | undefined) ?? []
        if (raw.length > 0) return convertPiHistory(raw)

        // RPC 返回空时，只有 session 闲置时才 fallback 到磁盘
        // 生成中的 session 不 fallback（磁盘可能未持久化最新消息）
        const session = this.sessions.get(sessionId)
        if (session && !session.isGenerating) {
          console.warn(`[session-service] getHistory via RPC returned empty for idle session ${sessionId}, falling back to file read`)
          return await getHistoryFromFile(sessionId)
        }
        // 生成中但返回空 — 返回空（RPC 数据比磁盘新）
        return []
      } catch (e) {
        console.warn(`[session-service] getHistory via RPC failed: ${e instanceof Error ? e.message : e}, falling back to file read`)
        return await getHistoryFromFile(sessionId)
      }
    }

    return await getHistoryFromFile(sessionId)
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

    const result = [...active, ...persisted].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    this.pruneGitCache(result)
    return result
  }

  /** Prune git-info cache entries for cwds no longer represented in any session. */
  private pruneGitCache(allSummaries: SessionSummary[]): void {
    const cwds = new Set(allSummaries.map(s => s.cwd))
    pruneGitInfoCache(cwds)
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

    // session cwd 可能已被删除（如 worktree 清理后），降级到 home + patch session 文件
    const sessionCwd = existsSync(target.cwd) ? target.cwd : (() => {
      console.warn(`[session-service] session cwd does not exist: ${target.cwd}, falling back to home`)
      patchSessionCwd(target.filePath, homedir())
      return homedir()
    })()

    const id = sessionId
    // Collect extension paths: built-in + user-installed + file-type
    const allExtPaths = await this.getExtensionPaths()
    const client = await this.pm.createSession(id, sessionCwd, {
      skillPaths: this.getSkillPaths(sessionCwd),
      extensionPaths: allExtPaths,
    })

    try {
      await client.sendCommand('switch_session', { sessionPath: target.filePath })
    } catch (e) {
      // switch_session 失败时清理已创建的资源，避免子进程/监听器泄漏
      await this.pm.destroySession(id).catch(() => {})
      throw e
    }

    const session = await this.initializeManagedSession(
      id, client, sessionCwd, target.name ?? basename(sessionCwd), target.filePath,
    )
    return this.toSummary(session)
  }

  /** Fork 后重新绑定：原 session 的 pi 进程已被 rebind 到新 session，
   *  需要更新 runtime 的 sessions Map 和 process manager 的 key。
   *  必须同步等待初始化完成，否则后续请求（tree-data、navigate）可能因注册未完成而失败。 */
  async rebindAfterFork(oldSessionId: string, newSessionId: string, label: string, sessionFilePath?: string): Promise<void> {
    const old = this.sessions.get(oldSessionId)
    if (!old) throw new Error(`Session ${oldSessionId} not found in sessions map`)

    // 先 rekey process manager（client 仍然是同一个 pi 进程）
    // 必须在 detach/delete 之前执行，确保 rekey 失败时旧状态不被破坏
    this.pm.rekey(oldSessionId, newSessionId)

    // rekey 成功后，安全地清理旧 session 的 adapter/listener/registry
    this.detachSession(old)
    this.treeService.unregisterSession(oldSessionId)
    this.sessions.delete(oldSessionId)

    // 用新 ID 重新注册 managed session（label 由调用方传入，已含 -fork/-clone 后缀）
    const client = this.pm.getClient(newSessionId)
    if (!client) throw new Error(`Client not found after rekey: ${newSessionId}`)
    await this.initializeManagedSession(newSessionId, client, old.cwd, label, sessionFilePath)
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

  /**
   * 返回有效的 extension 路径列表（通过 ExtensionService 单调用链）。
   * ExtensionService 封装 ExtensionResolver.resolve() + settings 状态过滤 + 文件型 extension。
   */
  private async getExtensionPaths(): Promise<string[]> {
    try {
      return await this.extensionService.getExtensionPaths()
    } catch (e) {
      console.warn('[session-service] getExtensionPaths failed:', e)
      return []
    }
  }

  /** 获取 xyz-pi agent 目录（开发和打包模式统一：~/.xyz-agent/pi/agent/） */
  private getAgentDir(): string {
    return getPiAgentDir()
  }

  private toSummary(s: ManagedSession): SessionSummary {
    const git = readGitInfo(s.cwd)
    return {
      id: s.id,
      label: s.label,
      cwd: s.cwd,
      gitBranch: git?.branch,
      gitIsWorktree: git?.isWorktree,
      status: s.isGenerating ? ('active' as SessionStatus) : ('idle' as SessionStatus),
      lastActiveAt: s.lastActiveAt,
      modelId: s.modelId,
      thinkingLevel: s.thinkingLevel,
      tokenCount: s.tokenCount,
    }
  }

  private findScannedSession(sessionId: string): ScannedSession | undefined {
    return scanPiSessions().find(s => s.id === sessionId)
  }

  private scannedToSummary(s: ScannedSession): SessionSummary {
    const git = readGitInfo(s.cwd)
    return {
      id: s.id,
      label: s.name ?? basename(s.cwd),
      cwd: s.cwd,
      gitBranch: git?.branch,
      gitIsWorktree: git?.isWorktree,
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
    // eslint-disable-next-line taste/no-silent-catch -- getCommands: failure to query extension commands must not block session
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
