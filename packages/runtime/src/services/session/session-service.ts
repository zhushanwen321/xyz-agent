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
import { BUILTIN_PRESET_IDS, IMAGE_LIMITS, SUBAGENT_RECORD_CUSTOM_TYPE, WORKFLOW_RECORD_CUSTOM_TYPE } from '@xyz-agent/shared'
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
import { quarantineCorruptFile } from '../../utils/json-store.js'
import { extractSubagentsFromSessionFile, scanSubagentEntries } from './subagent-extractor.js'
import { extractWorkflowsFromSessionFile, scanWorkflowEntries } from './workflow-extractor.js'
import { getSubagentSessionDir, getPiAgentDir } from '../../infra/pi/pi-paths.js'
import { applyOrphanToolResults } from '../../infra/pi/message-converter.js'
import type { IConfigStore } from '../ports/config.js'
import type { ISessionStore, SessionOutcome } from '../ports/session.js'
import type { IGitInfoReader } from '../ports/git-info.js'
import type { IManagedSessionView, ScannedSession, SendMessageHook } from './types.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import { SessionLifecycle } from './session-lifecycle.js'
import { MessageDispatcher } from './message-dispatcher.js'
import { SessionScanner } from './session-scanner.js'
import { ReplicatedState } from './replicated-state.js'
import {
  createLabelStateConfig,
  createThinkingLevelStateConfig,
  createModelIdStateConfig,
  createUsageStateConfig,
  createQueueDepthStateConfig,
  createCommandsStateConfig,
  type LabelSnapshot,
  type ThinkingLevelSnapshot,
  type ModelIdSnapshot,
  type UsageSnapshot,
  type QueueDepthSnapshot,
  type CommandsSnapshot,
  SCALAR_STATE_DEBOUNCE_MS,
} from './replicated-states.config.js'
import { HistoryRebuildCache, mergeIncrementalMessages } from './history-rebuild-cache.js'
import { toErrorMessage, isEnoent } from '../../utils/errors.js'
import { isPackaged, getExtensionFilePath } from '../../utils/runtime-env.js'
import { detectBareWorkspaceCached } from '../worktree/workspace-detector.js'
import { PresetService, type PresetResolution } from '../preset-service.js'
// MessageBus（wave:runtime-wiring）：per-session 消息广播核心。setter 注入（同 setConfigService 模式），
// 未注入时所有 bus 调用 no-op（this.messageBus?.publish）。type-only import 避免运行时环
//（MessageBus 不反向依赖 SessionService）。
import type { IMessageBus } from '../message-bus/message-bus.js'

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
  /**
   * 归属 project id 的内存态持有（D14 语义修正，2026-08-04）。
   *
   * 与 launchPresetId 同模式：.project.json sidecar 可能因 pi 延迟写入未 flush 而无法写入
   *（persistProjectBinding 的 existsSync 守卫跳过），内存态兑底持有 projectId，
   * 供 forkSession 继承 / toSummary 透传 / setProject 同步。
   */
  projectId?: string
}

/**
 * per-session ReplicatedState 实例组（W7 + W8 data-source-governance，六实例齐备）。
 *
 * label / thinkingLevel / modelId（W7）：快照唯一来源 get_state，失效源分别是
 * session_info_changed / thinking_level_changed / switchModel RPC 响应。
 * usage（W8 + W10 收编）：快照唯一来源 get_session_stats().contextUsage，失效源 = context
 * 相关事件 turn_end / agent_end / compaction（汇聚于 applyContextUpdate）+ restore 拉取
 * （fetchContext）+ switchModel RPC（contextWindow 随模型变化）。W10 起五写点全部收编：
 * inputTokens 的旧 session 缓存直写（applyContextUpdate / fetchContext 回写）已删，
 * usage 实例快照是唯一数据源（getInputTokens / tokenCount 派生 / switchModel
 * 重算全读快照），inputTokens 竞态从「时序约定」变「结构不可能」。
 * queue 深度（W8）：快照唯一来源 get_state().pendingMessageCount（深度权威 = pi，D6），
 * 失效源 = queue_update 翻译帧（send 汇聚点）。
 * commands（W8）：快照唯一来源 get_commands，失效源 = getCommands 全部调用路径
 * （激活发布 + renderer 主动查询，查询即失效）。
 * 事件与 RPC 响应永不直接写实例数据（只 markDirty）。session.label / thinkingLevel /
 * modelId 等会话字段缓存仍在双写过渡期（W12+ 收编），usage 双写已终结（W10）。
 */
interface SessionReplicatedStates {
  label: ReplicatedState<LabelSnapshot>
  thinkingLevel: ReplicatedState<ThinkingLevelSnapshot>
  modelId: ReplicatedState<ModelIdSnapshot>
  usage: ReplicatedState<UsageSnapshot>
  queue: ReplicatedState<QueueDepthSnapshot>
  commands: ReplicatedState<CommandsSnapshot>
}

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
 * W18：per-session record entry 派生缓存（subagent/workflow 列表的 runtime 侧 owner）。
 *
 * 三路径（父文档 §3.1 失效-重拉模式）：
 * - 初始态：cursor = null → 首次失效触发全量 get_entries 拉取，扫描结果整体建缓存。
 * - 增量：cursor 指向最后已拉 entryId → get_entries(since=cursor)，增量 entry 扫描结果
 *   merge 入派生 Map（自描述 entry 是完整快照，同 id 后到覆盖）。
 * - 失效自愈：游标指向的 entry 不在 pi 当前集合（"Entry not found"，session 文件被外部
 *   改写 / pi 重启）→ 丢 cursor 全量重拉重建（纯派生缓存可随时丢弃，正确性优先）。
 *
 * 数据写路径唯一 = refreshRecordEntries 的 entry 扫描（scanSubagentEntries /
 * scanWorkflowEntries，与冷启动磁盘路径同一份派生代码，D4）；发布经 messageBus
 * stateSnapshot（'subagents' / 'workflows' typeKey，W12 语义延续）。
 */
interface RecordEntriesCache {
  /** 最后已拉 entryId（增量游标）。null = 从未拉过（下次全量）。 */
  cursor: string | null
  /** subagent 派生缓存（subagentId → 最新快照记录）。 */
  subagents: Map<string, SubagentRecord>
  /** workflow 派生缓存（runId → 最新快照记录）。 */
  workflows: Map<string, WorkflowRunRecord>
  /** 防抖定时器（null = 未在等待）。 */
  debounceTimer: ReturnType<typeof setTimeout> | null
  /** in-flight 拉取 promise（并发失效共享一次拉取，消除重复 RPC）。 */
  inflight: Promise<void> | null
}

