// 执行编排 + 记录领域 Service（D4 按变化轴拆分后的编排核：execute/executeAndAwait 入口、
// record 生命周期、cancel）。通知簇 → notify-host.ts；轮次结算闭包 → round-settlement.ts；
// 冷路径复活 → cold-resurrect.ts。
// 上游：subagent-tool（execute/query/cancel）、TUI（onChange/collectRecords）。
// session_start 时经 initSession 注入 pi；modelRegistry/entries 归 ModelConfigService.initModel。

import { AsyncLocalStorage } from "node:async_hooks";

import { getLogger } from "../core/logger.ts";

import type { ExtensionMode } from "./host-mode.ts";

import type { AgentResult as WorkflowAgentResult } from "../orchestration/models/types.ts";
// D-A10: workflow 侧 AgentResult 映射（executeAndAwait 出口）
import { mapToWorkflowAgentResult } from "./agent-result-mapper.ts";
import { removeAliveMarker } from "./alive-store.ts";
import { bestEffort } from "./best-effort.ts";
// [V2 决策 3] lifecycle-manager idle timer：chatMode 统一投递新 turn disarm（防误杀活进程）。
// [M3] hasIdleTimer：notify-host 的 piAdapter.hasRunningBackground 排除等待续聊（timer armed）
// 的 record（D4-① 随通知簇搬移）。
import { disarmIdleTimer } from "./lifecycle-manager.ts";
import { type ConcurrencyPool,DefaultConcurrencyPool } from "./concurrency-pool.ts";
import type { DialogGlobalQueue, UiRequestHandler } from "./dialog-queue.ts";
import { COLD_LOOKUP_SCAN_LIMIT, coldLookupForAction, type ColdResurrectDeps } from "./cold-resurrect.ts";
import {
  completeRecord,
  createRecord,
  project,
  snapshot,
  tryTransition,
} from "./execution-record.ts";
import { doFinalizeRecord, doFinalizeRoundToIdle } from "./finalize-record.ts";
import { assertTaskShapeSupported } from "./engine/common/capability-gate.ts";
import { ExecutionNestingContext } from "./engine/common/nesting-guard.ts";
import { JOURNAL_INITIAL_POOL_KEY, wireEventJournal } from "./engine/common/journal-wiring.ts";
import { executeOptionsToEngineTaskSpec } from "./engine/host-task-spec.ts";
import { PiEngine } from "./engine/engines/pi/pi-engine.ts";
import { PI_POOL_KEY } from "./engine/engines/pi/pi-engine.ts";
import type { ChatRoundTicket, PiEngineService } from "./engine/engines/pi/pi-engine.ts";
import type { EnginePort, RunContext } from "./engine/port.ts";
import { DEFAULT_ENGINE_ID, getEngine } from "./engine/registry.ts";
import { type EngineRouteResult, routeEngineForHost } from "./engine/routing.ts";
import type { AgentOutcome } from "./engine/types.ts";
import { ManifestStore } from "./manifest-store.ts";
import type { ModelConfigService } from "./model-config-service.ts";
import type { AgentConfig, ModelInfo, ResolvedModel } from "./model-resolver.ts";
import { type NotifyHost, type PiLike, createNotifyHost } from "./notify-host.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "./path-encoding.ts";
import { createRoundSettler } from "./round-settlement.ts";
import type { StatusFilter } from "./record-store.ts";
import { RecordStore } from "./record-store.ts";
import { MAX_FORK_DEPTH } from "./session-context-resolver.ts";
import { getChildByRecord, killAllSpawnedChildren, registerSpawnedChildForRecord, runSpawn, type SessionRunnerContext, type SpawnResumeOpts } from "./engine/engines/pi/session-runner.ts";
import { isIdle, isResumable } from "./lifecycle-predicates.ts";
import { startIdleGc } from "./idle-gc.ts";
import { resetAllEpipeFailures } from "./engine/engines/pi/stdin-writer.ts";
import type { StreamSink, SubagentStream } from "./stream-sink.ts";
import { createBackgroundStream } from "./stream-sink.ts";
import { writeCancelledTombstone } from "./tombstone-store.ts";
import type { WorktreeHandle } from "./types.ts";
import type {
  AgentEvent,
  AgentResult,
  ClosedReason,
  ExecuteOptions,
  ExecutionHandle,
  ExecutionMode,
  ExecutionRecord,
  RecordSnapshot,
  SubagentRecord,
} from "./types.ts";
import { ForkDepthExceededError } from "./types.ts";
import { DEFAULT_AGENT_NAME } from "./types.ts";
import { registerGlobalObservability, UiRequestObservability } from "./ui-request-observability.ts";
import { WorktreeManager } from "./worktree-manager.ts";

const logger = getLogger("subagents");

/** [D4 查询面聚合] 读模型轴（record 快照读取 + store 订阅）——Service 上的
 *  `service.queries` 消费面。变化轴：改查询投影 / 过滤 / 订阅语义，只动 queries 组；
 *  Service 本体保留编排核（execute/executeAndAwait/cancel）与生命周期面。 */
export interface SubagentQueries {
  /** 按 id 查内存 running record 的只读快照（G3-002 修复）。不存在返回 undefined。 */
  findRecord(id: string): RecordSnapshot | undefined;
  /** [v8.5 A1/B] 全态查找：任意状态 × 任意归属的 record 快照（message 拒绝文案分流
   *  与 fork-from 源解析共用）。id 在内存与磁盘均不存在返回 undefined。 */
  lookupRecordAnyState(id: string): SubagentRecord | undefined;
  /** 合并内存 + 磁盘 record（/subagents list + tool list 消费，按 rootSessionId 过滤）。 */
  collectRecords(limit: number, statusFilter?: StatusFilter): SubagentRecord[];
  /** [perf] 单 record 详情懒加载（全量：eventLog/displayItems/result/turns/tokens）。 */
  getFullRecord(id: string): SubagentRecord | undefined;
  /** 订阅 store 变更（widget/list requestRender）。返回取消订阅。 */
  onChange(listener: () => void): () => void;
}

/** [D4 对话 action 面聚合] chat 域 message/close action 轴（M2-B3，原 Service 同节三方法）
 *  ——Service 上的 `service.chatActions` 消费面。变化轴：改对话域归属校验 / close 分流 /
   投递编排，只动 chatActions 组。 */
export interface SubagentChatActions {
  /** 按 id 查 record 并做归属校验（message/close action 的统一入口）。 */
  getRecordForAction(id: string, opts?: { allowReconnect?: boolean }): ExecutionRecord;
  /** close action 的统一行为分流（running 子态 × force）。 */
  closeSubagent(record: ExecutionRecord, force: boolean): Promise<void>;
  /** chatMode 统一投递入口（message action，经引擎交互面执行）。 */
  deliverChatMessage(record: ExecutionRecord, text: string, interrupt: boolean): Promise<void>;
}

// [v4 A-1] EPIPE 连续失败计数器在 stdin-writer.ts（stdin 错误域，避免 session-runner
// 反向 import 本文件 helper 产生循环依赖）。同步路径（PiEngine 热路径投递，D2 协议知识
// 下沉后）与异步路径（session-runner child.stdin.on('error')）共用 stdin-writer 的同一计数器。

/** dispose 后注入的 stub UI 请求 handler。
 *
 * [背景] Pi 单进程 session 串行接管。session A shutdown 时 SIGTERM 子进程后、
 * 子进程彻底 close 前（pi 子进程 trap SIGTERM 做 graceful shutdown，窗口几十~几百 ms），
 * 子进程的 trailing extension_ui_request 仍可能被父进程 pump 解析，调到 A 的 handler 闭包。
 * 若 dispose 不清 uiRequestHandler，旧 handler 闭包仍持有 A 的 ctx，触发
 * ui-request-queue.ts 的 catch 分支打 `[subagents] uiRequestHandler threw` 误导性
 * logger.error（看起来像 bug，实际是预期竞态；三层兜底已确保功能正确）。
 *
 * stub 始终返回 {cancelled:true}，不调 ctx.ui、不捕获任何 ctx，让 trailing ui_request
 * 干净降级为 cancelled（等价于子进程主动取消）。
 *
 * 不置 undefined —— 那会让 trailing ui_request 走 ui-request-queue.ts 的 handler-missing
 * 分支触发 notifyMissingHandlerGlobal warn，噪声性质从 threw-error 变 missing-handler，
 * 没真正解决。 */
const disposedUiRequestStub: UiRequestHandler = () => Promise.resolve({ cancelled: true });

/** UI streaming sink 的最小接口（ctx.ui.setWidget 的 duck-typed 子集）。
 *  session_start 时从 ctx.ui 注入，background 执行期间用于把合并后的 text_delta
 *  通过 setWidget 通道转发到 RPC stdout（不经 sendMessage 的持久化路径）。 */
export type { StreamSink } from "./stream-sink.ts";

/** Service 构造参数（进程级）。 */
export interface SubagentServiceInit {
  cwd: string;
  /** 配置/模型域 Service（execute 内部调其 resolveModel）。 */
  modelService: ModelConfigService;
  /** 缓存的主 session file 获取函数（fork source 解析用）。 */
  getMainSessionFile?: () => string | undefined;
  /** W2: UI 请求处理回调（ask_user 扩展）。
   *  签名见 dialog-queue.ts UiRequestHandler：接收 UiRequest，返回 UiResponse。 */
  uiRequestHandler?: UiRequestHandler;
}

/** session_start 注入参数（session 级）。 */
export interface SubagentServiceSessionInit {
  pi: PiLike;
  sessionId: string;
  /** 主 session 文件路径（session_start 解析后直传）。
   *  [E2E 实测] 不能经闭包缓存（getCachedMainSessionFile）读：jiti 多实例分裂下闭包
   *  变量不跨实例共享，恢复逻辑读到的是滞后一个事件的值（读到未 flush 的新 session
   *  ENOENT 路径，entry-born 孤儿整段漏判）。 */
  mainSessionFile?: string;
  /** UI streaming sink（ctx.ui.setWidget），用于 background text_delta 转发。 */
  streamSink?: StreamSink;
  /** 主进程运行模式（W4 守卫：headless 不注入 ask_user RPC 提示词）。
   *  initSession 读取后存入 this.sessionMode，buildSessionRunnerContext 透传给 session-runner。 */
  mode?: ExtensionMode;
  /** UI 请求 handler（session 级覆盖进程级）。
   *  [D4-④ UI 接线外提] 本字段是 handler 的唯一注入入口（原 setUiRequestHandler 方法已删）。
   *  三态语义：undefined = 不动（保留进程级构造/上次值，供不注入 handler 的调用方）；
   *  null = 显式清空（承载原 setUiRequestHandler(undefined) 语义——headless 的
   *  createUiRequestHandlerForMode 返回 undefined 时壳侧传 null）；值 = 注入并重置
   *  缺失告警去重。 */
  uiRequestHandler?: UiRequestHandler | null;
  /** L2 跨子进程全局 dialog 串行队列（进程单例）。透传给 session-runner，
   *  child close 时调 rejectChildDialogs 清理 pending（SR-4 防全局死锁）。 */
  dialogQueue?: DialogGlobalQueue;
  /** [竞态修复] 主 agent 是否空闲查询（ctx.isIdle），透传给 notifier 的 flush isIdle gate。
   *  避免 background 完成通知在 agent_end→finishRun 窗口里走错 sendMessage 分支丢失。
   *  可选：未注入时 notifier flush 不 gate（原行为）。 */
  isIdle?: () => boolean;
}

/** background 优先级（保留 priority 排序机制，单一值）。 */
const PRIORITY_BACKGROUND = 1000;

/** 跨进程身份贯穿的 env 名（父进程 spawn 子进程时注入，子进程 initSession 读取）。
 *  仿照 PI_SUBAGENT_FORK_DEPTH 机制，让递归 subagent 的身份（rootSessionId / parentRecordId / depth）
 *  跨进程传递，使主进程 /subagents 能看到完整递归树（设计见 docs/design/recursive-subagent-visibility.md）。
 *  语义：env 描述「子进程自己的身份」，不是父的身份（决策 1）。
 *  [MF-3] 第 4 个 env：真 ROOT 的 cwd（PI_SUBAGENT_ROOT_CWD）。worktree 模式下子进程 spawn cwd =
 *  checkout 路径，若按各自 cwd 编码落盘目录，深层 record 写到 enc(worktree) 段、ROOT 磁盘重建
 *  扫不到 → 全树可见性深度 ≥ 2 断裂。子进程经本 env 拿 ROOT cwd，sessions 与 records 两套目录
 *  统一编码在 enc(ROOT cwd) 段（与身份贯穿同构，见 session-runner 注入点）。 */
const ENV_ROOT_SESSION_ID = "PI_SUBAGENT_ROOT_SESSION_ID";
const ENV_SELF_RECORD_ID = "PI_SUBAGENT_SELF_RECORD_ID";
const ENV_DEPTH = "PI_SUBAGENT_DEPTH";
const ENV_ROOT_CWD = "PI_SUBAGENT_ROOT_CWD";

/** resolveIdentity 的产物——一次确定、写入 record 后不再变。 */
interface ResolvedIdentity {
  agent: string;
  agentConfig: AgentConfig | undefined;
  resolved: ResolvedModel;
}

/**
 * 执行编排 Service。进程级单例。
 *
 *   session_start:
 *     1. modelService = getModelConfigService() ?? new ModelConfigService({homeDir, agentDir})
 *     2. service = getSubagentService() ?? new SubagentService({cwd, modelService})
 *     3. modelService.initModel({modelRegistry, sessionId, entries})
 *     4. service.initSession({pi, sessionId})
 *
 *   session_shutdown:
 *     service.dispose()
 */
