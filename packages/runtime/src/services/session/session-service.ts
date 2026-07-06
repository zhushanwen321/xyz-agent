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
import { existsSync } from 'node:fs'
import type { SessionSummary, SessionGroup, SessionStatus, Message, ServerMessage } from '@xyz-agent/shared'
// paths.ts 是 Node-only 模块，刻意不从 shared barrel 导出（见 shared/src/index.ts L32 注释），
// Node 端从子路径 import
import { getDataDir } from '@xyz-agent/shared/paths'
import type {
  ISessionService, IMessageBroker,
  IEventAdapter, IExtensionService,
} from '../../interfaces.js'
import type { ISessionServiceInternal } from './session-internal.js'
import type { IProcessManager, IPiEngine } from '../ports/pi-engine.js'
import { readPiState } from '../ports/pi-engine.js'
import { getHistoryFromFile } from '../session-history.js'
import type { IConfigStore } from '../ports/config.js'
import type { ISessionStore } from '../ports/session.js'
import type { IGitInfoReader } from '../ports/git-info.js'
import type { IManagedSessionView, ScannedSession, SendMessageHook } from './types.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import { SessionLifecycle } from './session-lifecycle.js'
import { MessageDispatcher } from './message-dispatcher.js'
import { SessionScanner } from './session-scanner.js'
import { toErrorMessage } from '../../utils/errors.js'
import { isPackaged, getExtensionFilePath } from '../../utils/runtime-env.js'

/** Facade 内部完整 session:子模块可见视图 + 运行时句柄(adapter/listener)。 */
interface ManagedSession extends IManagedSessionView {
  adapter: IEventAdapter
  unsubUsageListener: (() => void) | null
}

/** 百分比上限（usagePercent 计算唯一常量，消除 model-service / index.ts 的重复）。 */
const MAX_PERCENT = 100

/**
 * 按 provider/modelId 解析模型 contextWindow 的窄函数（port）。
 *
 * SessionService 作为 session 级状态单一 owner，需读 model contextWindow 才能算
 * usagePercent。直接依赖 IModelService/IConfigService 会形成依赖环
 * （ModelService 依赖 SessionService 反过来也成立），故抽出此窄 port，由组合根
 * （index.ts）在所有服务构造完毕后经 setModelContextWindowResolver 注入。
 * 取值与 IConfigService.listProviders + IModelService.aggregateModels 等价（纯数据查询）。
 */
export type ModelContextWindowResolver = (provider: string, modelId: string) => number

export class SessionService implements ISessionService, ISessionServiceInternal {
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly restoringSessions = new Set<string>()
  private extensionPath = ''
  private readonly lifecycle: SessionLifecycle
  private readonly dispatcher: MessageDispatcher
  private readonly scanner: SessionScanner
  /**
   * model contextWindow 解析器（组合根注入）。算 usagePercent 用——按 provider/modelId
   * 查 ProviderInfo→ModelInfo 得到 contextWindow。未注入时 fallback 0（无法算百分比）。
   */
  private modelContextWindowResolver: ModelContextWindowResolver | null = null
  /**
   * 公共 session 创建成功回调（组合根注入，调 broker.broadcastAppInfo 重广播 app.info）。
   *
   * 时序：公共 session 在 server.start 之后才创建，首次 sendInitialState 推 app.info 时
   * publicSessionId 多为 undefined。创建成功后触发本回调，重广播带 publicSessionId 的 app.info，
   * 前端据此填 sessionStore.publicSessionId + 拉命令到 commandStore（landing slash 数据源）。
   */
  private onPublicSessionReady: (() => void) | null = null