export class SessionService implements ISessionService, ISessionServiceInternal {
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly restoringSessions = new Set<string>()
  private extensionPath = ''
  private readonly lifecycle: SessionLifecycle
  private readonly dispatcher: MessageDispatcher
  private readonly scanner: SessionScanner
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
   * 经 setter 注入（同 setConfigService 模式），避免构造参数环
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
   * S3-W2：session 创建回调（PluginService 注入——session 事件注册表定向投递）。
   * 全部创建入口（lifecycle create/restoreSession/forkSession）经
   * notifySessionCreated 收敛触发。回调异常不外抛（创建主流程优先）。
   */
  private onSessionCreated: ((summary: SessionSummary) => void) | null = null
  /**
   * S3-W2：session 销毁回调（同上）。全部删除路径汇聚于 removeSessionEntry
   * （lifecycle.delete 主动删 / onSessionExit 进程退出 / restore 清场），触发点在彼处。
   *
   * D6a（integrity-hardening §3.6）：升级为回调列表。该槽原是单函数槽且已被
   * PluginService（didDestroy 投递）占用，挂起 UI 请求清理（server 的
   * extensionTimeoutMgr 汇聚清理）无处可挂——单槽语义下后注册者会覆盖前者。
   * 列表语义允许多方注册，既有注入方（PluginService）行为不变，逐个隔离异常。
   */
  private readonly onSessionDestroyedHandlers: Array<(summary: SessionSummary) => void> = []
  /**
   * MessageBus 引用（组合根注入，wave:runtime-wiring）。
   *
   * session 级消息（带 sessionId payload）单通道走 bus.publish（per-session 单调 seq +
   * ring buffer + 订阅者广播；wave:perf-w09 D1-2 删双写后唯一通道），全局消息（无 sessionId）
   * 仍走 broker.broadcast 盲广播。session 销毁时调 bus.clearSession 彻底清理
   * （removeSessionEntry 触发，所有删除路径汇聚处）。
   *
   * 经 setter 注入（同 setConfigService/setPresetService/setOnMessageComplete 模式），
   * 避免破坏 SessionService 的 25+ 测试构造调用点。未注入时所有 bus 调用 no-op（this.messageBus?.*）。
   */
  private messageBus: IMessageBus | null = null
  /**
   * wave:perf-w20（D6）：per-session 历史重建缓存 + lastLeafId（LRU 容量帽 8）。
   * getHistory 命中缓存时走 getEntries(since=lastLeafId) 增量；removeSessionEntry
   * （session 删除 + pi 进程退出汇聚点）清除。纯派生数据，可随时丢弃退化为全量重建。
   */
  private readonly historyCache = new HistoryRebuildCache()
  /**
   * W20 review Fix-5：per-session getHistory inflight 复用。并发 getHistory 共享同一
   * promise（GitStateService inflightSnapshot 同款模式），消除「后完成者的旧 delta 与
   * 先完成者的新缓存交错写回」竞态。finally 清理，无泄漏。
   */
  private readonly inflightGetHistory = new Map<string, Promise<{ messages: Message[]; truncated: boolean }>>()
  /**
   * W7/W8：per-session ReplicatedState 实例组（六实例：label / thinkingLevel / modelId /
   * usage / queue / commands）。Map 分区（ADR-0049）：注册点 initializeManagedSession
   * （create/restore/fork 三入口汇聚），销毁点 removeSessionEntry（主动删 + 进程退出汇聚，
   * dispose 停防抖/退避/周期兜底全部定时器）。
   */
  private readonly replicatedStates = new Map<string, SessionReplicatedStates>()
  /**
   * W18（data-source-governance P3.1）：per-session record entry 派生缓存——subagent /
   * workflow 列表的唯一 runtime 数据持有（entry 扫描结果纯派生，事件 payload 永不直写）。
   * 注册点 initializeManagedSession（与 replicatedStates 同汇聚），销毁点
   * removeSessionEntry（清防抖定时器）。
   */
  private readonly recordEntriesCaches = new Map<string, RecordEntriesCache>()
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
    messageBus?: IMessageBus,
  ) {
    // 打包模式:extension 在 Resources 根;开发模式:在 repo root(apps/electron/ 父目录)
    this.extensionPath = getExtensionFilePath(this.projectRoot, isPackaged())

    // 子模块注入 this(Facade 半构造时仅存引用,其方法在 Facade 完全构造后才被调用)
    this.lifecycle = new SessionLifecycle(this, this.pm, this.configStore, this.sessionStore, this.workspaceService)
    this.dispatcher = new MessageDispatcher(this, this.pm, this.workspaceService, messageBus)
    this.scanner = new SessionScanner(this, this.sessionStore, this.gitInfoReader)

    // 进程崩溃清理:协调 adapter detach / Map 删 / 列表刷新 / session.exited 广播
    this.pm.onSessionExit((sessionId, code, stderr) => {
      const session = this.sessions.get(sessionId)
      if (!session) return
      session.adapter.detach()

      // 构建人类可读的退出原因（含 stderr 尾部，诊断价值 > 敏感性风险，本地工具场景）
      const reason = stderr
        ? `Session process exited (code: ${code})\n\n${stderr}`
        : `Session process exited (code: ${code})`

      // wave:perf-w07（D1-1）：session.exited 补 bus publish（stream 类：分配 seq 入 ring）。
      // 顺序约束：必须在 removeSessionEntry 之前——它内部调 bus.clearSession 清订阅者集合，
      // clearSession 之后再 publish 等于送空集合，订阅 renderer 一条也收不到（进程退出标记
      // dead + toast 丢失）。wave:perf-w09（D1-2）：broadcast 腿已删，publish 是唯一通道
      //（renderer 全量订阅覆盖 list 内全部 session，见 useSessionStreamSync）。
      const exitedMsg: ServerMessage = { type: 'session.exited', payload: { sessionId, code, reason } }
      this.messageBus?.publish(sessionId, exitedMsg)

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

      this.broker.broadcast({ type: 'config.sessions', payload: { groups: this.listPersistedSessions() } })
      // session.exited（独立事件，区别于 message.error 的「单次消息失败」语义）：
      // 前端据此标记 session dead 态 + 插入 error 消息 + toast 提示。
      //（wave:perf-w09：exitedMsg 的 broadcast 腿已删——session 级单通道，上方 publish 唯一出口。）
    })
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

  /** S3-W2：注入 session 创建回调（PluginService 绑 session 事件注册表投递）。 */
  setOnSessionCreated(handler: (summary: SessionSummary) => void): void {
    this.onSessionCreated = handler
  }

  /**
   * S3-W2：注入 session 销毁回调（触发点 removeSessionEntry）。
   * D6a：追加式注册（非覆盖）——回调列表语义，PluginService 的 didDestroy 投递与
   * transport 层的挂起 UI 请求清理（server.ts setServices 注册）互不挤占。
   */
  setOnSessionDestroyed(handler: (summary: SessionSummary) => void): void {
    this.onSessionDestroyedHandlers.push(handler)
  }

  /**
   * 注入 MessageBus 单例（组合根在所有服务构造后调用，wave:runtime-wiring）。
   *
   * session 级消息（带 sessionId payload）单通道走 bus.publish（wave:perf-w09 D1-2 删双写后
   * 唯一通道）；session 销毁时 removeSessionEntry 调 bus.clearSession。未注入时所有 bus 调用
   * no-op，与 setConfigService/setOnMessageComplete 同模式（nullable 注入，不破坏现有测试构造点）。
   *
   * bus 有两条注入通道：①构造参数（index.ts 构造 SessionService 时传入，经构造器传导给
   * dispatcher）；②本 setter（后置注入）。走 ② 时 dispatcher 已在构造器中创建（持有旧 bus
   * 或 undefined），故此处必须同步回填 dispatcher.setMessageBus——否则 dispatcher 的全部
   * session 级发布静默 no-op（null-safe 但消息丢失）。组合根两条通道都走（幂等：回填同一
   * 引用无副作用）。
   */
  setMessageBus(bus: IMessageBus): void {
    this.messageBus = bus
    this.dispatcher.setMessageBus(bus)
  }

  // ── ISessionService:纯委托(lifecycle / dispatcher / scanner)─────

  async create(cwd?: string, label?: string, options?: {
    hidden?: boolean
    presetId?: string
    /** 归属 project id（D14 语义修正，2026-08-04）。 */
    projectId?: string
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
    // wave:perf-w26（微项 12 find 合并）：整个 fork handler 只扫一次磁盘。
    // 原链路 resolveEntryIdByTimestamp 与 lifecycle.forkSession 各自 scanSessions().find()
    // （同 handler 两次全量扫描），合并为 facade 单次解析后贯穿传递。
    // findScannedSession 内部 force：路径解析消费方（fork 源文件定位，正确性敏感，plan M-3）。
    const source = this.findScannedSession(srcSessionId)
    if (!source) throw new Error(`fork: source session not found: ${srcSessionId}`)
    // piEntryId 缺失（RPC 路径读取的 session）时，读 JSONL 按 timestamp + role 匹配 entryId
    let resolvedEntryId = fromPiEntryId
    if (!resolvedEntryId) {
      resolvedEntryId = await this.resolveEntryIdByTimestamp(
        source,
        opts?.fromMessageTimestamp,
        opts?.fromMessageRole,
      )
    }
    // override 透传给 lifecycle.forkSession（而非 resolveEntryIdByTimestamp——override 与 entry 解析无关，
    // 仅作用于新 session 的 pi 启动参数）；source 同传（find 合并，lifecycle 不再自扫）。
    return this.lifecycle.forkSession(srcSessionId, resolvedEntryId, includeFrom, label, {
      modelOverride: opts?.modelOverride,
      thinkingOverride: opts?.thinkingOverride,
      source,
    })
  }

  /**
   * RPC 路径加载的 session 无 piEntryId，读 JSONL 按 timestamp + role 匹配 entryId。
   * [HISTORICAL] 2026-07-16：历史 session 通过 RPC 加载后 fork 报“缺少 piEntryId”。
   *
   * wave:perf-w26（微项 12）：source 由调用方（forkSession）单次扫描解析后传入，
   * 本函数不再自扫（同 handler 的 scanSessions 合并为一次）。
   */
  private async resolveEntryIdByTimestamp(
    source: ScannedSession,
    messageTimestamp?: number,
    messageRole?: string,
  ): Promise<string> {
    // AGENTS.md 规则 #6：所有读取 session 文件必须处理「不存在」（scan 与读间竞态——
    // 文件可能已被外部删除：pi 异常退出未 flush / 用户手动清理）。模式对齐 getHistoryFromFilePath。
    let content: string
    try {
      content = await readFile(source.filePath, 'utf-8')
    } catch (e) {
      if (isEnoent(e)) {
        console.warn(`[session-service] resolveEntryIdByTimestamp: session file missing: ${source.filePath}`)
        throw new Error(`fork: source session file missing for resolve: ${source.filePath}`)
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
      throw new Error(`fork: source session has no message entries: ${source.filePath}`)
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
  /**
   * W1（fix-chat-flow-order 探针 ②）：run 级联结束（pi agent_settled，晚于 pi finally 的
   * bash 落盘 flush）→ dispatcher 按序发布 per-session bash 待落列（D2 双分支延迟的 flush 腿）。
   * 经 EventInterpreter.onAgentSettled 回调注入（组合根 index.ts）。
   */
  flushPendingBashResults(sessionId: string): void { this.dispatcher.flushPendingBashResults(sessionId) }
  async steerMessage(sessionId: string, content: string): Promise<void> { return this.dispatcher.steerMessage(sessionId, content) }
  async followUpMessage(sessionId: string, content: string): Promise<void> { return this.dispatcher.followUpMessage(sessionId, content) }
  async compact(sessionId: string, customInstructions?: string): Promise<void> { return this.dispatcher.compact(sessionId, customInstructions) }
  setSendMessageHook(hook: SendMessageHook): void { this.dispatcher.setSendMessageHook(hook) }
  listPersistedSessions(): SessionGroup[] { return this.scanner.listPersistedSessions() }

  // ── ISessionService:Facade 直接实现(查 sessions / 经 rpc,轻量)─────

  /**
   * session 级状态单一 owner：切换模型的 RPC + 缓存更新 + 失效。
   *
   * W12（data-source-governance P1.5）：广播职责归快照挂钩——markDirty modelId / usage /
   * thinkingLevel 三实例后，各自防抖重拉，快照应用后经挂钩发布 session.state_changed
   * （payload 全字段来自实例快照，见 publishStateChangedFromSnapshot）。旧 broadcastSessionState
   * 的「get_state 直读 thinkingLevel + resolver 窗口重算 + session.modelId 直写投影」中间层
   * 已删（plan W12 步骤 3）；UI 更新延迟 = 防抖窗口 + 快照 RPC（W7 行为级验收预算 1s 内）。
   *
   * 为什么除 config.defaults 外还要发 session.state_changed（原 model-service 注释保留）：
   * config.defaults 是全局默认（不带 sessionId），前端无法据它定位「哪个 session 换了模型」。
   * session.state_changed 带 sessionId，前端据它同步 Composer 工具条（模型显示 / 用量 / 思考强度）。
   *
   * W10 owner 结构：inputTokens 唯一数据源 = usage 实例快照（fetch get_session_stats 写入，
   * 事件只 markDirty）。本方法的失效与 context 事件失效任意顺序到达，防抖到点后快照收敛
   * pi 权威值（pi 侧 setModel 后 getContextUsage 天然按新模型窗口），结构自愈。
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
    // W7：switchModel RPC 成功响应 = modelId 实例的失效源（RPC 响应驱动，「事件只做失效」的
    // 补充合法形态，D7）。markDirty 防抖重拉 get_state，实例快照与 pi 权威值收敛（行为级
    // 验收：模型名 1s 内更新）。失败路径（上方 throw）不失效——pi 侧未生效，实例保持旧快照。
    this.replicatedStates.get(sessionId)?.modelId.markDirty()
    // W10：switchModel 重算失效 = usage 失效源（contextWindow 随模型变化——markDirty 重拉
    // get_session_stats 后快照持有 pi 侧按新模型窗口算出的权威值）。失败路径不失效（同上）。
    this.replicatedStates.get(sessionId)?.usage.markDirty()
    // W12：thinkingLevel 失效——pi 切模型时若新模型 thinkingLevel 与当前相同则不 emit 事件
    //（thinking_level_changed 覆盖不住），markDirty 重拉 get_state 刷新快照（旧实现靠
    // broadcastSessionState 内 get_state 直读，随该方法删除改经实例）。
    this.replicatedStates.get(sessionId)?.thinkingLevel.markDirty()
    session.modelId = newModelId
    return sessionId
  }

  /**
   * 设置思考档并返回 pi 生效值。
   *
   * P3（pi-assumption final gate）：pi 会钳制模型族不支持的档位（如 mimo 族 max →
   * high，clampThinkingLevel 就近回落），且钳制时不发事件不写 entry——reply 与内存
   * 缓存若用请求值，会把 UI 的 pending 确认与 session 缓存污染成未生效档位。生效值
   * 以 set 后 get_state 快照为准（标量状态唯一权威读路径，ADR-0062）。
   */
  async setThinkingLevel(sessionId: string, level: string): Promise<string> {
    const client = this.pm.getClient(sessionId)
    if (!client) {
      // 无活跃进程（理论不可达：调用方都在活跃 session 语境）——请求值兜底，行为同旧版
      const session = this.sessions.get(sessionId)
      if (session) session.thinkingLevel = level
      return level
    }
    await client.setThinkingLevel(level)
    const state = await client.getState()
    const effective = typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : level
    const session = this.sessions.get(sessionId)
    if (session) session.thinkingLevel = effective
    return effective
  }
  /**
   * 更新活跃 session 的 label（内存态）。
   *
   * 调用方：pi session_info_changed 事件到达时（pi extension auto-rename）。
   * 不持久化——pi 侧已写 session_info，此处只同步内存态。
   */
  setLabelCache(sessionId: string, label: string): void {
    const session = this.sessions.get(sessionId)
    if (session) session.label = label
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

  /**
   * W7/W8：per-session 实例组访问器。消费方：
   * - 组合根（index.ts）：interpreter 的失效回调延迟解析（markDirty）；
   * - session-service 自身（W8）：usage / queue / commands 失效接线（applyContextUpdate /
   *   send 汇聚点 / getCommands）；
   * - 测试：断言 switchModel 后 modelId 实例 markDirty、事件路径写点后 usage/queue/commands markDirty。
   * session 未注册（非活跃 / 已销毁）返回 undefined，调用方安全跳过。
   * 方法名沿用 W7 的 ScalarReplicatedStates 语义（index.ts 组合根接线稳定，六实例后为
   * 全量实例组访问器——结构扩展不破坏既有消费方）。
   */
  getScalarReplicatedStates(sessionId: string): SessionReplicatedStates | undefined {
    return this.replicatedStates.get(sessionId)
  }

  // ── W18：record entry 派生缓存（entry_appended 失效 → get_entries 增量重拉）──

  /**
   * W18：自描述 record entry 失效信号唯一入口（interpreter 经组合根注入；entry_appended
   * 主信号 + subagent/workflow 事件兜底信号都汇于此）。
   *
   * 只做失效（防抖调度 markDirty 等价），事件 payload 不进数据缓存。防抖窗口内多次失效
   * 合并为一次增量拉取（自描述 entry append 频率 = record 状态迁移频率，防抖削峰）。
   * session 未激活（无缓存条目）时 no-op——冷启动路径由 getSubagents/getWorkflows RPC
   * 的磁盘扫描承接。
   */
  invalidateRecordEntries(sessionId: string, customType: string): void {
    if (customType !== SUBAGENT_RECORD_CUSTOM_TYPE && customType !== WORKFLOW_RECORD_CUSTOM_TYPE) return
    const cache = this.recordEntriesCaches.get(sessionId)
    if (!cache) return
    if (cache.debounceTimer !== null) return // 已在防抖等待中：合并
    cache.debounceTimer = setTimeout(() => {
      cache.debounceTimer = null
      void this.refreshRecordEntries(sessionId)
    }, SCALAR_STATE_DEBOUNCE_MS)
  }

  /** 取/建 per-session record entry 派生缓存（initializeManagedSession 注册点调用）。 */
  private ensureRecordEntriesCache(sessionId: string): RecordEntriesCache {
    const existing = this.recordEntriesCaches.get(sessionId)
    if (existing) return existing
    const cache: RecordEntriesCache = {
      cursor: null,
      subagents: new Map(),
      workflows: new Map(),
      debounceTimer: null,
      inflight: null,
    }
    this.recordEntriesCaches.set(sessionId, cache)
    return cache
  }

  /**
   * W18：get_entries 拉取编排（cursor 三路径见 RecordEntriesCache 注释）。
   *
   * 拉取 → scanSubagentEntries / scanWorkflowEntries（与冷启动同一份派生代码）→ merge
   * 派生 Map → 有变化才发布（session.subagents 全量帧 / session.workflowUpdate 增量信号）。
   * 失败语义：Entry not found → 丢 cursor 就地重试一次全量自愈（两轮上限，防坏 pi 反复全量）；
   * 其他 RPC 错误 → warn 后保留 cursor（下次失效重试仍走增量），不发布（快照未变）。
   */
  private async refreshRecordEntries(sessionId: string): Promise<void> {
    const cache = this.recordEntriesCaches.get(sessionId)
    if (!cache) return
    if (cache.inflight) return cache.inflight // 并发失效共享一次拉取
    const run = async (): Promise<void> => {
      const client = this.pm.getClient(sessionId)
      if (!client) return // session 已死：缓存冻结（removeSessionEntry 会清），冷启动走磁盘路径
      // 两轮：第 1 轮按 cursor 增量；Entry not found 丢 cursor 后第 2 轮全量自愈
      const MAX_REFRESH_ROUNDS = 2
      for (let round = 0; round < MAX_REFRESH_ROUNDS; round++) {
        let entries: unknown[]
        let leafId: string | undefined
        try {
          if (cache.cursor !== null) {
            const inc = await client.getEntries(cache.cursor) as { data?: { entries?: PiSessionEntry[]; leafId?: string | null } }
            entries = inc.data?.entries ?? []
            leafId = inc.data?.leafId ?? undefined
          } else {
            const full = await client.getEntries() as { data?: { entries?: PiSessionEntry[]; leafId?: string | null } }
            entries = full.data?.entries ?? []
            leafId = full.data?.leafId ?? undefined
            // 全量重建：派生缓存整体重置（纯派生语义——全量扫描结果就是新基线）
            cache.subagents.clear()
            cache.workflows.clear()
          }
        } catch (e) {
          if (cache.cursor !== null && isEntryNotFoundError(e)) {
            // 游标失效自愈：since 指向的 entry 不在 pi 当前集合 → 丢 cursor 全量重拉重建
            console.warn(`[session-service] record entries incremental Entry-not-found for ${sessionId}, dropping cursor and full rebuild`)
            cache.cursor = null
            continue
          }
          // 其他错误（超时 / pi 内部错误）：不发布（快照未变），cursor 保留，下次失效重试仍走增量
          console.warn(`[session-service] refresh record entries via getEntries failed for ${sessionId}: ${toErrorMessage(e)}`)
          return
        }
        this.applyRecordEntries(cache, entries, sessionId)
        if (leafId !== undefined) cache.cursor = leafId
        return
      }
    }
    cache.inflight = run().finally(() => { cache.inflight = null })
    return cache.inflight
  }

  /**
   * 扫描结果 merge 入派生缓存 + 变化发布。
   *
   * - subagents：merge 后与发布基线（缓存内当前值）比对，有变化 publish session.subagents
   *   全量帧（payload = 派生缓存快照数组）。
   * - workflows：merge 时收集状态变化的 run（含新增），按扫描序逐个 publish
   *   session.workflowUpdate 增量信号——最后一条即 stateSnapshot 'workflows' last-value
   *   （话题 last-value 语义与 W12 一致）。
   */
  private applyRecordEntries(cache: RecordEntriesCache, entries: unknown[], sessionId: string): void {
    const subagents = scanSubagentEntries(entries)
    let subagentsChanged = false
    for (const record of subagents) {
      const prev = cache.subagents.get(record.subagentId)
      if (prev === undefined || !subagentRecordEquals(prev, record)) subagentsChanged = true
      cache.subagents.set(record.subagentId, record)
    }

    const workflows = scanWorkflowEntries(entries)
    const workflowUpdates: Array<{ runId: string; status: string; reason?: string }> = []
    for (const record of workflows) {
      const prev = cache.workflows.get(record.runId)
      if (prev === undefined || prev.status !== record.status || prev.reason !== record.reason) {
        workflowUpdates.push({ runId: record.runId, status: record.status, reason: record.reason })
      }
      cache.workflows.set(record.runId, record)
    }

    if (!this.sessions.has(sessionId)) return // session 已销毁：不 publish（防 bus 重建已 clearSession 的 entry）
    if (subagentsChanged) {
      this.messageBus?.publish(sessionId, {
        type: 'session.subagents',
        payload: { sessionId, subagents: Array.from(cache.subagents.values()) },
      })
    }
    for (const update of workflowUpdates) {
      this.messageBus?.publish(sessionId, {
        type: 'session.workflowUpdate',
        payload: { sessionId, update },
      })
    }
  }

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
   * 拉取 session 历史（wave:perf-w20 D6：重建缓存 + lastLeafId 增量）。
   *
   * 优先走 pi get_entries RPC + entry 树重建（rebuildHistoryFromEntries）：从完整 entry 树
   * （含 message + custom entry）重建 Message[]，按 clientUuid ↔ userEntryId 映射回填
   * 结构化 Segment[]（image/file/skill badge，读 segments.json sidecar）。
   *
   * 三分支（04-history-incremental.md §3.3）：
   * 1. 缓存命中 → getEntries(since=lastLeafId) 增量。空增量 = leafId 未变 = 缓存新鲜，
   *    直接返回缓存（R-12 短路：不走尾读 fallback）。pi 侧成本 = findIndex + 空/小窗口序列化，
   *    全量 entry 树序列化（主要卡顿源）被消除。
   * 2. 增量非空 → parentId 不变量校验（W20 review Fix-2：delta 首条 entry.parentId 必须等于
   *    缓存 leafId，branch 后不成立 → 丢缓存全量重建，防静默混合历史）→ 重建增量窗口 +
   *    piEntryId 去重合并入缓存（D6-3）+ 孤儿 toolResult 回填（W20 review Fix-1：窗口以
   *    toolResult 开头时配对失败的输出按 toolCallId 回填到缓存 assistant 的 toolCall）。
   * 3. 无缓存（首次进入 / LRU 驱逐重进 / "Entry not found" fallback / parentId 不变量 violation）
   *    → 全量重建 + 写缓存。
   *
   * 并发（W20 review Fix-5）：per-session inflight 复用，同 session 并发调用共享同一 promise。
   *
   * 错误处理（D6-4）：
   * - 增量报 "Entry not found"（pi 实测文案，E 大写 not 小写）→ 丢缓存 → 全量重拉。
   *   触发面：缓存跨 pi 进程存活且 session 文件被外部改写（D6-1 的 removeSessionEntry
   *   清理已结构性消除常态触发，此为防御兜底）。
   * - 其他错误（超时/pi 内部错误）→ 与现状同链降级（尾读），缓存不动（下次重试仍走 since）。
   *
   * R-12：pi RPC 成功但 entries 为空 → 短路返回空列表。pi 的 get_entries 是活跃 session
   * 的权威视图（内存 fileEntries，restore 时从文件加载），空就是空；尾读会给出与 RPC
   * 视图不一致的文件尾部（最多 20 turn），两次 getHistory 结果闪变。
   *
   * 返回 { messages, truncated }——truncated=true 仅出现在尾读降级路径（N1）。
   *
   * 返回值契约（终审 minor）：messages 是缓存/重建结果的**浅拷贝**（数组级隔离，调用方可
   * 安全就地变更）；Message 元素引用与缓存共享，仍受只读契约约束（深层拷贝在数百条消息
   * 量级下成本不可接受，元素级污染面仅限「调用方 mutate message 对象自身」）。
   */
  async getHistory(sessionId: string): Promise<{ messages: Message[]; truncated: boolean }> {
    // W20 review Fix-5：并发 getHistory 复用同一 inflight promise（同 session 共享一次
    // RPC + 重建 + 缓存写回），消除「后完成者的旧 delta 写回旧基线 / 覆盖先完成者结果」竞态。
    const inflight = this.inflightGetHistory.get(sessionId)
    if (inflight) return inflight
    const promise = this.doGetHistory(sessionId).finally(() => this.inflightGetHistory.delete(sessionId))
    this.inflightGetHistory.set(sessionId, promise)
    return promise
  }

  private async doGetHistory(sessionId: string): Promise<{ messages: Message[]; truncated: boolean }> {
    const client = this.pm.getClient(sessionId)
    if (client) {
      // ── 分支 1/2：缓存命中 → since 增量 ──
      const cached = this.historyCache.get(sessionId)
      if (cached && cached.leafId !== null) {
        try {
          const inc = await client.getEntries(cached.leafId) as { data?: { entries?: PiSessionEntry[]; leafId?: string | null } }
          const incEntries = inc.data?.entries ?? []
          if (incEntries.length === 0) {
            // R-12 短路：空增量 = leafId 未变 = 缓存新鲜。零重建直接返回（不走尾读 fallback）。
            console.log(`[session-service] getHistory cache fresh (empty delta) for ${sessionId}, returning ${cached.messages.length} cached messages`)
            // 终审 minor：返回浅拷贝而非缓存引用——调用方就地 sort/splice/push 会打穿缓存
            // 基底（增量合并的正确性依赖缓存未被污染）。元素级引用仍共享（只读契约，
            // 与 scanPiSessions 浅拷贝注释同边界）。
            return { messages: cached.messages.slice(), truncated: cached.truncated }
          }
          // W20 review Fix-2：parentId 不变量检测。pi append-only 下 delta 首条 entry 的
          // parentId 恒等于缓存基线 leafId（上次响应的叶子即本次增量的父）；branch
          // （pi rpc-mode 把 navigateTree 暴露给 extension command context）后新分支首条
          // parentId 是 branch 点，pi **不报错**但直接合并会静默产出「老分支尾 + 新分支」
          // 的混合历史（D6-4 的 "Entry not found" fallback 只覆盖 entry 消失场景）。
          // 不满足不变量 → 丢缓存 fall-through 全量重建（正确性优先，代价一次全量）。
          if (incEntries[0].parentId !== cached.leafId) {
            console.warn(
              `[session-service] getHistory incremental parent-id invariant violated for ${sessionId}: ` +
              `delta head parent=${String(incEntries[0].parentId)} != cached leafId=${cached.leafId} (branch/rewrite?), dropping cache and full rebuild`,
            )
            this.historyCache.delete(sessionId)
          } else {
            const segmentsMetadata = await readSegmentsMetadataFile(sessionId)
            const rebuilt = this.sessionStore.rebuildHistoryFromEntries(incEntries, segmentsMetadata)
            const merged = mergeIncrementalMessages(cached.messages, rebuilt.messages)
            // W20 review Fix-1：增量窗口以 toolResult 开头（缓存 leafId 切在 assistant(toolCalls)
            // 与其 toolResults 之间——后台 session 生成中 getHistory 写缓存所致）时，convertPiHistory
            // 窗口局部配对失败的孤儿 toolResult 按 toolCallId 回填到缓存中 assistant 的 toolCall，
            // 工具输出不再静默丢失。
            if (rebuilt.orphanToolResults.length > 0) {
              applyOrphanToolResults(merged, rebuilt.orphanToolResults)
            }
            const newLeafId = inc.data?.leafId ?? null
            this.historyCache.set(sessionId, { leafId: newLeafId, messages: merged, truncated: false })
            console.log(`[session-service] getHistory incremental for ${sessionId}: ${incEntries.length} delta entries, merged ${cached.messages.length} -> ${merged.length} messages`)
            // merged 已写入缓存，返回浅拷贝与缓存本体分离（终审 minor，同上防御）
            return { messages: merged.slice(), truncated: false }
          }
        } catch (e) {
          if (isEntryNotFoundError(e)) {
            // D6-4 fallback：since 失效（缓存基线不在 pi 当前 entry 集合）→ 丢缓存 → 全量重拉
            console.warn(`[session-service] getHistory incremental Entry-not-found for ${sessionId}, dropping cache and full rebuild`)
            this.historyCache.delete(sessionId)
          } else {
            // 其他错误：现有降级链（尾读），缓存不动（下次重试仍走 since）
            console.warn(`[session-service] getHistory via getEntries(since) failed: ${toErrorMessage(e)}, falling back to tail read`)
            return await getHistoryTailFromFile(sessionId, this.sessionStore)
          }
        }
      }
      // ── 分支 3：全量重建（无缓存 / D6-4 fallback / Fix-2 parentId 不变量 violation 丢缓存后）──
      try {
        const result = await client.getEntries() as { data?: { entries?: PiSessionEntry[]; leafId?: string | null } }
        const entries = result.data?.entries ?? []
        if (entries.length > 0) {
          // 读 segments.json sidecar（runtime 直接读文件，不经 IPC——IPC 是 renderer→main，runtime 是独立进程）。
          // 文件缺失/损坏 → null（rebuildHistoryFromEntries 全降级为占位文本，非硬错误）。
          const segmentsMetadata = await readSegmentsMetadataFile(sessionId)
          const rebuilt = this.sessionStore.rebuildHistoryFromEntries(entries, segmentsMetadata)
          // leafId 是 session 当前叶子 entry id，记录为下次增量拉取的 since 基准（D6-1）。
          this.historyCache.set(sessionId, { leafId: result.data?.leafId ?? null, messages: rebuilt.messages, truncated: false })
          // entry 树重建返回全量历史（get_entries 不截断），truncated=false。
          // rebuilt.messages 已写入缓存，返回浅拷贝与缓存本体分离（终审 minor，同上防御）
          return { messages: rebuilt.messages.slice(), truncated: false }
        }
        // R-12：entries 空 → 短路返回空列表（pi RPC 是活跃 session 的权威视图，不走尾读）。
        return { messages: [], truncated: false }
      } catch (e) {
        console.warn(`[session-service] getHistory via getEntries failed: ${toErrorMessage(e)}, falling back to tail read`)
        return await getHistoryTailFromFile(sessionId, this.sessionStore)
      }
    }
    // 无 RPC client（离线 session）：走尾读，避免大文件全量读（不读不写缓存——文件路径无 leafId 概念）
    return await getHistoryTailFromFile(sessionId, this.sessionStore)
  }

  /**
   * W4 H4：全量读取 session 历史（加载更多 fallback）。
   *
   * 与 getHistory 的区别：getHistory 优先走 RPC（pi client.getEntries entry 树重建），文件路径
   * fallback 走尾读（W1 tailReadHistory，只加载最近 20 turn）。本方法显式走全量
   * 文件读取（getHistoryFromFilePath），供前端「加载更多历史」按钮调用（FR-4）。
   */
  async getFullHistory(sessionId: string): Promise<Message[]> {
    // wave:perf-w26（D9-1 消费方分层，plan M-3）：路径解析消费方 force 旁路 TTL——
    // 刚落盘 session 的「加载更多」在 TTL 窗口内也不静默返回空。
    const target = this.sessionStore.scanSessions({ force: true }).find((s) => s.id === sessionId)
    if (!target) return []
    return getHistoryFromFilePath(target.filePath, this.sessionStore)
  }

  async getSubagents(sessionId: string): Promise<SubagentRecord[]> {
    // 找主 session 文件路径（scanSessions 扫 pi/sessions/，含 cwd-encoded 子目录）。
    // wave:perf-w26（plan M-3）：路径解析消费方 force 旁路 TTL（刚落盘 session 的
    // subagent 面板在窗口内不静默返回空）。
    const target = this.sessionStore.scanSessions({ force: true }).find((s) => s.id === sessionId)
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
    // wave:perf-w26（plan M-3）：路径解析消费方 force 旁路 TTL（与 getSubagents 同理）。
    const target = this.sessionStore.scanSessions({ force: true }).find((s) => s.id === sessionId)
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
    // agent call 本质是 subagent（D4）：workflow trace[].sessionId 存的是 subagent record id
    //（sa-xxx），不是 pi session uuidv7。复用 getSubagentHistory 的 record 查找路径
    //（subagentId → 主 session JSONL 的 record.sessionFile），而非 _findAgentCallFile（按 header.id
    // 扫 subagents 目录，sa-xxx 永远不匹配 uuidv7 header）。找不到 record 返回 []（前端显空对话流）。
    return this.getSubagentHistory(sessionId, agentCallSessionId)
  }

  /**
   * 解析 agent call 对话流 JSONL 绝对路径（与 getAgentCallHistory 共用 _findAgentCallFile）。
   *
   * 与 getAgentCallHistory 的区别：找不到时返回空串而非 throw——这是展示型功能
   *（PanelHeader overlay 文件名），找不到路径不应阻断 UI，前端 v-if 据空串隐藏按钮。
   */
  async getAgentCallFilePath(sessionId: string, agentCallSessionId: string): Promise<string> {
    // 同 getAgentCallHistory：agent call 是 subagent，trace.sessionId 是 subagentId（sa-xxx），
    // 复用 record 查找（subagentId → record.sessionFile），不扫目录按 header.id 匹配。
    const subagents = await this.getSubagents(sessionId)
    const record = subagents.find((s) => s.subagentId === agentCallSessionId)
    if (!record?.sessionFile) return ''
    if (!isStrictlyUnder(getPiAgentDir(), record.sessionFile)) return ''
    return record.sessionFile
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

  /**
   * W10：inputTokens 读点唯一化——usage 实例快照派生（fetch get_session_stats 写入的唯一
   * 数据源）。旧 session.inputTokens 缓存直写（applyContextUpdate / fetchContext 回写，
   * 及已删除的外部 setter）已删，sessions Map 内字段退化为恒 0 的派生基线（types 必填
   * 字段，读点全部走本方法）。
   */
  getInputTokens(sessionId: string): number {
    return this.replicatedStates.get(sessionId)?.usage.get()?.inputTokens ?? 0
  }

  /**
   * 处理 context.update（pi agent_end/turn_end 推送 inputTokens + totalTokens）。session 级状态单一 owner。
   * index.ts onContextUpdate 仅调本方法。
   *
   * W12（data-source-governance P1.5）：事件只做失效——usage markDirty 后防抖重拉
   * get_session_stats，快照应用后经 fetchSessionStatsSnapshot 的挂钩发布 context.update
   * （payload 全字段来自 usage 实例快照），旧「事件即时值 + resolver 窗口重算再转发」的
   * 事件直写中间层已删（plan W12 步骤 3）。事件参数不再进任何 payload；发布延迟 =
   * 防抖窗口 + 快照 RPC（毫秒级），防抖到点收敛的 pi 权威 percent 与事件即时值同源同值
   * （event-adapter 翻译层同源直出，W10 论证），last-value 不因切换漂移。
   *
   * W10 owner 结构（五写点全部只做 usage 实例 markDirty，实例 fetch get_session_stats 是
   * 唯一数据写路径；tokenCount 派生见 toSummary 注释）：与 switchModel 的乱序竞态从结构上
   * 不可能——单一数据源 + 单一写入路径，两处失效任意顺序到达，防抖到点后快照收敛 pi
   * 权威值（结构自愈，见 switchModel 注释的 W10 段）。
   */
  applyContextUpdate(sessionId: string, _inputTokens: number, _totalTokens?: number): void {
    // usage 失效（事件只做失效——markDirty 置 dirty + 防抖重拉 get_session_stats 快照，
    // usage 实例唯一数据写路径）。0 值事件同样失效（与 W10 行为一致：失效在旧 0 值门控之前）。
    this.replicatedStates.get(sessionId)?.usage.markDirty()
  }

  /**
   * turn_end 单 turn 副作用（W3 迁移自 attachUsageListener turn_end 分支）。
   *
   * 承载 turn_end 时机的 project sidecar 兜底补写——第一个 turn_end 时 pi 已完成该轮
   * flush（session 文件已存在），existsSync 守卫通过。label 持久化已不在此承载
   *（W1 数据源治理：活跃 label 唯一写入口 = renameSession/create/fork 的 set_session_name RPC）。
   */
  handleTurnUsageSideEffects(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // D14 语义修正：turn_end 时 pi 已完成 flush（文件存在）→ 兜底补写归属 project sidecar
    //（create 时文件未落盘被 existsSync 守卫跳过，内存态 projectId 在此落盘）。
    this.tryPersistProjectBinding(session)
  }

  /**
   * agent_end 副作用（W3 迁移自 attachUsageListener agent_end 分支）。
   *
   * 承载三个副作用：
   *   1. 复位 isGenerating=false —— 不迁移则正常生成完成后 session 永远 isGenerating=true，
   *      下一条消息被 busy 拒绝（message-dispatcher preemptive reject），用户无法继续对话。
   *   2. project sidecar 兜底补写 —— turn_end 时仍未落盘则在此补写（label 持久化已不在此
   *      承载：W1 起活跃 label 唯一写入口 = set_session_name RPC）。
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
    // D14 语义修正：agent_end 兜底补写归属（turn_end 时仍未落盘则在此补写）。
    this.tryPersistProjectBinding(session)
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

  /**
   * W10：取 session 当前 usagePercent——usage 实例快照派生（pi 权威 percent 投影）。
   * 旧实现按「缓存 inputTokens + resolver 窗口」本地重算（computeUsage），W10 起快照
   * 已持有 pi 侧按当前模型窗口算出的权威 percent，读点直接派生；dirty 期间返回上次
   * 快照（核心不变量 2 的 UI 语义）。
   */
  getUsagePercent(sessionId: string): number {
    return this.replicatedStates.get(sessionId)?.usage.get()?.usagePercent ?? 0
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
    // wave:perf-w26（D9-1 消费方分层，plan M-3）：本方法的全部消费方（rename/delete/restore/
    // fork 的源文件解析、setProject 的 sidecar 写入）都是单 session 路径解析——统一 force
    // 旁路 TTL，刚落盘 session 在窗口内也能解析到。
    return this.sessionStore.scanSessions({ force: true }).find(s => s.id === sessionId)
  }

  /**
   * 手动归类（D14 语义修正，2026-08-04）：写 session 归属 project 到 `.project.json` sidecar。
   *
   * active session 同步内存态（toSummary 从内存透传，广播后 summary 立即携带新归属）；
   * 磁盘 session 经扫描拿 filePath 写 sidecar（scanner 下次扫描读到）。
   * 空 projectId = 归回默认项目（等价删除绑定，persistProjectBinding 空值守卫跳过）。
   * session 不存在/文件未落盘（延迟写入窗口）→ 静默跳过（不阻断归类流程，下次 create 兑底）。
   */
  async setProject(sessionId: string, projectId: string): Promise<void> {
    const active = this.sessions.get(sessionId) as (IManagedSessionView & { projectId?: string }) | undefined
    if (active) {
      active.projectId = projectId || undefined
      if (active.sessionFilePath) {
        this.sessionStore.persistProjectBinding(active.sessionFilePath, projectId)
      }
      return
    }
    const scanned = this.findScannedSession(sessionId)
    if (scanned?.filePath) {
      this.sessionStore.persistProjectBinding(scanned.filePath, projectId)
    }
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
      thinkingLevel: s.thinkingLevel,
      // W10：tokenCount 派生自 usage 实例快照（context 占用口径——事件链路三条路径的
      // totalTokens 与 inputTokens 同值直出，快照 inputTokens 保持同语义）。旧
      // session.tokenCount 直写（applyContextUpdate）已删，字段退化为恒 0 派生基线
      // （types 必填）；磁盘 session（非 active）无实例，fallback 字段值。
      tokenCount: this.replicatedStates.get(s.id)?.usage.get()?.inputTokens ?? s.tokenCount,
      hidden: s.hidden,
      parentSession: s.parentSession,
      forkEntryId: s.forkEntryId,
      handedOffTo: s.handedOffTo,
      sessionFile: s.sessionFilePath,
      // W-RT-4/§4.2：active session 的 launchPresetId 透传到 summary（内存态与 sidecar 并列）。
      // ManagedSession 实例携带此字段；普通 IManagedSessionView 无此字段时为 undefined（安全）。
      launchPresetId: (s as ManagedSession).launchPresetId,
      // D14 语义修正：归属 project 透传到 summary（内存态兑底，sidecar 扫描路径在 scanner）。
      projectId: (s as ManagedSession).projectId,
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
      this.sessionStore.persistHandoffSidecar(session.sessionFilePath, newSessionId)
    }
  }
  /**
   * S3-W2：session 创建通知（lifecycle 全部创建入口收敛点：create / restoreSession /
   * forkSession 三处 spawn 路径的 return 前调用）。触发 onSessionCreated →
   * PluginService session 事件注册表定向投递插件 didCreate。回调异常不外抛。
   */
  notifySessionCreated(summary: SessionSummary): void {
    try {
      this.onSessionCreated?.(summary)
    // eslint-disable-next-line taste/no-silent-catch -- best-effort 降级：插件 didCreate 投递异常不外抛（创建主流程优先），仅落日志供排查
    } catch (e: unknown) {
      console.error(`[session-service] onSessionCreated listener error (sessionId=${summary.id}):`, e)
    }
  }

  removeSessionEntry(sessionId: string): void {
    // S3-W2：删除前缓存 summary（插件 didDestroy 通知需要 SessionInfo；删除后 Map 查不到）。
    // Map 无条目（防御路径）时构造最小形状——id 之外的字段无从得知，宁发少知不发错。
    const session = this.sessions.get(sessionId)
    const destroyedSummary: SessionSummary = session
      ? this.toSummary(session)
      : { id: sessionId, label: sessionId, cwd: '', status: 'dead', lastActiveAt: 0, modelId: '', tokenCount: 0 }
    this.sessions.delete(sessionId)
    // R3：所有删除路径（lifecycle.delete 主动删 + onSessionExit 进程异常退）汇聚于此，
    // 触发 onSessionDelete 清 ReloadOrchestrator.pendingReload 残留。
    this.onSessionDelete?.(sessionId)
    // S3-W2 + D6a：同一汇聚点触发回调列表（插件 didDestroy 投递 + 挂起 UI 请求清理等）。
    // 逐个 try/catch 隔离：单 handler 异常不阻塞删除主流程，也不阻断列表内其余 handler。
    for (const handler of this.onSessionDestroyedHandlers) {
      try {
        handler(destroyedSummary)
      // eslint-disable-next-line taste/no-silent-catch -- best-effort 降级：销毁回调异常不外抛（删除主流程优先），仅落日志供排查
      } catch (e: unknown) {
        console.error(`[session-service] onSessionDestroyed listener error (sessionId=${sessionId}):`, e)
      }
    }
    // wave:perf-w20（D6-1）：session 删除 / pi 进程退出时清历史重建缓存 + lastLeafId。
    // pi 进程退出后缓存基线（lastLeafId）不再与新进程的 entry 集合对应，保留只会
    // 走 "Entry not found" fallback（防御兜底存在，但清理是正路径）。
    this.historyCache.delete(sessionId)
    // W7/W8：销毁 per-session 实例组（与 historyCache.delete 同汇聚点——主动删 + 进程退出）。
    // dispose 停防抖/退避/周期兜底全部定时器（thinkingLevel 的 30s poll 不清会泄漏定时器）。
    const replicated = this.replicatedStates.get(sessionId)
    if (replicated) {
      replicated.label.dispose()
      replicated.thinkingLevel.dispose()
      replicated.modelId.dispose()
      replicated.usage.dispose()
      replicated.queue.dispose()
      replicated.commands.dispose()
      this.replicatedStates.delete(sessionId)
    }
    // W18：销毁 record entry 派生缓存（同汇聚点）。停防抖定时器（在途 inflight 的拉取
    // 完成后 applyRecordEntries 的 sessions.has 守卫拦住发布，不复活已清 bus 条目）。
    const recordCache = this.recordEntriesCaches.get(sessionId)
    if (recordCache) {
      if (recordCache.debounceTimer !== null) clearTimeout(recordCache.debounceTimer)
      this.recordEntriesCaches.delete(sessionId)
    }
    // W12：state_changed 组合投影的 diff 基线随 session 销毁清除（防同 id 重建后误判同值）。
    this.lastPublishedStateChanged.delete(sessionId)
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
      // wave:perf-w09（02 文档 D1-2）：session 级消息单通道——payload 带 sessionId 的消息
      // 只走 bus.publish（per-session 单调 seq + ring/snapshot + 定向推给订阅该 sid 的 ws），
      // 盲广播腿已删除。broker.broadcast 退化为纯全局通道：只承接无 sessionId 的消息
      // （理论上 pi 事件流转发的消息恒带 sid，此分支是防御兜底，丢了比静默好）。
      // R8 验证结论（W09）：subagent.stream_delta 的 payload.sessionId 实为主 session id
      // （EventAdapter 以主 session 绑定翻译，extension setWidget 从主进程上报），
      // publish 目标即主 session，renderer 全量订阅（useSessionStreamSync）覆盖，无需 R-04。
      const sid = (msg.payload as { sessionId?: string } | null)?.sessionId
      // W8 queue 失效接线：queue_update 翻译帧只做深度失效信号（D6——深度权威 = pi get_state
      // 快照，帧自带的 steering/followUp 数组与附带的深度仅是事件即时值），markDirty 触发
      // queue 实例防抖重拉 get_state().pendingMessageCount，事件 payload 永不直写深度数据。
      if (msg.type === 'message.queue_update' && sid) {
        this.replicatedStates.get(sid)?.queue.markDirty()
      }
      if (sid) {
        this.messageBus?.publish(sid, msg)
      } else {
        this.broker.broadcast(msg)
      }
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
      // W10：inputTokens/tokenCount 退化为恒 0 派生基线（types 必填字段保留）——真值由
      // usage 实例快照持有，读点（getInputTokens / toSummary.tokenCount）从实例派生，
      // 任何路径不再直写这两个字段（旧外部 setter / applyContextUpdate 直写已删）。
      tokenCount: 0, inputTokens: 0, isGenerating: false, isCompacting: false, isBashRunning: false, bashRunToken: undefined,
      adapter, sessionFilePath,
      hidden,
      parentSession,
      forkEntryId,
    }
    this.sessions.set(id, session)
    // W7：注册 per-session 标量实例并播种首份快照（create/restore/fork 三入口的汇聚点）。
    // 播种走 refetch 立即拉取——session 激活后 renderer 要消费的 session 级状态必须主动拉取
    //（Runtime broadcast 时序竞争 [HISTORICAL]，架构约定）。
    // W12：session.commands 的激活发布不再单独直连 RPC（旧 fetchAndBroadcastCommands 已删），
    // 播种 fetch 经 fetchCommandsSnapshot 的快照应用后挂钩发布（publishCommandsSnapshot）。
    this.registerReplicatedStates(id)
    // W18：注册 record entry 派生缓存（不播种——首个 entry_appended 失效时全量拉取；
    // 激活后 renderer 的初始列表由 getSubagents/getWorkflows RPC 磁盘扫描承接，同 scan 函数）。
    this.ensureRecordEntriesCache(id)
    return session
  }

  // ── 私有协作者 ────────────────────────────────────────────────

  /**
   * W7/W8：注册 per-session 实例组（六实例）并 refetch 播种。
   * 配置即登记表条目（replicated-states.config.ts）；fetch 统一走窄访问器（fetchStateSnapshot /
   * fetchSessionStatsSnapshot / fetchCommandsSnapshot，复用 rpc-client 对应方法）。
   * 幂等注册（同 id 重复注册先 dispose 旧实例，防定时器泄漏）。
   */
  private registerReplicatedStates(sessionId: string): SessionReplicatedStates {
    const existing = this.replicatedStates.get(sessionId)
    if (existing) {
      existing.label.dispose()
      existing.thinkingLevel.dispose()
      existing.modelId.dispose()
      existing.usage.dispose()
      existing.queue.dispose()
      existing.commands.dispose()
    }
    const fetchState = () => this.fetchStateSnapshot(sessionId)
    // W12：modelId / thinkingLevel 的 fetch 走带 state_changed 发布挂钩的包装（快照应用后
    // 组合投影）；label / queue 无 state 话题发布需求，仍用裸 fetchState。
    const fetchStateForStateChanged = () => this.fetchStateSnapshotWithStatePublish(sessionId)
    const states: SessionReplicatedStates = {
      label: new ReplicatedState(createLabelStateConfig(fetchState)),
      thinkingLevel: new ReplicatedState(createThinkingLevelStateConfig(fetchStateForStateChanged)),
      modelId: new ReplicatedState(createModelIdStateConfig(fetchStateForStateChanged)),
      usage: new ReplicatedState(createUsageStateConfig(() => this.fetchSessionStatsSnapshot(sessionId))),
      queue: new ReplicatedState(createQueueDepthStateConfig(fetchState)),
      commands: new ReplicatedState(createCommandsStateConfig(() => this.fetchCommandsSnapshot(sessionId))),
    }
    this.replicatedStates.set(sessionId, states)
    states.label.refetch()
    states.thinkingLevel.refetch()
    states.modelId.refetch()
    states.usage.refetch()
    states.queue.refetch()
    states.commands.refetch()
    return states
  }

  /**
   * W7：get_state 快照拉取——label / thinkingLevel / modelId / queue 四实例的唯一 fetch 入口
   * （复用 rpc-client getState）。无活跃 client 时抛错 → 实例按快照失败处理（退避重试 +
   * 保留旧值，W6 核心不变量 2）。
   */
  private async fetchStateSnapshot(sessionId: string): Promise<Record<string, unknown> | undefined> {
    const client = this.pm.getClient(sessionId)
    if (!client) {
      throw new Error(`[session-service] get_state unavailable: no active pi client for session ${sessionId}`)
    }
    return client.getState()
  }

  /**
   * W8：get_session_stats 快照拉取——usage 实例的唯一 fetch 入口（复用 rpc-client
   * getSessionStats）。无活跃 client 抛错 → 实例按快照失败退避重试 + 保留旧值。
   *
   * W12：fetch 成功后排一次 context.update 发布（setTimeout 0 宏任务——fetch promise
   * resolve 后 doFetch 的 applySnapshot 在微任务链上先于宏任务执行，发布读到的必是已应用
   * 快照）。播种 refetch / context 事件失效（applyContextUpdate）/ fetchContext 查询失效 /
   * switchModel 失效的每次 fetch 都经本入口 ⇒ stateSnapshot 的 context last-value 恒 ==
   * owner 快照（「投影一次」，D7）。fetch 失败（throw）不发布——快照未变。
   */
  private async fetchSessionStatsSnapshot(sessionId: string): Promise<Record<string, unknown> | undefined> {
    const client = this.pm.getClient(sessionId)
    if (!client) {
      throw new Error(`[session-service] get_session_stats unavailable: no active pi client for session ${sessionId}`)
    }
    const stats = await client.getSessionStats() as Record<string, unknown> | undefined
    setTimeout(() => {
      this.publishContextFromSnapshot(sessionId)
      this.publishStateChangedFromSnapshot(sessionId)
    }, 0)
    return stats
  }

  /**
   * W12：读 usage 实例快照发布 context.update（state topic，last-value == owner 快照）。
   * 无值态（compact 后空快照 / 首拉失败）不发布——对齐 fetchContext「null 不更新」语义。
   */
  private publishContextFromSnapshot(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return // session 已销毁：不 publish（防 bus 重建已 clearSession 的 entry）
    const snapshot = this.replicatedStates.get(sessionId)?.usage.get()
    if (
      snapshot?.inputTokens === undefined
      || snapshot?.usagePercent === undefined
      || snapshot?.contextLimit === undefined
    ) return
    const msg: ServerMessage = {
      type: 'context.update',
      id: `ctx_${Date.now()}`,
      payload: { sessionId, inputTokens: snapshot.inputTokens, contextLimit: snapshot.contextLimit, usagePercent: snapshot.usagePercent },
    }
    this.messageBus?.publish(sessionId, msg)
  }

  /**
   * W8：get_commands 快照拉取——commands 实例的唯一 fetch 入口（复用 rpc-client getCommands）。
   * 无活跃 client 抛错 → 实例按快照失败退避重试 + 保留旧值。
   *
   * W12：fetch 成功后排一次 session.commands 发布（setTimeout 0 宏任务——fetch promise
   * resolve 后 doFetch 的 applySnapshot 在微任务链上先于宏任务执行，发布读到的必是已应用
   * 快照）。播种 refetch / 查询即失效（getCommands）/ 防抖重拉的每次 fetch 都经本入口 ⇒
   * stateSnapshot 的 commands last-value 恒 == owner 快照（「投影一次」，D7）。fetch 失败
   * （throw）不发布——快照未变，无需刷新 last-value。
   */
  private async fetchCommandsSnapshot(sessionId: string): Promise<unknown> {
    const client = this.pm.getClient(sessionId)
    if (!client) {
      throw new Error(`[session-service] get_commands unavailable: no active pi client for session ${sessionId}`)
    }
    const result = await client.getCommands()
    setTimeout(() => this.publishCommandsSnapshot(sessionId), 0)
    return result
  }

  /** W12：读 commands 实例快照发布 session.commands（state topic，last-value == owner 快照）。 */
  private publishCommandsSnapshot(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return // session 已销毁：不 publish（防 bus 重建已 clearSession 的 entry）
    const commands = this.replicatedStates.get(sessionId)?.commands.get()?.commands
    if (commands === undefined) return // 快照未就绪（首拉失败窗口）：不发（对齐旧路径失败不发）
    const msg: ServerMessage = { type: 'session.commands', payload: { sessionId, commands } }
    this.messageBus?.publish(sessionId, msg)
  }

  /**
   * W12：读 modelId / thinkingLevel / usage 三实例快照组合发布 session.state_changed
   *（state topic，payload 全字段来自实例快照）。
   *
   * 触发点 = 三实例各自的 fetch 成功挂钩（fetchStateSnapshotWithStatePublish /
   * fetchSessionStatsSnapshot）——任一实例快照应用后刷新组合，全部收敛后 last-value 为
   * 终态组合（中间态帧由下方 diff 抑制去重，renderer 幂等覆盖）。
   * 快照缺失字段 fallback 双写过渡期缓存（session.modelId / thinkingLevel，W13 收编）；
   * usage 无快照时三字段为 0 基线（与旧 broadcastSessionState 的缺省口径一致）。
   * diff 抑制：thinkingLevel 的 30s 周期兜底重拉会高频触发挂钩，同值组合不重复发帧。
   */
  private publishStateChangedFromSnapshot(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return // session 已销毁：不 publish（防 bus 重建已 clearSession 的 entry）
    const session = this.sessions.get(sessionId)
    const states = this.replicatedStates.get(sessionId)
    if (!session || !states) return
    const usage = states.usage.get()
    const payload = {
      sessionId,
      modelId: states.modelId.get()?.modelId ?? session.modelId,
      thinkingLevel: states.thinkingLevel.get()?.thinkingLevel ?? session.thinkingLevel,
      usagePercent: usage?.usagePercent ?? 0,
      inputTokens: usage?.inputTokens ?? 0,
      contextLimit: usage?.contextLimit ?? 0,
    }
    const last = this.lastPublishedStateChanged.get(sessionId)
    if (
      last
      && last.modelId === payload.modelId
      && last.thinkingLevel === payload.thinkingLevel
      && last.usagePercent === payload.usagePercent
      && last.inputTokens === payload.inputTokens
      && last.contextLimit === payload.contextLimit
    ) return
    this.lastPublishedStateChanged.set(sessionId, payload)
    // wave:perf-w09（D1-2）：session.state_changed 单通道走 bus publish
    //（wave:perf-w06：state_changed 已入 bus 的 STATE_TYPE_KEY_MAP——publish 分配 seq 写
    // stateSnapshot、不入 streamRing，重连由 stateSnapshot 恢复。）
    const stateMsg: ServerMessage = {
      type: 'session.state_changed',
      id: `push_${Date.now()}`,
      payload,
    }
    this.messageBus?.publish(sessionId, stateMsg)
  }

  /** W12：state_changed 组合投影的 diff 基线（per-session，removeSessionEntry 一并清除）。 */
  private readonly lastPublishedStateChanged = new Map<string, {
    modelId: string
    thinkingLevel: string | undefined
    usagePercent: number
    inputTokens: number
    contextLimit: number
  }>()

  /**
   * W12：modelId / thinkingLevel 实例的 fetch 包装——get_state 快照应用后挂钩发布
   * session.state_changed（组合投影）。与 fetchStateSnapshot 的关系：多一层「fetch 落定
   * （成功或失败）→ setTimeout 0 宏任务发布」（宏任务晚于 doFetch 的 applySnapshot 微任务
   * 链，成功路径发布读到的必是已应用快照）。失败路径同样排发布：payload 走快照缺失的
   * fallback 过渡期缓存——对齐旧 broadcastSessionState「get_state 失败不阻塞、thinkingLevel
   * 回退缓存值」语义；rethrow 由 finally 透传，实例退避重试语义不变。
   * label / queue 实例不发布 state 话题，仍用裸 fetchState。
   */
  private async fetchStateSnapshotWithStatePublish(sessionId: string): Promise<Record<string, unknown> | undefined> {
    try {
      return await this.fetchStateSnapshot(sessionId)
    } finally {
      setTimeout(() => this.publishStateChangedFromSnapshot(sessionId), 0)
    }
  }

  /**
   * 归属 project sidecar 延迟写入兑底（D14 语义修正，2026-08-04）。
   *
   * create 时 session 文件可能未落盘（pi 延迟写入窗口）→ persistProjectBinding 的
   * existsSync 守卫跳过（规则 #6 禁止提前建文件），只有内存态 projectId。
   * 本方法在 turn_end（主路径）/ agent_end（兑底）时补写——此时 pi 已完成 flush，
   * 文件存在，写 sidecar 安全。无归属（undefined）或文件仍不存在 → 跳过（下次兑底）。
   *
   * 用 projectBindingPersisted 标记防重复写（session 级运行时标记，不进 toSummary）。
   */
  private tryPersistProjectBinding(s: IManagedSessionView): void {
    const projectId = (s as IManagedSessionView & { projectId?: string }).projectId
    const persisted = (s as IManagedSessionView & { projectBindingPersisted?: boolean }).projectBindingPersisted
    if (persisted || !projectId || !s.sessionFilePath || !existsSync(s.sessionFilePath)) return
    this.sessionStore.persistProjectBinding(s.sessionFilePath, projectId)
    ;(s as IManagedSessionView & { projectBindingPersisted?: boolean }).projectBindingPersisted = true
  }

  /**
   * 查询 session 的扩展命令（pi getCommands）。纯查询，无副作用。
   * 用于 renderer 切 session 后主动拉取（修复 broadcast 与订阅时序竞争）。
   *
   * W8 commands 失效接线：本方法是 commands 失效信号的全部汇聚点（W12 起激活发布路径
   * 已删——播种 fetch 经 fetchCommandsSnapshot 挂钩发布，仅剩 renderer 的 session.getCommands
   * RPC 查询路径经此）——查询即失效，markDirty 触发 commands 实例防抖重拉 get_commands
   * 快照（实例唯一数据写路径），重拉完成后经挂钩刷新 session.commands last-value，
   * RPC 响应本身不直写实例数据、也不直接 publish。
   *
   * @throws session 未激活或 pi getCommands 失败时抛（调用方 try-catch）
   */
  async getCommands(sessionId: string): Promise<PiCommandInfo[]> {
    // W8：对齐现有发布路径的事件源全集（激活发布 + 主动查询），失效信号在 RPC 调用前发。
    this.replicatedStates.get(sessionId)?.commands.markDirty()
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`session ${sessionId} not active`)
    return client.getCommands()
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
      // W10：restore 拉取写点 = usage 失效源（session 激活后 context 权威值可能已变——markDirty
      // 防抖重拉 get_session_stats 快照刷新 usage 实例，快照是 inputTokens 唯一数据源）。
      // 旧外部 setter 缓存回写已删：switchModel → broadcastSessionState 读实例快照，
      // 注册播种（registerReplicatedStates refetch）已保证快照非空，不再依赖本方法回写。
      this.replicatedStates.get(sessionId)?.usage.markDirty()
      return {
        inputTokens: cu.tokens,
        contextLimit: cu.contextWindow,
        usagePercent: Math.round(cu.percent ?? 0),
      }
    }
    return null
  }

  /**
   * 拉取上下文用量并触发广播（restoreSession / forkSession 兜底用）。
   *
   * W12：广播职责归 usage fetch 挂钩（publishContextFromSnapshot）——本方法只做「查询即
   * 失效」（fetchContext 内 markDirty → 防抖重拉 → 快照应用后挂钩发布）。fetchContext 返回
   * null（compact 后无值）时不失效，快照保持旧值——对齐旧「null 不广播」语义。
   * 注意：挂钩发布的广播可能早于前端订阅新 sessionId 通道（时序竞争，见架构约定 #7），
   * 前端 useSidebar.selectSession 会主动调 session.getContext 再拉一次保证到达。
   * fire-and-forget 语义：失败不阻塞 session 恢复。
   */
  async fetchAndBroadcastContext(sessionId: string): Promise<void> {
    try {
      await this.fetchContext(sessionId)
    // eslint-disable-next-line taste/no-silent-catch -- 兜底拉取失败无影响（前端主动拉是主路径）
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
      // 读已有（文件不存在 → 空；损坏 → 隔离现场后降级为空，best-effort 不阻断写入）
      let file: SegmentsMetadataFile = { version: 1, entries: [] }
      if (existsSync(filePath)) {
        try {
          const raw = readFileSync(filePath, 'utf-8')
          const parsed = JSON.parse(raw) as SegmentsMetadataFile
          if (parsed && Array.isArray(parsed.entries)) file = parsed
        } catch (e) {
          // D1c 损坏隔离（integrity-hardening.md §3.1）：半截文件先 rename .corrupt-<ts>
          // 保留取证再降级为空——否则下方写入把「半截」合法化成「全空」，历史 segments
          // 永久丢失且不可恢复（与 JsonStore 共用同一 quarantine 实现，避免行为漂移）
          quarantineCorruptFile(filePath, { tag: 'session-service', reason: 'segments.json malformed', cause: e })
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
 * 判定 getEntries(since) 的 "Entry not found" 错误（wave:perf-w20 D6-4 fallback 触发条件）。
 *
 * pi 实测文案（2026-08-16，pi 0.84.0）：`Entry not found: <since-id>`——E 大写 not 小写
 * （pi rpc-mode.ts:615 模板字符串）。rpc-client 对 success:false 的响应 reject
 * `new Error(msg.error)`，错误原文进 Error.message。匹配用大小写宽容的 includes
 * （防御 pi 上游微调文案大小写）+ 前缀锚定（避免误吞其他含 "entry" 字样的错误）。
 */
function isEntryNotFoundError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /^entry not found/i.test(msg)
}

/**
 * W18：SubagentRecord 逐字段相等判定（record entry 派生缓存的发布 diff 基线）。
 * 结构固定（shared SubagentRecord），逐字段比对而非 JSON.stringify（顺序无关、无序列化抖动）。
 */
function subagentRecordEquals(a: SubagentRecord, b: SubagentRecord): boolean {
  return a.subagentId === b.subagentId
    && a.sessionFile === b.sessionFile
    && a.agent === b.agent
    && a.slug === b.slug
    && a.task === b.task
    && a.status === b.status
    && a.model === b.model
    && a.thinkingLevel === b.thinkingLevel
    && a.turns === b.turns
    && a.totalTokens === b.totalTokens
    && a.elapsedSeconds === b.elapsedSeconds
    && a.startedAt === b.startedAt
    && a.endedAt === b.endedAt
    && a.error === b.error
    && a.closedReason === b.closedReason
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
 *
 * [HISTORICAL] 本函数已不再被 getAgentCallHistory/getAgentCallFilePath 使用（2026-08-14：
 * agent call 的 trace.sessionId 是 subagentId sa-xxx，两方法改复用 getSubagentHistory 的
 * record.sessionFile 路径——sa-xxx 经主 session JSONL 的 subagent record 定位，不按 header.id
 * 扫目录）。保留作参考：按 header.id 扫 subagents/<encCwd>/sessions/ 匹配 uuidv7 的直查场景
 * 若未来需要可复用。`_` 前缀标记有意保留的未引用符号（ESLint no-unused-vars 的 /^_/u 豁免）。
 */
function _findAgentCallFile(mainCwd: string, agentCallSessionId: string, sessionStore: ISessionStore): string | null {
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
