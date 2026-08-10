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
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, isAbsolute, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { expandHome, isStrictlyUnder } from '../../utils/path-utils.js'
import type { SessionSummary, SessionGroup, SessionStatus, Message, ServerMessage, SubagentRecord, WorkflowRunRecord, BatchDeleteResult, SegmentsMetadataFile, SegmentsMetadataEntry, ProviderId } from '@xyz-agent/shared'
import { BUILTIN_PRESET_IDS, IMAGE_LIMITS } from '@xyz-agent/shared'
// paths.ts 是 Node-only 模块，刻意不从 shared barrel 导出（见 shared/src/index.ts L32 注释），
// Node 端从子路径 import
import { getAttachmentsDir } from '@xyz-agent/shared/paths'
import type { PiSessionEntry } from '../../infra/pi/pi-protocol.js'
import type {
  ISessionService, IMessageBroker,
  IEventAdapter, IExtensionService, IConfigService,
} from '../../interfaces.js'
import type { ISessionServiceInternal } from './session-internal.js'
import type { IProcessManager, IPiEngine, PiCommandInfo } from '../ports/pi-engine.js'
import { getHistoryFromFilePath, getHistoryTailFromFile } from '../session-history.js'
import { parseJsonl } from '../../utils/jsonl.js'
import { extractSubagentsFromSessionFile } from './subagent-extractor.js'
import { extractWorkflowsFromSessionFile } from './workflow-extractor.js'
import { getSubagentSessionDir, getPiAgentDir } from '../../infra/pi/pi-paths.js'
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
import { detectBareWorkspaceCached } from '../worktree/workspace-detector.js'
import { PresetService, type PresetResolution } from '../preset-service.js'
// MessageBus（wave:runtime-wiring）：per-session 消息广播核心。setter 注入（同 setConfigService 模式），
// 未注入时所有 bus 调用 no-op（this.messageBus?.publish）。type-only import 避免运行时环
//（MessageBus 不反向依赖 SessionService）。
import type { MessageBus } from '../message-bus/message-bus.js'

