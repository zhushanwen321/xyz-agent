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
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionSummary, SessionGroup, SessionStatus, Message, ServerMessage, SubagentRecord, WorkflowRunRecord } from '@xyz-agent/shared'
// paths.ts 是 Node-only 模块，刻意不从 shared barrel 导出（见 shared/src/index.ts L32 注释），
// Node 端从子路径 import
import { getDataDir } from '@xyz-agent/shared/paths'
import type {
  ISessionService, IMessageBroker,
  IEventAdapter, IExtensionService, IConfigService,
} from '../../interfaces.js'
import type { ISessionServiceInternal } from './session-internal.js'
import type { IProcessManager, IPiEngine } from '../ports/pi-engine.js'
import { getHistoryFromFilePath, getHistoryTailFromFile } from '../session-history.js'
import { parseJsonl } from '../../utils/jsonl.js'
import { extractSubagentsFromSessionFile } from './subagent-extractor.js'
import { extractWorkflowsFromSessionFile } from './workflow-extractor.js'
import { parseSessionHeader } from '../../infra/pi/session-file-utils.js'
import { getSubagentSessionDir, getPiAgentDir } from '../../infra/pi/pi-paths.js'
import { isStrictlyUnder } from '../../utils/path-utils.js'
import type { IConfigStore } from '../ports/config.js'
import type { ISessionStore, SessionOutcome } from '../ports/session.js'
import type { IGitInfoReader } from '../ports/git-info.js'
import type { IManagedSessionView, ScannedSession, SendMessageHook } from './types.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import { SessionLifecycle } from './session-lifecycle.js'
import { MessageDispatcher } from './message-dispatcher.js'
import { SessionScanner } from './session-scanner.js'
import { toErrorMessage, isEnoent } from '../../utils/errors.js'
import { isPackaged, getExtensionFilePath } from '../../utils/runtime-env.js'

/** Facade 内部完整 session:子模块可见视图 + 运行时句柄(adapter)。 */
interface ManagedSession extends IManagedSessionView {
  adapter: IEventAdapter
}

/** 百分比上限（usagePercent 计算唯一常量，消除 model-service / index.ts 的重复）。 */
const MAX_PERCENT = 100

/**
 * fork 点 entryId 按 timestamp 匹配时的容差（W7）。
 *
 * 来源：前端 messageTimestamp 是 Unix ms（Date.now()），JSONL 中 pi 写入的 timestamp 是
 * ISO 字符串（new Date(...).getTime() 还原回 ms）。两者本应完全相等，但：
 *   - 早期实现/历史 session 的 timestamp 精度可能到秒（无毫秒位）；
 *   - 时钟在不同阶段读到的瞬时值可能差几毫秒；
 *   - 序列化舍入（JSONL 写入时 Date.toISOString 的毫秒舍入）。
 * 旧值 2ms 在历史 session（秒级精度）下会全部漏匹配 → fallback 到最后一条 entry，
 * 导致 fork 点错位（用户期望 fork 到第 N 条消息，实际 fork 到最后一条）。
 * 1000ms 容差让「同一秒内」的 entry 视为同一条——fork 点按 timestamp + role 唯一性已足够区分，
 * 同秒内两条相同 role 的 entry 概率极低，且 fallback warn 仍会触发（兜底可见）。
 */