  constructor(
    private readonly pm: IProcessManager,
    private readonly broker: IMessageBroker,
    private readonly adapterFactory: (sessionId: string, send: (msg: ServerMessage) => void, cwd?: string) => IEventAdapter,
    private readonly projectRoot: string,
    private readonly extensionService: IExtensionService,
    private readonly configStore: IConfigStore,
    private readonly sessionStore: ISessionStore,
    private readonly gitInfoReader: IGitInfoReader,
    private readonly workspaceService: WorkspaceService,
  ) {
    // 打包模式:extension 在 Resources 根;开发模式:在 repo root(apps/electron/ 父目录)
    this.extensionPath = getExtensionFilePath(this.projectRoot, isPackaged())

    // 子模块注入 this(Facade 半构造时仅存引用,其方法在 Facade 完全构造后才被调用)
    this.lifecycle = new SessionLifecycle(this, this.pm, this.configStore, this.sessionStore, this.workspaceService)
    this.dispatcher = new MessageDispatcher(this, this.pm, this.broker, this.workspaceService)
    this.scanner = new SessionScanner(this, this.sessionStore, this.gitInfoReader)

    // 进程崩溃清理:协调 adapter detach / Map 删 / 列表刷新 / error 广播
    this.pm.onSessionExit((sessionId, code) => {
      const session = this.sessions.get(sessionId)
      if (!session) return
      session.adapter.detach()
      if (session.unsubUsageListener) session.unsubUsageListener()
      this.sessions.delete(sessionId)

      // 公共 session 崩溃：自动重建（landing 态命令源依赖它），不广播 error（对用户透明）
      const isPublic = sessionId === this.publicSessionId
      if (isPublic) {
        this.publicSessionId = undefined
        this.schedulePublicSessionRebuild()
        return
      }

      this.broker.broadcast({ type: 'session.list', payload: { groups: this.listPersistedSessions() } })
      this.broker.broadcast({ type: 'message.error', payload: { sessionId, message: `Session process exited unexpectedly (code: ${code})` } })
    })
  }

  /**
   * 公共 session：隐藏的常驻 session，cwd=数据目录，仅供 landing 态获取 pi 命令（/goal 等）。
   * 随 runtime 启动创建，pi 进程常驻。landing 态 composer 用此 session 的 commands。
   *
   * model 未配置时创建会失败（pi 要求 model），catch 后仅 warn，landing 态 fallback 到 skills。
   */
  private publicSessionId: string | undefined
  private publicSessionRebuildTimer: NodeJS.Timeout | undefined
  private publicSessionRebuildCount = 0
  // eslint-disable-next-line no-magic-numbers -- pi 持续 crash 时的重建上限，超过则放弃
  private static readonly PUBLIC_REBUILD_MAX = 3
  // eslint-disable-next-line no-magic-numbers -- 重建延迟（ms），避免立即重试撞同一错误
  private static readonly PUBLIC_REBUILD_DELAY_MS = 2000
  private static readonly PUBLIC_LABEL = '__public__'

  /** 当前公共 session id（供 broker app.info 推送；undefined 表示未创建/不可用） */
  getPublicSessionId(): string | undefined {
    return this.publicSessionId
  }

  /**
   * 创建公共 session。model 未配置 / spawn 失败时不抛（landing 降级到 skills）。
   * 在 runtime 启动收尾（server.start 后）调用。
   */
  async ensurePublicSession(): Promise<void> {
    if (this.publicSessionId) return
    try {
      const pub = await this.create(getDataDir(), SessionService.PUBLIC_LABEL, { hidden: true })
      this.publicSessionId = pub.id
      this.publicSessionRebuildCount = 0
      console.log(`[session-service] public session created: ${pub.id}`)
      // 通知前端：公共 session 就绪。首次 sendInitialState 推 app.info 时它尚未创建，
      // 这里重广播带 publicSessionId 的 app.info，前端据此填 landing slash 命令源。
      this.onPublicSessionReady?.()
    // eslint-disable-next-line taste/no-silent-catch -- 公共 session 是 best-effort：model 未配置/spawn 失败时 landing 降级到 skills fallback
    } catch (e) {
      console.warn(`[session-service] public session create failed (landing slash will use skills fallback):`, e)
    }
  }

  /**
   * 崩溃后延迟重建公共 session。带重试上限避免死循环（pi 持续 crash 时不再重建）。
   */
  private schedulePublicSessionRebuild(): void {
    if (this.publicSessionRebuildCount >= SessionService.PUBLIC_REBUILD_MAX) {
      console.warn(`[session-service] public session rebuild gave up after ${SessionService.PUBLIC_REBUILD_MAX} attempts`)
      return
    }
    this.publicSessionRebuildCount++
    if (this.publicSessionRebuildTimer) clearTimeout(this.publicSessionRebuildTimer)
    this.publicSessionRebuildTimer = setTimeout(() => {
      this.publicSessionRebuildTimer = undefined
      void this.ensurePublicSession()
    }, SessionService.PUBLIC_REBUILD_DELAY_MS)
  }

  /**
   * 注入 model contextWindow 解析器（组合根在所有服务构造后调用）。
   * session 级状态 owner 需读 contextWindow 才能算 usagePercent / 推 contextLimit。
   */
  setModelContextWindowResolver(resolver: ModelContextWindowResolver): void {
    this.modelContextWindowResolver = resolver
  }