export class SubagentService {
  private readonly pool: ConcurrencyPool;
  private readonly store: RecordStore;
  private readonly modelService: ModelConfigService;
  private readonly cwd: string;
  private readonly worktreeManager: WorktreeManager;
  private readonly getMainSessionFile: (() => string | undefined) | undefined;
  /** UI 请求 handler（进程级，可被 setUiRequestHandler / initSession 覆盖）。 */
  private uiRequestHandler: SubagentServiceInit["uiRequestHandler"];
  /** L2 dialog 串行队列（进程级）。SR-4：child close 时 session-runner 调 rejectChildDialogs 清理。 */
  private dialogQueue: DialogGlobalQueue | undefined;
  /** UI 请求可观测性（sessionMode + handler 缺失告警去重，提取自本类降低行数）。 */
  private readonly uiObservability = new UiRequestObservability();
  private pi: PiLike | null = null;
  /** 当前 Pi session ID（本进程 pi session，事件路由等用；record 过滤不用它）。initSession 时注入。 */
  private sessionId: string | null = null;
  /** 主 session 文件（initSession 按值直传——jiti 多实例下闭包缓存不可靠，见 SessionInit 注释）。 */
  private mainSessionFile: string | undefined;
  /** 所属根 session ID（record 归属过滤用）。根进程 = sessionId（自己是 root）；
   *  子进程 = env PI_SUBAGENT_ROOT_SESSION_ID 贯穿的真 ROOT（initSession 读取）。
   *  与 sessionId 正交：sessionId 是本进程 pi session（事件路由等），sessionRootId 是所属根
   *  （collectRecords filter 用，与 createRecordForMode 的 rootSessionId 盖章同源——子进程
   *  因此看到整棵 ROOT 树）。设计见 recursive-subagent-visibility.md 决策 3。 */
  private sessionRootId: string | null = null;
  /**
   * [D3-⑤ 嵌套防护合一] 进程内执行嵌套上下文（原 execCtxAls 私有字段下沉公共层
   * common/nesting-guard.ts ExecutionNestingContext——机制注释含 ALS 断裂基线兜底）。
   * 实例 per-Service：基线随宿主进程身份而异（initSession 从 env 建立）。
   */
  private readonly execNesting = new ExecutionNestingContext();
  /** fork 深度基线（同 ALS 断裂问题：forkDepthAls.getStore() 兜底用）。根进程=0。 */
  private forkDepthBaseline = 0;
  /** [MF-3] 所属根进程 cwd（sessions/records 落盘目录编码键）。
   *  根进程=自身 cwd（构造时 init.cwd）；子进程=env PI_SUBAGENT_ROOT_CWD 贯穿的真 ROOT cwd。
   *  worktree 模式下子进程 this.cwd 是 checkout 路径，若按它编码目录，深层 record 落到
   *  enc(worktree) 段、ROOT 扫描不到 → 全树可见性深度 ≥ 2 断裂（与 sessionRootId 同构）。 */
  private rootCwd: string;
  /** UI streaming sink（ctx.ui.setWidget）。workflow 域经 getStreamSink() 取用。 */
  private streamSink: StreamSink | null = null;
  /** [竞态修复] 主 agent isIdle 查询（ctx.isIdle）。notifier flush gate 用。
   *  initSession 注入，piAdapter 透传给 NotifierHost。 */
  private isIdleFn: (() => boolean) | undefined;
  getStreamSink(): StreamSink | null { return this.streamSink; }
  private _disposed = false;
  private _seq = 0;
  /** [D4-①] 通知簇 host 面（notifyComplete/notifyClosed/pending 注册注销 + notifier
   *  实例封装，原私有通知簇四方法与模块函数的搬移落点——notify-host.ts）。
   *  deps 惰性求值（pi/session 级状态运行时可变），行为与原 constructor 内
   *  createNotifier(this.piAdapter()) 逐字节等价。session_start revive，shutdown dispose。 */
  private readonly notifyHost: NotifyHost = createNotifyHost({
    getPi: () => this.pi,
    listRunning: () => this.store.listRunning(),
    getIsIdle: () => this.isIdleFn,
  });
  /** [MF#4][MF#2] fork 深度按 async 调用链传递（AsyncLocalStorage），替代共享可变计数器。
   *  主 session=0；fork 进入子 session 期间推进为子深度，供嵌套 fork 经 ALS 读到自身深度作为
   *  parentForkDepth。并发 background fork 各自独立调用链，不再互相压低深度值。
   *  [MF#2] 旧实现用单实例字段跨执行链共享 → 并发下 A 还原深度后 B 读到被压低值 → 护栏失效。 */
  private readonly forkDepthAls = new AsyncLocalStorage<number>();

  // [D3-⑤] subagent 执行上下文（record 身份 + 递归深度）的 ALS 传递已下沉公共层
  // （execNesting 字段，common/nesting-guard.ts）——「B run() 期间挂身份，B 内创建 C
  // 时读到 B」的机制与 ALS 断裂基线兜底注释见该文件。与 forkDepthAls 独立：后者只数
  // fork 链（fork=true 才递增），嵌套上下文数所有 subagent 嵌套。

  /** [review MF1] record 级在途 resume 守卫。冷路径续轮（resumeChatRound）全部守卫通过后
   *  add，runAndFinalize 结束（finally，覆盖轮次完成 / MF-6 失败回退 / abort / 终态化所有
   *  分支）时 delete（幂等：execute() 新建 record 不在集合，no-op）。窗口 = resume 发起
   *  （含 pool.acquire 排队）→ 本轮 runAndFinalize 收尾。窗口内同 record 再次到达续轮
   *  （冷路径重入 / EPIPE 兜底）直接 throw——防两个 pi 子进程以 --session 同一 JSONL 双写 +
   *  前一个脱离 kill 记账成孤儿（冷路径的 acquireActivateLock 只覆盖续轮同步段，锁释放
   *  在子进程注册（session-runner spawnedChildren.set）之前，锁空洞由此守卫兜住；EPIPE
   *  兜底不持锁，同样被覆盖）。child 注册完成后投递走热路径，不经此守卫。 */
  private readonly resumesInFlight = new Set<string>();

  /** chat 域 pi 引擎实例（D2 单轨：chat 域执行/投递统一经 EnginePort）。per-service DI——
   *  getService 经适配器绑本实例；registry 全局 'pi' 单例绑进程级 getSubagentService()，
   *  直构 Service 的测试场景解析不到本实例。不能 import registration.ts（其 import 本文件
   *  → 循环依赖），直接构造 PiEngine（pi-engine 不反向依赖本文件）。 */
  private readonly chatPiEngine: PiEngine = new PiEngine({ getService: () => this.piEngineServiceAdapter() });

  /** chat 域轮次交接包（executeViaEngine / 冷路径续轮挂载 → PiEngine.run 经 taskId 消费）。 */
  private readonly chatRoundTickets = new Map<string, ChatRoundTicket>();

  /** [D4-②] 轮次结算回调（原 buildSessionRunnerContext 内的 onRoundSettled 业务闭包
   *  搬移至 round-settlement.ts；deps 回调闭包惰性求值，session-runner agent_settled 时消费）。 */
  private readonly settleRound = createRoundSettler({
    notifyComplete: (record) => this.notifyHost.notifyComplete(record),
    reportRecordTransition: (record) => this.store.reportRecordTransition(record),
    closeAfterRoundSettled: (record) => this.closeAfterRoundSettled(record),
  });

  /** [D4-③] 冷路径复活依赖（原四件 private 方法的搬移落点——cold-resurrect.ts；
   *  deps 闭包惰性求值：sessionRootId / execNesting 基线运行时可变）。 */
  private readonly coldResurrectDeps: ColdResurrectDeps = {
    findLightById: (id) => this.store.findLightById(id),
    collectRecords: (limit, statusFilter, rootFilter) =>
      this.store.collectRecords(limit, statusFilter, rootFilter),
    register: (record) => this.store.register(record),
    reportRecordTransition: (record) => this.store.reportRecordTransition(record),
    getSessionRootId: () => this.sessionRootId,
    getBaselineRecordId: () => this.execNesting.baseline()?.recordId ?? undefined,
  };

  /** [D4 查询面聚合] 读模型消费面（壳 interface/ 视图与 tool 查询经此访问；
   *  纯委托——方法本体保留 private 实现不重写，行为逐字节等价）。 */
  readonly queries: SubagentQueries = {
    findRecord: (id) => this.findRecord(id),
    lookupRecordAnyState: (id) => this.lookupRecordAnyState(id),
    collectRecords: (limit, statusFilter) => this.collectRecords(limit, statusFilter),
    getFullRecord: (id) => this.getFullRecord(id),
    onChange: (listener) => this.onChange(listener),
  };

  /** [D4 对话 action 面聚合] chat 域 message/close 消费面（壳 subagent-actions 经此访问；
   *  纯委托同上。PiEngineService 适配器不经此——引擎边界走 piEngineServiceAdapter）。 */
  readonly chatActions: SubagentChatActions = {
    getRecordForAction: (id, opts) => this.getRecordForAction(id, opts),
    closeSubagent: (record, force) => this.closeSubagent(record, force),
    deliverChatMessage: (record, text, interrupt) => this.deliverChatMessage(record, text, interrupt),
  };

  private readonly manifestStore: ManifestStore;

  constructor(init: SubagentServiceInit) {
    this.cwd = init.cwd;
    this.modelService = init.modelService;
    this.getMainSessionFile = init.getMainSessionFile;
    this.uiRequestHandler = init.uiRequestHandler;
    this.pool = new DefaultConcurrencyPool(this.modelService.getGlobalConfig().maxConcurrent);
    this.worktreeManager = new WorktreeManager(this.modelService.getAgentDir());
    // [MF-3] worktree 隔离下全树落盘目录统一到 ROOT cwd：子进程（spawn cwd = worktree checkout 路径）
    // 若按自身 cwd 编码目录，深层 record 写到 enc(worktree) 段，ROOT 磁盘重建扫不到。
    // 读 env PI_SUBAGENT_ROOT_CWD（根进程无 env → init.cwd）。sessions 与 records 两套目录
    // 必须同源（同一 rootCwd），否则 enc 段不变量断裂（只改其一会让同 record 的
    // session 文件与 manifest 分落两段，GC/重建互相找不到）。
    const envRootCwd = process.env[ENV_ROOT_CWD];
    this.rootCwd = envRootCwd && envRootCwd !== "" ? envRootCwd : init.cwd;
    const sessionsDir = getSubagentSessionDir(this.modelService.getAgentDir(), this.rootCwd);
    const recordsDir = getSubagentRecordsDir(this.modelService.getAgentDir(), this.rootCwd);
    this.manifestStore = new ManifestStore(recordsDir);
    this.store = new RecordStore(sessionsDir, this.manifestStore, this.pi ?? undefined);
    // #11：注册进程级 observability 单例——ui-request-queue.handleUiRequest 经
    // globalThis 桥接（notifyMissingHandlerGlobal）调到同一实例，共享
    // warnedMissingHandlerSessions 去重集合。未注册时 queue 走 fallback warn（不去重）。
    registerGlobalObservability(this.uiObservability);
  }

  // ── 生命周期（index.ts 调）──────────────────────────────

  /** session_start 注入 pi + revive（modelRegistry/entries 归 ModelConfigService.initModel）。 */
  initSession(init: SubagentServiceSessionInit): void {
    this.pi = init.pi;
    // 同步注入 pi 到 RecordStore（构造时 this.pi 为 null，session_start 后才有真实 handle）。
    // RecordStore 跳过损坏 manifest 时调 appendEntry 上报用户可见——若不重新注入，
    // 上报通道永远是 no-op，事故排查依然静默。
    this.store.setPi(this.pi);
    this.sessionId = init.sessionId;
    // 主 session 文件按值直传（jiti 多实例下闭包缓存不可靠，见接口注释）。
    this.mainSessionFile = init.mainSessionFile;
    this.streamSink = init.streamSink ?? null;
    this.isIdleFn = init.isIdle;
    // 读取 mode（W4 守卫透传给 session-runner）+ session 级 handler 覆盖
    //（[D4-④] initSession.uiRequestHandler 是唯一注入入口；三态语义见接口注释——
    //null = 显式清空，承载原 setUiRequestHandler(undefined) 语义）。
    this.uiObservability.setMode(init.mode);
    if (init.uiRequestHandler !== undefined) {
      this.uiRequestHandler = init.uiRequestHandler ?? undefined;
      this.uiObservability.resetMissingHandlerWarnings();
    }
    // SR-4：注入 L2 dialog 队列（child close 清理路径）。undefined 时 buildSessionRunnerContext
    // 透传 undefined，session-runner onClose 跳过 L2 清理（仅清 L1，保留旧行为）。
    if (init.dialogQueue !== undefined) {
      this.dialogQueue = init.dialogQueue;
    }
    // [SPAWN fork depth 跨进程传递] 子进程被父 spawn 时，父通过 env
    // PI_SUBAGENT_FORK_DEPTH 传入当前 fork 链深度。子进程 session_start 时
    // 读取作为 forkDepthAls 基线，使后续嵌套 spawn fork 能从正确深度递增。
    // 未设置（顶层主 session）→ 基线 0。enterWith 贯穿整个 session 生命周期。
    const envDepth = process.env.PI_SUBAGENT_FORK_DEPTH;
    if (envDepth !== undefined && envDepth !== "") {
      const base = Number.parseInt(envDepth, 10);
      if (!Number.isNaN(base) && base > 0) {
        this.forkDepthAls.enterWith(base);
        this.forkDepthBaseline = base;
      }
    }
    // [递归可见性] 跨进程身份贯穿（设计 recursive-subagent-visibility.md）。
    // 父进程 spawn 时注入这 4 个 env 描述「子进程自己的身份」：
    //   - rootSessionId：所属根 session（贯穿真 ROOT，子进程不覆盖）
    //   - selfRecordId：子进程自己的 record id（孙 subagent 的直接父）
    //   - depth：子进程的嵌套深度
    //   - rootCwd：真 ROOT 的 cwd（[MF-3] 落盘目录编码键，worktree 下与自身 cwd 不同）
    // 子进程读 env 建立基线后，createRecordForMode 读嵌套上下文自动正确（孙挂到子名下）。
    // 根进程无 env → sessionRootId = init.sessionId（自己是 root），嵌套上下文不 enterWith（顶层）。
    // enterWith 贯穿整个 session 生命周期（与 forkDepthAls 同构，决策 4）。
    const envRoot = process.env[ENV_ROOT_SESSION_ID];
    this.sessionRootId = envRoot ?? init.sessionId;
    const envSelfRecord = process.env[ENV_SELF_RECORD_ID];
    if (envSelfRecord !== undefined && envSelfRecord !== "") {
      const envNestingDepth = Number.parseInt(process.env[ENV_DEPTH] ?? "0", 10);
      const nestingDepth = Number.isNaN(envNestingDepth) ? 0 : envNestingDepth;
      // [ALS 断裂修复] 基线兜底：enterWith 在 pi 事件回调模型下不可靠（机制注释见
      // common/nesting-guard.ts ExecutionNestingContext），基线是 createRecordForMode /
      // 护栏读 ALS store 失败时的权威回退。
      this.execNesting.setBaseline({ recordId: envSelfRecord, depth: nestingDepth });
      this.execNesting.enterWith({ recordId: envSelfRecord, depth: nestingDepth });
      if (process.env.XYZ_AGENT_DEBUG) {
        logger.debug(
          `[subagents] execNesting initialized: recordId=${envSelfRecord} depth=${nestingDepth} rootSessionId=${envRoot ?? init.sessionId}`,
        );
      }
    }
    // revive（dispose 的逆操作：/resume /fork /new 后复活）
    this._disposed = false;
    this.store.revive();
    this.notifyHost.revive();
    // 孤儿终态恢复（residual-fixes）：session_start 主动触发一次——父扩展死后再无人写
    // 终态 entry 的 record 在此判定落盘（否则侧栏永久 running）。放 initSession 末尾：
    // setPi 已注入（appendEntry 可用），sessionRootId 已建立（过滤当前根的 record）。
    // 幂等不 throw，失败不阻断 session_start。
    this.recoverOrphanRecords();
  }

