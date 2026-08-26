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
import { join, isAbsolute, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { expandHome, isStrictlyUnder } from '../../utils/path-utils.js'
import type { SessionSummary, SessionGroup, SessionStatus, Message, ServerMessage, ServerMessageMap, SubagentRecord, WorkflowRunRecord, BatchDeleteResult, SegmentsMetadataFile, SegmentsMetadataEntry, ProviderId } from '@xyz-agent/shared'
import { BUILTIN_PRESET_IDS, IMAGE_LIMITS, SUBAGENT_RECORD_CUSTOM_TYPE, WORKFLOW_RECORD_CUSTOM_TYPE } from '@xyz-agent/shared'
import type { SubagentEngineConfigView, SubagentEnginesFile } from '@xyz-agent/extension-protocol'
import { SUBAGENTS_ENGINES_FILENAME } from '@xyz-agent/extension-protocol'
// paths.ts 是 Node-only 模块，刻意不从 shared barrel 导出（见 shared/src/index.ts L32 注释），
// Node 端从子路径 import
import { getAttachmentsDir, getDataDir } from '@xyz-agent/shared/paths'
import type { PiSessionEntry } from '../../infra/pi/pi-protocol.js'
import type {
  ISessionService, IMessageBroker, SessionCreateOptions,
  IEventAdapter, IExtensionService, IConfigService,
} from '../../interfaces.js'
import type { ISessionServiceInternal } from './session-internal.js'
import type { IProcessManager, IPiEngine, PiCommandInfo, PiMessage } from '../ports/pi-engine.js'
import { getHistoryFromFilePath, getHistoryTailFromFile } from '../session-history.js'
import { parseJsonl } from '../../utils/jsonl.js'
import { quarantineCorruptFile } from '../../utils/json-store.js'
import { extractSubagentsFromSessionFile, scanSubagentEntries } from './subagent-extractor.js'
import {
  extractRecordEngine,
  readEngineSubagentHistory,
  DEFAULT_SUBAGENT_ENGINE,
} from './subagent-engine-history.js'
import { extractWorkflowsFromSessionFile, scanWorkflowEntries } from './workflow-extractor.js'
import { buildTraceSnapshotFromFile, parseTraceHeaderLine, nextTracePushId, collectMalformedLines, CURRENT_SYSTEM_PROMPT_CUSTOM_TYPE } from './session-trace.js'
import type { SessionTraceSnapshot } from './session-trace.js'
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
  createThinkingLevelStateConfig,
  createModelIdStateConfig,
  createUsageStateConfig,
  createCommandsStateConfig,
  type ThinkingLevelSnapshot,
  type ModelIdSnapshot,
  type UsageSnapshot,
  type CommandsSnapshot,
  SCALAR_STATE_DEBOUNCE_MS,
} from './replicated-states.config.js'
import { HistoryRebuildCache, mergeIncrementalMessages } from './history-rebuild-cache.js'
import { toErrorMessage, isEnoent, BUILTIN_EXTENSIONS_MISSING } from '../../utils/errors.js'
import { withFileLockSync } from '../../utils/file-lock.js'
import { atomicWrite } from '../../utils/fs-utils.js'
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
  /**
   * agent-managed session 标记的内存态持有（B-2）。
   *
   * 与 launchPresetId/projectId 同模式：.agent.json sidecar 可能因 pi 延迟写入未 flush
   * 而无法写入（persistAgentBinding 的 existsSync 守卫跳过），内存态兑底持有，
   * 供 session-manager list 按 spawnSource 过滤 / toSummary 透传（前端 AI badge）。
   */
  spawnSource?: 'user' | 'agent'
  /** agent-managed session 的父 session id（内存态持有，语义同上 spawnSource） */
  parentAgentSessionId?: string
}

/**
 * per-session ReplicatedState 实例组（W7 + W8 data-source-governance，四实例）。
 *
 * thinkingLevel / modelId（W7）：快照唯一来源 get_state，失效源分别是
 * thinking_level_changed / switchModel RPC 响应。
 * usage（W8 + W10 收编）：快照唯一来源 get_session_stats().contextUsage，失效源 = context
 * 相关事件 turn_end / agent_end / compaction（汇聚于 applyContextUpdate）+ restore 拉取
 * （fetchContext）+ switchModel RPC（contextWindow 随模型变化）。W10 起五写点全部收编：
 * inputTokens 的旧 session 缓存直写（applyContextUpdate / fetchContext 回写）已删，
 * usage 实例快照是唯一数据源（getInputTokens / tokenCount 派生 / switchModel
 * 重算全读快照），inputTokens 竞态从「时序约定」变「结构不可能」。
 * commands（W8）：快照唯一来源 get_commands，失效源 = getCommands 全部调用路径
 * （激活发布 + renderer 主动查询，查询即失效）。
 * 事件与 RPC 响应永不直接写实例数据（只 markDirty）。session.thinkingLevel /
 * modelId 会话字段缓存是登记的永久双写形态（PR #185 S2 裁决，2026-08-20，登记表
 * #4/#5 修订）：播种 refetch 三实例异步竞速 + get_state 失败退避（1s/5s/15s）窗口内
 * 快照未就绪，state_changed 组合投影 fallback 读该缓存；toSummary（session 列表）
 * 亦消费该字段。usage 双写已终结（W10）。
 *
 * [HISTORICAL] label / queue 深度两实例已撤销（PR #185 data-governance review MF1/MF2，
 * 2026-08-20）：两实例 .get() 生产零消费，markDirty 触发的防抖 get_state 拉取纯浪费 RPC，
 * 真值路径分别是 session_info_changed 事件直写 setLabelCache（label 唯一真值源）与
 * queue_update 帧内 pendingMessageCount（= pi 队列深度推送投影，renderer 对账直读帧值）。
 * 「完成 W7/W8 发布通道」属新功能开发，不在 review 修复范畴，按登记表 #1/#6 修订记录在案。
 */
export interface SessionReplicatedStates {
  thinkingLevel: ReplicatedState<ThinkingLevelSnapshot>
  modelId: ReplicatedState<ModelIdSnapshot>
  usage: ReplicatedState<UsageSnapshot>
  commands: ReplicatedState<CommandsSnapshot>
}

/** 现取 system prompt 轮询参数：命令 handler 毫秒级完成，250ms 间隔 1-2 轮命中；
 * 8s 超时上限覆盖慢盘/慢命令（超时地 fetch_current_prompt_timeout，前端可重试）。 */