  /**
   * 注入公共 session 创建成功回调（组合根调用）。
   * ensurePublicSession 成功（含崩溃重建）后触发——重广播 app.info 补发 publicSessionId。
   */
  setOnPublicSessionReady(cb: () => void): void {
    this.onPublicSessionReady = cb
  }

  // ── ISessionService:纯委托(lifecycle / dispatcher / scanner)─────

  async create(cwd?: string, label?: string, options?: { hidden?: boolean }): Promise<SessionSummary> { return this.lifecycle.create(cwd, label, options) }
  async delete(sessionId: string): Promise<void> { return this.lifecycle.delete(sessionId) }
  async renameSession(sessionId: string, newName: string): Promise<void> { return this.lifecycle.renameSession(sessionId, newName) }
  async restoreSession(sessionId: string): Promise<SessionSummary> { return this.lifecycle.restoreSession(sessionId) }
  async sendMessage(sessionId: string, content: string): Promise<{ blocked: boolean }> { return this.dispatcher.sendMessage(sessionId, content) }
  async sendSubagentMessage(sessionId: string, agent: string, task: string, content?: string): Promise<{ blocked: boolean }> {
    return this.dispatcher.sendSubagentMessage(sessionId, agent, task, content)
  }
  async abort(sessionId: string): Promise<void> { return this.dispatcher.abort(sessionId) }
  async steerMessage(sessionId: string, content: string): Promise<void> { return this.dispatcher.steerMessage(sessionId, content) }
  async followUpMessage(sessionId: string, content: string): Promise<void> { return this.dispatcher.followUpMessage(sessionId, content) }
  async compact(sessionId: string, customInstructions?: string): Promise<void> { return this.dispatcher.compact(sessionId, customInstructions) }
  setSendMessageHook(hook: SendMessageHook): void { this.dispatcher.setSendMessageHook(hook) }
  listPersistedSessions(): SessionGroup[] { return this.scanner.listPersistedSessions() }

  // ── ISessionService:Facade 直接实现(查 sessions / 经 rpc,轻量)─────

  /**
   * session 级状态单一 owner：切换模型的 RPC + 缓存更新 + 广播 session.state_changed。
   *
   * 时序（必须保留，原 model-service.broadcastSessionState 的竞态保护逻辑迁入此处）：
   * 1. 先调 pi RPC setModel —— 确保切模型在 pi 侧生效，否则后续 get_state 读到旧值。
   * 2. 写 session.modelId 缓存。
   * 3. 查 pi get_state 拿当前 thinkingLevel 并回写缓存（thinkingLevel 从 get_state 查询
   *    而非依赖 thinking_level_changed 事件：pi 切模型时若新模型 thinkingLevel 与当前相同
   *    则不 emit 事件，导致缓存恒为 undefined。get_state 是可靠来源）。
   * 4. 按「新 modelId 的 contextWindow + 当前 inputTokens」重算 usagePercent 并广播。
   *
   * 为什么除 config.defaults 外还要广播 session.state_changed（原 model-service 注释保留）：
   * config.defaults 是全局默认（不带 sessionId），前端无法据它定位「哪个 session 换了模型」。
   * session.state_changed 带 sessionId，前端据它同步 Composer 工具条（模型显示 / 用量 / 思考强度）。
   * 缺这条广播导致切换模型后 UI 不跟随（用量停在旧值、模型显示靠 defaultModel fallback 而非
   * per-session 真值）。
   *
   * context.update 与 switchModel 竞态（已踩过坑，2026-07-01 inputTokens 修复）：
   * inputTokens 由 onContextUpdate（agent_end 触发）回写到 session 缓存。switchModel 重算
   * usagePercent 时读的是该缓存。两者经 setInputTokens 缓存打通数据源——context.update 先回写、
   * switchModel 后读取，时序由「缓存写入先于 switchModel 读取」保证。本方法读 inputTokens
   * 必须在 setInputTokens 之后（getInputTokens），不可另起来源。
   */
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