  /** 孤儿终态恢复委托（RecordStore.recoverOrphanRecords 的唯一调用入口，维持 store
   *  private 封装——与 recoverManifestTmpFiles 同模式；[D4] public 面收窄：唯一调用方
   *  是 initSession，转 private）。判定语义见 store 侧注释。
   *  随后跑 entry-born 孤儿恢复（无子文件锚的 register-only record，spawn 窗口期死亡，
   *  E2E 实测缺口）——主 session 文件经 getMainSessionFile 注入（构造期可空）。 */
  private recoverOrphanRecords(): void {
    try {
      this.store.recoverOrphanRecords(this.sessionRootId ?? undefined);
    } catch (err) {
      logger.warn("[subagents] orphan recovery failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      this.store.recoverEntryOnlyOrphans(this.mainSessionFile, this.sessionRootId ?? undefined);
    } catch (err) {
      logger.warn("[subagents] entry-only orphan recovery failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 启动恢复：扫描 manifest tmp 残留（崩溃打断的 writeManifest 留下的 *.json.tmp.<pid>），
   *  3 分支判定（manifest已存在删tmp / tmp合法promote / tmp非法删）。幂等，不 throw。
   *  ADR-035 启动恢复接线——session_start 每次都调（与 maybeCleanupExpiredSessionFiles 一致）。
   *  manifestStore 保持 private 封装，本方法是唯一公开入口。 */
  async recoverManifestTmpFiles(): Promise<{ deleted: number; recovered: number }> {
    try {
      return await this.manifestStore.recoverTmpFiles();
    } catch (err) {
      bestEffort(err, "recoverManifestTmpFiles", "error");
      return { deleted: 0, recovered: 0 };
    }
  }

  /** SP-4: 关闭所有活跃 record。
   *
   *  遍历 store 中所有 running record，逐个 CAS 转终态 + completeRecord + archive。
   *  对有 worktreeHandle 的 record 触发 worktreeManager.cleanup（T3: worktree 绑定清理）。
   *
   *  [v4 A-6] 旧实现的 recentlyCascaded 收集（供已删除的 before_agent_start 注入告知）
   *  与 drainCascaded 已一并移除——被关 record 的告知改由 list 的 closedReason 表达。
   *
   *  @param reason 关闭原因（parent-fork / parent-new / parent-shutdown）
   *  @returns 被关闭的 record 数量
   */
  disposeAllRecords(reason: ClosedReason): number {
    const activeRecords = this.store.listAllActive();
    let count = 0;
    for (const record of activeRecords) {
      // tryTransition 只对 running 生效；idle 需要直接 completeRecord（无 CAS 保护）。
      // 与 closeChatIdle 对称：idle 无在途 AgentResult，构造合成 result。
      if (record.status === "running") {
        if (!tryTransition(record, "closed", reason)) continue;
      }
      const result: AgentResult = {
        text: "",
        turns: record.turnCount,
        durationMs: Date.now() - record.startedAt,
        success: false,
        error: `closed due to ${reason}`,
        sessionId: record.id,
        toolCalls: [],
      };
      completeRecord(record, result, "closed", reason);
      this.store.archive(record);
      // worktree 绑定清理（T3）。cleanup 已 async 化——同步签名（返回计数）不变，
      // 清理 fire-and-forget：失败经 bestEffort 留痕，不阻塞/不影响计数返回。
      if (record.worktreeHandle) {
        void this.worktreeManager.cleanup(record.worktreeHandle).catch((err: unknown) => {
          bestEffort(err, `worktree cleanup (${reason})`);
        });
      }
      // pending-notifications 注销
      this.notifyHost.emitPendingUnregister(record.id, "closed");
      count++;
    }
    return count;
  }

  /** SP-4: /fork 新 session 时清理旧 record。
   *  调用 disposeAllRecords("parent-fork")。由 index.ts 的 session_before_fork handler 触发。 */
  onParentFork(): number {
    return this.disposeAllRecords("parent-fork");
  }

  /** SP-4: /new 创建全新 session 时清理旧 record。
   *  调用 disposeAllRecords("parent-new")。由 index.ts 的 session_before_switch
   *  （reason==="new"）handler 触发。 */
  onParentNew(): number {
    return this.disposeAllRecords("parent-new");
  }

  /** SP-4: idle record GC（30 天 TTL，实现抽至 idle-gc.ts）。stop 函数（dispose 调）。 */
  private stopIdleGc: (() => void) | undefined;

  /** 启动 idle record GC 定时器（session_start 调用，幂等）。 */
  startGcTimer(): void {
    if (this.stopIdleGc) return;
    this.stopIdleGc = startIdleGc(this.store);
  }

  /** 停止 idle record GC 定时器（dispose 调用）。 */
  private stopGcTimer(): void {
    this.stopIdleGc?.();
    this.stopIdleGc = undefined;
  }

  /** session 结束清理（清定时器，丢弃 pending 通知）。幂等。
   *
   * [M-7] dispose 顺序假设：pending:unregister emit 依赖 pending-notifications 扩展的
   * listener 仍然存活。若 pending-notifications 先于本扩展执行 session_shutdown（后注册
   * 先执行的语义下会如此），listener 已注销，unregister 事件被静默丢弃。这是可接受的
   * 退化——进程退出后两侧状态本就不保证一致，下次 session_start 的 crash recovery 会修正。 */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stopGcTimer();
    // [dispose stub] 第一时间换 stub，防 trailing ui_request 调到 stale handler 闭包
    // （仍持有 disposed session 的 ctx）产生误导性 console.error。stub 干净降级为 cancelled。
    // 必须在 emit/abort 之前——这些步骤可能同步触发 trailing pump。
    // [D4-④] 原 setUiRequestHandler 方法已删（initSession 参数为唯一注入入口），
    // 此处内联其方法体（赋值 + 缺失告警去重重置）。
    this.uiRequestHandler = disposedUiRequestStub;
    this.uiObservability.resetMissingHandlerWarnings();
    // [R0/C1 孤儿进程修复] 先 abort running controllers + kill spawned children，再 dispose 资源。
    // abortRunningControllers 需要在 disposeAllRecords archive 之前执行（archive 后 store 找不到 record）。
    this.store.abortRunningControllers();
    killAllSpawnedChildren();
    // SP-4: 级联关闭所有活跃 record（parent-shutdown reason）
    // 在 abort/kill 之后执行：先终止子进程，再清理 record 状态。
    this.disposeAllRecords("parent-shutdown");
    // [v4 A-1] EPIPE 连续失败计数器清零（计数器已迁移到 stdin-writer，防跨 session 泄漏）
    resetAllEpipeFailures();
    // [review MF1] 在途 resume 守卫清空（正常由轮次收尾 finally 清除；此处兜底
    // abort/kill 后仍挂着的条目，防跨 session 复活时残留）
    this.resumesInFlight.clear();
    // chat 轮次交接包清空（正常由 PiEngine.run 消费；此处兜底 kill 后仍挂着的条目）
    this.chatRoundTickets.clear();
    // flush 待发通知后 dispose（防丢失）
    this.notifyHost.flushPendingNotifications();
    this.notifyHost.dispose();
    this.store.dispose();
  }

  // ── 执行（subagent-tool 调）────────────────────────────

  // [D4-①] 通知簇四方法（notifyComplete / notifyClosed / piAdapter / toNotifyRecord）
  // 与 emitPendingRegister / emitPendingUnregister 模块函数已整体搬移至 notify-host.ts
  //（本类经 this.notifyHost 消费；行为逐字节等价，搬移 + 依赖注入）。

  /**
   * 预解析 model（renderCall 标题行用，同步）。代理 modelService.resolveModel。
   * 仅解析 override/agentConfig 路径；ctxModel 缺失时拋错，调用方 catch 降级。
   */
  resolveModel(
    agent: string,
    override?: { model?: string; thinkingLevel?: string },
    ctxModel?: ModelInfo,
    agentConfig?: AgentConfig,
  ): ResolvedModel {
    return this.modelService.resolveModel(agent, override, ctxModel, agentConfig);
  }

  /**
   * 统一执行入口。mode 固定 background（sync 已删除）。
   * 内部完成：模型解析 → 执行 → 收尾。
   *
   * @param opts.ctxModel  主 agent 当前模型（模型解析第三层兼底）。undefined 时仅依赖 override/agentConfig。
   */
  async execute(opts: ExecuteOptions): Promise<ExecutionHandle> {
    this.assertReady();

    // 通用嵌套深度护栏（D-033）：嵌套上下文（[D3-⑤] 公共层 ExecutionNestingContext）
    // 记录所有 subagent 嵌套层级（fork + 非 fork），每层 +1。MAX_FORK_DEPTH 同时限
    // fork 链与通用嵌套——非 fork 递归虽不累积 session 体积，但耗资源且 LLM 易陷入
    // 「委派→再委派」死循环。在所有副作用之前拦截，错误直达调用方。
    // 计数基准：顶层 nestingDepth=0，nestingDepth>MAX 被拒。与 fork 体积护栏（parentForkDepth 检查）
    // 互补：本护栏更严（计所有嵌套），混合链下先生效；两者共享 MAX_FORK_DEPTH 上限不漂移。
    // [ALS 断裂修复] current() 内含基线兜底（pi 事件回调模型下 enterWith 不贯穿）。
    const parentNesting = this.execNesting.current();
    const nestingDepth = parentNesting ? parentNesting.depth + 1 : 0;
    if (nestingDepth > MAX_FORK_DEPTH) {
      throw new ForkDepthExceededError(
        `subagent nesting depth ${nestingDepth} > ${MAX_FORK_DEPTH} (max recursion), refusing to spawn deeper`,
      );
    }

    // mode 固定 background（sync 模式已删除）
    const mode: ExecutionMode = "background";

    // ── 1. IDENTITY 解析（确认 → agentConfig → resolveModel）──
    const identity = await this.resolveIdentity(opts);

    // ── 1.5 引擎路由（D2 单轨 + D3-② 路由单点：统一经 routeEngineForHost）──
    // 唯一实现在 engine/routing.ts（pi 同步短路 + registry 注入 + 兜底回本地 pi 实例
    // 收敛于此）；本调用点只装配三层输入与注入件。时机：路由（含 probe）在 record
    // 创建前完成——兜底时 record 按 pi 语义创建 + engineFallback 留痕（D5 字节级守护
    // 只约束「无 fallback 的纯缺省路径」）；守卫命中/strict 时在此 throw，不产生孤儿
    // record。pi 请求路径同步短路（routed 非 Promise，零微任务——缺省路径时序不变）。
    const routingInput = {
      callEngine: opts.engine,
      agentEngine: identity.agentConfig?.engine,
      globalDefaultEngine: this.modelService.getGlobalConfig().defaultEngine,
    };
    const routed = routeEngineForHost({
      routing: routingInput,
      // 守卫 c 判据只看调用方显式指定的 model（resolved model 含 ctxModel 兼底，
      // 恒非空会把一切兜底误判为 model 绑定命中）
      taskModel: opts.model,
      strict: this.modelService.getGlobalConfig().engineRouting?.strict === true,
      probe: (engineId) => getEngine(engineId).probe(),
      piEngine: this.chatPiEngine,
    });
    const route: EngineRouteResult = routed instanceof Promise ? await routed : routed;
    return this.executeViaEngine(opts, identity, route, mode);
  }

  /**
   * 按 id 查内存 running record 的只读快照（G3-002 修复）。
   * 不从 session.jsonl 重建（cancel/list 单点查询只关心内存 running record）。
   * 供 tool 层 cancelHandler 翻译 throw 用（id 不存在 / mode / 终态三种错误）。
   * 不存在返回 undefined。
   */
  private findRecord(id: string): RecordSnapshot | undefined {
    this.assertReady();
    const record = this.store.getMutable(id);
    return record ? snapshot(record) : undefined;
  }

  /** 取消 background record（tryTransition CAS 抢锁防重复副作用）。 */
  cancel(id: string): boolean {
    this.assertReady();
    const record = this.store.getMutable(id);
    if (!record) return false;
    return this.cancelBackground(record);
  }

  /**
   * [v8.5 A1/B] 全态查找：任意状态（running/closed）× 任意归属（含异 root session）的
   * record 快照。供 message 拒绝文案分流（A1）与 fork-from 源解析（B）共用。
   *
   * 与 getRecordForAction 的差异：不做归属/直接父校验、不重建可变 record 入内存，
   * 只读快照（light 形态可能缺详情重数据，身份/sidecar 状态字段齐全）。查询顺序与
   * getRecordForAction 冷路径同款（idToFile 索引直查 → collectRecords 全扫兑底），
   * 不限 status——终态（sidecar closed）记录也能查到。
   *
   * 返回 undefined：id 在内存与磁盘均不存在。
   */
  private lookupRecordAnyState(id: string): SubagentRecord | undefined {
    try {
      this.assertReady();
    } catch {
      return undefined; // 未初始化/disposed 时按「不存在」处理（文案分流无需区分）
    }
    const direct = this.store.findLightById(id);
    if (direct) return direct;
    return this.store.collectRecords(COLD_LOOKUP_SCAN_LIMIT, "all", undefined).find((r) => r.id === id);
  }

  // ── 对话模式投递（M2-B3 message action 调用）──────────────

  // [review 修复] 已删除 deliverToRunning（busy follow_up/steer 投递 + pendingMessages
  // 消费确认制）：SP-5 upgrade 后所有 running record 走 chatMode 分支 → 统一投递
  //（热路径 prompt+streamingBehavior / 冷路径 resume），该方法无生产调用方，
  // 其配套三段消费链（push / message_start shift / redeliverPending 补投）全部不可达，
  // 一并移除（详见各文件同步删除）。
  // [D2 单轨] 投递的 pi RPC stdin 协议知识（stdin prompt 命令直调 + streamingBehavior
  // 映射 + EPIPE 兜底 + 冷路径分流）已下沉 PiEngine.deliverPrompt——本层经
  // deliverChatMessage → PiEngine.interactRecord 调用，见下方两方法。

  /**
   * [V2 决策 3] chatMode 统一投递入口（message action 的 Service 面）——经引擎交互面
   * 执行（D2：PiEngine.interactRecord——port face interact 的 record 锚定形态，协议知识
   * 在引擎边界，编排层不做 stdin 写入）。分流语义（按**进程死活**，
   * 不按 record.status）与热/冷路径细节见 PiEngine.deliverPrompt：
   *
   *   热路径（进程活）：prompt + streamingBehavior——pi 权威裁决 busy/idle（F3/F4）。
   *   冷路径（进程死）：冷路径续轮（resumeChatRound）重开 session + prompt（仅崩溃/
   *     timeout kill/跨重启命中）。
   *
   * 失败语义与直调形态一致：业务拒绝（not ready / EPIPE 兜底耗尽等，文案自带行动语言）
   * 经 interact 结构化结果回传后原样 throw（错误文本逐字节保持）。
   *
   * @param record 目标 record（chatMode，running 或 idle）
   * @param text 消息正文
   * @param interrupt true=steer（抢占）/ false=followUp（排队），仅热路径 streamingBehavior 用
   */
  private async deliverChatMessage(record: ExecutionRecord, text: string, interrupt: boolean): Promise<void> {
    this.assertReady();
    // interactRecord：interact 的 record 锚定形态（调用方已持归属校验过的同一 record
    // 对象——port face interact 的 handle 解析在此冗余且会做二次 store 查找）
    const result = await this.chatPiEngine.interactRecord(
      record,
      { kind: "message", payload: text, interrupt },
    );
    if (!result.ok) {
      throw new Error(result.message);
    }
  }

  /**
   * 冷路径续轮（PiEngine.deliverPrompt 的编排回调，D2 下沉后的归属）：resume spawn
   * 开启新一轮对话（设计决策 6 idle 分支）。仅进程死（idle timer reap / 崩溃 / 跨重启
   * / EPIPE 兜底）时经引擎到达。
   *
   * record 必须 idle-resumable（轮次完成、进程已回收、record 留内存）。手动把 status
   * 设回 "running"（M2-A 边界：idle→running 是恢复非终态，绕过 tryTransition——
   * tryTransition 要求当前态 running 才 CAS）。
   *
   * resume 参数从 record identity 读（防多轮对话模型漂移，探针 P-10）：sessionFile、
   * model、thinkingLevel 均为 record 身份字段（创建时确定、不可变）。maxTurns/schema 等
   * 执行约束第一版不恢复（设计 §5 拆分 1 待验证检查点），agentConfig 用 undefined
   *（pi --session 续写保留上下文，agent 行为由 session 内 messages 决定；M2-B3 messageHandler 可完善）。
   *
   * detached 编排（kickOffChatRound，经 EnginePort 交接）：不 await，轮次在 background 跑。
   * chatMode + done 时轮次收尾的 M2-A 分流自动把 record 回退 idle-resumable。并发槽在
   * 轮次执行内重新 acquire（轮次间 idle 已 release）；pool.acquire 是排队模型，
   * 池满时排队等待槽位而非 throw（与 execute 一致）。
   *
   * @param record 目标 record（必须 idle-resumable）
   * @param text 新一轮消息正文
   * @throws Error record 非 running / 无 sessionFile / 无 controller / worktree 绑定丢失 / 续轮在途
   */
  private resumeColdRound(record: ExecutionRecord, text: string): void {
    this.assertReady();
    // [CL-b1-cas-coupling / v4 B-1] v4 把旧 idle 折入 running 后此守卫对 idle-resumable
    // record 恒放行（idle 本来就是 running），`status = "running"`（下方）是幂等写——
    // 旧「idle→running CAS」的单写者语义已消失。单写者守卫由 resumesInFlight 承担
    //（[review MF1]，见字段注释）；本守卫保留拦截终态（closed）record。
    if (record.status !== "running") {
      // MF-4：行动语言（spec §3.1），不暴露 resume/controller 等内部词汇。
      throw new Error(
        `subagent ${record.id} is not ready for a new message (current state: ${record.status}). ` +
        `Recovery: use action:'list' to confirm state; wait for the current round to finish, or send the message again once it is idle.`,
      );
    }
    // [review MF1] 在途 resume 守卫：上一条消息发起的 resume 仍在途（spawn 尚未注册 /
    // 本轮轮次未收尾）时，再次到达（冷路径重入 / EPIPE 兜底）直接拒绝。
    // 触发链：pi 对同一 assistant message 的 tool calls 顺序执行（sequential），tool1 的
    // 投递在冷路径续轮返回即 resolve（早于 spawn 注册完成），tool2 立即执行 →
    // getChildByRecord 仍 undefined → 再次冷路径。无此守卫 → 两次 kickOff →
    // runSpawn 2 次 → 两 pi 子进程双写同一 session JSONL + 第一个脱离 kill 记账成孤儿。
    if (this.resumesInFlight.has(record.id)) {
      // MF-4：行动语言。
      throw new Error(
        `subagent ${record.id} is already starting a new round (a previous message is still resuming). ` +
        `Recovery: wait for the round to start (check with action:'list'), then send the message again; ` +
        `or use action:'close' if this subagent is no longer needed.`,
      );
    }
    if (!record.sessionFile) {
      // MF-4：session 损坏 → canonical 文案（spec §3.1 失败表）。
      throw new Error(
        `subagent ${record.id} session unavailable (session file missing or unreadable). ` +
        `Recovery: use action:'close' to clean up, then action:'start' a new subagent.`,
      );
    }
    if (!record.controller) {
      // chatMode background record 创建时一定有 controller；兜底防御性检查。MF-4 行动语言。
      throw new Error(
        `subagent ${record.id} is not ready for a new message (internal state error). ` +
        `Recovery: use action:'close' to clean up, then action:'start' a new subagent.`,
      );
    }
    // [review round2] 跨重启 worktree 绑定丢失守卫：原 record 曾用 worktree 隔离
    //（hadWorktree 由 getRecordForAction 磁盘重建时从 session entry 恢复），但 handle
    // 不可序列化、跨重启后无法 reattach（reattach 也无 checkout 可用——reaper 在
    // session_start 已按 pid 死活清理孤儿 worktree）。此时 resume 的 spawn cwd 会静默
    // 回落主 repo，子 agent 直接编辑主仓库——正是 worktree 隔离要防的场景。拒绝续聊。
    if (record.hadWorktree === true && !record.worktreeHandle) {
      // MF-4：行动语言。
      throw new Error(
        `subagent ${record.id} was created with worktree isolation, but that binding was lost when the parent process restarted; ` +
        `resuming it now would run in the main repository and bypass the isolation. ` +
        `Recovery: use action:'close' to release this subagent, then action:'start' a new one with worktree isolation.`,
      );
    }

    // 手动设回 running（M2-A 边界：绕过 tryTransition，idle→running 恢复非终态 CAS）。
    record.status = "running";
    // 执行态信号清除（residual-fixes U3 补全）：新一轮开跑 = 无轮终信号——resumable
    // 与上一轮 result 都要清（§5.4 isStreaming 公式要求 result undefined 才显示
    // streaming，不清则续轮流仍显示 waiting、spinner 无法恢复）。
    record.resumable = undefined;
    record.result = undefined;
    // W16 [D4]：冷路径续轮是类外状态写点（不走 register/archive），显式上报迁移。
    this.store.reportRecordTransition(record);

    // resume 参数从 record identity 读（防漂移，P-10）。
    const resume: SpawnResumeOpts = {
      sessionFile: record.sessionFile,
      model: record.model,
      thinkingLevel: record.thinkingLevel,
    };

    // 重建 resolved：runSpawn 内 resume.model/thinkingLevel 优先（覆盖 resolved），
    // resolved.model.id 仅在 runSpawn 内被读（resume 短路时不报错）。从 record.model
    // （createRecordForMode 写入的 "provider/id" 格式）解析 provider/id 构造最小 ModelInfo。
    const slashIdx = record.model.indexOf("/");
    const provider = slashIdx >= 0 ? record.model.slice(0, slashIdx) : "unknown";
    const modelId = slashIdx >= 0 ? record.model.slice(slashIdx + 1) : record.model;
    const identity: ResolvedIdentity = {
      agent: record.agent,
      agentConfig: undefined,
      resolved: {
        model: { id: modelId, name: record.model, provider, reasoning: false },
        thinkingLevel: record.thinkingLevel,
      },
    };

    const opts: ExecuteOptions = {
      task: text,
      slug: record.slug,
      worktree: record.worktreeHandle,
    };
    const ctx = this.buildSessionRunnerContext();

    // detached 编排：轮次在 background 跑，pool 重新 acquire（轮次间 idle 已 release）。
    // chatMode + done 时 M2-A 分流自动 finalizeRoundToIdle（record 回 idle、round+1）。
    // [review MF1] 在途标记在 kickOff 前同步设置：本方法返回即生效，后续重入
    // （冷路径 / EPIPE 兜底）在守卫处被拒；轮次收尾 finally 统一清除。
    this.resumesInFlight.add(record.id);
    this.kickOffChatRound(record, opts, identity, ctx, record.controller.signal, PRIORITY_BACKGROUND, resume);
  }

  // ── 对话模式 message/close action 支持（M2-B3）──────────────

  /**
   * 按 id 查 record 并做归属校验（message/close action 的统一入口）。
   *
   * 设计决策 3（归属守卫）：校验 record.rootSessionId 必须等于当前 session 的根 id
   *（this.sessionRootId）。不匹配 / 不存在统一抛「not found or not owned」——不区分
   * 两种失败，防信息泄露（无法通过错误消息探测其他 session 的 subagent id）。
   *
   * 同进程内 running + idle record 都在内存（getMutable）；终态 record 已 archive。
   * 跨重启（SP-2）内存空时，从磁盘 collectRecords 重建 idle record 并 register 进内存。
   * reconstructAll 已将跨重启 record（无 sidecar marker + pid 死）标记为 running（v4 B-1 跨重启可续聊语义，record-store buildRecord 分支 4），
   * collectRecords 返回的 SubagentRecord 可直接转为可变 ExecutionRecord 供续操作。
   *
   * @param id subagent record id
   * @param opts.allowReconnect [v8.5 D] message 专属：冷查额外接受「可重连」的 closed 记录
   *   （死因∈ RECONNECTABLE_FINAL_REASONS，A 档真实死因 sidecar 是唯一准入门），经四重守卫后
   *   resurrectClosed 回边为 running 并续写原 session 文件。仅 message 开启；close/cancel 维持单向终态语义。
   * @returns 可变 ExecutionRecord（message/close handler 直接操作）
   * @throws Error record 不存在 / 非本 session 所有（含恢复指引）
   * @throws ResurrectDeniedError 命中可重连集但被 worktree/异进程活实例守卫拦截（自带完整行动语言）
   */
  private getRecordForAction(id: string, opts?: { allowReconnect?: boolean }): ExecutionRecord {
    this.assertReady();
    let record = this.store.getMutable(id);
    // SP-2 跨重启恢复：内存未命中时，从磁盘 collectRecords 重建 idle record。
    // reconstructAll 已将跨重启 record（无 sidecar + pid 死）标记为 running（v4 B-1 可续聊语义，非 crashed），
    // 直接转为可变 ExecutionRecord register 进内存，供 message/close action 续操作。
    if (!record) {
      // [D4-③] 冷查/复活链整体搬移至 cold-resurrect.ts（行为逐字节等价）。
      record = coldLookupForAction(this.coldResurrectDeps, id, opts?.allowReconnect === true);
    }
    if (!record || record.rootSessionId !== this.sessionRootId) {
      throw new Error(
        `subagent not found or not owned: ${id}. Recovery: use action:'list' to confirm the id; ` +
        `ended subagents cannot be messaged — start a new one; only subagents owned by the current session can be operated on.`,
      );
    }
    // [v4 A-5 / P7] 直接父校验：rootSessionId 已确认 record 属于本 session 树，但递归场景下
    // 孙级 record（parentRecordId = 某子进程的 self recordId）的子进程句柄只存在于其直接父
    // 进程内存。主进程（基线 null）若仅凭 rootSessionId 通过就 message 孙级，会走
    // 冷路径重新 spawn → 双写同一 session 文件（P7 双写者窗口）。统一用 baseline recordId 校验：
    //   - 主进程 baseline=undefined → 只能操作 parentRecordId=undefined 的根层 record
    //   - 子进程 baseline="sa-X"    → 只能操作 parentRecordId="sa-X" 的直接孩子
    // record.parentRecordId===undefined 视作根层，仅主进程可操作（身份缺省的旧/异常 record 归此）。
    const baselineRecordId = this.execNesting.baseline()?.recordId ?? undefined;
    if (record.parentRecordId !== baselineRecordId) {
      throw new Error(
        `subagent ${id} is owned by its direct parent; message it through that parent ` +
        `(see /subagents list, parent=${record.parentRecordId ?? "(root layer)"}). [v4 A-5] cross-layer ` +
        `ownership guard: this process's baseline=${baselineRecordId ?? "(root)"} is not the direct parent of ${id}; ` +
        `operating here would race the owning child process's handle and double-write the session file.`,
      );
    }
    return record;
  }

  // [D4-③] 冷路径复活链（findColdLookupCandidate / assertReconnectAllowed /
  // resurrectColdRecord / coldLookupForAction + isReconnectableClosed 判定）已整体
  // 搬移至 cold-resurrect.ts（本类经 coldResurrectDeps 注入，行为逐字节等价）。
  // SP-2 冷路径 [perf] 语义不变：idToFile 索引直查 → collectRecords 全扫兜底。

  /**
   * close action 的统一行为分流（running 子态 × force）。
   *
   *   running + force:true                → cancelBackground（显式 SIGTERM + closed+cancelled 终态）
   *   running + force:false + 无在跑轮    → closeChatIdle（立即终态化 done + 回收保活进程 + disarm timer）
   *     （isIdle timer armed 或 isResumable 无活进程）
   *   running + force:false + 有活进程在跑轮 → 置 closeAfterRound=true（轮完成时终态化：
   *     chatMode 消费点在 onRoundSettled，非 chatMode 在 runAndFinalize CAS 分支）
   *   其他终态                            → 幂等 no-op（已结束）
   *
   * 与设计决策 5 一致：close = 正式终态（走 finalize），force 只影响 running 时机。
   *
   * @param record 目标 record（getRecordForAction 已校验归属）
   * @param force true=立即终止（running 时 SIGTERM）/ false=优雅关闭（running 时等轮完）
   */
  private async closeSubagent(record: ExecutionRecord, force: boolean): Promise<void> {
    this.assertReady();
    if (record.status === "running") {
      if (force) {
        // 立即终止：cancelBackground（controller.abort + tryTransition closed+cancelled + finalize）
        this.cancelBackground(record);
      } else if (isIdle(record) || isResumable(record)) {
        // [M5] 无在跑轮：Path A（isIdle timer armed、进程保活等待续聊）/ Path B（isResumable
        // 无活进程）→ 立即终态化 done（closeChatIdle 内回收保活进程 + disarm timer）。
        // 旧代码 Path A 走 else 置 closeAfterRound，但唯一消费点（runAndFinalize CAS 分支）
        // 对 chatMode 不可达——agent_settled 恒 arm idle timer → runAndFinalize 恒命中
        // early return（isIdle 恒 true），标志置了无人消费，tool 却返回 {closed:true}（谎报）。
        await this.closeChatIdle(record);
      } else {
        // 优雅关闭：正在执行（有活进程在跑轮），标记 closeAfterRound，轮完成时终态化
        //（chatMode 消费点在 onRoundSettled，非 chatMode 在 runAndFinalize CAS 分支）
        record.closeAfterRound = true;
      }
    }
    // 其他终态（closed）：幂等 no-op
  }

  /**
   * 无在跑轮 record 的手动终态化为 done（close action 的 isIdle/isResumable 分支）。
   *
   * 无在途 AgentResult（轮次完成时 record 未冻结，turns[] 保留运行时状态），
   * 构造合成 done result（对齐 cancelBackground 的 cancelledResult 模式）。
   * 走 doFinalizeRecord 的完整终态化路径（completeRecord + archive + finalized + worktree
   * cleanup + alive marker + manifest）。
   *
   * [M5] 覆盖两路：Path B（无活进程，同旧行为）与 Path A（idle timer armed、进程保活等待
   * 续聊）。Path A 必须先显式回收进程 + disarm timer——否则 record 已终态化但保活进程
   * 继续驻留（终态后无人再杀它：closeSubagent 不再来、idle timer 已 disarm、runSpawn
   * promise 早已 resolve），直到宿主进程退出。
   *
   * 不走 tryTransition（v4 B-1 此态 status=running，但由 doFinalizeRecord 内部的
   * completeRecord 直接覆盖 status，与 cancelBackground 对 record 的处理同构）。
   */
  private async closeChatIdle(record: ExecutionRecord): Promise<void> {
    // [M5] Path A：回收保活进程 + disarm idle timer（终态化后无其他 kill 路径）
    disarmIdleTimer(record.id);
    const child = getChildByRecord(record.id);
    if (child && !child.killed) child.kill("SIGTERM");
    // 合成 closed result（无在途 AgentResult，对齐 closeAfterRoundSettled 的
    // `record.result ?? ""` 模式）。[W16 P-1 修复] text 必须沿用轮终真实 result：
    // completeRecord 会执行 record.result = result.text，合成空串会把轮终真实值抹空，
    // archive 落的 close 终态 subagent-record entry（D4 重建源）随之失真——重开
    // session 后 result 回退空串。
    const doneResult: AgentResult = {
      text: record.result ?? "",
      turns: record.turnCount,
      durationMs: Date.now() - record.startedAt,
      success: true,
      sessionId: record.id,
      toolCalls: [],
    };
    await doFinalizeRecord(
      {
        manifestStore: this.manifestStore,
        worktreeManager: this.worktreeManager,
        store: this.store,
        modelService: this.modelService,
        pi: this.pi,
        emitUnregister: (id, st) => this.notifyHost.emitPendingUnregister(id, st),
      },
      record,
      doneResult,
      "closed",
      "user-close", // close action 主动关闭
    );
    // [C-1] 终态通知（设计 D2 路径②）：正文空串占位 + sessionFile 指针行（idle 下
    // 末轮增量已由该轮轮次通知送达，终态再发属重复）。doneResult.text 已改保真
    // （P-1 修复），正文空由 notifyClosed 的 emptyBody 参数显式表达。
    // dedup 身份独立于轮次通知（notifyClosed 置 round=undefined），60s 窗内不被吞。
    // 防重入：closeSubagent 对 closed record 幂等 no-op，本路径不会被二次进入。
    this.notifyHost.notifyClosed(record, true);
  }

  /**
   * [M5] closeAfterRound 消费：chatMode 轮次完成时终态化 record（closed + user-close）。
   *
   * 由 onRoundSettled（agent_settled 回调）调用——chatMode 轮次完成的统一汇聚点（热路径轮
   * 不经 runAndFinalize CAS 分支，旧消费点对 chatMode 不可达）。合成 result 沿用 record.result
   *（= 本轮增量，设计 D2 路径①）：本轮增量已由调用方前置的轮次通知送达，终态通知正文因此
   * 是同一段增量 + 轮次统计 + sessionFile 指针行（notifyClosed），不重发全历史。
   *
   * 时序：同步前缀（disarm + kill + CAS）在 session-runner 的 resolveRun(0) 之前执行完——
   * 冷路径轮的 runAndFinalize 续体因 timer 已 disarm 跳过 early return，但其 tryTransition
   * CAS 对已 closed 的 record 失败 → 跳过二次 finalize（无双收尾）；热路径轮无 runAndFinalize
   * 续体，本方法是唯一收尾。冷路径续体 .then 的 notifyComplete 与轮次通知同 key=`id:round`，
   * 60s dedup 吞（不与下方终态通知叠加成第三条——后者 key 是裸 id）。
   */
  private async closeAfterRoundSettled(record: ExecutionRecord): Promise<void> {
    // 回收保活进程（Path A：轮次完成后进程仍活）+ disarm idle timer（终态化后无其他 kill 路径）
    disarmIdleTimer(record.id);
    const child = getChildByRecord(record.id);
    if (child && !child.killed) child.kill("SIGTERM");
    if (!tryTransition(record, "closed", "user-close")) {
      return; // 已被 cancel/finalize 抢先（CAS 失败），标志已消费即可——不发终态通知（幂等）
    }
    const doneResult: AgentResult = {
      text: record.result ?? "",
      turns: record.turnCount,
      durationMs: Date.now() - record.startedAt,
      success: true,
      sessionId: record.id,
      toolCalls: [],
    };
    await this.finalizeRecord(record, doneResult, "closed", "user-close");
    // [C-1] 终态通知（设计 D2 路径①）：与前置轮次通知（key=`id:round`）dedup 身份区分，
    // 「最后一轮轮次通知 + 终态通知」两条都送达父 agent。
    this.notifyHost.notifyClosed(record);
  }

  // ── 编排层专用接口（workflow 消费）──────────────────────

  /**
   * workflow 编排层专用：sync-await 接口，内部走 background 管道但返回 Promise<AgentResult>。
   *
   * 与 execute() 的区别（D-A1）：
   *   1. 返回 workflow AgentResult（content 字段），非 ExecutionHandle
   *   2. 不经 chat 轮次 kick-off（detached 回注）→ 不注入 followUp 完成通知（BC-11，结果直接返回 workflow）
   *   3. T2 删 sync 时 executeAndAwait 不受牵连（独立方法）
   *
   * 共享：runSpawn + ConcurrencyPool + record + pending emit（D-A4）。
   */
  async executeAndAwait(
    opts: ExecuteOptions,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<WorkflowAgentResult> {
    this.assertReady();

    // ── BC-12 嵌套护栏：复用 execute() 的嵌套上下文深度检查 ──
    // [ALS 断裂修复] current() 内含基线兜底（与 execute 同）。
    const parentNesting = this.execNesting.current();
    const nestingDepth = parentNesting ? parentNesting.depth + 1 : 0;
    if (nestingDepth > MAX_FORK_DEPTH) {
      throw new ForkDepthExceededError(
        `subagent nesting depth ${nestingDepth} > ${MAX_FORK_DEPTH} (max recursion), refusing to spawn deeper`,
      );
    }

    // ── 步骤 1: IDENTITY 解析 ──
    const identity = await this.resolveIdentity(opts);

    // ── 步骤 2: RECORD 创建（mode="background" 进池）──
    const record = this.createRecordForMode(identity, opts, "background");
    this.notifyHost.emitPendingRegister(record.id, record.agent);

    // ── 步骤 2.5: worktree creation (only worktree===true; handle injection is execute()'s path) ──
    // Workflow path receives boolean only (AgentCallOpts.worktree: boolean) — WorktreeHandle is a
    // main-thread non-serializable object that cannot cross worker postMessage, so no object branch
    // here (unlike execute() :445-447 which serves the subagent-tool path).
    // On create failure, finalizeFailed cleans up the record, then
    // throw lets SAR.run() convert it to an AgentResult.error (not return-handle like execute()).
    let worktreeHandle: WorktreeHandle | undefined;
    if (opts.worktree === true) {
      // [create-await 竞态守卫] 与 execute 同款（见其 worktree 分支注释）——差异仅在
      // 失败语义：executeAndAwait 对齐「失败 throw」，SAR.run 的 catch 会转成 AgentResult.error
      // （cancelled 呈现对齐 cancel 抢先路径）。赋值→终态检查→runAndFinalize 同一同步段。
      // 检查结果经标志位带出 try（守卫 throw 不能落在 try 内——会被下方 catch 当作
      // create 失败再走 finalizeFailed，对已 closed 的 record 语义未定义）。
      let cancelledDuringCreate = false;
      try {
        worktreeHandle = await this.worktreeManager.create(this.cwd, record.id);
        record.worktreeHandle = worktreeHandle;
        if (record.status === "closed") {
          cancelledDuringCreate = true;
        }
      } catch (err) {
        // finalizeFailed: CAS→finalizeRecord→emitUnregister (record already registered above).
        // throw (not return-handle): executeAndAwait's caller SAR.run() catches and wraps into
        // AgentResult.error. Diverges from execute() which returns buildEarlyFailedHandle
        // because the two methods have different return types.
        await this.finalizeFailed(record, err);
        throw err;
      }
      if (cancelledDuringCreate) {
        await this.worktreeManager.cleanup(worktreeHandle);
        throw new Error(`subagent ${record.id} cancelled during worktree creation`);
      }
    }

    // ── 步骤 3: SessionRunnerContext ──
    const ctx = this.buildSessionRunnerContext(opts.cwd);

    // ── 步骤 4: signal 决议 ──
    const effectiveSignal = signal ?? record.controller?.signal;

    // 步骤 5: runAndFinalize（await，不 detached）。onEvent 独立传，stream 透传。
    const result = await this.runAndFinalize(
      record,
      { ...opts, worktree: worktreeHandle },
      ctx,
      identity,
      effectiveSignal,
      PRIORITY_BACKGROUND,
      onEvent,
      stream,
    );

    // ── 步骤 6: D-A10 AgentResult 映射 ──
    // [MF-2] 不在此 emit pending:unregister——runAndFinalize 内部已覆盖所有路径：
    //   - CAS 成功（runAndFinalize L629）→ finalizeRecord 末尾 emit（L797）
    //   - CAS 失败（cancel/finalizeFailed/dispose 抢先转终态）→ 那些路径各自已 emit
    //     （cancelBackground L709 / finalizeFailed→finalizeRecord / dispose L240）
    // 旧实现无条件 emit 一次 → CAS 成功分支重复 emit（双注销）。
    const wfResult = mapToWorkflowAgentResult(result);
    // W2 改动 7：注入 worktreePath（worktree 隔离激活时来自 step 2.5 的 worktreeHandle）。
    // mapToWorkflowAgentResult 不感知 worktree（它只做 subagents AgentResult → workflow AgentResult
    // 的 DTO 映射），故在 caller 侧 mutate 刚新建的产物对象（无共享引用，安全）。
    //
    // ⚠️ worktreePath is diagnostic only, may not exist — see AgentResult.worktreePath JSDoc
    // （orchestration/models/types.ts）。下方诊断标识符语义（not cwd）说明同源。
    //
    // 诊断标识符语义（not cwd）：
    //   - runAndFinalize 内的 finalizeRecord 在 return 前已 cleanup（git worktree remove --force），
    //     worktreePath 指向的目录已被删除，不保证存在。
    //   - worktreePath 仅供日志/trace 关联（如定位某条 session jsonl 的 worktree 来源），无运行时语义。
    //   - **不可作为后续 agent 的 cwd**——目录已删，复用会 ENOENT。
    //   - wave 内 worktree 复用（spec-w §2 "wave 内 8 action 共享 worktree"）在 pi 当前架构下
    //     不可行：worktree 绑定单次 agent() record，每次 executeAndAwait 结束 finalizeRecord
    //     无条件 cleanup，worktree 无法跨 action 存活。wave 改用主 cwd。
    wfResult.worktreePath = record.worktreeHandle?.path;
    return wfResult;
  }

  // ── 状态查询（TUI 调）──────────────────────────────────

  /** 订阅 store 变更（widget/list requestRender）。返回取消订阅。 */
  private onChange(listener: () => void): () => void {
    return this.store.onChange(listener);
  }

  // [D4] listRunning 已删除：零生产调用方（TUI 计数经 collectRecords / notify-host 的
  // piAdapter 直调 store.listRunning 覆盖），唯一消费是初始空态单测——保留 store 层方法。

  /** 合并内存(running) + 磁盘(session.jsonl 重建) record（/subagents list + tool list 消费）。
   *  按 rootSessionId 过滤：根进程=本 session（sessionRootId===sessionId）；
   *  子进程=env 贯穿的真 ROOT（sessionRootId≠sessionId）→ 看到整棵 ROOT 树（决策 3）。
   *  [perf] 磁盘源为 light（头部 identity + 状态，无 eventLog/result/turns 等重数据）
   *  ——列表/补全/hasRunning 够用；详情场景调 getFullRecord(id) 懒加载补齐。 */
  private collectRecords(limit: number, statusFilter: StatusFilter = "all"): SubagentRecord[] {
    return this.store.collectRecords(limit, statusFilter, this.sessionRootId ?? this.sessionId ?? undefined);
  }

  /** [perf] 单 record 详情懒加载（全量：eventLog/displayItems/result/turns/tokens）。
   *  内存 running record 直接投影；磁盘 record 全量重建（per-file 缓存，stat 戳校验）。
   *  返回 undefined：id 不存在于内存与磁盘。 */
  private getFullRecord(id: string): SubagentRecord | undefined {
    return this.store.getFullRecord(id);
  }

  // ── 执行内部：身份解析 + record 创建 ──────────

  /** 步骤 1：身份解析。agentConfig → resolveModel（三层：override → agentConfig → 主 agent model）。 */
  private async resolveIdentity(opts: ExecuteOptions): Promise<ResolvedIdentity> {
    // agentRef 语义（S2）：agent 参数 = .md 绝对路径；不传 = 不加载 agentConfig，
    // 直接用 override → 主 agent model。DEFAULT_AGENT_NAME 仅作 record 显示名
    // （TUI 层 extractAgentName 共用，保证显示一致）。
    const agent = opts.agent ?? DEFAULT_AGENT_NAME;
    // 显式 agent ref（用户点名）失败必须报错，不静默降级：无 require 的 loadByPath
    // 对相对路径/裸名/文件缺失都返回 undefined → agentConfig undefined → resolveModel
    // 静默回落 override→主 agent model，用户拿到的 subagent 无 systemPrompt/工具白名单
    // 且零反馈。require:true 让失败抛出带 <available_subagents> 指引的错误（对齐
    // workflow name not found 反馈风格）；不传 agent = 默认 general-purpose 语义，
    // agentConfig 保持 undefined（合法缺省，走 override → ctxModel 兑底）。
    const agentConfig = opts.agent
      ? this.modelService.getRequiredAgentConfig(opts.agent)
      : undefined;

    const resolved = this.modelService.resolveModel(
      opts.agent ?? "",
      { model: opts.model, thinkingLevel: opts.thinkingLevel },
      opts.ctxModel,
      agentConfig,
    );

    return { agent, agentConfig, resolved };
  }

  /** 步骤 2：按 mode 生成 id + controller，创建 record 并注册。
   *  [L-1] ExecutionMode 类型固定 "background"（sync 已删除），id/controller 分支简化。 */
  private createRecordForMode(
    identity: ResolvedIdentity,
    opts: ExecuteOptions,
    mode: ExecutionMode,
  ): ExecutionRecord {
    // FR-1: record id 用全局 UUID，不依赖 transcript/PID
    const id = `sa-${crypto.randomUUID()}`;
    const controller = new AbortController();

    // 从 async 调用链读父执行上下文：主 session 链上无 store → 顶层 record；
    // B run() 期间包了嵌套上下文，B 内创建 C 时读到 B → C.parentRecordId=B.id, C.depth=B.depth+1。
    // depth 语义：顶层（无父）=0；有父=父 depth+1。靠 recordId 是否存在区分，不用负数魔数。
    // [ALS 断裂修复] current() 内含基线兜底——本进程的身份在 initSession 已确定（env 注入），
    // 任何上下文下都能正确挂父链。
    const parentCtx = this.execNesting.current();
    const parentRecordId = parentCtx?.recordId;
    const depth = parentCtx ? parentCtx.depth + 1 : 0;

    const record = createRecord(id, {
      agent: identity.agent,
      model: `${identity.resolved.model.provider}/${identity.resolved.model.id}`,
      thinkingLevel: identity.resolved.thinkingLevel,
      mode,
      task: opts.task,
      slug: opts.slug,
      startedAt: Date.now(),
      rootSessionId: this.sessionRootId ?? undefined,
      parentRecordId,
      depth,
      chatMode: opts.conversation === true,
      idleTimeoutMs: opts.idleTimeoutMs,
      // P4 引擎留痕（D9①）：opts.engine/engineFallback 由引擎适配层写入（PiEngine.run
      // 从 RunContext 回填；缺省 = pi 投影，存量调用方零感知）
      engine: opts.engine,
      engineFallback: opts.engineFallback,
      controller,
    });

    this.store.register(record);
    return record;
  }

  /** [MF#R4] worktree 前置失败的 early-return handle。
   *  record 已被 finalizeFailed 收尾为 failed、detached promise 从未启动。 */
  private buildEarlyFailedHandle(record: ExecutionRecord): ExecutionHandle {
    const details = project(record);
    return { mode: "background", subagentId: record.id, sessionFile: record.sessionFile, details };
  }

  // ── 引擎分支（D4/D10：非 pi 引擎的 chat 域执行骨架，U0）──────────

  /**
   * chat 域统一执行入口（D2 单轨：全引擎——含 pi——经此进入 EnginePort）。路由
   *（routeEngineForHost：三层 + pi 同步短路 + probe/守卫）已由 execute 完成——这里
   * 只剩 unsupported 预检 → record 创建+盖章 → worktree → detached 引擎 run。
   * 全部同步拒绝发生在 record 创建前（不产生孤儿 record）。
   */
  private async executeViaEngine(
    opts: ExecuteOptions,
    identity: ResolvedIdentity,
    route: EngineRouteResult,
    mode: ExecutionMode,
  ): Promise<ExecutionHandle> {
    const engine = route.engine;
    // [D3-④ 预检 capabilities 化] 唯一实现 = common/capability-gate（capabilities
    // 驱动，含 maxTurns 扩位）。检查点钉死：execute/executeViaEngine 同步段、record
    // 创建前（engine.capabilities() 同步可得）——承接「全部同步拒绝发生在 record
    // 创建前、不产生孤儿 record」不变量（其后的 kickOffEngineRun 是 fire-and-forget，
    // 检查若只落在 engine.run 内则拒绝异步化为「派发成功 + 静默失败 record」）。
    assertTaskShapeSupported(engine.id, engine.capabilities(), opts);
    // record 盖章路由结果（D5 字节级守护的执行侧落点）：
    //   - pi 纯缺省/显式 pi：不盖 engine 键（pi record entry 序列化产物不得新增 engine
    //     键，undefined 经 JSON 省略）——与旧 pi 主路径 piOpts 剥离语义逐字节一致；
    //   - pi 兜底：engine='pi' + engineFallback 留痕（engine = 实际执行引擎，from=请求
    //     引擎留痕）；
    //   - 非 pi：engine=route.engineId 显式留痕（+engineFallback 如有）。
    const recordOpts: ExecuteOptions =
      route.engineId === DEFAULT_ENGINE_ID
        ? route.engineFallback !== undefined
          ? { ...opts, engine: DEFAULT_ENGINE_ID, engineFallback: route.engineFallback }
          : opts.engine === undefined
            ? opts
            : { ...opts, engine: undefined }
        : {
          ...opts,
          engine: route.engineId,
          ...(route.engineFallback !== undefined ? { engineFallback: route.engineFallback } : {}),
        };
    const record = this.createRecordForMode(identity, recordOpts, mode);
    this.notifyHost.emitPendingRegister(record.id, record.agent);

    // ── worktree 创建（仅 worktree===true 或已传入 handle 时）──
    // record 先创建，worktree 失败时可 finalizeFailed（record 已在 store 中）。
    // worktree 必须显式开启：worktree===true 创建新 worktree；worktree===undefined/false 不创建。
    // fork 不隐含 worktree（UC-1 fork 可独立使用，fork 仅继承上下文，在 parent cwd 跑）。
    // 非 pi 引擎带 worktree 已被上方预检同步拒绝（caps.sandbox='none'），此段实际仅
    // sandbox 能力引擎（pi：caps.sandbox='emulated'）可达。
    let worktreeHandle: WorktreeHandle | undefined;
    if (typeof opts.worktree === "object") {
      // 传入的是已创建的 WorktreeHandle
      worktreeHandle = opts.worktree;
    } else if (opts.worktree === true) {
      // worktree===true（显式要求）——创建新 worktree。与 fork 正交（worktree 文件隔离不依赖 fork 上下文继承）。
      try {
        worktreeHandle = await this.worktreeManager.create(this.cwd, record.id);
        record.worktreeHandle = worktreeHandle;
        // [create-await 竞态守卫] create 的 await 窗口内 cancel/dispose 可 CAS 把 record
        // 转成 closed 终态——cancelBackground 当时读到的 worktreeHandle 可能仍是 undefined
        // （cleanup 被跳过）。赋值后同同步段检查终态：closed 则主动 cleanup（幂等，抢先的
        // fire-and-forget 清理无害）+ early-failed 返回，不进轮次 kick-off（避免子进程白跑）。
        // 实现约束：赋值 → 终态检查 → kick-off 必须在同一同步段，中间禁止插入 await。
        if (record.status === "closed") {
          await this.worktreeManager.cleanup(worktreeHandle);
          return this.buildEarlyFailedHandle(record);
        }
      } catch (err) {
        // create 失败→不进入 run，finalizeFailed 统一收尾（含 emitPendingUnregister failed）
        const _result = await this.finalizeFailed(record, err);
        return this.buildEarlyFailedHandle(record);
      }
    }

    if (route.engineId === DEFAULT_ENGINE_ID) {
      // pi：record 耦合执行（runSpawn 直驱 record 记账）——预备轮次经 EnginePort 交接
      //（kickOffChatRound），编排收尾（notify/终态迁移）与旧 pi 主路径语义一致。
      this.kickOffChatRound(
        record,
        { ...recordOpts, worktree: worktreeHandle },
        identity,
        this.buildSessionRunnerContext(opts.cwd),
        record.controller!.signal,
        PRIORITY_BACKGROUND,
      );
    } else {
      // 非 pi 引擎：engine.run 自足执行（handle+outcome），编排侧 journal 接线 + 终态迁移
      this.kickOffEngineRun(record, opts, engine);
    }
    return { mode: "background", subagentId: record.id, sessionFile: record.sessionFile, details: project(record) };
  }

  /**
   * 非 pi 引擎的 detached 执行编排（与 pi 轮次 kick-off 同构的 background 语义）：
   * pool 并发槽（maxConcurrent 对非 pi 引擎同样生效）→ journal 接线（D6 第②级：
   * taskId=record.id，初始池 key 占位 'shared'，onPoolResolved retarget 到引擎实际
   * 池 key——路径与 paths.ts 同源推导）→ engine.run（signal 接 record controller，
   * kill-chain 两级生效）→ engineHandle 回填（终态迁移落 entry 前）→ 终态迁移 →
   * bg notify（chat 域宿主职责，与 pi 完成通知同语义）。
   */
  private kickOffEngineRun(record: ExecutionRecord, opts: ExecuteOptions, engine: EnginePort): void {
    const signal = record.controller?.signal;
    void (async () => {
      try {
        await this.pool.acquire(PRIORITY_BACKGROUND, this.effectiveMaxConcurrentFor(record), signal);
      } catch {
        // S1: 排队中被 abort（signal.aborted）走 cancelled，与已运行被 abort 一致（runAndFinalize 同款）
        if (signal?.aborted) {
          await this.finalizeAborted(record);
        } else {
          await this.finalizeFailed(record, new Error("aborted"));
        }
        return;
      }
      // [review MF1] acquire 成功后必须 finally release：不 release 则
      // DefaultConcurrencyPool._active 永不递减——每次引擎任务泄漏一个并发槽，累计
      // maxConcurrent 次后全部 background subagent（pi 与引擎共用同一池）在 acquire 队列永久挂起
      try {
        await this.runEngineTask(record, opts, engine, signal);
        // cancel 抢先（closedReason='cancelled'）时 cancelBackground 自己 notify，跳过
        if (record.closedReason !== "cancelled") {
          this.notifyHost.notifyComplete(record);
        }
      } finally {
        this.pool.release();
      }
    })();
  }

  /**
   * kickOffEngineRun 的 acquire 后主体：journal 接线（D6 第②级：taskId=record.id，
   * 初始池 key 占位 'shared'，onPoolResolved retarget 到引擎实际池 key）→ engine.run
   * （signal 接 record controller，kill-chain 两级生效）→ engineHandle 回填（终态迁移
   * 落 entry 前）→ 终态迁移。bg notify 归编排侧（与 pi 轮次收尾通知归编排对称）。
   */
  private async runEngineTask(
    record: ExecutionRecord,
    opts: ExecuteOptions,
    engine: EnginePort,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    // [D3-③ journal 接线合一] writer + retarget + 路径权威收敛 common/journal-wiring
    //（与 SAR 同一实现）。chat 域无下游 onEvent 消费者——journal 是事件唯一出口，
    // 不传 forwardEvents。
    const journal = wireEventJournal({ engineId: engine.id, taskId: record.id });
    // 对齐点③：journal 路径权威 = 引擎声明的池 key（writer 初始用占位，retarget 后
    // 与 handle.poolKey 同源）。
    const runCtx: RunContext = {
      taskId: record.id,
      poolKey: JOURNAL_INITIAL_POOL_KEY,
      signal,
      ctxModel: opts.ctxModel,
      onEvent: journal.onEvent,
      onPoolResolved: journal.onPoolResolved,
      // D9①：路由层 fallback 留痕投影进 outcome（zcode 无独立 record 通路）
      ...(record.engineFallback !== undefined ? { engineFallback: record.engineFallback } : {}),
      // D10 终止链：engine spawn 的子进程注册进 spawnedChildren 记账
      //（cancelBackground SIGTERM / dispose killAll 收割对非 pi record 生效）
      onChildSpawned: (child) => registerSpawnedChildForRecord(record.id, child),
    };
    try {
      const { handle, outcome } = await engine.run(executeOptionsToEngineTaskSpec(opts), runCtx);
      // engineHandle 完整回填（U2：终态迁移落 entry 前）。sessionRef 整体透传——
      // 失败终态 sessionId 缺失时也回填已有部分（dbPath/poolKey），读侧①级降②级
      // 的防御形态；journalPath 取 retarget 后的实际落盘路径（writer 是路径权威）。
      record.engineHandle = {
        sessionRef: handle.data.sessionRef,
        poolKey: handle.data.poolKey,
        journalPath: journal.path,
      };
      await journal.close();
      await this.finalizeEngineOutcome(record, outcome);
    } catch (err) {
      // engine.run prepare 期 reject（进程创建前）→ failed 终态（与 runAndFinalize catch 同语义）；
      // journal 尽力而为收口（②级数据源写失败已由 writer 内部 warn 收敛）
      await journal.close();
      await this.finalizeFailed(record, err);
    }
  }

  /**
   * 分层并发配额：depth 越深可用配额越少（下限 1）。fork 深度护栏在池维度的投影，
   * 公式约定以 concurrency-pool.ts 注释为登记处、此处为唯一代码锚点。
   */
  private effectiveMaxConcurrentFor(record: ExecutionRecord): number {
    return Math.max(1, this.pool.maxConcurrent - record.depth);
  }

  /**
   * engine.run resolve 的终态迁移：outcome.error → failed（success=false + error 文案）；
   * 否则 done（result=content）。CAS 抢锁（tryTransition）防与 cancelBackground 双收尾。
   */
  private async finalizeEngineOutcome(record: ExecutionRecord, outcome: AgentOutcome): Promise<void> {
    if (outcome.sessionFile !== undefined) {
      record.sessionFile = outcome.sessionFile;
    }
    const result: AgentResult = {
      text: outcome.content,
      turns: outcome.usage?.turns ?? 0,
      durationMs: outcome.durationMs ?? Date.now() - record.startedAt,
      success: outcome.error === undefined,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      sessionId: outcome.sessionId ?? record.id,
      toolCalls: [],
      ...(outcome.parsedOutput !== undefined ? { parsedOutput: outcome.parsedOutput } : {}),
    };
    if (tryTransition(record, "closed", "gc")) {
      await this.finalizeRecord(record, result, "closed", "gc");
    }
  }

  // ── 执行内部：run + finalize（sync/bg 共用）──────────────

  /** 共享的"干活 + 收尾"——sync 直接 await，background 在 detached 里调。 */
  private async runAndFinalize(
    record: ExecutionRecord,
    opts: ExecuteOptions,
    ctx: SessionRunnerContext,
    identity: ResolvedIdentity,
    signal: AbortSignal | undefined,
    priority: number,
    rawOnEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
    /** resume 选项（M2-B1）：透传 runSpawn，重开已 idle 的 session 续聊。undefined = 新 session。 */
    resume?: SpawnResumeOpts,
  ): Promise<AgentResult> {
    const pooled = record.mode === "background";
    let acquired = false;
    if (pooled) {
      try {
        await this.pool.acquire(priority, this.effectiveMaxConcurrentFor(record), signal);
        acquired = true;
      } catch {
        // S1: 排队中被 abort（signal.aborted）走 cancelled，与已运行被 abort 一致。
        if (signal?.aborted) return this.finalizeAborted(record);
        return this.finalizeFailed(record, new Error("aborted"));
      }
    }
    // onEvent 直通（原此处曾有 onUpdate(project(record)) 节流回流包装——生产死路径，
    // 三调用点恒 onUpdate: undefined、仅测试触达，已按 swf-perf-impl ledger #22 删除
    // （决策 TC4/IF14，详见 .cw/swf-perf-impl/cleanup-slice-design.json；git 历史可完整恢复）。
    // ExecuteOptions.onUpdate 字段一并删除，未来误用将编译期失败而非静默无效。
    const onEvent = rawOnEvent;

    // 解析 worktree 参数：boolean → WorktreeHandle | undefined（true/undefined 由 run 内部处理）
    let worktreeHandle: WorktreeHandle | undefined;
    if (typeof opts.worktree === "object") {
      worktreeHandle = opts.worktree;
    }
    // [MF#4][MF#2] fork 深度护栏：ALS 传递深度（主 session 链无 store→0，fork 推进 +1）。
    const parentDepth = this.forkDepthAls.getStore() ?? this.forkDepthBaseline;
    const effectiveDepth = opts.fork ? parentDepth + 1 : parentDepth;

    let result: AgentResult;
    try {
      // 嵌套上下文包在 forkDepthAls 内层：B run() 期间挂 {recordId:B.id,depth:B.depth}，
      // B 内创建 C 时 createRecordForMode 读到 B → C 挂到 B 名下。两层 ALS 独立但同生命周期。
      result = await this.forkDepthAls.run(effectiveDepth, () =>
        this.execNesting.run(
          { recordId: record.id, depth: record.depth },
          () => runSpawn(record, opts.task, {
            resolved: identity.resolved,
            agentConfig: identity.agentConfig,
            appendSystemPrompt: opts.appendSystemPrompt,
            skillPath: opts.skillPath,
            schema: opts.schema,
            schemaEnv: opts.schemaEnv, // D-A6 bridge: workflow 编排层透传 schema 到 childEnv
            maxTurns: opts.maxTurns,
            graceTurns: opts.graceTurns,
            signal,
            onEvent,
            stream, // text_delta streaming（background 路径有值，workflow 路径 undefined）
            fork: opts.fork,
            // [v8.5 B] fork-from 显式源（ExecuteOptions.forkFromSessionFile）优先于
            // opts.fork 推导的 mainSessionFile；undefined = 旧语义不变。
            forkSource: opts.forkFromSessionFile,
            worktree: worktreeHandle,
            parentForkDepth: parentDepth, // [MF#4] 父链深度，不从 opts 读
          }, ctx, resume),
        ),
      );
    } catch (err) {
      // run() 正常路径不抛错，但创建期异常（createAndConfigureSession 失败）
      // 会逃逸出 run() —— 合成 failed result + 收尾。
      // swallow（不 re-throw）：sync 调用方拿到合成 failed result，background 的
      // .then 正常跑 notify。避免异常逃逸到 tool 层 + record 卡 running。
      //
      // MF-6（决策 6 spec §3.1）：chatMode（含 resume）spawn/创建失败不销毁对话——回退 idle
      //（可恢复），让 agent 可重试 message 或 close。与一次性模式（finalizeFailed 终态销毁）区分。
      if (record.chatMode) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const failedResult: AgentResult = {
          text: "",
          turns: record.turnCount,
          durationMs: Date.now() - record.startedAt,
          success: false,
          error: errMsg,
          sessionId: record.id,
          toolCalls: [],
        };
        if (tryTransition(record, "closed", "gc")) {
          // 回退 idle（record.result 由 finalizeRoundToIdle 设为 error 兜底文本，notify 可读）。
          await this.finalizeRoundToIdle(record, failedResult);
        }
        return failedResult;
      }
      result = await this.finalizeFailed(record, err);
      return result;
    } finally {
      if (pooled && acquired) this.pool.release();
      // 清除 streaming widget（subagent 终态，幂等）
      stream?.dispose();
      // [review MF1] 清除在途 resume 守卫（幂等）：本轮收尾——无论轮次完成（early return）、
      // MF-6 失败回退 resumable、abort 还是终态化，record 都可再次接受冷路径 message。
      // execute() 新建 record 不在集合，delete 是 no-op。
      this.resumesInFlight.delete(record.id);
    }

    // [V2 决策 2/3] chatMode 首轮闭环：runSpawn 因 agent_settled 提前 resolve（onRoundSettled
    // 已设 record.status=idle + round+=1 + notify 主 agent）。进程仍保活（idle timer armed），
    // 不进下方 chatMode 分流（那是 close 后 done/failed/cancelled 终态化的，走 finalizeRoundToIdle
    // / finalizeRecord）。tryTransition(idle→done) 天然失败（要求 status==="running"），此处显式
    // early return 让语义清晰 + 防状态机未来改动。防 double-notify 由 notifier dedup 兜底
    //（同 id:round 60s 内吞，chat 轮次收尾 .then 的 notify 是 no-op，见 notifier.ts L122）。
    if (record.chatMode && isIdle(record)) {
      return result;
    }

    // v4 B-1: status 恒为 closed。cancelled 折入 closed（closedReason='cancelled'）。
    const aborted = signal?.aborted === true;
    // closedReason 派生：aborted → cancelled；否则 success → user-close，!success → gc。
    const closedReason: ClosedReason = aborted ? "cancelled" : result.success ? "user-close" : "gc";

    // CAS 抢锁：抢到则完整收尾；没抢到（cancel 已先设 closed+cancelled）则跳过
    if (tryTransition(record, "closed", closedReason)) {
      if (record.chatMode && !aborted && result.success) {
        if (record.closeAfterRound) {
          // close 优雅关闭（force:false）：当前轮完成后终态化为 closed。
          record.closeAfterRound = undefined;
          await this.finalizeRecord(record, result, "closed", "user-close");
        } else {
          // 对话模式轮次成功完成 → 保持 running（旧 idle 折入 running，finalizeRoundToIdle 设回 running）。
          await this.finalizeRoundToIdle(record, result);
        }
      } else if (record.chatMode && (!result.success || aborted)) {
        // MF-6：chatMode 轮次失败/取消不销毁对话——回退 running-resumable（旧 idle，可恢复）。
        if (record.closeAfterRound) {
          // [M5] 优雅关闭挂起的失败/取消轮：轮已完成即兑现 close 意图终态化（含本轮 result），
          // 不再回退 resumable——否则标志残留到下一轮，record 已被 tool 谎报 closed。
          record.closeAfterRound = undefined;
          await this.finalizeRecord(record, result, "closed", closedReason);
        } else {
          await this.finalizeRoundToIdle(record, result);
        }
      } else if (!record.chatMode && !aborted && result.success) {
        if (record.closeAfterRound) {
          // [M5] 非 chatMode（one-shot）busy 时 close(force:false) 置的标志在本轮完成时消费
          // 终态化（对齐 close schema 文案 "release its resources"）。旧代码走
          // finalizeRoundToIdle 不消费——tool 返回 {closed:true} 谎报，record 永久
          // running-resumable、5min idle timer 杀进程、期间还能继续收 message。
          record.closeAfterRound = undefined;
          await this.finalizeRecord(record, result, "closed", "user-close");
        } else {
          // [SP-5] one-shot 成功完成 → 保持 running（旧 idle），等待 message 触发 upgrade。
          await this.finalizeRoundToIdle(record, result);
        }
      } else {
        // 非 chatMode 失败/取消 或其他终态：一次性销毁（archive + worktree cleanup）。
        await this.finalizeRecord(record, result, "closed", closedReason);
      }
    }
    return result;
  }

  /**
   * pi chat 域轮次的 detached 编排（D2 单轨——旧 pi 主路径绕过 EnginePort 的 detached
   *  编排删除后的 EnginePort 化形态）：
   * 预备轮次（record/opts/identity/host ctx/stream/resume）挂载交接 Map → engine.run 经
   * ctx.taskId 消费（PiEngine chat 分支回调 runChatRound——即 runAndFinalize 链，含 pool
   * 并发槽 acquire/release 与杀链，行为零变化）→ 完成回注 notify（cancel 抢先时跳过，
   * 与旧 .then 语义一致）。
   * stream 在挂载前同步创建（spawn 前置不变量，stream-sink 退役步骤 2 守护）。
   * chat 域不接 event journal（pi 子代理 session JSONL 即原生数据源；与迁移前产物
   * 形态一致——journal 接线仅 workflow 域 SAR 与非 pi 引擎 chat 路径）。
   */
  private kickOffChatRound(
    record: ExecutionRecord,
    opts: ExecuteOptions,
    identity: ResolvedIdentity,
    ctx: SessionRunnerContext,
    signal: AbortSignal | undefined,
    priority: number,
    /** resume 选项（M2-B1）：透传轮次执行→runSpawn。undefined = 新 session。 */
    resume?: SpawnResumeOpts,
  ): void {
    // 创建 streaming 生命周期对象。策略（含 widget 退役步骤 2：GUI + relay 激活时停发
    // 私货、TUI/未激活原样创建、sink 未注入降级 undefined）集中在 createBackgroundStream。
    const stream = createBackgroundStream(record.id, this.streamSink, ctx.mode, process.env);

    this.chatRoundTickets.set(record.id, { record, opts, identity, ctx, signal, priority, stream, resume });
    void this.chatPiEngine
      .run(
        // task 形参仅满足 port 签名——chat 轮次的任务声明由 ticket lossless 携带
        //（identity/forkFromSessionFile/host ctx 不在 AgentTaskSpec 字段表内，见
        // ChatRoundTicket 注释；u-3b 合流后消除双形态）
        executeOptionsToEngineTaskSpec(opts),
        { taskId: record.id, poolKey: PI_POOL_KEY, signal, stream },
      )
      .then(() => {
        // background 回注：仅当本路径抢到 CAS（closedReason 非 cancelled）才 notify。
        // cancel 抢先时 closedReason='cancelled'，cancelBackground 自己 notify，此处跳过。
        if (record.closedReason !== "cancelled") {
          this.notifyHost.notifyComplete(record);
        }
      })
      .catch((err: unknown) => {
        // detached 吞错：轮次执行内部已 finalize record（含 emitPendingUnregister），
        // 且 finalizeRecord 的 manifest 写入已降级为 best-effort（失败仅 logger.error + appendEntry，
        // 不外抛）。因此此处不应走到——但作为最后一道兼底，记录调试日志后吞下，不外抛。
        // 完成通知由 finalizeRecord 内的 emitPendingUnregister 承担（pending-notifications 消费）。
        // cancel 抢先时 status=cancelled，cancelBackground 自己 emit，此处无需重复。
        // 交接包未被消费（engine.run 前置 throw 的极端形态）时的泄漏兜底。
        this.chatRoundTickets.delete(record.id);
        if (err instanceof Error) {
          logger.debug(`[subagent] background finalize error (record=${record.id}): ${err.message}`);
        }
      });
  }

  /** PiEngine 的编排服务适配器（chat 绑定）：闭包持有本实例的编排面——chat 轮次交接
   *  由此成为 PiEngineService 的可选面（SAR 直绑 Service 的 workflow 实例不提供，
   *  Service 公共接口不为引擎内部交接扩面）。 */
  private piEngineServiceAdapter(): PiEngineService {
    return {
      executeAndAwait: (opts, signal, onEvent, stream) => this.executeAndAwait(opts, signal, onEvent, stream),
      getRecordForAction: (id) => this.getRecordForAction(id),
      closeSubagent: (record, force) => this.closeSubagent(record, force),
      cancel: (id) => this.cancel(id),
      collectRecords: (limit, statusFilter) => this.collectRecords(limit, statusFilter),
      takeChatRound: (taskId) => this.takeChatTicket(taskId),
      runChatRound: (ticket) => this.runTicketRound(ticket),
      resumeChatRound: (record, text) => this.resumeColdRound(record, text),
      reportRecordTransition: (record) => this.store.reportRecordTransition(record),
    };
  }

  /** [D4 聚合连带] PiEngineService 的显式结构视图（registration / SAR 直绑消费）。
   *  原两绑定点把 SubagentService 整体结构化兼容为 PiEngineService——依赖查询/交互
   *  方法 public；聚合收窄后改经本视图显式适配（成员集合与原直绑等价，行为零差异）。
   *  getter 形态：face 视图（惰性构造的适配对象）而非动作方法。 */
  get asEngineService(): PiEngineService {
    return this.piEngineServiceAdapter();
  }

  /** chat 域轮次交接的消费侧（PiEngine.run 回调）：一次性取走，防重复消费。私有名与
   *  PiEngineService 可选面成员不同名（历史约束：D4 聚合前的结构化直绑时代，私有同名
   *  成员会阻断 SubagentService 直绑；聚合后经 asEngineService 显式视图，约束已消失，
   *  不同名保留为与 adapter 显式映射一致的命名纪律）。 */
  private takeChatTicket(taskId: string): ChatRoundTicket | undefined {
    const ticket = this.chatRoundTickets.get(taskId);
    if (ticket !== undefined) this.chatRoundTickets.delete(taskId);
    return ticket;
  }

  /** PiEngine chat 分支的执行回调：原 runAndFinalize 直调链的 EnginePort 化落点
   *  （编排归 Service——pool 槽 + runSpawn + 终态迁移，行为零变化）。 */
  private async runTicketRound(ticket: ChatRoundTicket): Promise<AgentResult> {
    return this.runAndFinalize(
      ticket.record,
      ticket.opts,
      ticket.ctx,
      ticket.identity,
      ticket.signal,
      ticket.priority,
      undefined,
      ticket.stream,
      ticket.resume,
    );
  }

  /** 取消 background record。CAS 抢锁——抢到则 notify + 写 tombstone。 */
  private cancelBackground(record: ExecutionRecord): boolean {
    record.controller?.abort();
    // [M6] 显式 kill + disarm：chatMode 首轮 agent_settled 后 runSpawn 提前 resolveRun(0)
    // 返回，`opts.signal.removeEventListener("abort", onAbort)`（session-runner runSpawn 尾部）
    // 已移除 abort→kill listener；热路径续聊轮（PiEngine 直接 stdin 写入）不再
    // 进 runSpawn。此后 cancel 只有 controller.abort() 无人响应——record 已终态化 cancelled
    // 但子进程继续跑完当前 turn（工具副作用继续发生），之后 agent_settled 还对已 archived
    // record 触发脏通知（round+1 → 新 dedup key → "finished a round"），最终靠 5min idle
    // timer 兜底 kill。故 cancel 必须显式 SIGTERM + disarm idle timer。非 chatMode 路径
    // listener 仍在（abort 已 kill 一次），此处对已 killed child 是 no-op，无副作用。
    const child = getChildByRecord(record.id);
    if (child && !child.killed) child.kill("SIGTERM");
    disarmIdleTimer(record.id);
    if (!tryTransition(record, "closed", "cancelled")) {
      return false; // detached 已 finalize，cancel 来晚了
    }
    // 抢到锁：completeRecord（用空 result 填 cancelled）+ archive（立即移出内存）+ notify。
    // 写 cancelled tombstone：session.jsonl 被 abort 截断，cancelled 状态靠 sidecar 标记，
    // collectRecords 重建时 override status=cancelled。durationMs 用真实耗时（startedAt → now）。
    const cancelledResult: AgentResult = { text: "", turns: record.turnCount, durationMs: Date.now() - record.startedAt, success: false, error: "cancelled by user", sessionId: record.id, toolCalls: [] };
    completeRecord(record, cancelledResult, "closed", "cancelled");
    // 写 tombstone（best-effort，sessionFile 可能为 undefined——窗口期 cancel）。
    if (record.sessionFile) {
      writeCancelledTombstone(record.sessionFile, {
        id: record.id,
        status: "cancelled",
        agent: record.agent,
        startedAt: record.startedAt,
        endedAt: record.endedAt ?? Date.now(),
      });
    }
    this.store.archive(record);
    // worktree cleanup + removeAliveMarker（cancel 不写 finalized，BC-4 互斥）。
    // cleanup 已 async 化——boolean 同步返回语义不变，清理 fire-and-forget。
    if (record.worktreeHandle) {
      void this.worktreeManager.cleanup(record.worktreeHandle).catch((err: unknown) => {
        bestEffort(err, "worktree cleanup (cancelBackground)");
      });
    }
    if (record.sessionFile) {
      try {
        removeAliveMarker(record.sessionFile);
      } catch (err) {
        bestEffort(err, "removeAliveMarker (cancelBackground)");
      }
    }
    // pending-notifications：cancel 注销（只记 registry 状态）
    this.notifyHost.emitPendingUnregister(record.id, "closed");
    // cancel 完成通知（与轮次收尾 .then 对称——cancel 抢先时 .then 跳过 notify）
    this.notifyHost.notifyComplete(record);
    return true;
  }

  /**
   * D-017 时序收尾：委托 doFinalizeRecord（提取到 finalize-record.ts，降低本文件行数）。
   * [Critical #1] cleanup 全部在 manifest 写之前，manifest best-effort 不阻断（详见 finalize-record.ts）。 */
  private async finalizeRecord(
    record: ExecutionRecord,
    result: AgentResult,
    status: "closed",
    closedReason?: ClosedReason,
  ): Promise<void> {
    await doFinalizeRecord(
      {
        manifestStore: this.manifestStore,
        worktreeManager: this.worktreeManager,
        store: this.store,
        modelService: this.modelService,
        pi: this.pi,
        emitUnregister: (id, st) => this.notifyHost.emitPendingUnregister(id, st),
      },
      record,
      result,
      status,
      closedReason,
    );
  }

  /**
   * 对话模式轮次完成收尾：委托 doFinalizeRoundToIdle（record 进 idle，保留内存 + worktree）。
   * 与 finalizeRecord 对称的委托方法，deps 同源注入。chatMode + done/failed/cancelled 时由 runAndFinalize 调用
   *（MF-6：chatMode 失败/取消也回退 idle 而非终态销毁）。 */
  private async finalizeRoundToIdle(
    record: ExecutionRecord,
    result: AgentResult,
  ): Promise<void> {
    await doFinalizeRoundToIdle(
      {
        manifestStore: this.manifestStore,
        worktreeManager: this.worktreeManager,
        store: this.store,
        modelService: this.modelService,
        pi: this.pi,
        emitUnregister: (id, st) => this.notifyHost.emitPendingUnregister(id, st),
      },
      record,
      result,
    );
  }

  /** run() 创建期异常的收尾（H1 修复）：createAndConfigureSession 失败会抛，本方法合成 failed
   *  AgentResult → CAS 抢锁 → finalizeRecord（与正常路径同形）。返回合成 result 供 runAndFinalize
   *  继续返回（不 re-throw，swallow 策略）。 */
  private async finalizeFailed(record: ExecutionRecord, err: unknown): Promise<AgentResult> {
    const errMsg = err instanceof Error ? err.message : String(err);
    // durationMs 用真实耗时（startedAt → now），避免失败统计恒为 0 失真。
    const failedResult: AgentResult = { text: "", turns: record.turnCount, durationMs: Date.now() - record.startedAt, success: false, error: errMsg, sessionId: record.id, toolCalls: [] };
    // CAS 抢锁：抢到（status 仍 running）则完整收尾；没抢到（cancel 已先设 cancelled）跳过。
    // SP-1: failed → closed + gc（通用失败终态）。
    if (tryTransition(record, "closed", "gc")) {
      await this.finalizeRecord(record, failedResult, "closed", "gc");
    }
    return failedResult;
  }

  /** S1: 排队中被 abort 走 cancelled 终态（对齐已运行被 abort 的 cancelBackground）。 */
  private async finalizeAborted(record: ExecutionRecord): Promise<AgentResult> {
    const cancelledResult: AgentResult = { text: "", turns: record.turnCount, durationMs: Date.now() - record.startedAt, success: false, error: "cancelled by user", sessionId: record.id, toolCalls: [] };
    if (tryTransition(record, "closed", "cancelled")) {
      await this.finalizeRecord(record, cancelledResult, "closed", "cancelled");
    }
    return cancelledResult;
  }

  // ── 内部 ────────────────────────────────────────────────

  /**
   * 校验 Service 就绪（pi 已注入 + 未 dispose）。
   *
   * dispose 后调用是异常路径：session_shutdown 已清资源，正常情况下紧接着
   * session_start 会 initSession 复活。若走到这里说明 session_start 没跟上
   * （RPC 边界 / reload 异常等），service 卡在 disposed 状态。
   *
   * 旧实现只抛 "hub disposed"——无信息，调用方和 AI 都看不懂，导致反复盲试。
   * 现在给出原因 + 恢复指引（重启会话或 /new）。真实错误文本会经 renderResult
   * 兜底透传到 AI（见 tool-render.ts extractResultError）。
   */
  private assertReady(): void {
    if (this.pi === null) {
      throw new Error("pi not injected (initSession not called?)");
    }
    if (this._disposed) {
      throw new Error(
        "subagents service disposed (session ended). " +
          "This happens after session shutdown when the follow-up session_start did not arrive. " +
          "Recovery: start a new session or run /new to revive the subagents runtime.",
      );
    }
  }

  /** 构造 SessionRunnerContext（spawn 模式：无需 SDK 实例）。 */
  private buildSessionRunnerContext(overrideCwd?: string): SessionRunnerContext {
    return {
      cwd: overrideCwd ?? this.cwd,
      agentDir: this.modelService.getAgentDir(),
      // ADR-031 废弃 discovery.json 后，skillDirs 为空。子 session 的 --skill
      // 由 agent({skill}) 调用方显式传入（resolveSkillPath → opts.skillPath）。
      skillDirs: [],
      mainCwd: this.cwd,
      // mainSessionFile: fork source 解析用，从 session_start 缓存获取。
      mainSessionFile: this.getMainSessionFile?.() ?? undefined,
      // worktree pid 回调：session-runner first header 时补全注册表 pid。
      onWorktreePid: (branch: string, pid: number, sessionFile?: string) => this.worktreeManager.registerPid(branch, pid, sessionFile),
      uiRequestHandler: this.uiRequestHandler,
      // SR-4：L2 dialog 队列透传——child close 时 session-runner 据此调 rejectChildDialogs
      // 清理 L2 pending dialog，防全局死锁。undefined 时 session-runner 跳过 L2 清理。
      dialogQueue: this.dialogQueue,
      // 主进程运行模式：session-runner W4 守卫据此决定是否注入 ask_user RPC 提示词。
      mode: this.uiObservability.getMode(),
      // [递归可见性] 透传所属根 session（runSpawn 注入为子进程 env PI_SUBAGENT_ROOT_SESSION_ID）。
      // sessionRootId 在 initSession 设定（根进程=sessionId，子进程=env 贯穿的真 ROOT）。
      // execute/executeAndAwait 调本方法前必经 initSession，此时 sessionRootId 已非空；
      // ?? 兑底防类型漂移（运行时不可达）。
      sessionRootId: this.sessionRootId ?? this.sessionId ?? "",
      // [MF-3] 透传 ROOT cwd（runSpawn 落盘目录编码键 + 注入子进程 env PI_SUBAGENT_ROOT_CWD）。
      // worktree 模式下 mainCwd = 本进程 checkout 路径，rootCwd 才是真 ROOT——session 文件
      // 落盘统一用 rootCwd 编码，ROOT 磁盘重建才扫得到深层 record（与 sessionRootId 同构）。
      rootCwd: this.rootCwd,
      // [V2 决策 2] chatMode 首轮闭环：agent_settled 时 session-runner 调本回调。
      // [D4-②] 业务闭包已拆至 round-settlement.ts（this.settleRound 字段工厂构造，
      // deps 回调注入 notifyComplete / reportRecordTransition / closeAfterRoundSettled，
      // 行为逐字节等价）——轻量 idle 化语义（round+=1 + notify 主 agent，不调
      // doFinalizeRoundToIdle）与增量派生/base 推进/哨兵的机制注释见该文件。
      onRoundSettled: this.settleRound,
    };
  }
}

// ── 进程单例访问器 ────────────────────────────────────
// globalThis[Symbol.for] 防 jiti 路径不同致单例分裂。详见 docs/standards.md §7.5。
const SERVICE_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.service");

type ServiceSlot = { current: SubagentService | null };

function getServiceSlot(): ServiceSlot {
  let slot = Reflect.get(globalThis, SERVICE_SLOT_KEY) as ServiceSlot | undefined;
  if (!slot) {
    slot = { current: null };
    Reflect.set(globalThis, SERVICE_SLOT_KEY, slot);
  }
  return slot;
}

/** 获取进程单例。session_start 前为 null。 */
export function getSubagentService(): SubagentService | null {
  return getServiceSlot().current;
}

/** 设置进程单例（session_start 首次创建时）。 */
export function setSubagentService(service: SubagentService): void {
  getServiceSlot().current = service;
}