const FETCH_CURRENT_PROMPT_POLL_MS = 250
const FETCH_CURRENT_PROMPT_TIMEOUT_MS = 8000

/**
 * 定向消息文本的换行编码（composer 四符号 §3.3.3 / 探针 P3 转义协议）。
 *
 * 为什么编码：`/subagents message <id> <text>` 经 client.prompt 单行传输（pi 以首个
 * 空格拆命令名后取剩余全文，真实换行会破坏命令的单行性），故发送前把真实换行编码为
 * 字面 `\n` 两字符、原生反斜杠编码为 `\\`。
 *
 * 为什么连反斜杠一起转义：extension 侧 decodeNewlineEscapes（command-actions.ts）
 * 与本函数互逆——若只编码换行不编码反斜杠，原文里的字面反斜杠+n（如路径 `C:\new`）
 * 会被误解码成换行（歧义）。反斜杠先转义消除该歧义，两侧测试对三种原文
 * （字面 \n / 反斜杠 / 真实换行）钉死往返不变。
 */
export function encodeDirectiveText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
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
   * session-trace 增量腿基线（A33）：per-session 上次全量拉取的 leafId（since 基准）。
   * getTraceEntries 活跃路径写入；syncTraceEntries 读取后 get_entries(since) 拉 delta 并
   * 滚动更新。无基线（trace 视图未打开过）→ 增量腿 no-op（前端打开时会全量拉取建立基线）。
   * 哨兵 ''（review round1 MUST_FIX）：空 session（pi leafId=null）也要建立基线，语义 =
   * 「基线已建立但当前无叶子」——后续 sync 经 getEntriesSince 无参全量拉（'' 不是合法
   * entry id，不可下传 pi 当 since），拉到真实 leaf 后推进；否则空 session 台账冻结空态
   * 且无恢复出口。removeSessionEntry 清除（与 historyCache 同汇聚点，见下）。
   */
  private readonly traceLeafCache = new Map<string, string>()
  /**
   * session-trace 增量腿串行链（A33）：per-session promise 链，同 session 触发事件按到达序
   * 串行拉取（message_end + agent_settled 几乎同时到达 → 链式串行后第二次 since 已是新
   * leaf，空 delta 不广播；burst 天然合并）。每段 catch 兑底，链永不 reject（diffChain 同款）。
   */
  private readonly traceSyncChains = new Map<string, Promise<void>>()
  /**
   * W7/W8：per-session ReplicatedState 实例组（四实例：thinkingLevel / modelId /
   * usage / commands）。Map 分区（ADR-0049）：注册点 initializeManagedSession
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

  async create(cwd?: string, label?: string, options?: SessionCreateOptions): Promise<SessionSummary> { return this.lifecycle.create(cwd, label, options) }
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
  // [HISTORICAL] sendSubagentMessage（marker 半成品通道）已删除（composer 四符号设计 D2）：
  // base64 隐藏注释前缀在 extension 侧零消费方，且经主 agent 转发违背
  // 「直达 subagent」目标——定向消息改走 subagentAction(message/start)。
  async abort(sessionId: string): Promise<void> { return this.dispatcher.abort(sessionId) }
  /** 强制退出卡死 session（sidebar 右键入口，杀 pi 进程 + stopped 收敛）。 */
  async forceQuit(sessionId: string): Promise<void> { return this.dispatcher.forceQuit(sessionId) }
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
   * session.state_changed 带 sessionId，前端据它同步 Composer 工具条（模型显示 / 思考强度；
   * 用量刷新走 context.update 帧，D1 协议收敛后 state_changed 不再携带 usage）。
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
    // PR #185 S2 裁决的永久双写形态：RPC 已成功（pi 侧生效），直写让 toSummary（session
    // 列表）与 state_changed fallback（防抖 300ms + 重拉窗口内快照未收敛）立即读到新值；
    // 实例快照收敛后主路径照常读快照（与直写同值，无冲突）。
    session.modelId = newModelId
    // session-trace（A33）：lifecycle RPC 成功后主动补拉——model_change 的 append 无通用事件
    //（design D4：model_change / label 无事件，这些动作由 runtime 自身发起，RPC 成功后补拉覆盖）。
    // fire-and-forget：补拉失败不影响切模型主流程（syncTraceEntries 内部吞错）。
    this.syncTraceEntries(sessionId, 'set_model')
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
    // session-trace（A33）：thinking_level_change 的 append 虽有事件但消费点在 pi 侧
    // extension 回调（xyz-agent 不订阅）；与 set_model 同款，RPC 成功后主动补拉。
    // fire-and-forget：补拉失败不影响设档主流程（syncTraceEntries 内部吞错）。
    this.syncTraceEntries(sessionId, 'set_thinking_level')
    const state = await client.getState()
    const effective = typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : level
    const session = this.sessions.get(sessionId)
    // PR #185 S2 裁决的永久双写形态：effective 来自 pi get_state（权威值），直写让
    // toSummary 与 state_changed fallback 在实例防抖重拉窗口内即读准值（modelId 同理，
    // 见 switchModel）。pi 同档位钳制不发事件、不写 entry，此直写是唯一即时同步点。
    if (session) session.thinkingLevel = effective
    return effective
  }
  /**
   * 更新活跃 session 的 label（内存态）——session_info_changed 事件路径的唯一写方（PR #185 MF1）。
   *
   * 调用方：pi session_info_changed 事件到达时（pi extension auto-rename，经组合根
   * onSessionRenamed 回调）。另一写方 = renameSession 活跃分支（set_session_name RPC
   * 成功后直写 session.label，见 session-lifecycle.ts，两者写点同源 pi 权威）。
   * 不持久化——pi 侧已写 session_info，此处只同步内存态（toSummary/config.sessions
   * 的即时数据源）。label 的 ReplicatedState 实例已撤销（.get() 零消费、拉取纯浪费
   * RPC，见 SessionReplicatedStates 注释 [HISTORICAL] 段）。
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

  /**
   * 可能返回已死 client（exited=true），业务入口（prompt / subagent / auto-restore）
   * 应走 ensureActive（死 client 视同无 client 走 restore）；直接调用方需自行处理 exited
   * （handoff-service 等依赖裸 client 观察 exited，故本方法不改语义只标注契约）。
   */
  getRpcClient(sessionId: string): IPiEngine | undefined { return this.pm.getClient(sessionId) }

  /**
   * W7/W8：per-session 实例组访问器。消费方：
   * - 组合根（index.ts）：interpreter 的失效回调延迟解析（markDirty，thinkingLevel）；
   * - session-service 自身（W8）：usage / commands 失效接线（applyContextUpdate /
   *   getCommands）；
   * - 测试：断言 switchModel 后 modelId 实例 markDirty、事件路径写点后 usage/commands markDirty。
   * session 未注册（非活跃 / 已销毁）返回 undefined，调用方安全跳过。
   * 方法名沿用 W7 的 ScalarReplicatedStates 语义（index.ts 组合根接线稳定，四实例后为
   * 全量实例组访问器——结构收窄不破坏既有消费方）。
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
        let fetched: { entries: unknown[]; leafId: string | undefined }
        try {
          fetched = await this.fetchRecordEntriesRound(client, cache)
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
        this.applyRecordEntries(cache, fetched.entries, sessionId)
        if (fetched.leafId !== undefined) cache.cursor = fetched.leafId
        return
      }
    }
    cache.inflight = run().finally(() => { cache.inflight = null })
    return cache.inflight
  }

  /**
   * W18：单轮 get_entries 拉取——按 cursor 有无分流增量/全量。
   * 全量重建时派生缓存整体重置（纯派生语义——全量扫描结果就是新基线）。
   */
  private async fetchRecordEntriesRound(
    client: IPiEngine,
    cache: RecordEntriesCache,
  ): Promise<{ entries: unknown[]; leafId: string | undefined }> {
    if (cache.cursor !== null) {
      const inc = await client.getEntries(cache.cursor) as { data?: { entries?: PiSessionEntry[]; leafId?: string | null } }
      return { entries: inc.data?.entries ?? [], leafId: inc.data?.leafId ?? undefined }
    }
    const full = await client.getEntries() as { data?: { entries?: PiSessionEntry[]; leafId?: string | null } }
    cache.subagents.clear()
    cache.workflows.clear()
    return { entries: full.data?.entries ?? [], leafId: full.data?.leafId ?? undefined }
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
    // 纵深防御（pi-exit-notification-and-respawn §6.6）：上游清理（onSessionExit）出现竞态时
    // processes Map 可能残留已死 client——视同无 client 走下方 restoreSession（其内部对
    // existing sessions 条目已有 detach + safeDestroy + removeSessionEntry 清场），
    // 不把死 client 交给 prompt。
    if (existing && !existing.exited) return existing
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
    if (!record) return []

    // P5 分协议路由：非 pi 引擎（record.engine 字段路由，缺省 pi）走 extractor 的
    // 三级降级读取链（①引擎原生 reader ②journal ③outcome-only）。pi 的现有直读链
    // 零变化（A1 守护）
    const engine = extractRecordEngine(record)
    if (engine !== DEFAULT_SUBAGENT_ENGINE) {
      return readEngineSubagentHistory(record, getDataDir())
    }

    if (!record.sessionFile) return []

    // 路径穿越校验：sessionFile 必须严格落在 piAgentDir 下（~/.xyz-agent/pi/agent/）。
    // record.sessionFile 由 subagent-extractor 从 JSONL 文本提取，不可信——攻击者构造的
    // session JSONL 可塞入任意路径（如 /etc/passwd），不校验直接读会泄露任意文件内容。
    if (!isStrictlyUnder(getPiAgentDir(), record.sessionFile)) return []

    // 直读 subagent JSONL，复用 getHistoryFromFilePath 转换链路（parseJsonl + filter + convertHistory）。
    // subagent JSONL 格式与主 session 一致（pi SessionManager._persist 写入）。
    return getHistoryFromFilePath(record.sessionFile, this.sessionStore)
  }

  /**
   * [U7] 子代理引擎配置视图：engines.json（extension 权威写入的动态引擎列表）+
   * config.json defaultEngine（extension ModelConfigService 读同一文件）。
   * 纯磁盘读取，Settings 冷启动（无活跃 session）也可用。
   *
   * 回退链（U7b 冷启动：app 刚打开、尚无 pi 进程 → engines.json 不存在）：
   * subagent-workflow 安装目录 package.json 的 `xyz-agent.subagentEngines` 静态声明
   * （守护测试防与代码注册表漂移）→ 最终兜底 ['pi']。
   */
  async getSubagentEngineConfig(): Promise<SubagentEngineConfigView> {
    const subagentsDir = join(getPiAgentDir(), 'subagents')
    let engines: string[] | undefined
    try {
      const raw = readFileSync(join(subagentsDir, SUBAGENTS_ENGINES_FILENAME), 'utf8')
      const parsed = JSON.parse(raw) as Partial<SubagentEnginesFile>
      if (Array.isArray(parsed.engines) && parsed.engines.every((e) => typeof e === 'string') && parsed.engines.length > 0) {
        engines = parsed.engines
      }
    } catch {
      // 缺失/损坏 → 走静态声明回退
    }
    if (engines === undefined) {
      engines = await this.readDeclaredEnginesFallback()
    }
    let defaultEngine = 'pi'
    try {
      const conf = JSON.parse(readFileSync(join(subagentsDir, 'config.json'), 'utf8')) as { defaultEngine?: unknown }
      if (typeof conf.defaultEngine === 'string' && conf.defaultEngine.trim() !== '') {
        defaultEngine = conf.defaultEngine.trim()
      }
    } catch {
      // 无 config / 坏 JSON → 缺省 pi（extension 侧同缺省语义）
    }
    return { engines, defaultEngine }
  }

  /**
   * [U7b] 静态声明回退：经 extensionService 定位 subagent-workflow 安装目录（dev 源码
   * / packaged staged / live env 三形态统一由 getExtensionPaths 覆盖），读 package.json
   * 的 xyz-agent.subagentEngines。任何失败返回 ['pi']（pi 恒可用）。
   */
  private async readDeclaredEnginesFallback(): Promise<string[]> {
    try {
      const paths = await this.extensionService.getExtensionPaths()
      const swDir = paths.find((p) => p.endsWith('subagent-workflow') || p.includes(`${sep}subagent-workflow`))
      if (!swDir) return ['pi']
      const pkg = JSON.parse(readFileSync(join(swDir, 'package.json'), 'utf8')) as {
        'xyz-agent'?: { subagentEngines?: unknown }
      }
      const declared = pkg['xyz-agent']?.subagentEngines
      if (Array.isArray(declared) && declared.every((e) => typeof e === 'string') && declared.length > 0) {
        return declared as string[]
      }
    } catch {
      // 回退链的回退——静默到 ['pi']
    }
    return ['pi']
  }

  /**
   * [U7] 设置全局默认子代理引擎：读改写 config.json（保留其他字段）+ tmp+rename 原子写。
   * engineId 校验：engines.json 清单内才允许（防 GUI 端把未知引擎写进配置）。
   *
   * 🔒 跨进程锁（C-data-09）：config.json 与 agent bash 写（subagent-ext-config skill
   * 指导）、用户手编构成多写方——RMW 全程持 withFileLockSync（lockfile = config.json.lock，
   * 协议对齐 worktree-config-helper ext-config / settings.json 先例）。锁失败 fail-fast
   * 抛错（ELOCKED，预算 1s），经 RPC 错误通路返回 GUI。不取锁的 bash/手编写方作为
   * last-write-wins 残余风险由 data-source-registry.md §6 登记。
   */
  async setSubagentDefaultEngine(engineId: string): Promise<void> {
    const view = await this.getSubagentEngineConfig()
    if (!view.engines.includes(engineId)) {
      throw new Error(`unknown subagent engine '${engineId}' (available: ${view.engines.join(', ')})`)
    }
    const configPath = join(getPiAgentDir(), 'subagents', 'config.json')
    withFileLockSync(configPath, () => {
      let conf: Record<string, unknown> = {}
      try {
        conf = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      } catch {
        // 无既有配置 → 新建（extension 读侧对缺字段的容忍与 DEFAULT_CONFIG 对齐）
        conf = {}
      }
      if (conf['defaultEngine'] === engineId) return
      conf['defaultEngine'] = engineId
      // subagents 目录无需再建：withFileLockSync 取锁前已兜底 mkdir dirname(configPath)
      // （无锁时代这行 mkdir 承重，引入锁后成为死代码）。原子写单点走 fs-utils.atomicWrite
      // （tmp+rename）；写失败时 .tmp 残留不被清理——与 worktree-config-helper ext-config
      // 先例同款取舍，磁盘孤儿文件无害，不在此另复制一份清理逻辑
      atomicWrite(configPath, JSON.stringify(conf, null, 2), `${process.pid}-${Date.now()}`)
    })
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
   * session-trace 台账全量拉取（design D4 数据通路 A1，A31/A32）。
   *
   * 路由：① 活跃（pm 有 client）→ RPC get_entries（pi 权威解析）+ 文件首行补 header
   * （getEntries() 不含 header）+ 文件解析补 malformed（pi 静默跳坏行，G1 占位可见）
   * + sidecar session_end；成功后写 traceLeafCache（增量腿
   * since 基线）。② RPC 失败（pi 进程异常）或无 client → 路径 B 文件直读（core parse-jsonl
   * 坏行容错 + sidecar 合并；design §3.1 降级路径：前端 banner「来自磁盘文件」）。
   * ③ 未落盘（pi 延迟写入窗口）→ source='empty' 空态标记。
   *
   * 文件路径解析：活跃 session 优先内存 sessionFilePath（pi spawn 后回填，免扫描），
   * 否则 scanSessions({force:true})（路径解析消费方旁路 TTL，plan M-3 同 getFullHistory）。
   */
  async getTraceEntries(sessionId: string): Promise<SessionTraceSnapshot> {
    const client = this.pm.getClient(sessionId)
    if (client) {
      try {
        const result = await client.getEntries() as { data?: { entries?: unknown[]; leafId?: string | null } }
        const entries = result.data?.entries ?? []
        const leafId = result.data?.leafId ?? null
        // 空 session（仅 header，pi _buildIndex 置 leafId=null）也必须建立基线（哨兵 ''），
        // 否则 doSyncTraceEntries 恒 no-op——台账冻结空态且无恢复出口（review round1 MUST_FIX）
        this.traceLeafCache.set(sessionId, leafId ?? '')
        const filePath = this.resolveTraceFilePath(sessionId)
        const header = parseTraceHeaderLine(filePath !== null ? this.sessionStore.readSessionHeaderLine(filePath) : null)
        // G1 坏行可见性：pi get_entries 静默跳坏行，RPC 路径必须补文件解析占位（否则活跃
        // session 的坏行对 Trace 视图彻底不可见）；读失败（未落盘窗口）→ 恒空数组降级
        const malformed = collectMalformedLines(
          filePath !== null ? this.sessionStore.readSessionJsonlText(filePath) : null,
        )
        const sessionEnd = filePath !== null ? (this.sessionStore.readSessionEndMeta(filePath) ?? undefined) : undefined
        return {
          sessionId,
          source: 'rpc',
          filePath,
          ...(header !== undefined ? { header } : {}),
          entries,
          malformed,
          ...(sessionEnd !== undefined ? { sessionEnd } : {}),
          leafId,
        }
      } catch (e) {
        // design §3.1 失败路径：RPC 失败（pi 进程异常）降级路径 B 文件直读
        console.warn(`[session-trace] getTraceEntries via RPC failed (sid=${sessionId}), falling back to file read: ${toErrorMessage(e)}`)
      }
    }
    return buildTraceSnapshotFromFile(sessionId, this.resolveTraceFilePath(sessionId), this.sessionStore)
  }

  /**
   * session-trace 增量腿补拉（A33）：触发事件（message_end/compaction_end/agent_settled/
   * entry_appended，经 event-interpreter onTraceSync）或 lifecycle RPC（set_model/
   * set_thinking_level 成功后未方法内直调）到达后调用。
   *
   * 流程：查 traceLeafCache 基线（无 → no-op，trace 未打开过）→ get_entries(since=基线)
   * → 滚动更新基线 → delta 非空时 bus.publish session.traceEntryAppended（含 sessionId，
   * 规则 7）。“Entry not found”（基线跨进程失效，如 pi 重启）→ 清基线 + warn（下次
   * getTraceEntries 重建，不广播错序数据）。串行链防 burst 重复拉取（见 traceSyncChains）。
   */
  syncTraceEntries(sessionId: string, trigger: string): void {
    const prev = this.traceSyncChains.get(sessionId) ?? Promise.resolve()
    const next = prev.then(() => this.doSyncTraceEntries(sessionId, trigger)).catch((e: unknown) => {
      // 链段兑底：单次同步失败不断链（diffChain 同款）；错误已在 doSync 内分类处理，
      // 此处仅防 unhandledRejection 逃逸。
      console.warn(`[session-trace] sync chain segment failed (sid=${sessionId}, trigger=${trigger}):`, e)
    })
    this.traceSyncChains.set(sessionId, next)
    void next.then(() => {
      // 链尾自清理：settled 且仍是链尾时释放 Map 槽位（burst 期间新段已接管，不误删）
      if (this.traceSyncChains.get(sessionId) === next) this.traceSyncChains.delete(sessionId)
    })
  }

  private async doSyncTraceEntries(sessionId: string, trigger: string): Promise<void> {
    const baseline = this.traceLeafCache.get(sessionId)
    if (baseline === undefined) return // 无基线（trace 视图未打开过）→ 增量腿 no-op
    const client = this.pm.getClient(sessionId)
    if (!client) return // 无活跃 client → 无 RPC 增量源（文件路径无 leaf 概念）
    let delta: unknown[] = []
    let newLeafId: string | null = null
    try {
      // 哨兵 ''（空 session 基线）→ 无参全量拉：空 session delta 空 = 正常稳态；有新 entry
      // 后全量 delta 即全部 entry（消费端按 entry.id 去重），拉到真实 leaf 后基线推进
      const result = await this.getEntriesSince(client, baseline) as { data?: { entries?: unknown[]; leafId?: string | null } }
      delta = result.data?.entries ?? []
      newLeafId = result.data?.leafId ?? null
    } catch (e) {
      if (isEntryNotFoundError(e)) {
        // 基线失效（缓存跨 pi 进程存活 / session 文件被外部改写）：清基线，下次全量重建。
        // 恢复动作：前端重新打开 Trace 视图调 session.getTraceEntries（或下次触发前无增量）。
        console.warn(`[session-trace] since baseline invalid (sid=${sessionId}), dropping leaf cache; re-open trace view to rebuild`)
        this.traceLeafCache.delete(sessionId)
      } else {
        console.warn(`[session-trace] getEntries(since) failed (sid=${sessionId}, trigger=${trigger}): ${toErrorMessage(e)}`)
      }
      return
    }
    if (newLeafId) this.traceLeafCache.set(sessionId, newLeafId)
    if (delta.length === 0) return // 触发事件到达但无新 entry（追赶式拉取的正常稳态）
    // 规则 7：session 级消息必带 sessionId（bus.publish 定向推给订阅该 sid 的 ws）
    this.messageBus?.publish(sessionId, {
      type: 'session.traceEntryAppended',
      id: nextTracePushId(),
      payload: { sessionId, entries: delta, leafId: newLeafId },
    })
  }

  /** trace 文件路径解析：活跃 session 内存 sessionFilePath 优先，否则扫描（force 旁路 TTL）。 */
  private resolveTraceFilePath(sessionId: string): string | null {
    const active = this.sessions.get(sessionId)
    if (active?.sessionFilePath) return active.sessionFilePath
    const target = this.sessionStore.scanSessions({ force: true }).find((s) => s.id === sessionId)
    return target?.filePath ?? null
  }

  /**
   * 哨兵感知 get_entries 调用：baseline === ''（空 session 基线——已建立但当时无叶子）时
   * 无参全量拉取（'' 不是合法 entry id，下传 pi 当 since 用会 Entry not found / 空结果，
   * `?? undefined` 只处理 null/undefined 挡不住 ''）；真实 leafId / undefined 原样透传 since。
   */
  private getEntriesSince(client: IPiEngine, baseline: string | undefined): Promise<PiMessage> {
    return baseline === '' ? client.getEntries() : client.getEntries(baseline)
  }

  /**
   * 现取当前 system prompt（session-trace design §3.1 失败路径 / D2）。
   *
   * 通道：pi RPC 无 get_system_prompt 命令、getSystemPrompt() 只在 extension API，且现取
   * 不能依赖可禁的留痕包（system-prompt-trace 是 feature tier）——链路固定为：
   *   client.prompt('/__xyz_get_system_prompt__')（builtin agent-ext 包注册，不可禁，
   *   /__ 内部命令不经 LLM；RPC prompt 在 preflight 后即返回，不等 handler 完成）
   *   → handler 写 xyz:current-system-prompt custom entry
   *   → 本方法轮询 get_entries(since=基线) 拉到该 entry 后提取返回。
   *
   * 副作用：命中后滚动 traceLeafCache 基线 + 广播 session.traceEntryAppended（现取 entry
   * 作为 DATA 行同步出现在 trace 台账，留下取值痕迹；custom 不进 LLM context，零模型影响——
   * pi sessionEntryToContextMessages 对 type=custom 落入末尾 return []，session-manager.ts:383-413）。
   *
   * @throws code=session_not_active（无活跃 pi 进程——非活跃 session 无现取源）/
   *   session_busy（生成/压缩中，命令会排队导致超时，预检拒绝更诚实）/
   *   fetch_current_prompt_timeout（轮询超时，命令未产出 entry）
   */
  async fetchCurrentSystemPrompt(sessionId: string): Promise<ServerMessageMap['session.currentSystemPrompt']> {
    const client = this.pm.getClient(sessionId)
    if (!client) {
      throw Object.assign(new Error(`Session ${sessionId} not active`), { code: 'session_not_active' })
    }
    // busy 预检只看明确的 busy 信号（生成/压缩中命令会排队导致超时）；sessions Map 无条目
    //（恢复窗口/测试简化态）不拒——能否执行由 pi 决定
    const active = this.sessions.get(sessionId)
    if (active?.isGenerating || active?.isCompacting) {
      throw Object.assign(new Error(`Session ${sessionId} is busy`), { code: 'session_busy' })
    }
    let baseline = await this.ensurePromptBaseline(sessionId, client)
    await client.prompt('/__xyz_get_system_prompt__')
    // 轮询：命令 handler 毫秒级完成，RPC 往返 1-2 轮命中；超时上限覆盖慢盘/慢命令
    const deadline = Date.now() + FETCH_CURRENT_PROMPT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const step = await this.pollOnceForPromptEntry(sessionId, client, baseline)
      if (step === 'retry') {
        baseline = undefined
        continue
      }
      if (!step.hit) continue
      // 增量同步给 trace 台账（DATA 行留取值痕迹；消费端按 entry.id 去重）
      if (step.delta.length > 0 && this.messageBus) {
        this.messageBus.publish(sessionId, {
          type: 'session.traceEntryAppended',
          id: nextTracePushId(),
          payload: { sessionId, entries: step.delta, leafId: step.newLeafId },
        })
      }
      return extractCurrentPromptHit(sessionId, step.hit)
    }
    throw Object.assign(new Error(`Timed out fetching current system prompt for session ${sessionId}`), { code: 'fetch_current_prompt_timeout' })
  }

  /**
   * 现取轮询的 since 基线初始化：trace 打开过则用缓存；否则 getEntries() 全量拉一次建立
   *（全量拉是接受的一次性开销——现取是用户显式动作）。
   */
  private async ensurePromptBaseline(sessionId: string, client: IPiEngine): Promise<string | undefined> {
    const cached = this.traceLeafCache.get(sessionId)
    if (cached !== undefined) return cached
    const initial = await client.getEntries() as { data?: { leafId?: string | null } }
    const baseline = initial.data?.leafId ?? undefined
    if (baseline) this.traceLeafCache.set(sessionId, baseline)
    return baseline
  }

  /**
   * 现取轮询单步：sleep → getEntries(since=baseline) → 倒序找 xyz:current-system-prompt
   * custom entry。未命中也滚动 traceLeafCache 基线（增量无遗漏）。
   * 基线跨 pi 进程失效（Entry not found）时清缓存基线并返回 'retry'——调用方置
   * baseline=undefined 全量重建后继续轮询（命令可能已产出 entry）。
   */
  private async pollOnceForPromptEntry(
    sessionId: string,
    client: IPiEngine,
    baseline: string | undefined,
  ): Promise<PromptPollStep> {
    await new Promise((resolve) => setTimeout(resolve, FETCH_CURRENT_PROMPT_POLL_MS))
    let delta: unknown[] = []
    let newLeafId: string | null = null
    try {
      // 哨兵感知（getEntriesSince）：'' 基线无参全量拉，undefined 同样全量（?? 挡不住 ''）
      const result = await this.getEntriesSince(client, baseline) as { data?: { entries?: unknown[]; leafId?: string | null } }
      delta = result.data?.entries ?? []
      newLeafId = result.data?.leafId ?? null
    } catch (e) {
      if (isEntryNotFoundError(e)) {
        this.traceLeafCache.delete(sessionId)
        return 'retry'
      }
      throw e
    }
    const hit = [...delta].reverse().find(
      (e) => (e as { type?: unknown; customType?: unknown })?.type === 'custom'
        && (e as { customType?: unknown })?.customType === CURRENT_SYSTEM_PROMPT_CUSTOM_TYPE,
    )
    if (newLeafId) this.traceLeafCache.set(sessionId, newLeafId)
    return { hit: hit ?? null, delta, newLeafId }
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
   * subagent 生命周期/定向消息操作（经扩展 slash command，不经 LLM）。
   * 对称 workflowAction 的转发模式：client.prompt("/subagents <action> ...")。
   * 扩展侧 RPC 分支解析（command-actions.ts parseSubagentRpcCommand）：
   * - cancel：<subagentId>（service.cancel → SIGTERM kill 子进程）
   * - message：<subagentId> <text>（subagent 续聊，热路径 stdin 直写 prompt）
   * - start：<slug> <task>（conversation:true 可续聊的新 subagent）
   * text/task 经 encodeDirectiveText 编码（换行 → 字面 \n，命令保持单行）。
   *
   * 刻意直接 client.prompt 绕过 dispatcher busy 预检 / BeforeSend hook（对称
   * promptReload 的绕过模式）：定向消息必须「主 agent 生成中也能发」（设计 §3.3.4
   * 直达目标），且 hook 审核的是主 agent prompt，不适用于 subagent 定向文本。
   */
  async subagentAction(
    sessionId: string,
    action: 'cancel' | 'message' | 'start',
    params: { subagentId?: string; text?: string; slug?: string; task?: string },
  ): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not active`)
    if (action === 'cancel') {
      // 错误指向恢复动作：字段缺失是调用方协议错误，fail-fast 让 WS error envelope 暴露
      if (!params.subagentId) throw new Error('[session-service] subagentAction cancel: subagentId is required')
      await client.prompt(`/subagents cancel ${params.subagentId}`)
      return
    }
    if (action === 'message') {
      if (!params.subagentId || !params.text) {
        throw new Error('[session-service] subagentAction message: subagentId and text are required')
      }
      await client.prompt(`/subagents message ${params.subagentId} ${encodeDirectiveText(params.text)}`)
      return
    }
    if (!params.slug || !params.task) {
      throw new Error('[session-service] subagentAction start: slug and task are required')
    }
    await client.prompt(`/subagents start ${params.slug} ${encodeDirectiveText(params.task)}`)
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

  /**
   * U3（composer 四符号 §3.3.5）：reload 完成后失效 commands 快照（slash 列表动态刷新
   * 链路闭合点）。失效点挂在这里的时机依据（设计 F8）：pi 对 extension 命令
   * `await _tryExecuteExtensionCommand`（agent-session.js:800），promptReload resolve 即
   * reload 已完成；而 `session_start(reason='reload')` 事件是 extension-only 不出 stdout
   * （agent-session.js:2072），runtime 侧不存在可订阅的 reload 完成事件。
   *
   * 事件只做失效（对齐 applyContextUpdate 范式）——markDirty 置 dirty + 防抖重拉
   * get_commands（commands 实例唯一数据写路径），重拉成功后经既有挂钩
   * fetchCommandsSnapshot 内的 publishCommandsSnapshot 自动广播 session.commands，
   * 本方法无需额外广播。
   */
  handleSessionReloaded(sessionId: string): void {
    this.replicatedStates.get(sessionId)?.commands.markDirty()
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
      // 打包产物断链（builtin staged 目录缺失）不可降级：rethrow 贯通 resolver 的
      // fail-fast（electron-build R3-S1）——吞掉会让无 presetId 的 session 启动路径
      // pi 无 --extension 静默启动（system-prompt 注入 / msg-id 映射无声失效），
      // 与 preset 路径（getLaunchPresetOptions 全链无 catch）语义对齐，错误冒泡到
      // session handler 可见。其余意外错误维持降级（旧版兼容：空列表不阻断会话）。
      if (typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === BUILTIN_EXTENSIONS_MISSING) throw e
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
      // B-2：agent-managed 标记透传——list 按 spawnSource/parentAgentSessionId 过滤时
      // active session 走本路径（scanned 路径被 activeFilePaths 排除），漏透传 = 过滤失效。
      spawnSource: (s as ManagedSession).spawnSource,
      parentAgentSessionId: (s as ManagedSession).parentAgentSessionId,
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
      // catch 内有 console.error（非 silent catch），无需 no-silent-catch 豁免。
    } catch (e: unknown) {
      // 降级策略（best-effort）：插件回调异常不阻断创建主流程，仅落日志供排查
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
    // session-trace（A33）：同汇聚点清 trace 增量腿基线与串行链（与 historyCache 同因——
    // 基线跨进程存活无意义；链已 settled，删 Map 条目只释放槽位）。
    this.traceLeafCache.delete(sessionId)
    this.traceSyncChains.delete(sessionId)
    // W7/W8：销毁 per-session 实例组（与 historyCache.delete 同汇聚点——主动删 + 进程退出）。
    // dispose 停防抖/退避/周期兜底全部定时器（thinkingLevel 的 30s poll 不清会泄漏定时器）。
    const replicated = this.replicatedStates.get(sessionId)
    if (replicated) {
      replicated.thinkingLevel.dispose()
      replicated.modelId.dispose()
      replicated.usage.dispose()
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
      // PR #185 MF2：queue_update 帧不再对 queue 实例 markDirty（实例已撤销——.get() 生产
      // 零消费，防抖重拉 get_state 属无效 RPC）。深度真值 = 帧内 pendingMessageCount
      //（pi 队列深度的推送投影，与 get_state 快照同公式同源），renderer 对账直读帧值。
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
   * W7/W8：注册 per-session 实例组（四实例）并 refetch 播种。
   * 配置即登记表条目（replicated-states.config.ts）；fetch 统一走窄访问器（fetchStateSnapshot /
   * fetchSessionStatsSnapshot / fetchCommandsSnapshot，复用 rpc-client 对应方法）。
   * 幂等注册（同 id 重复注册先 dispose 旧实例，防定时器泄漏）。
   */
  private registerReplicatedStates(sessionId: string): SessionReplicatedStates {
    const existing = this.replicatedStates.get(sessionId)
    if (existing) {
      existing.thinkingLevel.dispose()
      existing.modelId.dispose()
      existing.usage.dispose()
      existing.commands.dispose()
    }
    // W12：modelId / thinkingLevel 的 fetch 走带 state_changed 发布挂钩的包装（快照应用后
    // 组合投影）；usage / commands 的 fetch 各自带发布挂钩（fetchSessionStatsSnapshot /
    // fetchCommandsSnapshot），无需裸 fetchState。
    const fetchStateForStateChanged = () => this.fetchStateSnapshotWithStatePublish(sessionId)
    const states: SessionReplicatedStates = {
      thinkingLevel: new ReplicatedState(createThinkingLevelStateConfig(fetchStateForStateChanged)),
      modelId: new ReplicatedState(createModelIdStateConfig(fetchStateForStateChanged)),
      usage: new ReplicatedState(createUsageStateConfig(() => this.fetchSessionStatsSnapshot(sessionId))),
      commands: new ReplicatedState(createCommandsStateConfig(() => this.fetchCommandsSnapshot(sessionId))),
    }
    this.replicatedStates.set(sessionId, states)
    states.thinkingLevel.refetch()
    states.modelId.refetch()
    states.usage.refetch()
    states.commands.refetch()
    return states
  }

  /**
   * W7：get_state 快照拉取——thinkingLevel / modelId 实例的唯一 fetch 入口
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
   *
   * D1（context-consistency Phase 1）：fetch 成功且投影为空快照（pi tokens=null 合法无值）
   * 时挂钩改发「无值占位帧」（仅含 sessionId，typeKey='context' last-value 显式登记无值态，
   * 切回的 stateSnapshot 回放可区分「该 session 无值」与「从未收到帧」）。空投影判定在
   * fetch 返回值上做而非实例 .get()——ownerSnapshotMerge 对空快照保持旧值，.get() 拿到的
   * 是旧值不是「空」；.get() 为 undefined（从未 fetch 成功 / 退避窗口）时值可能马上就来，
   * 不发占位帧防消费方误写 no-value。
   */
  private async fetchSessionStatsSnapshot(sessionId: string): Promise<Record<string, unknown> | undefined> {
    const client = this.pm.getClient(sessionId)
    if (!client) {
      throw new Error(`[session-service] get_session_stats unavailable: no active pi client for session ${sessionId}`)
    }
    const stats = await client.getSessionStats() as Record<string, unknown> | undefined
    const noValue = isUsageNoValueProjection(stats)
    setTimeout(() => {
      if (noValue) {
        this.publishContextNoValuePlaceholder(sessionId)
      } else {
        this.publishContextFromSnapshot(sessionId)
      }
      this.publishStateChangedFromSnapshot(sessionId)
    }, 0)
    return stats
  }

  /**
   * W12：读 usage 实例快照发布 context.update（state topic，last-value == owner 快照）。
   * 三字段任一 undefined 不发布（快照未就绪——fetch 失败退避 / 播种竞速窗口；真无值走
   * publishContextNoValuePlaceholder 占位帧，见 fetchSessionStatsSnapshot D1 注释）。
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
   * D1（context-consistency Phase 1）：无值占位帧——仅含 sessionId 的 context.update。
   * 触发条件 = 本次 fetch 成功且投影为空快照（pi tokens=null；见 fetchSessionStatsSnapshot
   * 的判定注释）。写入 typeKey='context' 的 last-value 后，stateSnapshot 回放能区分「该
   * session 无值」与「从未收到帧」。协议层语义：字段缺失 = 无值（0 基线帧已随 D1 消失）。
   */
  private publishContextNoValuePlaceholder(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return // session 已销毁：不 publish（防 bus 重建已 clearSession 的 entry）
    const msg: ServerMessage = {
      type: 'context.update',
      id: `ctx_${Date.now()}`,
      payload: { sessionId },
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
   * W12：读 modelId / thinkingLevel 两实例快照组合发布 session.state_changed
   *（state topic，payload 全字段来自实例快照）。
   *
   * 触发点 = 各实例的 fetch 成功挂钩（fetchStateSnapshotWithStatePublish /
   * fetchSessionStatsSnapshot）——任一实例快照应用后刷新组合，全部收敛后 last-value 为
   * 终态组合（中间态帧由下方 diff 抑制去重，renderer 幂等覆盖）。
   * 快照缺失字段 fallback 双写缓存（session.modelId / thinkingLevel）——登记的永久形态
   * （PR #185 S2 裁决，2026-08-20）：播种 refetch 实例异步竞速，先落定者即触发本发布，
   * 未落定实例 .get() 为 undefined；get_state 失败退避（1s/5s/15s）窗口同理。缓存由
   * switchModel / setThinkingLevel RPC 成功后直写保持最新，兜底值即 pi 生效值。
   * D1（context-consistency Phase 1）：usage 三字段已从本帧删除——usage 只经 context.update
   * 一条帧贯穿，本方法不再投影 usage（旧「无快照 ?? 0 基线」随协议删除）。
   * diff 抑制：thinkingLevel 的 30s 周期兜底重拉会高频触发挂钩，同值组合不重复发帧。
   */
  private publishStateChangedFromSnapshot(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return // session 已销毁：不 publish（防 bus 重建已 clearSession 的 entry）
    const session = this.sessions.get(sessionId)
    const states = this.replicatedStates.get(sessionId)
    if (!session || !states) return
    const payload = buildStateChangedPayload(sessionId, session, states)
    const last = this.lastPublishedStateChanged.get(sessionId)
    if (last && stateChangedPayloadEquals(last, payload)) return
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
  private readonly lastPublishedStateChanged = new Map<string, SessionStateChangedBaseline>()

  /**
   * W12：modelId / thinkingLevel 实例的 fetch 包装——get_state 快照应用后挂钩发布
   * session.state_changed（组合投影）。与 fetchStateSnapshot 的关系：多一层「fetch 落定
   * （成功或失败）→ setTimeout 0 宏任务发布」（宏任务晚于 doFetch 的 applySnapshot 微任务
   * 链，成功路径发布读到的必是已应用快照）。失败路径同样排发布：payload 走快照缺失的
   * fallback 双写缓存（永久形态，见 publishStateChangedFromSnapshot 注释）——对齐旧
   * broadcastSessionState「get_state 失败不阻塞、thinkingLevel 回退缓存值」语义；
   * rethrow 由 finally 透传，实例退避重试语义不变。
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
   * 前端 useContextUsage composable 的恢复腿（每次切入视图拉 session.getContext）保证到达。
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

/** fetchCurrentSystemPrompt 单轮轮询产物；'retry' = 基线跨 pi 进程失效，需全量重建后再轮。 */
type PromptPollStep =
  | 'retry'
  | { hit: unknown; delta: unknown[]; newLeafId: string | null }

/** 从命中的 xyz:current-system-prompt custom entry 提取响应载荷（缺字段降级为空值）。 */
function extractCurrentPromptHit(sessionId: string, hit: unknown): ServerMessageMap['session.currentSystemPrompt'] {
  const data = (hit as { data?: Record<string, unknown> }).data
  const fullText = typeof data?.fullText === 'string' ? data.fullText : ''
  const charCount = typeof data?.charCount === 'number' ? data.charCount : fullText.length
  const fetchedAt = typeof data?.fetchedAt === 'string' ? data.fetchedAt : ''
  return { sessionId, fullText, charCount, fetchedAt }
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
 * D1（context-consistency Phase 1）：get_session_stats 响应是否为「合法无值」投影。
 * 与 createUsageStateConfig.fetchSnapshot 的投影口径镜像对齐：
 * - stats / stats.contextUsage 非对象 = 协议异常（fetchSnapshot 会 throw WireSnapshotSchemaError，
 *   实例退避重试）——fetch 未成功，不发占位帧，返回 false；
 * - contextUsage.tokens 非 number（pi tokens=null，compact 后无新 turn）= 空快照 {}——
 *   合法无值，返回 true。
 */
function isUsageNoValueProjection(stats: Record<string, unknown> | undefined): boolean {
  if (typeof stats !== 'object' || stats === null) return false
  const cu = stats.contextUsage
  if (typeof cu !== 'object' || cu === null) return false
  return typeof (cu as Record<string, unknown>).tokens !== 'number'
}

/**
 * W12：state_changed 组合投影的 diff 基线形状（2 字段；sessionId 是 map key 恒同值，不参与 diff）。
 * buildStateChangedPayload 产出的 payload 含 sessionId 字段，结构上是本形状的超集，可直接入基线。
 * D1：usage 三字段已从基线删除（协议收敛，payload 不再携带 usage）。
 */
interface SessionStateChangedBaseline {
  modelId: string
  thinkingLevel: string | undefined
}

/**
 * W12：modelId / thinkingLevel 两实例快照 → session.state_changed 组合投影 payload。
 * 快照缺失字段 fallback 双写缓存（session.modelId / thinkingLevel）——登记的永久形态
 * （PR #185 S2 裁决，2026-08-20）：播种 refetch 异步竞速 + 失败退避窗口内 .get() 为
 * undefined，缓存兜底（写方 = switchModel / setThinkingLevel RPC 成功后直写）。
 * D1（context-consistency Phase 1）：usage 三字段不再投影（usage 只经 context.update 帧，
 * 旧「无快照 ?? 0 基线」编码随协议删除）。
 */
function buildStateChangedPayload(
  sessionId: string,
  session: ManagedSession,
  states: SessionReplicatedStates,
): SessionStateChangedBaseline & { sessionId: string } {
  return {
    sessionId,
    modelId: states.modelId.get()?.modelId ?? session.modelId,
    thinkingLevel: states.thinkingLevel.get()?.thinkingLevel ?? session.thinkingLevel,
  }
}

/**
 * W12：state_changed 组合投影的 diff 判定（2 字段全等 → 同值组合不重复发帧）。
 * thinkingLevel 的 30s 周期兜底重拉会高频触发发布挂钩，靠本判定抑制重复帧。
 */
function stateChangedPayloadEquals(a: SessionStateChangedBaseline, b: SessionStateChangedBaseline): boolean {
  return a.modelId === b.modelId
    && a.thinkingLevel === b.thinkingLevel
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