const TIMESTAMP_TOLERANCE_MS = 1000

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
   * ConfigService 引用（组合根注入）。getReplaceSystemPrompt 委托用——
   * spawn pi 时透传用户配置的替换系统提示词。经 setter 注入而非构造参数，与
   * setModelContextWindowResolver 同模式，避免破坏 SessionService 的 18+ 测试调用点。
   * 未注入时 getReplaceSystemPrompt 返回 undefined（pi 走默认系统提示词）。
   */
  private configService: IConfigService | null = null
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

    // 进程崩溃清理:协调 adapter detach / Map 删 / 列表刷新 / session.exited 广播
    this.pm.onSessionExit((sessionId, code, stderr) => {
      const session = this.sessions.get(sessionId)
      if (!session) return
      session.adapter.detach()
      this.sessions.delete(sessionId)

      // 公共 session 崩溃：自动重建（landing 态命令源依赖它），不广播 error（对用户透明）
      const isPublic = sessionId === this.publicSessionId
      if (isPublic) {
        this.publicSessionId = undefined
        this.schedulePublicSessionRebuild()
        return
      }

      // W4：进程异常退出写 stopped 终态（在 sessions.delete 后，直接用已取的 session 对象，
      // 不走 persistSessionOutcome 的内部 get——delete 后 get 返回 undefined）
      if (session.sessionFilePath) {
        // W2-5/W8：已有任意终态（done/error/stopped）则不覆盖。
        // 正常 turn 完成时 handleTurnEndSideEffects 已写 'done'；随后 pi 进程正常退出触发本回调，
        // 此处若再写 'stopped' 会覆盖已写入的 'done'。进程退出是正常结束的副作用，非用户中止。
        // W8：abort 路径 dispatcher 已写 'stopped' + 原始 abort reason，随后进程退出触发本回调时，
        // 若再次用「Process exited (code: N)」覆盖，会丢失 dispatcher 写入的原始 abort reason——
        // 第一个终态优先（abort 是用户主动行为，reason 比 process exit 更具诊断价值）。
        const existingOutcome = this.sessionStore.extractSessionOutcome(session.sessionFilePath)
        if (existingOutcome !== 'done' && existingOutcome !== 'error' && existingOutcome !== 'stopped') {
          this.sessionStore.persistSessionEnd(
            session.sessionFilePath,
            'stopped',
            `Process exited (code: ${code})`,
          )
        }
      }

      // 构建人类可读的退出原因（含 stderr 尾部，诊断价值 > 敏感性风险，本地工具场景）
      const reason = stderr
        ? `Session process exited (code: ${code})\n\n${stderr}`
        : `Session process exited (code: ${code})`

      this.broker.broadcast({ type: 'config.sessions', payload: { groups: this.listPersistedSessions() } })
      // session.exited（独立事件，区别于 message.error 的「单次消息失败」语义）：
      // 前端据此标记 session dead 态 + 插入 error 消息 + toast 提示。
      this.broker.broadcast({ type: 'session.exited', payload: { sessionId, code, reason } })
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
   * 注入 ConfigService（组合根在所有服务构造后调用）。
   * getReplaceSystemPrompt 委托用——spawn pi 时透传用户配置的替换系统提示词。
   */
  setConfigService(configService: IConfigService): void {
    this.configService = configService
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
  async forkSession(
    srcSessionId: string,
    fromPiEntryId: string | undefined,
    includeFrom: boolean,
    label?: string,
    opts?: { fromMessageTimestamp?: number; fromMessageRole?: string },
  ): Promise<SessionSummary> {
    // piEntryId 缺失（RPC 路径读取的 session）时，读 JSONL 按 timestamp + role 匹配 entryId
    let resolvedEntryId = fromPiEntryId
    if (!resolvedEntryId) {
      resolvedEntryId = await this.resolveEntryIdByTimestamp(
        srcSessionId,
        opts?.fromMessageTimestamp,
        opts?.fromMessageRole,
      )
    }
    return this.lifecycle.forkSession(srcSessionId, resolvedEntryId, includeFrom, label)
  }

  /**
   * RPC 路径加载的 session 无 piEntryId，读 JSONL 按 timestamp + role 匹配 entryId。
   * [HISTORICAL] 2026-07-16：历史 session 通过 RPC 加载后 fork 报“缺少 piEntryId”。
   */
  private async resolveEntryIdByTimestamp(
    sessionId: string,
    messageTimestamp?: number,
    messageRole?: string,
  ): Promise<string> {
    const target = this.sessionStore.scanSessions().find((s) => s.id === sessionId)
    if (!target) throw new Error(`fork: source session not found for resolve: ${sessionId}`)
    // AGENTS.md 规则 #6：所有读取 session 文件必须处理「不存在」（scan 与读间竞态——
    // 文件可能已被外部删除：pi 异常退出未 flush / 用户手动清理）。模式对齐 getHistoryFromFilePath。
    let content: string
    try {
      content = await readFile(target.filePath, 'utf-8')
    } catch (e) {
      if (isEnoent(e)) {
        console.warn(`[session-service] resolveEntryIdByTimestamp: session file missing: ${target.filePath}`)
        throw new Error(`fork: source session file missing for resolve: ${target.filePath}`)
      }
      throw e
    }
    const entries = parseJsonl(content) as Array<Record<string, unknown>>
    // 只看 message 类型 entry（有 entry.id 和 entry.message.timestamp）
    const msgEntries = entries.filter((e) =>
      e.type === 'message'
      && typeof e.id === 'string'
      && e.message && typeof e.message === 'object'
    )
    if (msgEntries.length === 0) {
      throw new Error(`fork: source session has no message entries: ${target.filePath}`)
    }
    // 按 timestamp + role 匹配（JSONL timestamp 是 ISO 字符串，前端是 Unix ms）
    // ±TIMESTAMP_TOLERANCE_MS（模块顶层常量，W7）容差：历史 session 可能秒级精度，1000ms 容差兜底
    if (messageTimestamp != null) {
      for (const e of msgEntries) {
        const msg = e.message as Record<string, unknown>
        const entryTs = typeof msg.timestamp === 'string'
          ? new Date(msg.timestamp).getTime()
          : typeof e.timestamp === 'string'
            ? new Date(e.timestamp).getTime()
            : 0
        const roleMatch = !messageRole || msg.role === messageRole
        if (roleMatch && Math.abs(entryTs - messageTimestamp) <= TIMESTAMP_TOLERANCE_MS) {
          return e.id as string
        }
      }
    }
    // fallback：取最后一条 message entry（用户最可能 fork 到最近的消息）
    const last = msgEntries[msgEntries.length - 1]
    if (!last) throw new Error('msgEntries unexpectedly empty after length check')
    console.warn(`[session-service] resolveEntryIdByTimestamp: no timestamp match, falling back to last entry: ${last.id}`)
    return last.id as string
  }

  async sendMessage(sessionId: string, content: string): Promise<{ blocked: boolean; rejected?: boolean }> { return this.dispatcher.sendMessage(sessionId, content) }
  async sendSubagentMessage(sessionId: string, agent: string, task: string, content?: string): Promise<{ blocked: boolean; rejected?: boolean }> {
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
    if (!session) throw new Error('session not active')
    const newModelId = `${provider}/${modelId}`
    const client = this.pm.getClient(sessionId)
    if (!client) return sessionId // 无活跃 pi 进程：跳过缓存写和广播，不假装成功
    try {
      await client.setModel(provider, modelId)
    } catch (e) {
      console.error(`[session-service] switchModel RPC failed: sessionId=${sessionId}, model=${newModelId}`, e)
      throw e
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

  /**
   * 拉取 session 历史。
   * 优先 RPC（pi client.getHistory，返回全量不截断）；RPC 空/失败 fallback 文件尾读。
   * 返回 { messages, truncated }——truncated=true 表示文件尾读截断了早期 turn（N1）。
   */
  async getHistory(sessionId: string): Promise<{ messages: Message[]; truncated: boolean }> {
    const client = this.pm.getClient(sessionId)
    if (client) {
      try {
        const result = await client.getHistory() as { data?: { messages?: unknown[] } }
        const raw = result.data?.messages ?? []
        // RPC 路径返回全量历史（pi get_messages 不截断），truncated=false
        if (raw.length > 0) return { messages: this.sessionStore.convertHistory(raw), truncated: false }
        // RPC 返回空时,仅闲置 session fallback 到磁盘尾读
        const session = this.sessions.get(sessionId)
        if (session && !session.isGenerating) {
          console.warn(`[session-service] getHistory via RPC returned empty for idle session ${sessionId}, falling back to tail read`)
          return await getHistoryTailFromFile(sessionId, this.sessionStore)
        }
        return { messages: [], truncated: false }
      } catch (e) {
        console.warn(`[session-service] getHistory via RPC failed: ${toErrorMessage(e)}, falling back to tail read`)
        return await getHistoryTailFromFile(sessionId, this.sessionStore)
      }
    }
    // 无 RPC client（离线 session）：走尾读，避免大文件全量读
    return await getHistoryTailFromFile(sessionId, this.sessionStore)
  }

  /**
   * W4 H4：全量读取 session 历史（加载更多 fallback）。
   *
   * 与 getHistory 的区别：getHistory 优先走 RPC（pi client.getHistory），文件路径
   * fallback 走尾读（W1 tailReadHistory，只加载最近 20 turn）。本方法显式走全量
   * 文件读取（getHistoryFromFilePath），供前端「加载更多历史」按钮调用（FR-4）。
   */
  async getFullHistory(sessionId: string): Promise<Message[]> {
    const target = this.sessionStore.scanSessions().find((s) => s.id === sessionId)
    if (!target) return []
    return getHistoryFromFilePath(target.filePath, this.sessionStore)
  }

  async getSubagents(sessionId: string): Promise<SubagentRecord[]> {
    // 找主 session 文件路径（scanSessions 扫 pi/sessions/，含 cwd-encoded 子目录）
    const target = this.sessionStore.scanSessions().find((s) => s.id === sessionId)
    if (!target) return []
    return extractSubagentsFromSessionFile(target.filePath)
  }

  async getSubagentHistory(sessionId: string, subagentId: string): Promise<Message[]> {
    // 先从主 session 提取 subagent 列表，找到 sessionFile 路径
    const subagents = await this.getSubagents(sessionId)
    const record = subagents.find((s) => s.subagentId === subagentId)
    if (!record?.sessionFile) return []

    // 路径穿越校验：sessionFile 必须严格落在 piAgentDir 下（~/.xyz-agent/pi/agent/）。
    // record.sessionFile 由 subagent-extractor 从 JSONL 文本提取，不可信——攻击者构造的
    // session JSONL 可塞入任意路径（如 /etc/passwd），不校验直接读会泄露任意文件内容。
    if (!isStrictlyUnder(getPiAgentDir(), record.sessionFile)) return []

    // 直读 subagent JSONL，复用 getHistoryFromFilePath 转换链路（parseJsonl + filter + convertHistory）。
    // subagent JSONL 格式与主 session 一致（pi SessionManager._persist 写入）。
    return getHistoryFromFilePath(record.sessionFile, this.sessionStore)
  }

  /**
   * 获取 session 派生的 workflow 列表（从主 session JSONL 的 workflow-state-link 提取）。
   * 纯磁盘读取，不依赖 pi 进程活跃。文件不存在或无 workflow 调用时返回空数组。
   */
  async getWorkflows(sessionId: string): Promise<WorkflowRunRecord[]> {
    const target = this.sessionStore.scanSessions().find((s) => s.id === sessionId)
    if (!target) return []
    return extractWorkflowsFromSessionFile(target.filePath)
  }

  /**
   * 获取 workflow 内 agent call 的对话流历史。
   *
   * agentCallSessionId 是 trace[].sessionId（pi session ID，uuidv7）。
   * agent call 的 JSONL 落在 getSubagentSessionDir(mainCwd) 下
   * （~/.xyz-agent/pi/agent/subagents/<encodedCwd>/sessions/<ISO>_<sessionId>.jsonl），
   * **不在**主 session 的 sessions 目录。scanPiSessions 只扫主 sessions 目录，
   * 所以不能用 getHistoryFromFile（它经 scanSessions 查找），需在此直接按 sessionId 在
   * subagents 目录下查找文件。
   *
   * Fail-fast：agent call 有 trace 记录说明执行过，历史文件理应存在。
   * 找不到文件时 throw（而非静默返回空数组），让前端报错给用户而非显示空白。
   * 文件存在但解析为空（如 pi 延迟写入只有 session header）返回空数组（正常边界）。
   *
   * @throws 找不到主 session / 主 session 无 cwd / subagents 目录不存在 / 无匹配 sessionId 的文件
   */
  async getAgentCallHistory(sessionId: string, agentCallSessionId: string): Promise<Message[]> {
    const mainSession = this.sessionStore.scanSessions().find((s) => s.id === sessionId)
    if (!mainSession) {
      throw new Error(`主 session ${sessionId} 不存在，无法查找 agent call 历史`)
    }
    if (!mainSession.cwd) {
      throw new Error(`主 session ${sessionId} 无 cwd，无法推导 subagent session 目录`)
    }

    const filePath = findAgentCallFile(mainSession.cwd, agentCallSessionId)
    if (!filePath) {
      throw new Error(
        `未找到 agent call 的 session 文件（sessionId=${agentCallSessionId}）。` +
        `可能原因：agent call 执行失败未创建 session，或 session 文件尚未落盘。`,
      )
    }
    return getHistoryFromFilePath(filePath, this.sessionStore)
  }

  /**
   * 解析 agent call 对话流 JSONL 绝对路径（与 getAgentCallHistory 共用 findAgentCallFile）。
   *
   * 与 getAgentCallHistory 的区别：找不到时返回空串而非 throw——这是展示型功能
   *（PanelHeader overlay 文件名），找不到路径不应阻断 UI，前端 v-if 据空串隐藏按钮。
   */
  async getAgentCallFilePath(sessionId: string, agentCallSessionId: string): Promise<string> {
    const mainSession = this.sessionStore.scanSessions().find((s) => s.id === sessionId)
    if (!mainSession?.cwd) return ''
    return findAgentCallFile(mainSession.cwd, agentCallSessionId) ?? ''
  }

  /**
   * 触发 workflow 生命周期操作（pause/resume/abort）。
   * 经 client.prompt("/workflows <action> <runId>") 调扩展 slash command，
   * pi 检测 / 开头直接执行 command handler（不经 LLM）。
   * 扩展侧 RPC 分支已实现（commands.ts ctx.mode==='rpc'）。
   */
  async workflowAction(sessionId: string, action: 'pause' | 'resume' | 'abort', runId: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not active`)
    await client.prompt(`/workflows ${action} ${runId}`)
  }

  /**
   * 取消 running subagent（经扩展 slash command，不经 LLM）。
   * 对称 workflowAction 的转发模式：client.prompt("/subagents cancel <subagentId>")。
   * 扩展侧 RPC 分支已实现（subagents.ts ctx.mode==='rpc' → service.cancel → SIGTERM kill 子进程）。
   */
  async subagentAction(sessionId: string, action: 'cancel', subagentId: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not active`)
    await client.prompt(`/subagents ${action} ${subagentId}`)
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
   * 处理 context.update（pi agent_end/turn_end 推送 inputTokens + totalTokens）。session 级状态单一 owner：
   * 回写 inputTokens 缓存 + 写 tokenCount + 算 usagePercent + 广播 context.update。
   * index.ts onContextUpdate 仅调本方法，不再自己算 usagePercent。
   *
   * totalTokens（W3 迁移自 attachUsageListener）：写入 session.tokenCount。turn_end 与 agent_end
   * 双路径对称回写——SessionSummary.tokenCount 是 UI token 用量显示的数据源，不写则恒 0。
   *
   * context.update 与 switchModel 竞态（已踩过坑，原 index.ts onContextUpdate 注释保留）：
   * 此处回写 inputTokens 缓存是打通 context.update 与 switchModel 数据源的关键——
   * 使 switchModel 重算 usagePercent 时读到真实值而非恒 0（2026-07-01 inputTokens 竞态修复）。
   * 顺序保证：onContextUpdate 回写在先、switchModel 读取在后（缓存写入先于 switchModel 读）。
   */
  applyContextUpdate(sessionId: string, inputTokens: number, totalTokens?: number): void {
    if (!inputTokens || inputTokens === 0) return
    const session = this.sessions.get(sessionId)
    if (!session) return
    // 回写缓存（打通数据源）
    session.inputTokens = inputTokens
    // W3：tokenCount 写入（原 attachUsageListener 的 s.tokenCount = usage.totalTokens）
    if (typeof totalTokens === 'number') session.tokenCount = totalTokens
    // 算 usagePercent + 广播
    const { usagePercent, contextLimit } = this.computeUsage(sessionId, session.modelId)
    this.broker.broadcast({
      type: 'context.update',
      id: `ctx_${Date.now()}`,
      payload: { sessionId, usagePercent, inputTokens, contextLimit },
    })
  }

  /**
   * turn_end 单 turn 副作用（W3 迁移自 attachUsageListener turn_end 分支）。
   *
   * 承载 tryPersistLabel 主路径——「首 turn 即持久化」时序保证：
   * 第一个 turn_end 时 pi 已完成该轮 flush（session 文件已存在），此时 append session_info 安全。
   * 不等 agent_end（后者要等所有工具调用轮次跑完，中途关 app 仍会丢 label）。
   *
   * tryPersistLabel 经此方法间接暴露（不直接 public）：封装 existsSync guard（规则 #6，
   * 禁止在 pi flush 前创建文件 → EEXIST → session 卡死）。
   */
  handleTurnUsageSideEffects(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.tryPersistLabel(session)
  }

  /**
   * agent_end 副作用（W3 迁移自 attachUsageListener agent_end 分支）。
   *
   * 承载三个副作用：
   *   1. 复位 isGenerating=false —— 不迁移则正常生成完成后 session 永远 isGenerating=true，
   *      下一条消息被 busy 拒绝（message-dispatcher preemptive reject），用户无法继续对话。
   *   2. tryPersistLabel 兜底 —— turn_end 时 pi flush 尚未完成（文件不存在）则在此补写。
   *   3. session_end 终态写入（W4，ADR 0036）—— 让 scanner 读到终态，前端无需预加载历史。
   *
   * @param stopReason pi agent_end 的 stopReason。
   *   outcome 映射：'error'→error，'aborted'→stopped，其余→done。
   *   aborted 走 stopped 与 message-dispatcher.abort 路径一致（abort 写 stopped 后若 pi 仍发
   *   agent_end{stopReason:'aborted'}，此处也写 stopped，两条 session_end 一致不冲突）。
   */
  handleTurnEndSideEffects(sessionId: string, stopReason?: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.isGenerating = false
    this.tryPersistLabel(session)
    // W4：写 session_end 终态。aborted→stopped（与 abort 路径一致），error→error，其余→done
    const outcome = stopReason === 'error' ? 'error'
      : stopReason === 'aborted' ? 'stopped'
        : 'done'
    this.persistSessionOutcome(sessionId, outcome)
  }

  /**
   * 写 session_end 终态 entry（W4，ADR 0036）。
   * 3 个终态点复用：正常完成（handleTurnEndSideEffects）/ abort（message-dispatcher）/ 进程崩溃（onSessionExit）。
   * sessionFilePath 不存在时静默跳过（首 turn 前崩溃 / pi 延迟写入窗口）。
   */
  persistSessionOutcome(sessionId: string, outcome: SessionOutcome, reason?: string): void {
    const session = this.sessions.get(sessionId)
    if (!session?.sessionFilePath) return
    this.sessionStore.persistSessionEnd(session.sessionFilePath, outcome, reason)
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

  /** 当前生效的替换系统提示词（委托 ConfigService.getReplaceSystemPrompt）。 */
  getReplaceSystemPrompt(): string | undefined {
    return this.configService?.getReplaceSystemPrompt()
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
      sessionFile: s.sessionFilePath,
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
    const modelRef = this.configStore.getDefaultModel()
    const session: ManagedSession = {
      id, cwd, label,
      modelId: modelRef ? `${modelRef.provider}/${modelRef.modelId}` : '',
      createdAt: Date.now(), lastActiveAt: Date.now(),
      tokenCount: 0, inputTokens: 0, isGenerating: false, isCompacting: false,
      adapter, sessionFilePath,
      hidden,
      labelPersisted: false,
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
        const state = await client.getState()
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

  /**
   * 首次将 label 持久化到 session JSONL 的 session_info 行。
   *
   * pi 自身 flush 不写 session_info（已验证：真实 session 文件 0 个 session_info 行），
   * 不持久化会导致重启后 label 丢失（extractSessionName 返回 null → fallback basename(cwd)）。
   *
   * [HISTORICAL] 禁止在 pi 首次 flush 前创建文件（openSync wx → EEXIST → session 卡死，规则 #6），
   * 故必须先 existsSync 确认文件已由 pi 创建，只走 persistSessionName 的 append 分支。
   * 文件尚不存在时跳过，不重置 labelPersisted，下次 turn_end/agent_end 会补写。
   */
  private tryPersistLabel(s: IManagedSessionView): void {
    if (s.labelPersisted || !s.sessionFilePath || !existsSync(s.sessionFilePath)) return
    this.sessionStore.persistSessionName(s.sessionFilePath, s.label, s.id, s.cwd)
    s.labelPersisted = true
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
    // pi 的 contextUsage 在 compact 后无新 turn 时返回 tokens=null（保守设计：
    // compact 前 last assistant usage 反映压缩前 context size，不可信；只有 compact 后
    // 产生新 assistant usage 才能算出真实 context 占用）。
    // 此时不应 fallback 到 tokens.total——那是 session 全生命周期的 token 累加
    // （含 cacheRead），远大于当前 context 占用，会显示荒谬的百分比（如 compact 后 978%）。
    // 正确行为：返回 null，前端不显示 ctx 用量，等用户发消息后 turn_end 刷成精确值。
    if (cu && cu.tokens != null) {
      // 回写 session.inputTokens 缓存：fetchContext 是 restoreSession / session.getContext RPC
      // 的共同落点。initializeManagedSession 把 inputTokens 初始化为 0，若不在此回写，
      // switchModel → broadcastSessionState 读缓存拿到 0 → 推 inputTokens=0 → 前端 ctx 按钮变「—」。
      // 与 applyContextUpdate（turn-end 路径）对称，两者是 inputTokens 缓存的全部写入点。
      this.setInputTokens(sessionId, cu.tokens)
      return {
        inputTokens: cu.tokens,
        contextLimit: cu.contextWindow,
        usagePercent: Math.round(cu.percent ?? 0),
      }
    }
    return null
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

/**
 * 在 subagent session 目录下按 sessionId 查找 agent call 的 JSONL 文件。
 *
 * agent call（workflow 内的子 agent 执行）JSONL 落在
 * getSubagentSessionDir(mainCwd) = <piAgentDir>/subagents/<encodedCwd>/sessions/ 下，
 * 文件名 <ISO>_<sessionId>.jsonl，首行是 {type:"session", id:"<sessionId>"}。
 * 按 sessionId 匹配首行 header.id（不从文件名解析——文件名 ISO 格式不稳定）。
 *
 * 目录不存在或无匹配文件返回 null。
 */
function findAgentCallFile(mainCwd: string, agentCallSessionId: string): string | null {
  let dir: string
  try {
    dir = getSubagentSessionDir(mainCwd)
  } catch {
    return null
  }
  if (!existsSync(dir)) return null

  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.endsWith('.finalized'))
  } catch {
    return null
  }

  for (const file of files) {
    const filePath = join(dir, file)
    const header = parseSessionHeader(filePath)
    if (header?.id === agentCallSessionId) return filePath
  }
  return null
}