    // 切模型后立即广播 session 级状态（modelId + 按新 contextWindow 重算用量 + thinkingLevel）
    await this.broadcastSessionState(sessionId, provider, modelId)
    return sessionId
  }

  async setThinkingLevel(sessionId: string, level: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) session.thinkingLevel = level
    const client = this.pm.getClient(sessionId)
    if (client) await client.setThinkingLevel(level)
  }
  /** 仅回写 thinkingLevel 缓存（不调 pi RPC），供 thinking_level_changed 事件 callback 用 */
  setThinkingLevelCache(sessionId: string, level: string | undefined): void {
    if (level === undefined) return
    const session = this.sessions.get(sessionId)
    if (session) session.thinkingLevel = level
  }

  hasActiveSession(sessionId: string): boolean { return this.pm.hasClient(sessionId) }
  getRpcClient(sessionId: string): IPiEngine | undefined { return this.pm.getClient(sessionId) }

  /** 确保会话活跃;不存在则自动 restore。并发 restore 时去重拒绝。 */
  async ensureActive(sessionId: string): Promise<IPiEngine> {
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
        const result = await client.getHistory() as { data?: { messages?: unknown[] }; payload?: { messages?: unknown[] } }
        const data = result.data
        const raw = data?.messages ?? (result.payload?.messages) ?? []
        if (raw.length > 0) return this.sessionStore.convertHistory(raw)
        // RPC 返回空时,仅闲置 session fallback 到磁盘(生成中磁盘可能未持久化最新消息)
        const session = this.sessions.get(sessionId)
        if (session && !session.isGenerating) {
          console.warn(`[session-service] getHistory via RPC returned empty for idle session ${sessionId}, falling back to file read`)
          return await getHistoryFromFile(sessionId, this.sessionStore)
        }
        return []
      } catch (e) {
        console.warn(`[session-service] getHistory via RPC failed: ${toErrorMessage(e)}, falling back to file read`)
        return await getHistoryFromFile(sessionId, this.sessionStore)
      }
    }
    return await getHistoryFromFile(sessionId, this.sessionStore)
  }

  getSummary(sessionId: string): SessionSummary | undefined {
    const session = this.sessions.get(sessionId)
    return session ? this.toSummary(session) : undefined
  }

  getInputTokens(sessionId: string): number {
    return this.sessions.get(sessionId)?.inputTokens ?? 0
  }
  setInputTokens(sessionId: string, tokens: number): void {
    const s = this.sessions.get(sessionId)
    if (s && typeof tokens === 'number') s.inputTokens = tokens
  }

  /**
   * 处理 context.update（pi agent_end 推送 inputTokens）。session 级状态单一 owner：
   * 回写 inputTokens 缓存 + 算 usagePercent + 广播 context.update。index.ts onContextUpdate
   * 仅调本方法，不再自己算 usagePercent。
   *
   * context.update 与 switchModel 竞态（已踩过坑，原 index.ts onContextUpdate 注释保留）：
   * 此处回写 inputTokens 缓存是打通 context.update 与 switchModel 数据源的关键——
   * 使 switchModel 重算 usagePercent 时读到真实值而非恒 0（2026-07-01 inputTokens 竞态修复）。
   * 顺序保证：onContextUpdate 回写在先、switchModel 读取在后（缓存写入先于 switchModel 读）。
   */
  applyContextUpdate(sessionId: string, inputTokens: number): void {
    if (!inputTokens || inputTokens === 0) return
    const session = this.sessions.get(sessionId)
    if (!session) return
    // 回写缓存（打通数据源）
    session.inputTokens = inputTokens
    // 算 usagePercent + 广播
    const { usagePercent, contextLimit } = this.computeUsage(sessionId, session.modelId)
    this.broker.broadcast({
      type: 'context.update',
      id: `ctx_${Date.now()}`,
      payload: { sessionId, usagePercent, inputTokens, contextLimit },
    })
  }

  /** 取 session 当前 usagePercent（按缓存 inputTokens + 当前 modelId 的 contextWindow 算）。 */
  getUsagePercent(sessionId: string): number {
    const session = this.sessions.get(sessionId)
    if (!session) return 0
    return this.computeUsage(sessionId, session.modelId).usagePercent
  }

  async destroyAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.adapter.detach()
      if (session.unsubUsageListener) session.unsubUsageListener()
    }
    await this.pm.destroyAll()
    this.sessions.clear()
  }

  // ── ISessionServiceInternal:子模块经此访问 sessions / 共享 helper ──

  getSkillPaths(_cwd: string): string[] {
    return this.configStore.getSkillPaths().filter((p) => {
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
    return this.sessionStore.scanSessions().find(s => s.id === sessionId)
  }

  toSummary(s: IManagedSessionView): SessionSummary {
    const git = this.gitInfoReader.readGitInfo(s.cwd)
    return {
      id: s.id, label: s.label, cwd: s.cwd,
      gitBranch: git?.branch, gitIsWorktree: git?.isWorktree,
      status: s.isGenerating ? ('active' as SessionStatus) : ('idle' as SessionStatus),
      lastActiveAt: s.lastActiveAt, modelId: s.modelId,
      thinkingLevel: s.thinkingLevel, tokenCount: s.tokenCount,
      hidden: s.hidden,
    }
  }

  getSession(sessionId: string): IManagedSessionView | undefined { return this.sessions.get(sessionId) }
  removeSessionEntry(sessionId: string): void { this.sessions.delete(sessionId) }

  getSessionByClient(client: IPiEngine): IManagedSessionView | undefined {
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

  /** 初始化 ManagedSession:建 adapter、注册监听、入 Map、查 commands。 */
  async initializeManagedSession(
    id: string, client: IPiEngine, cwd: string, label: string, sessionFilePath?: string, hidden?: boolean,
  ): Promise<IManagedSessionView> {
    const send = (msg: ServerMessage) => this.broker.broadcast(msg)
    // #8 G1：传 cwd 给 EventAdapter（write added/modified 判定 + agent_end git 对账用）
    const adapter = this.adapterFactory(id, send, cwd)
    adapter.attach(client)
    const unsubUsage = this.attachUsageListener(id, client)
    const modelRef = this.configStore.getDefaultModel()
    const session: ManagedSession = {
      id, cwd, label,
      modelId: modelRef ? `${modelRef.provider}/${modelRef.modelId}` : '',
      createdAt: Date.now(), lastActiveAt: Date.now(),
      tokenCount: 0, inputTokens: 0, isGenerating: false,
      adapter, unsubUsageListener: unsubUsage, sessionFilePath,
      hidden,
    }
    this.sessions.set(id, session)
    await this.fetchAndBroadcastCommands(id)
    return session
  }

  // ── 私有协作者 ────────────────────────────────────────────────

  /**
   * usagePercent 计算的唯一实现（消除 model-service / index.ts 两处重复）。
   * 公式：contextWindow>0 ? Math.min(Math.round(inputTokens/contextWindow*100), 100) : 0。
   * 与原两处实现结果一致（验证见 model-service / index.ts 旧代码）。
   * contextLimit 同步返回（广播 payload 用），未配置 contextWindow 时为 0。
   */
  private computeUsage(sessionId: string, modelId: string): { usagePercent: number; contextLimit: number } {
    const inputTokens = this.getInputTokens(sessionId)
    const contextWindow = this.resolveContextWindow(modelId)
    const usagePercent = contextWindow > 0
      ? Math.min(Math.round((inputTokens / contextWindow) * MAX_PERCENT), MAX_PERCENT)
      : 0
    return { usagePercent, contextLimit: contextWindow }
  }

  /** 按 modelId（'provider/model' 形式）经 resolver 查 contextWindow；未注入 resolver 返回 0。 */
  private resolveContextWindow(modelId: string): number {
    if (!this.modelContextWindowResolver) return 0
    const sepIdx = modelId.indexOf('/')
    if (sepIdx < 0) return 0
    const provider = modelId.slice(0, sepIdx)
    const id = modelId.slice(sepIdx + 1)
    return this.modelContextWindowResolver(provider, id) ?? 0
  }

  /**
   * 广播 session.state_changed：切换模型后立即把新 modelId + 按新 contextWindow 重算的用量
   * + pi 当前 thinkingLevel 推给前端，无需等下一次 agent_end。（原 model-service.broadcastSessionState
   * 逻辑迁入，时序/竞态保护全部保留。）
   *
   * thinkingLevel 从 pi get_state 查询（而非依赖 thinking_level_changed 事件）：
   * pi 切模型时若新模型的 thinkingLevel 与当前相同则不 emit 事件，导致缓存恒为 undefined。
   * get_state 是可靠来源。
   */
  private async broadcastSessionState(sessionId: string, provider: string, modelId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return // session 不在活跃 Map（磁盘 session），无法重算
    const client = this.pm.getClient(sessionId)
    let thinkingLevel = session.thinkingLevel
    if (client) {
      try {
        const state = await readPiState(client)
        const level = state?.thinkingLevel as string | undefined
        if (level) {
          this.setThinkingLevelCache(sessionId, level)
          thinkingLevel = level
        }
      // eslint-disable-next-line taste/no-silent-catch -- get_state 失败不阻塞切换：thinkingLevel 回退到 summary 值
      } catch (e) {
        console.error('[session-service] get_state for thinkingLevel failed:', e)
      }
    }
    const inputTokens = this.getInputTokens(sessionId)
    const { usagePercent, contextLimit } = this.computeUsage(sessionId, `${provider}/${modelId}`)
    this.broker.broadcast({
      type: 'session.state_changed',
      id: `push_${Date.now()}`,
      payload: {
        sessionId,
        modelId: session.modelId,
        thinkingLevel,
        usagePercent,
        inputTokens,
        contextLimit,
      },
    })
  }

  /** Attach agent_end listener:track token usage + isGenerating。 */
  private attachUsageListener(id: string, client: IPiEngine): () => void {
    return client.onEvent((event) => {
      const e = event as Record<string, unknown>
      if (e.type === 'agent_end') {
        const s = this.sessions.get(id)
        if (!s) return
        s.isGenerating = false
        const payload = e.payload as Record<string, unknown> | undefined
        const usage = payload?.usage as
          { outputTokens?: number; inputTokens?: number; totalTokens?: number } | undefined
        if (usage) {
          s.tokenCount = (usage.totalTokens ?? usage.outputTokens ?? 0) as number
          // 缓存 inputTokens 供 switchModel 重算 usagePercent（无需等下一次 agent_end）
          if (typeof usage.inputTokens === 'number') s.inputTokens = usage.inputTokens
        }
      }
    })
  }

  /**
   * 查询 session 的扩展命令（pi getCommands）。纯查询，无副作用。
   * 用于 renderer 切 session 后主动拉取（修复 broadcast 与订阅时序竞争）。
   * @throws session 未激活或 pi getCommands 失败时抛（调用方 try-catch）
   */
  async getCommands(sessionId: string): Promise<Array<{ name: string; description?: string; source: string }>> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`session ${sessionId} not active`)
    return client.getCommands() as Promise<Array<{ name: string; description?: string; source: string }>>
  }

  /** Query pi extension commands 并广播。失败不阻塞 session。 */
  private async fetchAndBroadcastCommands(id: string): Promise<void> {
    try {
      const commands = await this.getCommands(id)
      console.log(`[session-service] getCommands returned ${commands.length} commands:`, commands.map(c => c.name))
      this.broker.broadcast({ type: 'session.commands', payload: { sessionId: id, commands } })
    // eslint-disable-next-line taste/no-silent-catch -- getCommands failure must not block session
    } catch (e) {
      console.warn('[session-service] getCommands failed:', e)
    }
  }

  /**
   * 查询 pi 当前上下文占用（get_session_stats.contextUsage），返回 context.update payload。
   * 用于 session 恢复后拉取用量——pi 从历史估算，重启后旧 session 也能显示当前占用。
   * 复用 context.update 契约（inputTokens/contextLimit/usagePercent）。
   * contextUsage.tokens=null（compaction 后未跑新 turn）或 session 未激活时返回 null。
   * @throws session 未激活或 pi rpc 失败时抛（调用方 try-catch）
   */
  async fetchContext(sessionId: string): Promise<{
    inputTokens: number; contextLimit: number; usagePercent: number
  } | null> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`session ${sessionId} not active`)
    const stats = await client.getSessionStats()
    const cu = stats.contextUsage
    if (!cu || cu.tokens == null) return null
    return {
      inputTokens: cu.tokens,
      contextLimit: cu.contextWindow,
      usagePercent: Math.round(cu.percent ?? 0),
    }
  }

  /**
   * 拉取上下文用量并广播 context.update（restoreSession 兜底用）。
   * 注意：此广播可能早于前端订阅新 sessionId 通道（时序竞争，见架构约定 #7），
   * 前端 useSidebar.selectSession 会主动调 session.getContext 再拉一次保证到达。
   * fire-and-forget 语义：失败不阻塞 session 恢复。
   */
  async fetchAndBroadcastContext(sessionId: string): Promise<void> {
    try {
      const payload = await this.fetchContext(sessionId)
      if (!payload) return
      this.broker.broadcast({
        type: 'context.update',
        id: `ctx_restore_${Date.now()}`,
        payload: { sessionId, ...payload },
      })
    // eslint-disable-next-line taste/no-silent-catch -- 兜底广播失败无影响（前端主动拉是主路径）
    } catch (e) {
      console.warn('[session-service] fetchAndBroadcastContext failed:', e)
    }
  }
}