/** Facade 内部完整 session:子模块可见视图 + 运行时句柄(adapter)。 */
interface ManagedSession extends IManagedSessionView {
  adapter: IEventAdapter
  /**
   * launch preset id 的内存态持有（W-RT-4，设计文档 §4.2）。
   *
   * session 活跃期间 .preset.json sidecar 可能因 pi 延迟写入未 flush 而无法写入
   *（persistPresetBinding 的 existsSync 守卫跳过），此时内存态兜底持有 presetId，
   * 供 forkSession 在 active 期读源 session preset（W-RT-5）。
   *
   * 不放 IManagedSessionView（types.ts 非 slice 范围）：session-lifecycle 经
   * svc.getSession(id) 拿到 ManagedSession 实例后，as 转换读写此字段（patch 模式，
   * 见 lifecycle W-RT-4/5 实现注释）。toSummary 一并透传到 SessionSummary.launchPresetId。
   */
  launchPresetId?: string
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
   * PresetService 引用（组合根注入）。getLaunchPresetOptions 委托用——
   * spawn pi 时按用户选定的 launch preset 构建 extension/skill/tool args。
   * 经 setter 注入（同 setConfigService 模式），未注入时 getLaunchPresetOptions
   * 返回 undefined（调用方 session-lifecycle fallback 到现有 getExtensionPaths/getSkillPaths）。
   * 见 pi-launch-presets 设计文档 §8.1。
   */
  private presetService: PresetService | null = null
  /**
   * W5：message.complete 广播回调（组合根注入 ReloadOrchestrator.onMessageComplete）。
   * 经 setter 注入（同 setModelContextWindowResolver 模式），避免构造参数环
   * （orchestrator 依赖 sessionService，sessionService 不能反向依赖 orchestrator 具体类型）。
   * 未注入时 message.complete 广播无额外副作用（reload 编排不生效）。
   */
  private onMessageComplete: ((sessionId: string) => void) | null = null
  /**
   * R3：session 删除回调（组合根注入 ReloadOrchestrator.clearPending）。
   * 主动 delete（lifecycle.delete）和进程异常退出（onSessionExit）均经 removeSessionEntry
   * 汇聚触发，清掉 pendingReload 残留（running session 入队后被删，永不发 message.complete）。
   */
  private onSessionDelete: ((sessionId: string) => void) | null = null
  /**
   * MessageBus 引用（组合根注入，wave:runtime-wiring）。
   *
   * session 级消息（带 sessionId payload）走 bus.publish（per-session 单调 seq + ring buffer +
   * 订阅者广播），全局消息（无 sessionId）仍走 broker.broadcast 盲广播。过渡期双写
   * （R1 mitigation：bus.publish + broker.broadcast 都发，移除 bandaids wave 后评估删除
   * broker.broadcast 的 session 级路径）。session 销毁时调 bus.clearSession 彻底清理
   * （removeSessionEntry 触发，所有删除路径汇聚处）。
   *
   * 经 setter 注入（同 setConfigService/setPresetService/setOnMessageComplete 模式），
   * 避免破坏 SessionService 的 25+ 测试构造调用点。未注入时所有 bus 调用 no-op（this.messageBus?.*）。
   */
  private messageBus: MessageBus | null = null
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
    messageBus?: MessageBus,
  ) {
    // 打包模式:extension 在 Resources 根;开发模式:在 repo root(apps/electron/ 父目录)
    this.extensionPath = getExtensionFilePath(this.projectRoot, isPackaged())

    // 子模块注入 this(Facade 半构造时仅存引用,其方法在 Facade 完全构造后才被调用)
    this.lifecycle = new SessionLifecycle(this, this.pm, this.configStore, this.sessionStore, this.workspaceService)
    this.dispatcher = new MessageDispatcher(this, this.pm, this.broker, this.workspaceService, messageBus)
    this.scanner = new SessionScanner(this, this.sessionStore, this.gitInfoReader)

    // 进程崩溃清理:协调 adapter detach / Map 删 / 列表刷新 / session.exited 广播
    this.pm.onSessionExit((sessionId, code, stderr) => {
      const session = this.sessions.get(sessionId)
      if (!session) return
      session.adapter.detach()
      // 注意：此处 session 是 delete 前缓存的引用，removeSessionEntry 后 Map 条目已删除
      // 统一经 removeSessionEntry（触发 onSessionDelete 清 pendingReload 等残留）
      this.removeSessionEntry(sessionId)

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
   * 注入 PresetService（组合根在所有服务构造后调用）。
   * getLaunchPresetOptions 委托用——spawn pi 时按 launch preset 构建 args。
   * 与 setConfigService 同模式（setter 注入，避免破坏现有测试构造点）。
   */
  setPresetService(presetService: PresetService): void {
    this.presetService = presetService
  }

  /** W5：注入 message.complete 回调（组合根绑 ReloadOrchestrator.onMessageComplete）。 */
  setOnMessageComplete(handler: (sessionId: string) => void): void {
    this.onMessageComplete = handler
  }

  /** R3：注入 session 删除回调（组合根绑 ReloadOrchestrator.clearPending）。 */
  setOnSessionDelete(handler: (sessionId: string) => void): void {
    this.onSessionDelete = handler
  }

  /**
   * 注入 MessageBus 单例（组合根在所有服务构造后调用，wave:runtime-wiring）。
   *
   * session 级消息（带 sessionId payload）经 send 回调 / fetchAndBroadcast* 双写走 bus.publish；
   * session 销毁时 removeSessionEntry 调 bus.clearSession。未注入时所有 bus 调用 no-op，
   * 与 setConfigService/setOnMessageComplete 同模式（nullable 注入，不破坏现有测试构造点）。
   */
  setMessageBus(bus: MessageBus): void {
    this.messageBus = bus
  }

  // ── ISessionService:纯委托(lifecycle / dispatcher / scanner)─────

  async create(cwd?: string, label?: string, options?: {
    hidden?: boolean
    presetId?: string
    /** Landing Model Chip 传入值，覆盖 preset.modelOverride（设计文档 §5.2 优先级）。 */
    modelOverride?: string
    /** Landing Thinking Chip 传入值，覆盖 preset.thinkingLevel（设计文档 §5.2 优先级）。 */
    thinkingOverride?: string
  }): Promise<SessionSummary> { return this.lifecycle.create(cwd, label, options) }
  async delete(sessionId: string): Promise<void> { return this.lifecycle.delete(sessionId) }
  async deleteByCwd(cwd: string): Promise<BatchDeleteResult> { return this.lifecycle.deleteByCwd(cwd) }
  async renameSession(sessionId: string, newName: string): Promise<void> { return this.lifecycle.renameSession(sessionId, newName) }
  async restoreSession(sessionId: string): Promise<SessionSummary> { return this.lifecycle.restoreSession(sessionId) }
  async forkSession(
    srcSessionId: string,
    fromPiEntryId: string | undefined,
    includeFrom: boolean,
    label?: string,
    opts?: {
      fromMessageTimestamp?: number
      fromMessageRole?: string
      /** Staging Mode（ADR-0056）：composer 暂存的模型覆盖，优先于源 preset.modelOverride。 */
      modelOverride?: string
      /** Staging Mode（ADR-0056）：composer 暂存的思考等级覆盖，优先于源 preset.thinkingLevel。 */
      thinkingOverride?: string
    },
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
    // override 透传给 lifecycle.forkSession（而非 resolveEntryIdByTimestamp——override 与 entry 解析无关，
    // 仅作用于新 session 的 pi 启动参数）。
    return this.lifecycle.forkSession(srcSessionId, resolvedEntryId, includeFrom, label, {
      modelOverride: opts?.modelOverride,
      thinkingOverride: opts?.thinkingOverride,
    })
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

  async sendMessage(sessionId: string, content: string, images?: Array<{ data: string; mimeType: string }>): Promise<{ blocked: boolean; rejected?: boolean }> { return this.dispatcher.sendMessage(sessionId, content, images) }
  async sendSubagentMessage(sessionId: string, agent: string, task: string, content?: string): Promise<{ blocked: boolean; rejected?: boolean }> {
    return this.dispatcher.sendSubagentMessage(sessionId, agent, task, content)
  }
  async abort(sessionId: string): Promise<void> { return this.dispatcher.abort(sessionId) }
  async sendBash(sessionId: string, command: string, excludeFromContext?: boolean): Promise<{ blocked: boolean; rejected?: boolean }> {
    return this.dispatcher.sendBash(sessionId, command, excludeFromContext)
  }
  async abortBash(sessionId: string): Promise<void> { return this.dispatcher.abortBash(sessionId) }
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
  async switchModel(sessionId: string, provider: ProviderId, modelId: string): Promise<string> {
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

  /** 活跃 session id 列表（含公共 session，供 SkillRegistry 计算 skill 变更广播范围）。 */
  getActiveSessionIds(): string[] {
    return Array.from(this.sessions.keys())
  }

  /** 取 session cwd（未激活/不存在返回 undefined，供 SkillRegistry 按项目 skill 变更定位受影响 session）。 */
  getSessionCwd(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd
  }

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
   *
   * 优先走 pi get_entries RPC + entry 树重建（rebuildHistoryFromEntries）：从完整 entry 树
   * （含 message + custom entry）重建 Message[]，按 clientUuid ↔ userEntryId 映射回填
   * 结构化 Segment[]（image/file/skill badge，读 segments.json sidecar）。
   *
   * 与原 get_messages 路径的区别：get_messages 只返回扁平 message 列表，无 custom entry，
   * 无法回填 badge（降级为占位文本）。get_entries 含 custom entry，可精确还原 badge。
   *
   * 降级链：get_entries 空/失败 → fallback 文件尾读（getHistoryTailFromFile）。
   * 返回 { messages, truncated }——truncated=true 表示文件尾读截断了早期 turn（N1）。
   */
  async getHistory(sessionId: string): Promise<{ messages: Message[]; truncated: boolean }> {
    const client = this.pm.getClient(sessionId)
    if (client) {
      try {
        const result = await client.getEntries() as { data?: { entries?: PiSessionEntry[]; leafId?: string | null } }
        // leafId 是 session 当前叶子 entry id（branch 后指向新叶子）。当前 getHistory 全量拉取不消费它，
        // 保留供未来增量拉取（getEntries(since=leafId)）或 branch 历史完整性判断用。
        const entries = result.data?.entries ?? []
        if (entries.length > 0) {
          // 读 segments.json sidecar（runtime 直接读文件，不经 IPC——IPC 是 renderer→main，runtime 是独立进程）。
          // 文件缺失/损坏 → null（rebuildHistoryFromEntries 全降级为占位文本，非硬错误）。
          const segmentsMetadata = await readSegmentsMetadataFile(sessionId)
          const rebuilt = this.sessionStore.rebuildHistoryFromEntries(entries, segmentsMetadata)
          // entry 树重建返回全量历史（get_entries 不截断），truncated=false
          return { messages: rebuilt.messages, truncated: false }
        }
        // entries 空 → 仅闲置 session fallback 到磁盘尾读
        const session = this.sessions.get(sessionId)
        if (session && !session.isGenerating) {
          console.warn(`[session-service] getHistory via getEntries returned empty for idle session ${sessionId}, falling back to tail read`)
          return await getHistoryTailFromFile(sessionId, this.sessionStore)
        }
        return { messages: [], truncated: false }
      } catch (e) {
        console.warn(`[session-service] getHistory via getEntries failed: ${toErrorMessage(e)}, falling back to tail read`)
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

    const filePath = findAgentCallFile(mainSession.cwd, agentCallSessionId, this.sessionStore)
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
    return findAgentCallFile(mainSession.cwd, agentCallSessionId, this.sessionStore) ?? ''
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

  /**
   * W5：session 是否处于可 reload 的空闲态（进程存活且非生成中）。
   * 供 ReloadOrchestrator 判断 skill 变更时是立即 reload 还是排队。
   */
  isSessionIdle(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    return !!session && !session.isGenerating
  }

  /**
   * W5：session 是否仍存活（sessions Map 含此 id，进程未退出 / 未被 delete）。
   * 供 ReloadOrchestrator 检测排队期 session 删除，避免对已死 session 发 reload。
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /**
   * W5：向 session 发 `/__xyz_reload__` 触发 pi reload（重扫 skill + 重建 runtime）。
   * 对称 workflowAction 的转发模式：直接 client.prompt 绕过 dispatcher busy 预检 / hook，
   * 专用于 internal reload action（builtin extension 注册，不经 LLM）。client 不存在或
   * prompt 抛错向上抛，由 ReloadOrchestrator 降级 catch（best-effort，不阻塞）。
   */
  async promptReload(sessionId: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not active`)
    await client.prompt('/__xyz_reload__')
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
   *   3. session_end 终态写入（W4，ADR 0042）—— 让 scanner 读到终态，前端无需预加载历史。
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
   * 写 session_end 终态 entry（W4，ADR 0042）。
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

  getSkillPaths(cwd: string): string[] {
    // FR-1（cw-2026-07-21-scan-project-agents-skills）：相对路径按 session cwd resolve 成绝对路径再 existsSync filter。
    // 修复现状 bug：原 getSkillPaths(_cwd) 忽略 cwd，discovery.json 中的相对路径（如 .agents/skills）
    // 按 runtime 进程 cwd（app.getAppPath/resourcesPath）解析 → 在该 cwd 下不存在被 filter 掉 →
    // pi 启动 --skill 参数为空 → pi 加载不到项目 skill。
    // resolve 基准是 session cwd（用户当前项目），返回绝对路径避免 pi 侧再次错位。
    //
    // R1（review fix）：~/xxx 家目录前缀先 expandHome 展开（与 W2 loadSkills 对称）。
    // 否则 isAbsolute('~/...') false → resolve(cwd, '~/...') = <cwd>/~/... 错位 → filter 掉全局 skill。
    // discovery.json 实际配置 ~/.pi/agent/skills、~/.agents/skills 等带 ~ 前缀，必须展开。
    const normalize = (p: string): string => {
      const expanded = expandHome(p)
      return isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
    }
    return this.configStore.getSkillPaths().filter((p) => {
      const resolved = normalize(p)
      if (existsSync(resolved)) {
        return true
      }
      console.warn(`[session-service] skill path not found, skipping: ${p} (resolved: ${resolved})`)
      return false
    }).map(normalize)
  }

  async getExtensionPaths(cwd?: string): Promise<string[]> {
    try {
      return await this.extensionService.getExtensionPaths(cwd)
    } catch (e) {
      console.warn('[session-service] getExtensionPaths failed:', e)
      return []
    }
  }

  /** 当前生效的替换系统提示词（委托 ConfigService.getReplaceSystemPrompt）。 */
  getReplaceSystemPrompt(): string | undefined {
    return this.configService?.getReplaceSystemPrompt()
  }

  /**
   * 按 launch presetId 解析 pi 启动参数（委托 PresetService.resolve）。
   *
   * 供 session-lifecycle 的 create/restoreSession/forkSession 调用（runtime-lifecycle-integration slice）。
   * 返回 undefined 仅当 presetService 未注入（组合根未构造，理论上不会发生）。
   *
   * 找不到指定 preset 时 fallback 到 builtin:full（设计文档 §4.3 runtime 锁定）：
   * preset 被删 / 历史 session 的 presetId 失效时，用全工具模式兜底而非放弃 preset 解析。
   * builtin:full 永在（DEFAULT_PRESETS 保证），故理论上不会二次 fallback 失败。
   *
   * 设计文档 §8.1 + §4.3：session-lifecycle 拿到 PresetResolution 后覆盖现有
   * getExtensionPaths/getSkillPaths 结果，并追加 toolArgs/flags 到 pi args。
   */
  async getLaunchPresetOptions(presetId: string, cwd: string): Promise<PresetResolution | undefined> {
    if (!this.presetService) return undefined
    let preset = this.presetService.getPreset(presetId)
    if (!preset) {
      // 找不到 preset 时 fallback 到 builtin:full（设计文档 §4.3）。
      // 避免返回 undefined 让 session-lifecycle 退到无 tool/thinking args 的旧行为。
      preset = this.presetService.getPreset(BUILTIN_PRESET_IDS.FULL)
      if (!preset) return undefined  // 理论上不会发生（builtin 永在）
    }
    return this.presetService.resolve(preset, cwd)
  }

  findScannedSession(sessionId: string): ScannedSession | undefined {
    return this.sessionStore.scanSessions().find(s => s.id === sessionId)
  }

  toSummary(s: IManagedSessionView): SessionSummary {
    const git = this.gitInfoReader.readGitInfo(s.cwd)
    return {
      id: s.id, label: s.label, cwd: s.cwd,
      gitBranch: git?.branch, gitIsWorktree: git?.isWorktree,
      // R1：复用 WorkspaceDetector 检测 .bare workspace（带缓存），填 isBareWorkspace
      // 供前端 Landing.vue 派生「新建 worktree」动作项显隐。
      isBareWorkspace: detectBareWorkspaceCached(s.cwd),
      status: s.isGenerating ? ('active' as SessionStatus) : ('idle' as SessionStatus),
      lastActiveAt: s.lastActiveAt, modelId: s.modelId,
      thinkingLevel: s.thinkingLevel, tokenCount: s.tokenCount,
      hidden: s.hidden,
      parentSession: s.parentSession,
      forkEntryId: s.forkEntryId,
      handedOffTo: s.handedOffTo,
      sessionFile: s.sessionFilePath,
      // W-RT-4/§4.2：active session 的 launchPresetId 透传到 summary（内存态与 sidecar 并列）。
      // ManagedSession 实例携带此字段；普通 IManagedSessionView 无此字段时为 undefined（安全）。
      launchPresetId: (s as ManagedSession).launchPresetId,
    }
  }

  getSession(sessionId: string): IManagedSessionView | undefined { return this.sessions.get(sessionId) }

  /**
   * M3：标记源 session 已交接给新 session。
   *
   * 把 handedOffTo 的写入（内存 + 磁盘 handoff_marker）收归 SessionService（拥有 sessions Map
   * 与 sessionFilePath），避免 handoff-service 直接改内部对象（srcSession.handedOffTo = newId）
   * 绕过所有权——getSession 未来若返回防御性副本会让外部直接写入静默失效。
   *
   * 仅处理 active session（sessions Map 命中）：内存写 handedOffTo（toSummary 透传到
   * SessionSummary，活跃态立即生效不等 scanner 重扫）+ 磁盘写 handoff_marker（scanner
   * 读后填 SessionSummary.handedOffTo，前端跳转/标记用）。
   *
   * handoff 编排保证源 session 在交接时仍 active（由前端触发跳转前 pi turn 已结束、进程未退出），
   * 故非 active 路径（已被删 / 纯 RPC）按 no-op 处理。若未来需支持非 active 源 session 交接，
   * 此处应通过 findScannedSession(srcSessionId)?.filePath 解析路径后补写磁盘。
   */
  markHandedOff(srcSessionId: string, newSessionId: string): void {
    const session = this.sessions.get(srcSessionId)
    if (session) {
      session.handedOffTo = newSessionId
    }
    if (session?.sessionFilePath) {
      this.sessionStore.persistHandedOff(session.sessionFilePath, newSessionId)
    }
  }
  removeSessionEntry(sessionId: string): void {
    this.sessions.delete(sessionId)
    // R3：所有删除路径（lifecycle.delete 主动删 + onSessionExit 进程异常退）汇聚于此，
    // 触发 onSessionDelete 清 ReloadOrchestrator.pendingReload 残留。
    this.onSessionDelete?.(sessionId)
    // wave:runtime-wiring（GAP1 决策）：session 销毁时清理 MessageBus 的该 session 状态
    // （ring buffer + state snapshot + 订阅者集合 + 反查表）。幂等（ES1：session 不存在 no-op）。
    // 不在 pi flush / turn 结束时清理——ring 容量 1000 会自然 FIFO 淘汰旧 turn delta，
    // turn 边界清理是阶段 2 的精细化策略（届时评估）。
    this.messageBus?.clearSession(sessionId)
  }

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
    parentSession?: string, forkEntryId?: string, modelOverride?: string,
  ): Promise<IManagedSessionView> {
    const send = (msg: ServerMessage) => {
      // wave:runtime-wiring：session 级消息（payload 带 sessionId）双写走 bus.publish。
      // bus 负责 per-session 单调 seq 分配 + ring buffer 缓存 + 广播给订阅该 session 的 ws；
      // broker.broadcast 盲广播保留（R1 双写过渡：未迁移到 subscribe 的 renderer 仍能收到）。
      // 判断依据：payload 是否含 sessionId 字段（全局消息如 config.sessions 无 sessionId 不走 bus）。
      // remove-bandaids wave 后评估是否删除 broker.broadcast 的 session 级路径。
      const sid = (msg.payload as { sessionId?: string } | null)?.sessionId
      if (sid) {
        this.messageBus?.publish(sid, msg)
      }
      this.broker.broadcast(msg)
      // W5：message.complete 广播后通知 reload-orchestrator（消费 pendingReload 队）。
      // 覆盖所有 message.complete 路径（event-interpreter turn-end 主路径 + dispatcher abort
      // 手动广播）。onMessageComplete 未注入时为 no-op。
      if (msg.type === 'message.complete' && sid) {
        this.onMessageComplete?.(sid)
      }
    }
    // #8 G1：传 cwd 给 EventAdapter（write added/modified 判定 + agent_end git 对账用）
    const adapter = this.adapterFactory(id, send, cwd)
    adapter.attach(client)
    // Staging Mode（ADR-0056）：modelOverride 优先写入 session 元数据，让前端 composer chip
    // 正确显示用户选定的模型（create/fork/handoff 路径透传 effectiveModel）。pi 进程的模型
    // 已由 createSession 时 client options.model 设定，此处只补齐元数据层缺口。
    // 无 override 时 fallback 全局默认（与原行为一致）。
    const defaultModelRef = this.configStore.getDefaultModel()
    const fallbackModelId = defaultModelRef ? `${defaultModelRef.provider}/${defaultModelRef.modelId}` : ''
    const session: ManagedSession = {
      id, cwd, label,
      modelId: modelOverride ?? fallbackModelId,
      createdAt: Date.now(), lastActiveAt: Date.now(),
      tokenCount: 0, inputTokens: 0, isGenerating: false, isCompacting: false, isBashRunning: false, bashRunToken: undefined,
      adapter, sessionFilePath,
      hidden,
      parentSession,
      forkEntryId,
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
  private async broadcastSessionState(sessionId: string, provider: ProviderId, modelId: string): Promise<void> {
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
    // wave:runtime-wiring：session.state_changed 是 session 级状态，双写走 bus + broker。
    //（state_changed 不在 bus stateTypeKey 占位映射表，仅进 streamRing 不进 stateSnapshot——
    // 完整映射在后续 wave 扩展，本 wave 不动占位实现，GAP3 决策。）
    const stateMsg: ServerMessage = {
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
    }
    this.messageBus?.publish(sessionId, stateMsg)
    this.broker.broadcast(stateMsg)
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
  async getCommands(sessionId: string): Promise<PiCommandInfo[]> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`session ${sessionId} not active`)
    return client.getCommands()
  }

  /** Query pi extension commands 并广播。失败不阻塞 session。 */
  private async fetchAndBroadcastCommands(id: string): Promise<void> {
    try {
      const commands = await this.getCommands(id)
      console.log(`[session-service] getCommands returned ${commands.length} commands:`, commands.map(c => c.name))
      // wave:runtime-wiring：session.commands 是 session 级状态（state topic），双写走 bus
      //（bus stateSnapshot 用 'commands' typeKey 去重缓存，subscribe 时 reconcile）+ broker（过渡兼容）。
      const msg: ServerMessage = { type: 'session.commands', payload: { sessionId: id, commands } }
      this.messageBus?.publish(id, msg)
      this.broker.broadcast(msg)
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
      // wave:runtime-wiring：context.update 是 session 级状态（state topic），双写走 bus
      //（bus stateSnapshot 用 'context' typeKey 去重缓存）+ broker（过渡兼容）。
      const msg: ServerMessage = {
        type: 'context.update',
        id: `ctx_restore_${Date.now()}`,
        payload: { sessionId, ...payload },
      }
      this.messageBus?.publish(sessionId, msg)
      this.broker.broadcast(msg)
    // eslint-disable-next-line taste/no-silent-catch -- 兜底广播失败无影响（前端主动拉是主路径）
    } catch (e) {
      console.warn('[session-service] fetchAndBroadcastContext failed:', e)
    }
  }

  // ── wave:runtime-patch ipc-converge-a3 W2：业务持久化写（从 main privileged-handlers 原样搬，安全校验 TC3 零削弱）──
  /**
   * 写入粘贴截图（base64 → attachments 文件）。
   *
   * sessionId 非空 → <dataDir>/attachments/<sessionId>/（持久化，persisted=true）；
   * 空 → OS tmpdir（landing 降级，session 创建后需 migrateImage，persisted=false）。
   *
   * 安全校验（原样搬自 main privileged-handlers，TC3 零削弱）：
   * - mimeType 必须以 image/ 开头（防借道写任意文件）
   * - base64 解码后 <= IMAGE_LIMITS.SINGLE_MAX_BYTES（20MB，防超大输入撑爆内存/磁盘）
   * - name sanitize 剥离路径分隔符 + 控制字符（防目录穿越），uuid 前缀保证唯一性
   */
  async writeImage(
    sessionId: string,
    base64: string,
    mimeType: string,
    name: string,
  ): Promise<{ path: string; fileName: string; displayName: string; id: string; persisted: boolean }> {
    if (!mimeType.startsWith('image/')) {
      throw new Error('mimeType must start with image/')
    }
    // 解码前按 base64 长度估算解码字节数（3/4 比例），超 SINGLE_MAX_BYTES 拒绝。
    // eslint-disable-next-line no-magic-numbers
    const decodedBytes = Math.ceil((base64.length * 3) / 4)
    if (decodedBytes > IMAGE_LIMITS.SINGLE_MAX_BYTES) {
      // eslint-disable-next-line no-magic-numbers
      const sizeMB = Math.round(decodedBytes / 1024 / 1024)
      throw new Error(`图片过大（${sizeMB}MB），上限 20MB`)
    }
    const extByMime: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
    }
    const ext = extByMime[mimeType] ?? 'png'
    // sanitize name：剥离路径分隔符（/ \ :）和控制字符防目录穿越，trim 首尾空白。
    const extRegExp = new RegExp(`\\.${ext}$`, 'i')
    const sanitized = name.replace(/[/\\:\x00-\x1f]/g, '').trim().replace(extRegExp, '') || 'image'
    try {
      const dir = sessionId ? getAttachmentsDir(sessionId) : tmpdir()
      if (sessionId) mkdirSync(dir, { recursive: true })
      const filename = `${randomUUID()}-${sanitized}.${ext}`
      const fullPath = join(dir, filename)
      writeFileSync(fullPath, Buffer.from(base64, 'base64'))
      const isPlaceholder = sanitized === 'image'
      const displayName = isPlaceholder
        ? `截图-${formatTimestamp()}.${ext}`
        : `${sanitized}.${ext}`
      return { path: fullPath, fileName: filename, displayName, id: randomUUID(), persisted: !!sessionId }
    } catch (err) {
      console.error('[session-service] writeImage failed:', err)
      throw new Error('write-session-image failed')
    }
  }

  /**
   * 迁移 landing 态 tmpdir 图片到 attachments 持久化目录。
   *
   * 安全校验（原样搬自 main，TC3 零削弱）：
   * - sessionId 非空 + fromPath 存在
   * - fileName sanitize 剥离路径分隔符 + 控制字符（防逃逸 attachments 目录）
   * - fromPath 白名单：只允许从 OS tmpdir 或目标 session attachments 目录迁移（防 XSS move 敏感文件外泄）
   *   复用 runtime isStrictlyUnder（比 main isUnderPrefix 多一道 !isAbsolute 跨盘符防线，R1 增强非削弱）
   */
  async migrateImage(
    fromPath: string,
    sessionId: string,
    fileName: string,
  ): Promise<{ path: string }> {
    if (!sessionId) throw new Error('migrate-session-image requires non-empty sessionId')
    if (!existsSync(fromPath)) {
      throw new Error(`source file not found: ${fromPath}`)
    }
    try {
      // getAttachmentsDir 内已校验 sessionId 字符集（防路径穿越）
      const dir = getAttachmentsDir(sessionId)
      mkdirSync(dir, { recursive: true })
      const sanitized = fileName.replace(/[/\\:\x00-\x1f]/g, '').trim() || 'image'
      const newPath = join(dir, sanitized)
      // fromPath 白名单：只允许从 OS tmpdir 或目标 session attachments 迁移。
      const allowedSources = [tmpdir(), dir]
      const resolvedFrom = resolve(fromPath)
      if (!allowedSources.some((prefix) => isStrictlyUnder(prefix, resolvedFrom))) {
        throw new Error(`migrate-session-image fromPath outside allowed sources: ${fromPath}`)
      }
      renameSync(fromPath, newPath)
      return { path: newPath }
    } catch (err) {
      console.error('[session-service] migrateImage failed:', err)
      throw new Error('migrate-session-image failed')
    }
  }

  /**
   * 追加/覆盖一条 segments 元数据到 sidecar（segments.json）。
   *
   * 同 clientUuid 重发（editAndResend）→ 后者覆盖前者（按 clientUuid 去重）。
   * atomic 写（tmp + rename），Windows EPERM/ENOTEMPTY 兜底 unlink+retry（原样搬自 main，TC3 零削弱）。
   */
  async writeSegmentsMetadata(sessionId: string, entry: SegmentsMetadataEntry): Promise<void> {
    if (!sessionId) throw new Error('write-segments-metadata requires non-empty sessionId')
    try {
      const dir = getAttachmentsDir(sessionId)
      mkdirSync(dir, { recursive: true })
      const filePath = join(dir, 'segments.json')
      // 读已有（文件不存在 → 空；损坏 → 重置，best-effort 不阻断写入）
      let file: SegmentsMetadataFile = { version: 1, entries: [] }
      if (existsSync(filePath)) {
        try {
          const raw = readFileSync(filePath, 'utf-8')
          const parsed = JSON.parse(raw) as SegmentsMetadataFile
          if (parsed && Array.isArray(parsed.entries)) file = parsed
          // eslint-disable-next-line taste/no-silent-catch -- segments.json 损坏时 best-effort 重置为空（不阻断写入），与 main 原实现语义一致
        } catch {
          console.warn('[session-service] segments.json malformed, resetting:', filePath)
        }
      }
      // 按 clientUuid 去重：同 uuid 覆盖，新 uuid 追加
      const idx = file.entries.findIndex((e) => e.clientUuid === entry.clientUuid)
      if (idx >= 0) file.entries[idx] = entry
      else file.entries.push(entry)
      // atomic 写：临时文件 + rename。POSIX 同文件系统 rename 原子；
      // Windows 目标已存在时 renameSync 抛 EPERM/ENOTEMPTY → unlink 后重试。
      const JSON_INDENT = 2
      const tmpPath = filePath + '.tmp'
      writeFileSync(tmpPath, JSON.stringify(file, null, JSON_INDENT), 'utf-8')
      try {
        renameSync(tmpPath, filePath)
      } catch {
        // eslint-disable-next-line taste/no-silent-catch -- 目标不存在属预期（首次写入）；非 enoent 也无法恢复（后续 rename 会抛）
        try { unlinkSync(filePath) } catch { /* 目标不存在，忽略 */ }
        try {
          renameSync(tmpPath, filePath)
        } catch (retryErr) {
          // eslint-disable-next-line taste/no-silent-catch -- tmpPath 可能已被 rename 消费（并发竞争）；retryErr 才是要抛的真错误
          try { unlinkSync(tmpPath) } catch { /* tmpPath 可能已被 rename 消费，忽略 */ }
          throw retryErr
        }
      }
    } catch (err) {
      console.error('[session-service] writeSegmentsMetadata failed:', err)
      throw new Error('write-segments-metadata failed')
    }
  }
}

/** 生成 YYYYMMDD-HHMM 时间戳（displayName 用，本地时区；原样搬自 main privileged-handlers） */
function formatTimestamp(): string {
  const d = new Date()
  const PAD_WIDTH = 2
  const JANUARY_OFFSET = 1
  const pad = (n: number) => String(n).padStart(PAD_WIDTH, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + JANUARY_OFFSET)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

/**
 * 读 segments.json sidecar（runtime 直接读文件，不经 IPC）。
 *
 * IPC 的 writeSegmentsMetadata / readSegmentsMetadata 是 renderer→main 通道，runtime 是独立 Node 进程
 * （不持 electron app 句柄），不能走 IPC。runtime 直接读 <dataDir>/attachments/<sessionId>/segments.json。
 *
 * 文件缺失/损坏（JSON parse 失败 / entries 非数组）→ 返回 null（rebuildHistoryFromEntries 据此
 * 全降级为占位文本，非硬错误）。异步读：与周围 getEntries RPC / readFile 一致，sidecar 是小文件
 * （每条 user message 一条 entry）但统一走异步避免事件循环阻塞。
 */
async function readSegmentsMetadataFile(sessionId: string): Promise<SegmentsMetadataFile | null> {
  try {
    const filePath = join(getAttachmentsDir(sessionId), 'segments.json')
    if (!existsSync(filePath)) return null
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as SegmentsMetadataFile
    if (!parsed || !Array.isArray(parsed.entries)) return null
    return parsed
  } catch {
    return null
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
function findAgentCallFile(mainCwd: string, agentCallSessionId: string, sessionStore: ISessionStore): string | null {
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
    const header = sessionStore.parseSessionHeader(filePath)
    if (header?.id === agentCallSessionId) return filePath
  }
  return null
}
