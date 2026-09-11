// 执行编排 + 记录领域 Service（D4 按变化轴拆分后的编排核：execute/executeAndAwait 入口、
// record 生命周期、cancel）。通知簇 → notify-host.ts；轮末分流归 ConversationContinuation
//（[H1 U2] §3.4）；冷路径查询链 → cold-lookup.ts（[H1 U6] 原 cold-resurrect.ts 改名落位）。
// 上游：subagent-tool（execute/query/cancel）、TUI（onChange/collectRecords）。
// session_start 时经 initSession 注入 pi；modelRegistry/entries 归 ModelConfigService.initModel。

import { getLogger } from "../core/logger.ts";

import type { AgentResult as WorkflowAgentResult } from "../orchestration/models/types.ts";
import { MAX_TIMER_DELAY_MS } from "../shared/timer-delay.ts";
// D-A10: workflow 侧 AgentResult 映射（executeAndAwait 出口）
import { mapToWorkflowAgentResult } from "./agent-result-mapper.ts";
import { removeAliveMarker } from "./alive-store.ts";
import { bestEffort } from "./best-effort.ts";
import { CollectCoordinator } from "./collect-coordinator.ts";
import { DEFAULT_COLLECT_SYNC } from "./config.ts";
// [V2 决策 3] lifecycle-manager idle timer：chatMode record 的 disarm 面（终态化/取消
// 路径防误杀）；[H1 U6] armChatIdleTimer（idle 相位帧 arm 锚点）随长驻消亡退役——
// 「5min idle 关闭」语义随每轮新 run + 轮末进程回收消亡（设计 §2.2#5），30 天 idle-gc
// 只归档不终态化不变。
// [T4②] DEFAULT_IDLE_TIMEOUT_MS：assertIdleTimeoutMsSafe 错误文案的缺省时长基准。
// （[M3] hasIdleTimer / hasLiveProcessHandle 的 piAdapter.hasRunningBackground 过滤随通知簇
// 在 notify-host.ts 消费，不经本文件。）
import { disarmIdleTimer, DEFAULT_IDLE_TIMEOUT_MS } from "./lifecycle-manager.ts";
import { type ConcurrencyPool,DefaultConcurrencyPool } from "./concurrency-pool.ts";
import type { UiRequestHandler } from "./dialog-queue.ts";
import { COLD_LOOKUP_SCAN_LIMIT, coldLookupForAction, type ColdLookupDeps } from "./cold-lookup.ts";
import {
  completeRecord,
  createRecord,
  project,
  snapshot,
  tryTransition,
  updateFromEvent,
} from "./execution-record.ts";
import { doFinalizeRecord, doFinalizeRoundToIdle, writeManifestBestEffort, type RoundSettlementOutcome } from "./finalize-record.ts";
// [H1 U2] chat 域统一进 run 域：ConversationContinuation（§3.4 全规格）——每 chatMode
// record 一个实例，message/close 编排与轮末分流（D7）的唯一承接组件。
import {
  ConversationContinuation,
  type ContinuationDispatchInput,
  type ContinuationRoundHandlers,
} from "./conversation-continuation.ts";
import { assertTaskShapeSupported } from "./engine/common/capability-gate.ts";
// [R1] 转发 getter 返回类型标注（值构造已迁聚合，仅 type 引用）。
import type { ExecutionNestingContext } from "./engine/common/nesting-guard.ts";
import { JOURNAL_INITIAL_POOL_KEY, wireEventJournal } from "./engine/common/journal-wiring.ts";
// [H2 W2 迁移步⑥] mergeRunSignals 提公共 helper（原 SAR 模块内直调）——workflow
// 派发的 timeout+watchdog+外部 signal 三源合流。
import { mergeRunSignals, type MergedRunSignalHandle } from "./engine/common/run-signals.ts";
import { executeOptionsToEngineTaskSpec } from "./engine/host-task-spec.ts";
import type { AgentCallOpts } from "../orchestration/models/types.ts";
// [H2 W2] workflow 域 record slug 推导（description ?? agent ?? "unknown" +
// SLUG_MAX_LENGTH 截断；原 pump dispatchAgentCall trace 命名同源规则随 [H2 W3]
// 旁路 record 族删除，唯一推导点在本文件）
import { SLUG_MAX_LENGTH } from "../orchestration/models/types.ts";
import { setHostUiRequestEndpoint } from "./engine/host/host-ui-endpoint.ts";
// [W3 chat 域收口] chat 轮次与 run 域同路：经 pi-host-binding 解析 registry 'pi' 的
// cli 形态 port（RemoteEngine），协议 run(interact) 发往 pi-subagent-cli 引擎进程。
// inproc PiEngine（inproc pi 引擎目录）已删——本文件不再持有任何本地引擎实例。
import { PI_POOL_KEY, resolveHostPiEnginePort } from "./engine/host/pi-host-binding.ts";
import type { HostBridgeServiceFace } from "./engine/host/host-bridge.ts";
import type { EnginePort, RunContext } from "./engine/port.ts";
import { DEFAULT_ENGINE_ID, getEngine, listEngines } from "./engine/registry.ts";
import {
  joinEngineModelRef,
  splitEngineModelRef,
  validateModelForEngine,
  withCrossEngineHint,
} from "./engine/model-validation.ts";
import { type EngineRouteResult, routeEngineForHost } from "./engine/routing.ts";
import type { AgentOutcome } from "./engine/types.ts";
import { ManifestStore } from "./manifest-store.ts";
import type { ModelConfigService } from "./model-config-service.ts";
import type { AgentConfig, ModelInfo, ResolvedModel } from "./model-resolver.ts";
import { type NotifyHost, type PiLike, createNotifyHost } from "./notify-host.ts";
// [T4④ / PS-5] flush 被门拦时的未投递 pending 落盘账本（persistUndeliveredNotificationsForReplay 消费）
import type { BatchBudgetParams, BgNotifyRecord } from "./notifier.ts";
// [H1 U2] notify 门迁 notifier.ts（Continuation 双闸共用），此处 re-export 保持既有
// import 路径（测试消费面 `from "../subagent-service.ts"` 不变）。
export { notifyGateAllowsDelivery } from "./notifier.ts";
import { notifyGateAllowsDelivery } from "./notifier.ts";
import { getBoundNotifyLedger, NOTIFY_LEDGER_CUSTOM_TYPE } from "./notify-ledger.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "./path-encoding.ts";
import type { StatusFilter } from "./record-store.ts";
import { RecordStore } from "./record-store.ts";
// [E1 恢复批语义修复 / S11] 恢复批补发映射 + getFullRecord miss 成员兜底落标数据源
//（变化轴拆分，实现与语义注释见 sync-rebuild.ts）
import { bufferedMemberFallbackRecord, syncRebuildToNotifyMember } from "./sync-rebuild.ts";
import { MAX_FORK_DEPTH } from "./session-context-resolver.ts";
// [W6 宿主面下沉 → W3 纯镜像] killAll / killRecord / register 三函数经
// spawnedChildren 状态镜像公共面（engine/host/spawned-children.ts）——子进程活在
// 引擎进程内，本模块只做镜像记账（终止意图位），实际终止经协议 interact cancel/close。
import {
  killAllSpawnedChildren,
  killRecordChildWithEscalation,
  registerSpawnedChildForRecord,
} from "./engine/host/spawned-children.ts";
// [u-t2a T2②/T2③ + W4] settled watchdog：会话形态轮 settled 等待两段守护。
// [H1] arm 点 = 轮开跑（kickOffChatRound）；中段刷新源 = run 事件通道 9 种既有事件
//（refreshFromProtocolEvent）；settle 交棒 = run 应答驱动（Continuation onRunSettled 内
// noteRoundSettledFromProtocol——[H1 U6] 旧协议相位帧消费面已退役）。
import {
  armMidRoundNoProgress,
  disarmRoundFromProtocol,
  disarmSettledWatchdog,
  refreshFromProtocolEvent,
  type SettledWatchdogFireInfo,
} from "./settled-watchdog.ts";
import { hasLiveProcessHandle, isIdle, isResumable } from "./lifecycle-predicates.ts";
import { startIdleGc } from "./idle-gc.ts";
// [W4] 轮次活性监督器（D2「等待有主」权威层；机制与注释见 round-supervisor/，
// 装配绑定面在 service-binding.ts——变化轴独立）
import type { RoundSupervisor } from "./round-supervisor/index.ts";
import {
  createRoundSupervisorForService,
  runPendingReconcileSweepForService,
} from "./round-supervisor/service-binding.ts";
// [W4] WorkflowRun store 纳入 idle-gc（startedAt 锚归档，宿主无关实现，见 file-run-store.ts）
import { FileRunStore } from "../orchestration/file-run-store.ts";
// [F-1 修复] idle-gc 的 WorkflowRun store 读根 = pi 壳 JsonlRunStore 同源布局
import { resolvePiWorkflowStateDir } from "./workflow-state-root.ts";
// [W4] 引擎进程死亡分诊（表 3 行 1 判据：EngineSdkError engine_crashed）
import { EngineSdkError } from "@zhushanwen/subagent-engine-sdk";
import type { ResumeAnchor } from "@zhushanwen/subagent-engine-sdk";
import type { StreamSink, SubagentStream } from "./stream-sink.ts";
import { createBackgroundStream } from "./stream-sink.ts";
import { updateRecordBinding, writeCancelledState, writeRecordBinding } from "./state-marker.ts";
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
import { isReconnectableFinalReason } from "./types.ts";
import { registerGlobalObservability } from "./ui-request-observability.ts";
// [R1] 转发 getter 返回类型标注（实例已迁聚合，仅 type 引用）。
import type { UiRequestObservability } from "./ui-request-observability.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import { toErrorMessage } from "../core/error-message.ts";
// [H3/R1] 域 #2 聚合（session 注入 + ALS/嵌套身份基线）——壳经转发 getter/方法透传，
// 对外签名零变化。ENV_SELF_RECORD_ID 常量 SSOT 随消费主体迁入聚合（壳→聚合正向 import）。
import {
  disposedUiRequestStub,
  ENV_SELF_RECORD_ID,
  SessionBaselines,
  type SubagentServiceSessionInit,
} from "./service/session-baselines.ts";

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
  /** 合并内存 + 磁盘 record（/subagents list + tool list 消费，按 rootSessionId 过滤）。
   *  [H2 W1] includeWorkflow 缺省 false = 过滤 origin==="workflow"（D1 投影过滤①③④）；
   *  true = 排查通道全量。 */
  collectRecords(limit: number, statusFilter?: StatusFilter, includeWorkflow?: boolean): SubagentRecord[];
  /** [H2 W1] 按 workflow run id 列 record（内存 ∪ 磁盘重建 ∪ manifest 口径，不过滤
   *  origin——W2 run 视图进度 / W3 下钻消费）。 */
  collectRecordsByParentRunId(parentRunId: string, limit: number): SubagentRecord[];
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
  /** chatMode 统一投递入口（message action → ConversationContinuation.onMessage，
   *  [H1 U6] interrupt 参数随 D2 打断统一语义退役）。 */
  deliverChatMessage(record: ExecutionRecord, text: string): Promise<void>;
}

// [v4 A-1] EPIPE 连续失败计数器在 stdin-writer.ts（stdin 错误域，避免 session-runner
// 反向 import 本文件 helper 产生循环依赖）。同步路径（PiEngine 热路径投递，D2 协议知识
// 下沉后）与异步路径（session-runner child.stdin.on('error')）共用 stdin-writer 的同一计数器。

// [R1] disposedUiRequestStub（dispose 后 stub UI handler，含背景/降级语义注释）已随
// 域 #2 聚合迁至 service/session-baselines.ts——壳 dispose 应答端替换经顶部 import 消费。

/** UI streaming sink 的最小接口（ctx.ui.setWidget 的 duck-typed 子集）。
 *  session_start 时从 ctx.ui 注入，background 执行期间用于把合并后的 text_delta
 *  通过 setWidget 通道转发到 RPC stdout（不经 sendMessage 的持久化路径）。 */
export type { StreamSink } from "./stream-sink.ts";

// pi 依赖端口类型 re-export：测试侧 mock PiLike 历来从本模块取（与 StreamSink 同构的门面模式）
export type { PiLike } from "./notify-host.ts";

/**
 * Service 构造参数（进程级）。
 *
 * @experimental execution 运行时面（设计 docs/design/subagent-core-sink-design.md §3.3 D6）：
 * 一个 minor 周期内允许签名微调，稳定后转常规 semver 承诺。
 */
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

/** session_start 注入参数（session 级）。
 *  [R1] 接口本体已迁 service/session-baselines.ts（唯一消费者 SessionBaselines.initSession）；
 *  此处类型别名 re-export 保持既有导出符号面（外部 `from "./subagent-service.ts"` 消费零改动）。 */
export type { SubagentServiceSessionInit };

/** background 优先级（保留 priority 排序机制，单一值）。 */
const PRIORITY_BACKGROUND = 1000;

/** 时间换算常数（settled watchdog 分钟数展示用；与 session-runner 同名常量同语义）。 */
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

// [T4① / PS-2] notify 门（NOTIFY_BLOCKED_CLOSED_REASONS + notifyGateAllowsDelivery）
// [H1 U2] 已迁 notifier.ts（Continuation 成功/失败分支双闸共用），本文件经顶部
// import 消费 + re-export 保持既有 import 路径不变。

/**
 * [H1 U2 / 红线②] stale-child 兜底的退出等待窗（ms）：镜像在途子进程活项时，协议
 * cancel（引擎侧 SIGTERM → pi trap flush → 退出）的有界收敛窗。pi 对裸 SIGTERM 做
 * graceful shutdown（窗口几十~几百 ms，见 disposedUiRequestStub 注释实测口径），
 * 300ms 覆盖常见退出路径；残余双写窗与宿主重启窗口同属红线③经验性登记（量级 =
 * 引擎存活期状态错配频次 × 窗内未退出概率，罕见）。
 */
const STALE_CHILD_EXIT_WAIT_MS = 300;

/** 有界 delay（stale-child 退出窗消费；fire-and-forget 场景不引入 timer 依赖）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// [R1] 跨进程身份贯穿 env 名常量（ENV_ROOT_SESSION_ID / ENV_SELF_RECORD_ID / ENV_DEPTH /
// ENV_ROOT_CWD，含 [MF-3] 注释）SSOT 已随域 #2 聚合迁至 service/session-baselines.ts；
// 壳经顶部 import 消费（reconcile sweep 装配闭包的 ENV_SELF_RECORD_ID 判据）。

/** [v2 D4] E1 等待分支 settled 有界重扫上限。无上限重扫 = 泄漏（设计 §3.3 D4 被否
 *  谱系）；8 次覆盖重启后主 agent 对 resumable 成员的典型续跑轮次，达限仍有
 *  running → disposed，交下次 session_start 收敛。 */
const SETTLED_RESCAN_LIMIT = 8;

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
 *     1. modelService = getModelConfigService() ?? new ModelConfigService({cwd, agentDir})
 *     2. service = getSubagentService() ?? new SubagentService({cwd, modelService})
 *     3. modelService.initModel({modelRegistry, sessionId, entries})
 *     4. service.initSession({pi, sessionId})
 *
 *   session_shutdown:
 *     service.dispose()
 *
 * 第三宿主不经 session_start 流程时改用 createSubagentService(init) 参数注入构造。
 *
 * @experimental execution 运行时面（设计 docs/design/subagent-core-sink-design.md §3.3 D6）：
 * 一个 minor 周期内允许签名微调，稳定后转常规 semver 承诺。
 */

export class SubagentService {

  // ── 域 #1 依赖装配（壳组合根；R1-R4 抽取后留壳）（R0 重排）──

  private readonly pool: ConcurrencyPool;
  private readonly store: RecordStore;
  private readonly modelService: ModelConfigService;
  private readonly cwd: string;
  private readonly worktreeManager: WorktreeManager;
  private readonly getMainSessionFile: (() => string | undefined) | undefined;

  /** [D4-①] 通知簇 host 面（notifyComplete/notifyClosed/pending 注册注销 + notifier
   *  实例封装，原私有通知簇四方法与模块函数的搬移落点——notify-host.ts）。
   *  deps 惰性求值（pi/session 级状态运行时可变），行为与原 constructor 内
   *  createNotifier(this.piAdapter()) 逐字节等价。session_start revive，shutdown dispose。
   *  [sync-collect 合并] toNotifyRecord/notify/notifyBatch 随批路由需要由 host 导出
   *  （collectCoordinator 闭包与 E9/E1 直发路径消费，见 notify-host.ts 接口注释）。 */
  private readonly notifyHost: NotifyHost = createNotifyHost({
    getPi: () => this.pi,
    listRunning: () => this.store.listRunning(),
    getIsIdle: () => this.isIdleFn,
  });

  private readonly manifestStore: ManifestStore;

  /**
   * [D6 #7a] records 目录（与 manifestStore 同源同一推导）——屏障失败 warn 带 manifest
   * 文件路径用（ManifestStore.dir 私有，此处不破封装另存同源值；漂移由构造点同语句保证不发生）。
   */
  private readonly recordsDir: string;

  /**
   * [T1/PS-9] subagent sessionDir（getSubagentSessionDir 推导，与 store 同源同一 rootCwd）。
   * 传给 doFinalizeRecord 的 FinalizeDeps.sessionDir——record.sessionFile 缺失时 finalize
   * 用它做磁盘 identity 反查（marker/alive 清理的依据）。
   */
  private readonly sessionsDir: string;

  constructor(init: SubagentServiceInit) {
    this.cwd = init.cwd;
    this.modelService = init.modelService;
    this.getMainSessionFile = init.getMainSessionFile;
    // [R1] 域 #2 基线聚合：进程级初值（uiRequestHandler / rootCwd env 推导）在聚合构造期
    // 落位；deps 全晚绑定闭包（构造期零求值——store/notifyHost 等后续才构造的依赖经闭包
    // 现读，形态先例 = D4 late-bound getter 与 notifyHost 装配闭包）。
    this.baselines = new SessionBaselines(
      { cwd: init.cwd, uiRequestHandler: init.uiRequestHandler },
      {
        // [D4 late-bound getter `() => ({pi, disposed})`] assertReady 断言状态现读：
        // pi（initSession 时点注入，经壳 getter 透传聚合）+ disposed（壳旗标）。
        readAssertState: () => ({ pi: this.pi, disposed: this._disposed }),
        // session 复活（initSession 内 revive 步骤回调）——旗标写点留壳（断言面同源）。
        reviveDisposed: () => {
          this._disposed = false;
        },
        // [C-2 显式回调] #5 SyncCollect 的 settledRescanState 复活重置（R2 抽取后改指
        // 聚合显式接口；当前为壳字段的显式封装——跨聚合边不再隐式直写）。
        resetSettledRescan: () => {
          this.settledRescanState = null;
        },
        getStore: () => this.store,
        getNotifyHost: () => this.notifyHost,
        // [跨域编排回调] initSession 复活后编排（R3/R4 域方法；抽取后改指聚合显式接口）。
        recoverOrphans: () => this.recoverOrphansIfRootProcess(),
        bootRoundSupervisor: () => this.roundSupervisor.bootPartition(),
        runPendingReconcileSweep: () =>
          runPendingReconcileSweepForService(
            {
              getStore: () => this.store,
              getPi: () => this.pi,
              getSessionRootId: () => this.sessionRootId,
              getMainSessionFile: () => this.mainSessionFile,
              finalizeClosed: (record, result) => this.finalizeRecord(record, result, "closed", "gc"),
            },
            (process.env[ENV_SELF_RECORD_ID] ?? "") !== "",
          ),
      },
    );
    // [W6 R3 MF-A] 壳侧应答端登记：cli 形态引擎经 host/askUser 反向请求消费（discovery
    // portFactory 构造 EngineClient 时读取该登记）。
    setHostUiRequestEndpoint(init.uiRequestHandler);
    this.pool = new DefaultConcurrencyPool(this.modelService.getGlobalConfig().maxConcurrent);
    this.worktreeManager = new WorktreeManager(this.modelService.getAgentDir());
    // [MF-3] worktree 隔离下全树落盘目录统一到 ROOT cwd：子进程（spawn cwd = worktree checkout 路径）
    // 若按自身 cwd 编码目录，深层 record 写到 enc(worktree) 段，ROOT 磁盘重建扫不到。
    // rootCwd 的 env 推导随域 #2 聚合（session-baselines.ts 构造器）；sessions 与 records 两套
    // 目录必须同源（同一 rootCwd），否则 enc 段不变量断裂（只改其一会让同 record 的
    // session 文件与 manifest 分落两段，GC/重建互相找不到）。
    const sessionsDir = getSubagentSessionDir(this.modelService.getAgentDir(), this.rootCwd);
    const recordsDir = getSubagentRecordsDir(this.modelService.getAgentDir(), this.rootCwd);
    this.sessionsDir = sessionsDir;
    this.recordsDir = recordsDir;
    this.manifestStore = new ManifestStore(recordsDir);
    this.store = new RecordStore(sessionsDir, this.manifestStore, this.pi ?? undefined);
    // collectCoordinator（subagent-sync-collect U2）：notifyComplete 唯一路由入口——
    // async 直通（字节不变）/ sync 批缓冲 + 闭合检测。[U3 接线点] 已接线：flush =
    // manifest 屏障（await 全部落盘）→ notifier.notifyBatch 单条批投递（幂等键
    // sync-batch:<hash> + 闭合触发排程合批 flush：同宏任务去抖窗口收纳背靠背
    // route——U8 拆批盲窗修复 → ledger 写账 → attemptDeliver 边沿投递）+
    // batchFinalized 落标（出口①，见下方闭包注释）。屏障先于写账 = 「通知可达 ⇒
    // 索引就位」的构造性保证（时序竞态修复，见 flushBatch 闭包注释）。
    // [U8] 排程与 E9/E1 交互：dispose 经 convertPendingSyncBufferToAsync 先取消挂起
    // 排程（取消而非同步 flush——双通道并发写账防护，见该函数注释）；E1 只在
    // session_start 编排处运行（此前 dispose 已取消排程，补发直走 notifyBatch 不经
    // 协调器），异常时序相撞由账本 sync-batch:<hash> 幂等拒绝兜底。
    // [D4-① 合并] notifier 实例封装在 notifyHost 内（createNotifyHost 装配），本类
    // 经 this.notifyHost.notify / notifyBatch / toNotifyRecord 出口消费。
    this.collectCoordinator = new CollectCoordinator({
      notifyAsync: (record) => {
        const notify = this.notifyHost.toNotifyRecord(record);
        if (notify) this.notifyHost.notify(notify);
      },
      toNotifyRecord: (record) => this.notifyHost.toNotifyRecord(record),
      // 闭合判定数据源：listAllActive（原始 ExecutionRecord 内存态，携带 collectMode/
      // batchFinalized 原始值）。[U3 修正] 原接 collectRecords——其经 recordToSubagent
      // 投影丢 collectMode（U2 披露的投影缺口）→ 真链上闭合判定恒立即闭合、跨轮续累
      // 失效（真链 trace 实证）。非终态 sync 成员必在内存（archive 只删终态；磁盘重建
      // 残留属孤儿恢复域），内存视图语义完整。
      listRecords: (limit) => this.store.listAllActive().slice(0, limit),
      flushBatch: async (members) => {
        // [E9 防御过滤] 排除 dispose 时已转 async 写账的成员（同进程 revive 后协调器
        // 缓冲残留的陈旧快照，见 e9ConvertedIds 字段注释）；全被排除 → 空批零副作用
        // 返回（成员已单独写账+落标，无需再动）。
        const live = members.filter((m) => !this.e9ConvertedIds.has(m.id));
        if (live.length === 0) return;
        // 成员全量快照：getFullRecord 冷路径重建（成员在 notifyComplete 前已 archive，
        // 内存无；闭合判定 hasRunningSync 的 listRecords 扫描已建 idToFile 索引，此处
        // 命中）。快照在屏障前一次取定，屏障写与落标共用同一份（manifest 与落标 entry
        // 字段同源）。
        // [S11] getFullRecord 不可达（子 session 文件缺失/已 GC 的窗口）的成员改用
        // 缓冲快照兜底落标，不再跳过——该成员仍随 live 进批写账（成员集 hash 含它），
        // 跳过落标的旧行为会在重启后让 E1 重新收集它（无标记候选），以异成员集 hash
        // 重新补发 → 同成员双投递（异 hash 不触发账本 sync-batch 幂等；旧注释「该
        // 窗口下 E1 本也收不到该成员」不成立：E1 走主 session 文件末条 entry 扫描，
        // 与 getFullRecord 的 manifest/子文件通路相互独立，manifest 屏障 best-effort
        // 写失败同样制造此窗口）。
        const fulls: SubagentRecord[] = [];
        const fullMissed: BgNotifyRecord[] = [];
        for (const m of live) {
          const full = this.store.getFullRecord(m.id);
          if (full) fulls.push(full);
          else fullMissed.push(m);
        }
        // [时序屏障] 成员 manifest 写先于写账并 await 全部落盘——「通知可达 ⇒ 索引
        // 就位」的构造性保证（by construction）：批通知的指针行消费依赖
        // records/<sa-id>.json 反查索引，fire-and-forget 下「通知送达时已落盘」只是
        // 大概率成立（探针实测 mtime 相对 notify entry ±2/3ms 方向不定）。写失败仍
        // best-effort（debug 不阻断写账投递，语义与 doFinalizeRecord Step 4 一致）。
        await this.writeSyncBatchManifestBarrier(fulls);
        // 单条批投递：accepted=false（同成员集批已在账——E1 重建重发/重复 flush）或
        // 空批/dispose → 零副作用返回，不落标（设计 §3.1.3 出口①绑「写账成功」）。
        const accepted = this.notifyHost.notifyBatch(live, this.getCollectSyncBudget());
        if (!accepted) return;
        // batchFinalized 纯落标（设计 §3.1.3 两出口之一：批闭合 flush 写账成功后）。
        // collectMode/batchFinalized 显式覆写在 appendBatchFinalizedEntry 内（防非
        // entry 源重建丢标记）；末条 entry 带标记 → E1 重建扫描（collectMode=sync 且
        // 无标记才收）据此排除，防双重通知。源序「写账先于落标」不变（v1 幂等窗口
        // 语义）；manifest 已在屏障提前写，幂等窗口内崩溃时索引更早已就位。
        for (const full of fulls) {
          this.appendBatchFinalizedEntry(full);
        }
        // [S11] miss 成员兜底落标（缓冲快照 → 最小标记 entry，映射见 sync-rebuild.ts），
        // 与 fulls 同出口①语义（写账成功后统一补标）。
        for (const m of fullMissed) {
          this.appendBatchFinalizedEntry(bufferedMemberFallbackRecord(m, this.sessionRootId ?? undefined));
        }
      },
    });
    // #11：注册进程级 observability 单例——inproc UI 请求队列 handleUiRequest（已删） 经
    // globalThis 桥接（notifyMissingHandlerGlobal）调到同一实例，共享
    // warnedMissingHandlerSessions 去重集合。未注册时 queue 走 fallback warn（不去重）。
    registerGlobalObservability(this.uiObservability);
  }

  // [D4-①] 通知簇四方法（notifyComplete / notifyClosed / piAdapter / toNotifyRecord）
  // 与 emitPendingRegister / emitPendingUnregister 模块函数已整体搬移至 notify-host.ts
  //（本类经 this.notifyHost 消费；行为逐字节等价，搬移 + 依赖注入）。

  // ── 对外聚合面（域 #0，壳终态保留 D3）（R0 重排）──

  /** [D4 查询面聚合] 读模型消费面（壳 interface/ 视图与 tool 查询经此访问；
   *  纯委托——方法本体保留 private 实现不重写，行为逐字节等价）。 */
  readonly queries: SubagentQueries = {
    findRecord: (id) => this.findRecord(id),
    lookupRecordAnyState: (id) => this.lookupRecordAnyState(id),
    collectRecords: (limit, statusFilter, includeWorkflow) =>
      this.collectRecords(limit, statusFilter, includeWorkflow),
    // [H2 W1] parentRunId 查询入口：rootSessionFilter 口径与 private collectRecords 一致
    //（sessionRootId → sessionId → undefined 兜底），委托 store（不过滤 origin）。
    collectRecordsByParentRunId: (parentRunId, limit) =>
      this.store.collectRecordsByParentRunId(
        parentRunId,
        limit,
        this.sessionRootId ?? this.sessionId ?? undefined,
      ),
    getFullRecord: (id) => this.getFullRecord(id),
    onChange: (listener) => this.onChange(listener),
  };

  /** [D4 对话 action 面聚合] chat 域 message/close 消费面（壳 subagent-actions 经此访问；
   *  纯委托同上。PiEngineService 适配器不经此——引擎边界走 piEngineServiceAdapter）。 */
  readonly chatActions: SubagentChatActions = {
    getRecordForAction: (id, opts) => this.getRecordForAction(id, opts),
    closeSubagent: (record, force) => this.closeSubagent(record, force),
    deliverChatMessage: (record, text) => this.deliverChatMessage(record, text),
  };

  // ── 域 #2 SessionBaselines 聚合转发（R1 抽取；本体 execution/service/session-baselines.ts）──

  /** [R1] 域 #2 聚合实例：session 级基线状态（pi / session 身份 / fork ALS / 嵌套 ALS /
   *  UI handler 面）的唯一宿主与唯一写者（r0-inventory 清单① #13-#25 共 13 字段）。
   *  deps 全晚绑定闭包（装配见构造器），壳经下方 getter/方法透传，对外签名零变化。 */
  private readonly baselines: SessionBaselines;

  // 基线字段读路径透传（R1 打样模式 2·strangler 转发壳）：壳内既有 this.X 引用点零改动；
  // 写点已收口聚合方法（D1 单写者），只 getter 无 setter = 壳侧只读。
  private get pi(): PiLike | null { return this.baselines.pi; }
  private get sessionId(): string | null { return this.baselines.sessionId; }
  private get mainSessionFile(): string | undefined { return this.baselines.mainSessionFile; }
  private get sessionRootId(): string | null { return this.baselines.sessionRootId; }
  private get streamSink(): StreamSink | null { return this.baselines.streamSink; }
  private get isIdleFn(): (() => boolean) | undefined { return this.baselines.isIdleFn; }
  private get execNesting(): ExecutionNestingContext { return this.baselines.execNesting; }
  private get rootCwd(): string { return this.baselines.rootCwd; }
  private get uiObservability(): UiRequestObservability { return this.baselines.uiObservability; }

  /** session_start 注入 pi + revive（modelRegistry/entries 归 ModelConfigService.initModel）。
   *  本体已迁 SessionBaselines.initSession（fork/exec 嵌套基线建立、复活与跨域编排时序
   *  逐行等价随迁）；壳纯转发，对外签名不变。 */
  initSession(init: SubagentServiceSessionInit): void {
    this.baselines.initSession(init);
  }

  /**
   * [F6] 当前根 session id 的只读访问——引擎接线方（SAR 等）构造 RunContext 注入
   * `ctx.sessionRootId`（pi 引擎 relay 归属键 SESSION_ID 权威源）。initSession 后有值
   * （根进程 = 本 session id；嵌套 = env 贯穿的真 ROOT）。[D3+] 壳终态保留面。
   */
  getSessionRootId(): string | null {
    return this.baselines.getSessionRootId();
  }

  /** UI streaming sink 只读访问（workflow 域消费）。[D3+] 壳终态保留面。 */
  getStreamSink(): StreamSink | null { return this.baselines.getStreamSink(); }

  /** [D4 下沉] 就绪断言本体已迁聚合（late-bound getter 现读 pi/disposed，错误文案不变）；
   *  壳 9 个调用点经此转发。 */
  private assertReady(): void {
    this.baselines.assertReady();
  }
  // ── 域 #5 sync 批（R2 SyncCollectDomain）（R0 重排）──

  /** collectCoordinator（subagent-sync-collect U2）：sync 批缓冲 + 闭合检测 + flush 分流。 */
  private readonly collectCoordinator: CollectCoordinator;

  /** [E9] dispose 时已转 async 写账的成员 id（revive 后 flushBatch 防御过滤用）。
   *  背景：dispose 后同进程 revive（/resume /fork /new）时协调器内部缓冲仍持有已转换
   *  成员快照（协调器无 drain API，U5 领地不含 collect-coordinator.ts）——若后续新
   *  sync 成员触发闭合，陈旧快照会随批重投（新成员集新 hash，账本跨键不拦）→ 双重
   *  通知。flushBatch 闭包按本集过滤，陈旧成员零重投。id 唯一 per spawn，无误伤面。 */
  private readonly e9ConvertedIds = new Set<string>();

  /** [v2 D4] E1 等待分支的 settled 有界重扫状态（null = 未注册）。disposed 后保持
   *  非 null——同 session 内不再重复注册（补发完成/达限后 settled 边沿已无事可做，
   *  单注册即单重扫）；initSession（revive）置 null 允许新 session 重新注册。
   *  pi.on 无 off（见 armSettledRescan）：旧 handler 闭包捕获旧 state，未 disposed 时
   *  遇 settled 边沿仍会执行，扫描 this.mainSessionFile 当前值（handler 不绑定注册时
   *  的文件域）；dispose 的惰化处置见 dispose()。 */
  private settledRescanState: { disposed: boolean; scans: number } | null = null;

  /** [U4 deviation #8 接线] collectSync 预算热读（flush 时读值，与 getCollectSyncDefault
   *  同款访问链 modelService.getGlobalConfig().collectSync）。节缺失/读失败 → undefined
   *  → notifyBatch 落 buildBatchLlmContent 设计默认值（4000/24000，E5 不炸启动）。
   *  sanitizeCollectSync 保证节存在时两字段必有合法正整数。 */
  private getCollectSyncBudget(): BatchBudgetParams | undefined {
    const cs = this.collectSyncSection();
    return cs !== undefined ? { perItemChars: cs.perItemChars, totalChars: cs.totalChars } : undefined;
  }

  /** [E9 专用] batchFinalized 落标 + manifest fire-and-forget 写（设计 §3.1.5 E9）。
   *  批通知路径（flush/E1）已改走「manifest 屏障 → 写账 → 纯落标」序列（「通知可达
   *  ⇒ 索引就位」的构造性保证，见 flushBatch 闭包 / runSyncCollectRecoveryScan），
   *  不再经本 helper；仅 E9 转换的成员保持原形态——其走 async 单条通知（全文注入、
   *  无指针行消费），manifest 无时序要求，落标后 fire-and-forget 补写（list 后手动
   *  反查的顺带索引）。
   *  路径 = getFullRecord 冷路径重建 → appendBatchFinalizedEntry 纯落标 → fire
   *  manifest。getFullRecord 不可达（子 session 文件缺失/已 GC）→ 跳过该成员
   *  （详见 flushBatch 闭包注释）。 */
  private markMembersBatchFinalized(memberIds: readonly string[]): void {
    for (const id of memberIds) {
      const full = this.store.getFullRecord(id);
      if (!full) continue;
      this.appendBatchFinalizedEntry(full);
      // 反查索引缺失只影响指针行反查（session-reader 错误文案已指引绝对路径兜底），
      // 不构成落标失败（与屏障路径的 best-effort 语义同源，仅无时序保证）。
      void this.writeBatchMemberManifest(full).catch((err: unknown) => {
        logger.debug(
          `[subagents] batch-finalized manifest write failed (record=${full.id})`,
          { reason: err instanceof Error ? err.message : String(err) },
        );
      });
    }
  }

  /** batchFinalized 落标唯一出口（appendEntry 公共末步，纯落标）：显式覆写
   *  collectMode/batchFinalized → reportSubagentRecord。覆写动机：recordToSubagent
   *  投影已含两字段（U5 修复），但 getFullRecord 冷路径含 sidecar/manifest 重建分支
   *  （非 entry 源），显式赋值防非 entry 源重建时丢标记。
   *
   *  [v2 D1 断链 1] 落标即「离开批 = 通知已/即将送达 = 指针行即将被消费」——成功
   *  成员走 SP-5 改道 doFinalizeRoundToIdle（不写 manifest），批路径不补写则
   *  records/<sa-id>.json 永不产生、session-reader 反查 0 命中。manifest 写点已从
   *  本出口的 fire-and-forget 前移至各调用方：批通知路径（flush/E1）在写账前屏障
   *  await 全部落盘（「通知可达 ⇒ 索引就位」的构造性保证）；E9 保持落标后
   *  fire-and-forget（async 单条通知无指针行消费，无时序要求）。
   *  rec 两来源（flush 的 getFullRecord 内存全量 / E1 的 rebuildEntryRecord 重建
   *  快照）必需字段恒齐备（id/agentName←agent/rootSessionId/createdAt←startedAt），
   *  task/slug/parentRecordId 等可选 undefined 自然缺省。 */
  private appendBatchFinalizedEntry(rec: SubagentRecord): void {
    this.store.reportSubagentRecord({ ...rec, collectMode: "sync", batchFinalized: true });
  }

  /** 批成员 manifest（sa- id → sessionFile 反查索引）写的唯一投影点（D2 字段投影 +
   *  status 如实投影：成功成员此刻 record 实态 running+resumable → "running"，后续
   *  message upgrade 走完整 finalize 时 Step 4 原子覆盖为 "closed"）。
   *  返回原始 promise 不吞错——失败语义由调用方定：批通知路径经
   *  writeSyncBatchManifestBarrier 的 allSettled（debug 不阻断写账）；E9 经
   *  fire-and-forget catch（debug 不阻断落标）。 */
  private writeBatchMemberManifest(rec: SubagentRecord): Promise<void> {
    return this.manifestStore.writeManifest({
      id: rec.id,
      rootSessionId: rec.rootSessionId ?? "",
      parentRecordId: rec.parentRecordId,
      agentName: rec.agent,
      status: rec.status,
      createdAt: rec.startedAt,
      completedAt: rec.endedAt,
      sessionFile: rec.sessionFile,
      task: rec.task,
      slug: rec.slug,
      model: rec.model,
    });
  }

  /** [时序屏障] 批通知路径（flush/E1）专用：成员 manifest 并行写 + await 全部完成
   *  （allSettled）后才允许写账投递——「通知可达 ⇒ 索引就位」的构造性保证。写失败
   *  不阻断（best-effort 语义与 doFinalizeRecord Step 4 一致：反查索引缺失只影响指针行
   *  反查，session-reader 错误文案已指引绝对路径兜底，不构成写账失败）；warn 留痕
   *  （D6 #7a / SC-1：屏障失败意味着该成员指针行反查索引缺失，debug 级在排障时不可见）。 */
  private async writeSyncBatchManifestBarrier(recs: readonly SubagentRecord[]): Promise<void> {
    const results = await Promise.allSettled(recs.map((rec) => this.writeBatchMemberManifest(rec)));
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === "rejected") {
        logger.warn(
          `[subagents] batch-finalized manifest write failed (record=${recs[i]!.id}, manifest=${this.recordsDir}/${recs[i]!.id}.json)`,
          { reason: result.reason instanceof Error ? result.reason.message : String(result.reason) },
        );
      }
    }
  }

  /** [E9] dispose 时批未闭合：缓冲中已终态未通知成员逐条转 async 语义写账（放弃攒批）
   *  + 落 batchFinalized 标记（E1 重建扫描据此排除，防双重通知），交由既有 shutdown
   *  flush / resume 重放兑底；仍在跑的成员走现有退出路径（disposeAllRecords 关闭，
   *  与 async 一致）。写账用 notifier.notify 现有通路（ledger.record + attemptDeliver）。
   *  源序：写账先于落标——写账后崩溃 → E1 重建收该成员，但 async notifyId 与批 hash
   *  跨键不拦的重发属设计披露的 E9 残余窗（at-least-once 良性，PS-17 同族，v1 接受）。 */
  private convertPendingSyncBufferToAsync(): void {
    // [U8 拆批修复·E9 交互] 挂起的合批排程先取消——dispose 已选「放弃攒批转 async」
    // 语义（最简语义 = 取消而非同步 flush）：放任排程触发会让 flushBatch（批 hash
    // 通道）与下方逐条 notify（async id 通道）双通道并发写账 → 同成员双投递，且触发
    // 点可能落在 notifier/store dispose 之后。取消后缓冲原样保留，本函数既有单通路
    // 完整接管（协调器侧幂等：无排程时 no-op）。
    this.collectCoordinator.cancelScheduledFlush();
    const members = this.collectCoordinator.pendingMembers();
    if (members.length === 0) return;
    for (const member of members) {
      this.e9ConvertedIds.add(member.id);
      this.notifyHost.notify(member);
    }
    this.markMembersBatchFinalized(members.map((m) => m.id));
    logger.warn(
      `[subagents] E9 dispose: converted ${members.length} buffered sync member(s) to async notify`,
      { ids: members.map((m) => m.id) },
    );
  }

  /**
   * [E1] sync 批崩溃恢复钩子（设计 §3.1.5 E1，index.ts session_start 恢复编排处调用，
   * 须晚于 initSession——孤儿终态恢复先行收敛 running 成员，「全员终态」判定才可达）：
   *
   *  - 扫描主 session 文件每 id 末条 subagent-record entry（store.scanLastRecordEntries，
   *    collectLastRecordEntries 同构 + 投影扩展含 collectMode/batchFinalized + 终态五
   *    字段；禁走 collectRecords light 路径——主 session 落标 entry 对它不可见）；
   *  - 只收 collectMode=sync 且无 batchFinalized 的成员（排除已通过批 flush 或 E9
   *    转换离场的，防双重通知），按 rootSessionId 过滤当前根；
   *  - 全员终态且账本无同成员集批记录 → manifest 屏障（await 落盘，「通知可达 ⇒
   *    索引就位」构造性保证，与 flushBatch 同款）→ notifyBatch 补发（内容 = 末条
   *    entry 终态快照；账本 record 同 hash 幂等拒绝 = 已投递/已在账，两种结局都算
   *    「已处理」）；
   *  - 仍有 running → 本次不动，注册 settled 有界重扫（D4，见 armSettledRescan）——
   *    成员延迟终态（主 agent 冷路径 resume → 正常流落 entry）由 settled 边沿驱动
   *    重扫收敛，不再依赖「下次 session_start」作唯一再驱动（v2 §2.4 断链 4）；
   *    running 口径与协调器同构
   *    （resumable 豁免，v2 D3——覆写不可达的防御分支残余不被误判「仍在跑」）；
   *  - 补发尝试后统一补 batchFinalized 标记（账本拒绝也算已投递；直接用末条重建快照
   *    落标不经 getFullRecord——子文件缺失/已 GC 时标记仍可落盘，窗口自愈不依赖二次
   *    重启；补标自身崩溃重入幂等收敛，末条 entry last-writer-wins）。
   *
   *  async 化（时序屏障修复）：返回 Promise 但**内部自捕获不外抛**——宿主 index.ts
   *  session_start 以同步 try/catch 调用（其 catch 兑现不到 promise 内的异常），
   *  自捕获维持同款 warn 容错语义，浮动调用零适配、不产生 unhandled rejection。
   *
   *  [U8 拆批修复] 与协调器合批排程无交集：E1 只在 session_start 编排处运行（此前
   *  dispose 已取消挂起排程），补发直走 notifier.notifyBatch 不经协调器；异常时序
   *  相撞由账本 sync-batch:<hash> 幂等拒绝兜底。
   */
  async recoverSyncCollectBatch(): Promise<void> {
    try {
      const { outcome } = await this.runSyncCollectRecoveryScan();
      // [v2 D4] 断链 4：等待分支不再死等——挂 settled 有界重扫（幂等单注册）。
      if (outcome === "waiting") {
        this.armSettledRescan();
      }
    } catch (err) {
      // 与 index.ts 调用点原 try/catch 的 warn 容错同语义（该处 catch 对 async 化后
      // 的 promise 异常兑现不到，容错收敛到本方法内部）。
      logger.warn("[subagents] sync collect batch recovery failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** [E1/D4] 单次「扫描→判定→可达则补发+落标」，E1 首扫与 settled 重扫共用同一实现
   *  （防两处复制粘贴分岔）。三态返回：idle（无 sync 候选——已全部落标/E9 转换/异根，
   *  无事可等）/ waiting（仍有 running 成员，本次不动）/ dispatched（全员终态，已补发
   *  +统一落标）。async：补发前有 manifest 屏障 await（见函数头 E1 注释）。 */
  /** 返回 outcome + waitingIds（达限 warn 需滞留成员 id，D6 #7b——仅 waiting 态非空）。 */
  private async runSyncCollectRecoveryScan(): Promise<{
    outcome: "idle" | "waiting" | "dispatched";
    waitingIds: string[];
  }> {
    const lastRecords = this.store.scanLastRecordEntries(this.mainSessionFile);
    if (lastRecords.length === 0) return { outcome: "idle", waitingIds: [] };
    const rootFilter = this.sessionRootId;
    const candidates = lastRecords.filter(
      (r) =>
        r.collectMode === "sync" &&
        r.batchFinalized !== true &&
        (rootFilter === undefined || r.rootSessionId === rootFilter),
    );
    if (candidates.length === 0) return { outcome: "idle", waitingIds: [] };
    // [v2 D3] 与协调器 hasRunningSync 同构口径（collect-coordinator.ts）：running+
    // resumable 视为已完成、不阻止补发——成功成员崩溃时的末条 entry 恒为轮终
    // running+resumable（SP-5 有意语义），旧口径只看 status !== "closed" 会把主场景
    // （批内含成功成员）顶死在「等自然终态」永不补发（v2 §2.3 断链 3）。
    const running = candidates.filter((r) => r.resumable !== true && r.status !== "closed");
    if (running.length > 0) {
      logger.debug(
        `[subagents] E1 sync batch recovery: ${running.length} member(s) still running, wait for natural completion`,
        { ids: running.map((r) => r.id) },
      );
      return { outcome: "waiting", waitingIds: running.map((r) => r.id) };
    }
    // [时序屏障] manifest 先于写账 await 全部落盘——E1 补发同样是批通知（指针行消费
    // 依赖反查索引），「通知可达 ⇒ 索引就位」的构造性保证与 flushBatch 同款。
    await this.writeSyncBatchManifestBarrier(candidates);
    // 全员终态：单条批补发（budget 热读与 flushBatch 同源）；账本同 hash 幂等拒绝也算
    // 已投递（批已在账/已销账，重放由账本承接）——两种结局统一补标。
    const members = candidates.map((r) => syncRebuildToNotifyMember(r));
    const accepted = this.notifyHost.notifyBatch(members, this.getCollectSyncBudget());
    for (const rec of candidates) {
      this.appendBatchFinalizedEntry(rec);
    }
    logger.warn(
      `[subagents] E1 sync batch recovery: re-notified ${members.length} member(s) (ledger accepted=${accepted})`,
      { ids: members.map((m) => m.id) },
    );
    return { outcome: "dispatched", waitingIds: [] };
  }

  /** [v2 D4] 注册 agent_settled 有界重扫（幂等：settledRescanState 非 null 不叠加注册
   *  ——E1 现仅 session_start 单调用点，守卫是防第二入口引入时的注册叠加断言面）。
   *  每次 settled 边沿重跑同一 E1 扫描（runSyncCollectRecoveryScan）：dispatched
   *  （补发+落标完成，scan 的 warn 已留痕）或 idle（候选已被其他通路落标）→ disposed；
   *  累计 SETTLED_RESCAN_LIMIT 次仍在等 → disposed + warn 留痕（D6 #7b / SC-2：达限
   *  放弃重扫意味着滞留成员的批通知要等下次 session_start 才收敛，含滞留 id 的 warn
   *  是唯一线索，debug 级排障不可见；后续事件零处理，下次 session_start 再收敛）。
   *  pi.on 无 off（0.84.4 实装）——disposed 标志包装兑现退订（scheduler extension
   *  index.ts subscribeSettled 同款先例）。P-settled 定谳（0.84.4 dist 实装证据）：
   *  pi.on 为 per-extension 列表分发——loader.js `on()` 把 handler push 进
   *  extension.handlers.get(event) 数组（非覆盖），runner.js `emit()` 对全部
   *  extension 的全部 handler 逐一 await；故本注册与 ledger host 经
   *  piAdapter.onAgentSettled 注册的 settled 分发互不干扰，无需降级并入 host 链。 */
  private armSettledRescan(): void {
    if (this.settledRescanState !== null) return;
    const state = { disposed: false, scans: 0 };
    this.settledRescanState = state;
    this.pi?.on?.("agent_settled", async () => {
      if (state.disposed) return;
      state.scans += 1;
      // await 完整补发序列（manifest 屏障 → 写账 → 落标）：pi emit 对 handler 逐一
      // await（P-settled 定谳，0.84.4 dist runner.js），async 化不改变分发语义。
      const { outcome, waitingIds } = await this.runSyncCollectRecoveryScan();
      if (outcome === "waiting" && state.scans < SETTLED_RESCAN_LIMIT) return;
      state.disposed = true;
      if (outcome === "waiting") {
        // D6 #7b / SC-2：warn + 滞留成员 id（debug 级排障不可见——达限即批通知挂起至下次 session_start）
        logger.warn(
          `[subagents] E1 settled rescan: reached limit (${SETTLED_RESCAN_LIMIT}) with member(s) still running, disposed until next session_start`,
          { ids: waitingIds },
        );
      }
    });
  }

  // [E1 语义对齐 toNotifyRecord] 补发成员映射 syncRebuildToNotifyMember 拆至
  // sync-rebuild.ts（变化轴：恢复批通知语义）：one-shot 成功成员末条恒
  // running+resumable（SP-5），直通 status 会让恢复批批头「0 finished」且丢
  // patchFile 的 git-apply 指针——对齐后补发记录为 closed + outcome 物化 +
  // patchFile 透传。调用点：runSyncCollectRecoveryScan。

  /**
   * collectSync.default 当前生效值（subagent-sync-collect U2，偏差#3 接线：
   * startHandler 缺省 collect 解析用）。
   * config 未配/读失败 → DEFAULT_COLLECT_SYNC.default 兜底（E5 不炸启动）。
   * 新 session 生效语义与 engine 配置一致（globalConfig 由 ModelConfigService
   * reloadGlobalConfig 刷新）。
   */
  /** collectSync 节单读取点（S9，code-simplify）：「读节」一处，「投影成 default 或
   *  budget」各自 accessor 负责（getCollectSyncDefault / getCollectSyncBudget）。 */
  private collectSyncSection() {
    return this.modelService.getGlobalConfig().collectSync;
  }

  getCollectSyncDefault(): "async" | "sync" {
    return this.collectSyncSection()?.default ?? DEFAULT_COLLECT_SYNC.default;
  }

  // ── 域 #3 孤儿/manifest 恢复（R3 RecordLifecycle）（R0 重排）──

  /**
   * 孤儿终态恢复（residual-fixes）：session_start 主动触发一次——父扩展死后再无人写
   * 终态 entry 的 record 在此判定落盘（否则侧栏永久 running）。幂等不 throw，失败不
   * 阻断 session_start。
   *
   * [T5① / PS-8] 只有根进程做扫描者：恢复机制假设「单扫描者」，但子进程 sessionRootId
   * 经 env 与父同值（过滤域 = 整树共享的 sessions/records 目录），env 贯穿让每个子进程
   * 都成了扫描者——递归编排中任一子进程启动时，恰有兄弟记录 marker 缺失或超软超时
   *（hours-long wave 必然命中）→ 活记录被无关进程盖 .finalized sidecar，closed entry
   * 写进别的进程的 session 文件（跨进程互写，无任何锁）。子进程身份判据 = env
   * PI_SUBAGENT_SELF_RECORD_ID（父 spawn 时注入的「子进程自己的 record id」，仅子进程
   * 非空）——与 execNesting 基线同源。根进程恢复语义不变。
   */
  private recoverOrphansIfRootProcess(): void {
    const isChildProcess = (process.env[ENV_SELF_RECORD_ID] ?? "") !== "";
    if (!isChildProcess) {
      this.recoverOrphanRecords();
    } else if (process.env.XYZ_AGENT_DEBUG) {
      logger.debug("[subagents] child process detected (PI_SUBAGENT_SELF_RECORD_ID set), skipping orphan recovery scan");
    }
  }

  /** 孤儿终态恢复委托（RecordStore.recoverOrphanRecords 的唯一调用入口，维持 store
   *  private 封装——与 recoverManifestTmpFiles 同模式；[D4] public 面收窄：唯一调用方
   *  是 initSession，转 private）。判定语义见 store 侧注释。
   *  mainSessionFile 随调用透传（v2 D3 覆写 merge 数据源：主文件末条 entry 的批域
   *  标记与轮终 result/model；initSession 先赋值后恢复，时序就绪）。
   *  随后跑 entry-born 孤儿恢复（无子文件锚的 register-only record，spawn 窗口期死亡，
   *  E2E 实测缺口）——主 session 文件经 getMainSessionFile 注入（构造期可空）。
   *  [M1 Gate B] 末段跑可重连 entry 的 manifest 重物化（闭含 dispose 时 manifest
   *  fire-and-forget 写被 SIGKILL 竞态吞掉的窗口）。 */
  private recoverOrphanRecords(): void {
    try {
      this.store.recoverOrphanRecords(this.sessionRootId ?? undefined, this.mainSessionFile);
    } catch (err) {
      logger.warn("[subagents] orphan recovery failed", {
        reason: toErrorMessage(err),
      });
    }
    try {
      this.store.recoverEntryOnlyOrphans(this.mainSessionFile, this.sessionRootId ?? undefined);
    } catch (err) {
      logger.warn("[subagents] entry-only orphan recovery failed", {
        reason: toErrorMessage(err),
      });
    }
    try {
      this.rematerializeReconnectableEntryManifests();
    } catch (err) {
      logger.warn("[subagents] reconnectable entry manifest re-materialization failed", {
        reason: toErrorMessage(err),
      });
    }
  }

  /**
   * [M1 Gate B] 可重连终态 entry 的 manifest 重物化（boot 自愈段）。
   *
   * 缺口：编排性关闭（disposeAllRecords）的 manifest 写是 fire-and-forget——SIGKILL /
   * 崩溃打进 shutdown 窗口时 entry（pi flush）与 manifest 写可能只活下来前者。末条
   * subagent-record entry 为 closed + closedReason ∈ 可重连集（RECONNECTABLE_FINAL_
   * REASONS = parent-shutdown/disconnected，types.ts SSOT）的 record，若查询面
   * （collectRecords：内存∪磁盘∪manifest）已不可见，则从 entry 自描述快照重物化
   * manifest——恢复 list 可见性 + message 的可重连分流（D4 revive 准入仍由
   * cold-lookup 四守卫把门，重物化只补反查索引，不复活任何执行态）。
   *
   * 刻意收窄的语义边界：
   *  - 只认可重连集。user-close/cancelled（主动告别，close 语义不可旁路）与
   *    gc/parent-fork/parent-new（自洽终态，无续聊歧义）不重物化——条目自洽，
   *    「不可恢复」即其对外语义，补可见性收益不抵语义面扩大（M1 负向断言锁定）。
   *  - 只补本 rootSessionId 的 entry（每 session boot 治自己的树；跨 session 记录
   *    归属其自身 boot 段，防本进程替异树批量落盘）。
   *  - 已可见（磁盘锚或 manifest 幸存）的 id 跳过——重物化是幂等补缺，不是覆写源。
   */
  private rematerializeReconnectableEntryManifests(): void {
    if (this.mainSessionFile === undefined) return;
    const visibleIds = new Set(
      this.store.collectRecords(COLD_LOOKUP_SCAN_LIMIT, "all", undefined).map((r) => r.id),
    );
    for (const rec of this.store.scanLastRecordEntries(this.mainSessionFile)) {
      if (visibleIds.has(rec.id)) continue; // 查询面已可见：磁盘锚或 manifest 幸存
      if (rec.rootSessionId !== this.sessionRootId) continue; // 只治本 session 树
      if (rec.status !== "closed" || !isReconnectableFinalReason(rec.closedReason)) continue;
      // manifest 投影（对齐 writeManifestBestEffort 字段面；status 恒 closed——
      // entry 的 closed 即终态自描述，无 running 形态可达此处）。
      void this.manifestStore
        .writeManifest({
          id: rec.id,
          rootSessionId: rec.rootSessionId ?? "",
          parentRecordId: rec.parentRecordId,
          agentName: rec.agent,
          status: "closed",
          closedReason: rec.closedReason,
          createdAt: rec.startedAt,
          completedAt: rec.endedAt ?? Date.now(),
          sessionFile: rec.sessionFile,
          task: rec.task,
          slug: rec.slug,
          model: rec.model,
        })
        .catch((err: unknown) => {
          logger.warn(`[subagents] re-materialized manifest write failed (record=${rec.id})`, {
            reason: err instanceof Error ? err.message : String(err),
          });
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

  // ── 域 #4 回收面（R3 RecordLifecycle）（R0 重排）──

  /** SP-4: 关闭所有活跃 record。
   *
   *  遍历 store 中所有 running record，逐个 CAS 转终态 + completeRecord + archive。
   *  对有 worktreeHandle 的 record 触发 worktreeManager.cleanup（T3: worktree 绑定清理）。
   *
   *  [T2⑥ / PS-1] 补齐三回收面（对照 dispose() 的既有形态，消除同文件双标）：
   *  controller.abort + kill（收敛到 killChildWithEscalation）+ disarmIdleTimer +
   *  disarmSettledWatchdog。旧实现只关 record 不中止执行——「record 已关」≠「执行已
   *  处置」：在途子进程继续跑且无任何用户可及的取消通道（cancel 只查内存 running，
   *  archive 后恒 false），若挂死唯一上界是默认关闭的 spawn watchdog → 泄漏至宿主退出。
   *  abort/kill/timer 三面对已终态/已死 record 均幂等 no-op，dispose() 先行的
   *  abortRunningControllers + killAllSpawnedChildren 不受影响（parent-shutdown 路径
   *  双保险）。
   *
   *  [v4 A-6] 旧实现的 recentlyCascaded 收集（供已删除的 before_agent_start 注入告知）
   *  与 drainCascaded 已一并移除——被关 record 的告知改由 list 的 closedReason 表达。
   *
   *  [M1 Gate B] 本路径曾整体缺 manifest 反查索引（不经 doFinalizeRecord 的唯一终态
   *  写点缺口）：优雅停机关掉的在途 record 重启后 list 不可见（records/<id>.json 不
   *  存在）、message 报 not found——「展示层∪动作链」双失。现补 writeManifestBestEffort
   *  （best-effort fire-and-forget，对齐既有 finalize 语义；shutdown 窗口内不阻塞——
   *  session_shutdown handler 后续 await 给了 flush 窗，SIGKILL 竞态丢失由
   *  recoverOrphanRecords 的可重连 entry 重物化自愈，见该处注释）。
   *
   *  [M1 sessionFile 锚点提升] 在途 record 的 sessionFile 尚未回填（run 应答未到）时，
   *  R4 运行中句柄回填（onHandleReady → backfillEngineHandle）可能已把引擎上报的子
   *  session 文件路径写进 engineHandle.sessionRef——提升为 record.sessionFile 后，
   *  archive entry 与 manifest 都带上真实锚点，重启 revive/fork-from 可直接定位子文件。
   *  提升源与 settle 回填（outcomeToAgentResult）同 authority（引擎 sessionRef）。
   *
   *  @param reason 关闭原因（parent-fork / parent-new / parent-shutdown）
   *  @returns 被关闭的 record 数量
   */
  disposeAllRecords(reason: ClosedReason): number {
    const activeRecords = this.store.listAllActive();
    let count = 0;
    for (const record of activeRecords) {
      // [T2⑥/PS-1] 回收面 i：abort 在途 controller（排队的 acquire / 在途 signal listener
      // 立即感知取消）。幂等：已 aborted 的 controller.abort() 是 no-op。
      record.controller?.abort();
      // 回收面 ii：回收子进程（SIGTERM + 30s SIGKILL 升级，收敛 T2④同款）。
      // 回收面 iii：disarm idle timer + settled watchdog（进程回收后 timer 只会误触发）。
      killRecordChildWithEscalation(record.id, `disposeAllRecords (${reason})`);
      disarmIdleTimer(record.id);
      disarmSettledWatchdog(record.id);
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
      // [M1 sessionFile 锚点提升] 先于 archive——close 终态 entry 随之携带锚点。
      this.promoteSessionFileFromEngineHandle(record);
      this.store.archive(record);
      // [F-5 修复] 本路径不经 doFinalizeRecord（编排性关闭直连 completeRecord+archive），
      // chat 轮路由注销在此补齐（幂等；闭包持 record/stream 引用，防泄漏）。
      // [H1 U2] 汇聚点扩为 onRecordFinalizedCleanup（路由注销 + Continuation 清理）。
      this.onRecordFinalizedCleanup(record.id);
      // worktree 绑定清理（T3）。cleanup 已 async 化——同步签名（返回计数）不变，
      // 清理 fire-and-forget：失败经 bestEffort 留痕，不阻塞/不影响计数返回。
      if (record.worktreeHandle) {
        void this.worktreeManager.cleanup(record.worktreeHandle).catch((err: unknown) => {
          bestEffort(err, `worktree cleanup (${reason})`);
        });
      }
      // pending-notifications 注销
      this.notifyHost.emitPendingUnregister(record.id, "closed");
      // [M1 Gate B] manifest 反查索引补写（Step 4 对位：cleanup 之后最后一步）。
      // 内部自吞错（logger + appendEntry），void 即弃——不阻塞 shutdown 收尾。
      void writeManifestBestEffort({ manifestStore: this.manifestStore, pi: this.pi }, record);
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

  /**
   * [M1 Gate B] sessionFile 锚点提升：record.sessionFile 未回填（run 应答未到）但 R4
   * 运行中句柄回填已把引擎上报的子 session 文件路径写进 engineHandle.sessionRef 时，
   * 提升为 record.sessionFile。提升源与 settle 回填（outcomeToAgentResult /
   * finalizeEngineOutcome）同 authority（引擎 sessionRef.sessionFile）。
   *
   * 消费方：disposeAllRecords / cancelBackground 的终态化——让 archive entry 与
   * manifest 带真实锚点，重启后 revive/fork-from 可定位子文件。无 engineHandle 或
   * sessionRef 无 sessionFile（handle_ready 前就停机的残余形态）保持 undefined——
   * 该子形态无确定性恢复路径（子文件名 `<ts>_<sessionId>.jsonl` 由子进程生成，
   * 宿主无记录映射），恢复语义降级为「manifest 可见 + fork-from/start 指引」。
   */
  private promoteSessionFileFromEngineHandle(record: ExecutionRecord): void {
    if (record.sessionFile !== undefined) return;
    const sessionFile = record.engineHandle?.sessionRef.sessionFile;
    if (typeof sessionFile !== "string" || sessionFile === "") return;
    record.sessionFile = sessionFile;
  }

  /** SP-4: idle record GC（30 天 TTL，实现抽至 idle-gc.ts）。stop 函数（dispose 调）。 */
  private stopIdleGc: (() => void) | undefined;

  /** 启动 idle record GC 定时器（session_start 调用，幂等）。
   *  [W4] WorkflowRun store（FileRunStore）同批纳入：running 且 startedAt 超 30 天
   *  锚窗的 run 终态化归档（只终态化不补注销，见 idle-gc.ts 头注）。宿主未
   *  configureCore 时 loadAll 抛错由 idle-gc 内部吞掉（单轮跳过）。
   *  [F-1 修复] stateDir 与 pi 壳 JsonlRunStore 落盘布局同源
   *  （resolvePiWorkflowStateDir → <sessionDir>/workflow-state/）——缺省 dataRoot 根
   *  与 pi 生产落盘不相交，WorkflowRun GC 曾恒空转（W4 引入的装配错位）。 */
  startGcTimer(): void {
    if (this.stopIdleGc) return;
    this.stopIdleGc = startIdleGc(this.store, new FileRunStore({ stateDir: resolvePiWorkflowStateDir() }));
  }

  /** 停止 idle record GC 定时器（dispose 调用）。 */
  private stopGcTimer(): void {
    this.stopIdleGc?.();
    this.stopIdleGc = undefined;
  }

  // ── 域 #13 身份解析/record 创建（R3 RecordLifecycle）（R0 重排）──

  /** 步骤 1：身份解析。agentConfig → resolveModel（三层：override → agentConfig → 主 agent model）。
   *
   * [u-h2] pi 未命中跨引擎候选（D2-4）：resolveModel 抛 notFoundError（pi registry
   * 全等裁决未命中）时反查其他已注册引擎清单，唯一命中则追加「该 id 属于引擎 X」
   * 候选段（场景 3）；其余裁决失败（孪生歧义/auth）与命中路径原样返回（零回归）。
   * execute() 与 executeAndAwait() 两个派发路径共享本方法，故 chat 与 workflow 域的
   * pi 校验同享场景 3 文案。
   */
  private async resolveIdentity(
    opts: ExecuteOptions,
    pre?: { agent: string; agentConfig: AgentConfig | undefined },
  ): Promise<ResolvedIdentity> {
    // agentRef 语义（S2）：agent 参数 = .md 绝对路径；不传 = 不加载 agentConfig，
    // 直接用 override → 主 agent model。DEFAULT_AGENT_NAME 仅作 record 显示名
    // （TUI 层 extractAgentName 共用，保证显示一致）。
    const agent = pre?.agent ?? opts.agent ?? DEFAULT_AGENT_NAME;
    // 显式 agent ref（用户点名）失败必须报错，不静默降级：无 require 的 loadByPath
    // 对相对路径/裸名/文件缺失都返回 undefined → agentConfig undefined → resolveModel
    // 静默回落 override→主 agent model，用户拿到的 subagent 无 systemPrompt/工具白名单
    // 且零反馈。require:true 让失败抛出带 <available_subagents> 指引的错误（对齐
    // workflow name not found 反馈风格）；不传 agent = 默认 general-purpose 语义，
    // agentConfig 保持 undefined（合法缺省，走 override → ctxModel 兑底）。
    // [u-h2 D2-1] execute() 已在路由前解析 agentConfig（pre 通道），此处复用不二次加载。
    const agentConfig = pre
      ? pre.agentConfig
      : opts.agent
        ? this.modelService.getRequiredAgentConfig(opts.agent)
        : undefined;

    let resolved: ResolvedModel;
    try {
      resolved = this.modelService.resolveModel(
        opts.agent ?? "",
        { model: opts.model, thinkingLevel: opts.thinkingLevel },
        opts.ctxModel,
        agentConfig,
      );
    } catch (err) {
      throw withCrossEngineHint(err, listEngines(), (id) => {
        try {
          return getEngine(id);
        } catch {
          return undefined; // 清单快照与注册表并发变化的防御：取不到引擎按未注册处理
        }
      });
    }

    return { agent, agentConfig, resolved };
  }

  /**
   * [u-h2 D2-1③] 非 pi 引擎的 identity 解析：跳过 pi registry 三层解析（ctxModel 主
   * agent model 不透传——主 agent 的 pi id 对目标引擎大概率无效，缺省语义归引擎）。
   *
   * 逐层语义（设计 D2-1 归趋表）：
   *   - model 源 = engineModel（调用参数 opts.model > agentConfig.model frontmatter，
   *     agent 作者声明不忽略——配错在 validateModel 同步报错，不落引擎缺省静默续跑）；
   *   - 无显式 model → 校验/留痕走引擎缺省（validateModel(undefined) 的 canonicalRef）；
   *   - thinkingLevel 直接透传（引擎中立参数，不涉 registry）。
   *
   * 引擎未实现 validateModel 时 modelRef 原样透传（其 prepare 期校验兜底，现状语义）。
   */
  private resolveIdentityForEngine(
    engine: EnginePort,
    engineModel: string | undefined,
    agent: string,
    agentConfig: AgentConfig | undefined,
    opts: ExecuteOptions,
  ): ResolvedIdentity {
    const canonical = validateModelForEngine(engine, engineModel);
    // record.model 留痕：canonical（引擎裁决 ref，允许无斜杠形态——契约变更④，协议化
    // 后引擎可原样返回 ref）；引擎未实现校验面且无显式 model 时为空串（记录形态退化，
    // 生产不可达——注册表内非 pi 引擎均实现 validateModel；防御性空串避免 throw 打断
    // 兜底语义）。拆分单一权威 = splitEngineModelRef（无斜杠 → provider=""/id=ref/
    // 整串进 name，不再落 "<ref>/" 畸形）。
    const modelStr = canonical ?? engineModel ?? "";
    const model = splitEngineModelRef(modelStr);
    return {
      agent,
      agentConfig,
      resolved: {
        model: {
          id: model.id,
          name: model.name,
          provider: model.provider,
          reasoning: false,
        },
        thinkingLevel: opts.thinkingLevel ?? agentConfig?.thinkingLevel,
      },
    };
  }

  /** 步骤 2：按 mode 生成 id + controller，创建 record 并注册。
   *  [L-1] ExecutionMode 类型固定 "background"（sync 已删除），id/controller 分支简化。
   *  [H2 W2] originFields：workflow 域派发（executeWorkflowAgent）的来源身份——
   *  origin:"workflow" + parentRunId 进 record（D1）；缺省不传 = tool 来源（存量零迁移）。 */
  private createRecordForMode(
    identity: ResolvedIdentity,
    opts: ExecuteOptions,
    mode: ExecutionMode,
    originFields?: { origin: "workflow"; parentRunId: string },
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

    const base = createRecord(id, {
      agent: identity.agent,
      // model 留痕词形与拆分同源（joinEngineModelRef）：provider 为空串只写 id——
      // 契约变更④的无斜杠 ref（provider=""/id=ref）不得落成 "/ref" 或 "ref/" 畸形；
      // 续聊回读侧 splitEngineModelRef 对无斜杠串还原 provider=""/id=ref，往返自洽。
      model: joinEngineModelRef(identity.resolved.model),
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
      // subagent-sync-collect U2（偏差#4 接线）：sync record 落 collectMode——
      // 协调器路由判据 + startHandler pendingSyncCount 枚举含本条的数据源。
      // undefined = async（缺省语义，旧记录零迁移）。
      collectMode: opts.collect === "sync" ? "sync" : undefined,
      controller,
    });
    // [H2 W2] 来源身份在对象构造点落位（origin/parentRunId 为 readonly，创建期一次性
    // 写入——与 createRecord 的 identity 语义同款「创建时确定，不可变」）。
    const record: ExecutionRecord =
      originFields !== undefined
        ? { ...base, origin: originFields.origin, parentRunId: originFields.parentRunId }
        : base;

    this.store.register(record);
    return record;
  }

  /** [MF#R4] worktree 前置失败的 early-return handle。
   *  record 已被 finalizeFailed 收尾为 failed、detached promise 从未启动。 */
  private buildEarlyFailedHandle(record: ExecutionRecord): ExecutionHandle {
    const details = project(record);
    return { mode: "background", subagentId: record.id, sessionFile: record.sessionFile, details };
  }

  // ── 域 #8 查询面（R3 RecordLifecycle）（R0 重排）──

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
  private collectRecords(
    limit: number,
    statusFilter: StatusFilter = "all",
    includeWorkflow: boolean = false,
  ): SubagentRecord[] {
    return this.store.collectRecords(limit, statusFilter, this.sessionRootId ?? this.sessionId ?? undefined, includeWorkflow);
  }

  /** [perf] 单 record 详情懒加载（全量：eventLog/displayItems/result/turns/tokens）。
   *  内存 running record 直接投影；磁盘 record 全量重建（per-file 缓存，stat 戳校验）。
   *  返回 undefined：id 不存在于内存与磁盘。 */
  private getFullRecord(id: string): SubagentRecord | undefined {
    return this.store.getFullRecord(id);
  }

  // ── 域 #10 action 网关（R3 RecordLifecycle）（R0 重排）──

  /** [D4-③] 冷路径查询依赖（cold-lookup.ts；deps 闭包惰性求值：sessionRootId /
   *  execNesting 基线运行时可变）。 */
  private readonly coldLookupDeps: ColdLookupDeps = {
    findLightById: (id) => this.store.findLightById(id),
    collectRecords: (limit, statusFilter, rootFilter) =>
      this.store.collectRecords(limit, statusFilter, rootFilter),
    register: (record) => this.store.register(record),
    reportRecordTransition: (record) => this.store.reportRecordTransition(record),
    getSessionRootId: () => this.sessionRootId,
    getBaselineRecordId: () => this.execNesting.baseline()?.recordId ?? undefined,
  };

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
      // [D4-③] 冷查/复活链在 cold-lookup.ts（[H1 U6] 原 cold-resurrect.ts 改名落位）。
      record = coldLookupForAction(this.coldLookupDeps, id, opts?.allowReconnect === true);
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

  // [D4-③] 冷路径查询链（findColdLookupCandidate / assertReconnectAllowed /
  // resurrectColdRecord / coldLookupForAction + isReconnectableClosed 判定）落位
  // cold-lookup.ts（本类经 coldLookupDeps 注入）。
  // SP-2 冷路径 [perf] 语义不变：idToFile 索引直查 → collectRecords 全扫兜底。

  // ── 域 #11 close 三路（R3 RecordLifecycle）（R0 重排）──

  /**
   * close action 的统一行为分流（running 子态 × force）。
   *
   *   chatMode（[H1 U2 / D4] close 行统一）：
   *     force:true                        → cancelBackground（显式 SIGTERM + closed+cancelled 终态）
   *     force:false（任意子态）           → abort 在途轮 + 清空队列（Continuation）+ 立即终态化
   *       （closeChatIdle：closed/user-close + notifyClosed——「closeAfterRound 等轮终」
   *       挂起标志随 chat 域长驻消亡退役：D4 close = abort + 清队列 + 立即终态化，
   *       不等轮终；S7 无僵尸轮、无 close 后追加通知由 onRunSettled 终态守卫构造性保证）
   *   非 chatMode（one-shot，现状不变）：
   *     running + force:false + 无在跑轮  → closeChatIdle（立即终态化）
   *     running + force:false + 有活进程  → 置 closeAfterRound=true（settleOneShotOutcome 消费——照旧）
   *   其他终态                            → 幂等 no-op（已结束）
   *
   * 与设计决策 5 一致：close = 正式终态（走 finalize），force 只影响 running 时机。
   *
   * @param record 目标 record（getRecordForAction 已校验归属）
   * @param force true=立即终止（running 时 SIGTERM）/ false=优雅关闭
   */
  private async closeSubagent(record: ExecutionRecord, force: boolean): Promise<void> {
    this.assertReady();
    if (record.status === "running") {
      if (force) {
        // 立即终止：cancelBackground（controller.abort + tryTransition closed+cancelled + finalize）
        this.cancelBackground(record);
      } else if (record.chatMode) {
        // [H1 U2 / D4] chat close：abort 在途轮（幂等——无在途轮 no-op）+ 清空队列，
        // 随即立即终态化（closeChatIdle 收口——closeAfterRound 挂起标志在 chat 域退役，
        // 不再有「轮完成时终态化」的等待窗；[H1 U6] 消费点 closeAfterRoundSettled 已删，
        // S7 无僵尸轮、无 close 后追加通知由 onRunSettled 终态守卫构造性保证）。
        this.continuations.get(record.id)?.abortAndClearQueue();
        await this.closeChatIdle(record);
      } else if (isIdle(record) || isResumable(record)) {
        // [M5] 无在跑轮：Path A（isIdle timer armed、进程保活等待续聊）/ Path B（isResumable
        // 无活进程）→ 立即终态化 done（closeChatIdle 内回收保活进程 + disarm timer）。
        await this.closeChatIdle(record);
      } else {
        // 优雅关闭：正在执行（有活进程在跑轮），标记 closeAfterRound，轮完成时终态化
        //（one-shot 消费点在 settleOneShotOutcome CAS 分支——照旧，G3）
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
    // [M5] Path A：回收保活进程 + disarm idle timer（终态化后无其他 kill 路径）。
    // [T2④ / LC-2] 终止语义收敛：SIGTERM 被无视时 30s 升级 SIGKILL——终态化后
    // record 已 archive，挂住 = 幽灵进程无任何后续回收通道。同时 disarm settled
    // watchdog（本路径终态化 = settled 等待窗口终结，防 watchdog 误杀后续同 id 资源）。
    // [W3] 实际终止在引擎进程内（协议 interact close force → 引擎侧杀链）；
    // killRecordChildWithEscalation 只做镜像置死记账。
    disarmIdleTimer(record.id);
    disarmSettledWatchdog(record.id);
    disarmRoundFromProtocol(record.id);
    killRecordChildWithEscalation(record.id, "closeChatIdle");
    // 合成 closed result（无在途 AgentResult，`record.result ?? ""` 模式）。
    // [W16 P-1 修复] text 必须沿用轮终真实 result：
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
        // [F-5 修复] 同 finalizeRecord——chat 轮路由注销单一汇聚点钩子
        //（[H1 U2] 汇聚点扩为 onRecordFinalizedCleanup：路由注销 + Continuation 清理）。
        onFinalized: (id) => this.onRecordFinalizedCleanup(id),
        sessionDir: this.sessionsDir,
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

  // [H1 U6] closeAfterRoundSettled（[M5] chat 域「轮完成时终态化」消费面）已随 chat 域
  // closeAfterRound 挂起标志退役删除：D4 close = abort 在途 + 清空队列 + 立即终态化
  //（closeChatIdle），不等轮终；one-shot 域的 closeAfterRound 消费走 consumeCloseAfterRound
  //（settleOneShotOutcome，照旧）。

  // ── 域 #17 取消（R3 RecordLifecycle）（R0 重排）──

  /** 取消 background record（tryTransition CAS 抢锁防重复副作用）。 */
  cancel(id: string): boolean {
    this.assertReady();
    const record = this.store.getMutable(id);
    if (!record) return false;
    return this.cancelBackground(record);
  }

  /**
   * 取消 background record。CAS 抢锁（tryTransition）——抢到则 notify + 写 tombstone；
   * 没抢到（detached 已 finalize，record 已终态）返回 false，不触碰任何收尾副作用。
   *
   * stop 手段（abort/kill/disarm）无条件先执行：对已终态 record 幂等无害，且保证
   * cancel 语义 = 进程必死；收尾副作用（completeRecord/tombstone/archive/notify）只归
   * CAS 赢家。[A2-1] 此前 CAS 被误删，cancel 可在 doFinalizeRecord Step 0 await 窗口
   * 命中已终态 record——覆写终态 + tombstone/finalized 双标 + notify 双发 + 谎报 true。
   */
  private cancelBackground(record: ExecutionRecord): boolean {
    record.controller?.abort();
    // [M6] 显式 kill + disarm：chatMode 首轮 agent_settled 后 runSpawn 提前 resolveRun(0)
    // 返回，`opts.signal.removeEventListener("abort", onAbort)`（session-runner runSpawn 尾部）
    // 已移除 abort→kill listener；热路径续聊轮（PiEngine 直接 stdin 写入）不再
    // 进 runSpawn。此后 cancel 只有 controller.abort() 无人响应——record 已终态化 cancelled
    // 但子进程继续跑完当前 turn（工具副作用继续发生），之后 agent_settled 还对已 archived
    // record 触发脏通知（round+1 → 新 dedup key → "finished a round"），最终靠 5min idle
    // timer 兜底 kill。故 cancel 必须显式 kill + disarm idle timer。非 chatMode 路径
    // listener 仍在（abort 已 kill 一次），此处对已 killed child 是 no-op，无副作用。
    // [T2④ / LC-2] 裸 SIGTERM 收敛到 killRecordChildWithEscalation：SIGTERM 被无视时
    // 30s 升级 SIGKILL——cancel 语义 = 进程必死，不能赌 SIGTERM 生效（record 已终态化，
    // 此后无其他回收通道）。settled watchdog 同步撤下（等待窗口随取消终结，幂等）。
    // [W3 → H1 U6] 在途 run 的实际终止经 controller.abort → 轮级 signal（RemoteEngine
    // cancel 分级：cancel 帧 → grace → 杀链）；[H1 U6] 旧 interact cancel 通道随
    // interact 面退役。
    killRecordChildWithEscalation(record.id, "cancelBackground");
    disarmIdleTimer(record.id);
    disarmSettledWatchdog(record.id);
    disarmRoundFromProtocol(record.id);
    this.onRecordFinalizedCleanup(record.id);
    // [A2-1] CAS 抢锁防重复收尾：running 才放行。doFinalizeRecord Step 0 await 窗口内
    // record 可能已被终态化（closed）但尚未 archive——没抢到说明 detached 已 finalize，
    // cancel 来晚了，闭嘴返回 false（completeRecord 会覆写终态 + tombstone/finalized
    // 双标 + notify 双发，绝不可执行）。
    if (!tryTransition(record, "closed", "cancelled")) {
      return false; // detached 已 finalize，cancel 来晚了
    }
    // 抢到锁：completeRecord（用空 result 填 cancelled）+ archive（立即移出内存）+ notify。
    // 写 cancelled 终态 sidecar：session.jsonl 被 abort 截断，cancelled 状态靠 sidecar 标记，
    // collectRecords 重建时 override status=cancelled。durationMs 用真实耗时（startedAt → now）。
    const cancelledResult: AgentResult = { text: "", turns: record.turnCount, durationMs: Date.now() - record.startedAt, success: false, error: "cancelled by user", sessionId: record.id, toolCalls: [] };
    completeRecord(record, cancelledResult, "closed", "cancelled");
    // [M1 sessionFile 锚点提升] 先于 sidecar/manifest——spawn 窗口期 cancel 的 record
    // 经 engineHandle 提升后，sidecar 与 manifest 都能落在真实子文件上。
    this.promoteSessionFileFromEngineHandle(record);
    // 写终态 sidecar（best-effort，sessionFile 可能为 undefined——窗口期 cancel）。
    if (record.sessionFile) {
      writeCancelledState(record.sessionFile, record.endedAt ?? Date.now());
      // [H2 A3] 终态 usage 快照随 binding 落盘（finalizeRecord Step3a 同款语义，
      // cancel 独立终态链的镜像补点——绕过 writeTerminalState，故在此补）。
      updateRecordBinding(record.sessionFile, {
        totalTokens: record.totalTokens,
        turns: record.turnCount,
        endedAt: record.endedAt,
      });
    }
    this.store.archive(record);
    // [M2 Gate B] manifest 反查索引补写（best-effort fire-and-forget）。本路径原不写
    // manifest：sessionFile 缺失形态（spawn 窗口期 cancel）重启后 record 完全不可见，
    // message 报原始 not-found（Gate B 实测 sq-c）——补写后 manifest 源可见且
    // closedReason=cancelled 让 endedMessageGuard 走「主动关闭」专属文案。
    void writeManifestBestEffort({ manifestStore: this.manifestStore, pi: this.pi }, record);
    // worktree cleanup + removeAliveMarker（终态 sidecar 单文件单状态，无互斥清理需求）。
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
    this.collectCoordinator.route(record);
    return true;
  }

  // ── 域 #18 finalize 簇（R3 RecordLifecycle，H4 落点 D5）（R0 重排）──

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
        // [F-5 修复] 同 closeChatIdle——chat 轮路由注销单一汇聚点钩子
        //（[H1 U2] 汇聚点扩为 onRecordFinalizedCleanup：路由注销 + Continuation 清理）。
        onFinalized: (id) => this.onRecordFinalizedCleanup(id),
        sessionDir: this.sessionsDir,
      },
      record,
      result,
      status,
      closedReason,
    );
  }

  /** run() 创建期异常的收尾（H1 修复）：createAndConfigureSession 失败会抛，本方法合成 failed
   *  AgentResult → CAS 抢锁 → finalizeRecord（与正常路径同形）。返回合成 result 供 runAndFinalize
   *  继续返回（不 re-throw，swallow 策略）。
   *  [W3 契约变更⑤（run 期失败清理前置副作用）] kickOffEngineRun 前已建的 worktree
   *  （executeViaEngine 创建点，record.worktreeHandle 已绑定）经本方法 → finalizeRecord
   *  → doFinalizeRecord Step 3b cleanupWorktreeIfBound 清理（manifest 多声明 run 期
   *  失败 / engine.run prepare 期 reject 共用本收尾链）；CAS 没抢锁（cancel 抢先终态）
   *  时由 cancelBackground 的 worktree cleanup 覆盖。唯一前置副作用 = worktree（并发
   *  池槽 acquire/release 在 kickOffEngineRun finally 内自回收，journal 是宿主数据不清理）。 */
  private async finalizeFailed(record: ExecutionRecord, err: unknown): Promise<AgentResult> {
    const errMsg = toErrorMessage(err);
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

  // ── 域 #6 model 解析（R4 RunOrchestration）（R0 重排）──

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

  // ── 域 #7 run 域执行入口（R4 RunOrchestration）（R0 重排）──

  /**
   * 统一执行入口。mode 固定 background（sync 已删除）。
   * 内部完成：模型解析 → 执行 → 收尾。
   *
   * @param opts.ctxModel  主 agent 当前模型（模型解析第三层兼底）。undefined 时仅依赖 override/agentConfig。
   */
  async execute(opts: ExecuteOptions): Promise<ExecutionHandle> {
    this.assertReady();
    // [T4② / PS-4] idleTimeoutMs 配置错误在首个副作用前同步 fail-fast（错误含合法范围）。
    this.assertIdleTimeoutMsSafe(opts);

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

    // ── 1. IDENTITY 前置解析：agentConfig（agent .md 加载）保持在最前 ──
    // [u-h2 D2-1] 路由先行：model 解析从「路由之前」移到「路由之后、按目标引擎分支」
    // （修 F2-A/B 时序根因——曾 :850 先解析 model 再 :867 路由）。agentConfig 是路由
    // 第二层输入（frontmatter engine）必须先解析；显式 agent ref 校验语义不变。
    const agent = opts.agent ?? DEFAULT_AGENT_NAME;
    const agentConfig = opts.agent
      ? this.modelService.getRequiredAgentConfig(opts.agent)
      : undefined;

    // ── 1.5 引擎路由（D2 单轨 + D3-② 路由单点：统一经 routeEngineForHost）──
    // 唯一实现在 engine/routing.ts（pi 同步短路 + registry 注入 + 兜底回本地 pi 实例
    // 收敛于此）；本调用点只装配三层输入与注入件。时机：路由（含 probe）在 record
    // 创建前完成——兜底时 record 按 pi 语义创建 + engineFallback 留痕（D5 字节级守护
    // 只约束「无 fallback 的纯缺省路径」）；守卫命中/strict 时在此 throw，不产生孤儿
    // record。pi 请求路径同步短路（routed 非 Promise，零微任务——首个 await 前完成
    // 路由决策；执行经进程边界，「run 内首个 await 前已触达 executeAndAwait」的旧
    // 时序契约由引擎协议化设计 §3.5.3 作废放宽）。
    // [u-h2 D2-1] 路由先行于 pi 链 model 解析：agentConfig 是路由第二层输入（frontmatter
    // engine）已前置解析；pi 的 resolveModel 移到路由之后、按目标引擎分支执行——非 pi
    // 请求不被 pi registry 解析错误拦截（F2-A/B 时序根因），model 校验归目标引擎（D2-2）。
    const routingInput = {
      callEngine: opts.engine,
      agentEngine: agentConfig?.engine,
      globalDefaultEngine: this.modelService.getGlobalConfig().defaultEngine,
    };
    const routed = routeEngineForHost({
      routing: routingInput,
      // 守卫 c 判据只看调用方显式指定的 model（resolved model 含 ctxModel 兼底，
      // 恒非空会把一切兜底误判为 model 绑定命中）
      taskModel: opts.model,
      strict: this.modelService.getGlobalConfig().engineRouting?.strict === true,
      probe: (engineId) => getEngine(engineId).probe(),
      // [W3] chat 域 pi 路由 = registry cli 形态 port（协议客户端）——inproc DI 实例
      // 随 inproc pi 引擎目录 删除消亡，chat 与 run 域同路（G1 单一 CLI 形态）。
      piEngine: this.resolveChatEnginePort(),
    });
    const route: EngineRouteResult = routed instanceof Promise ? await routed : routed;
    return this.executeViaEngine(opts, { agent, agentConfig }, route, mode);
  }

  // ── 域 #12 await 入口（R4 RunOrchestration）（R0 重排）──

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
    // [T4② / PS-4] 与 execute() 同款入口校验（两入口共享 runAndFinalize → armIdleTimer 链）。
    this.assertIdleTimeoutMsSafe(opts);

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

    // ── 步骤 3/4 合并（W3）：signal 决议（SessionRunnerContext 已随 inproc 链路删除）──
    const effectiveSignal = signal ?? record.controller?.signal;

    // 步骤 5: runAndFinalize（await，不 detached）。onEvent 独立传，stream 透传。
    const result = await this.runAndFinalize(
      record,
      { ...opts, worktree: worktreeHandle },
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

  // ── 域 #14 引擎编排（R4 RunOrchestration；含 H2 workflow 族 + Continuation 协作面）（R0 重排）──

  // [H1 U6] resumesInFlight（record 级在途 resume 守卫，[review MF1]）随 resumeColdRound
  // 退役删除——Continuation 的 activeRunId 同步占位单飞（dispatchRoundGuarded）构造性
  // 承接防双写者语义。chatRoundRoutes（recordId 键反向通道路由表）随 interact 面退役删除。

  /**
   * [H1 U2] ConversationContinuation 实例表（recordId 键）：chatMode record 的续聊
   * 编排承载（§3.4）。创建点 = chatMode 首轮派发前 / message 到达（SP-5 升级后）；
   * 清理点 = record 终态化路径（onRecordFinalizedCleanup）。跨重启冷查（cold-lookup）
   * 重建会创建新 record 对象——continuationFor 对缓存实例做绑定一致性检查，换新即重建。
   */
  private readonly continuations = new Map<string, ConversationContinuation>();

  /**
   * [W4] 轮次活性监督器（D2「等待有主」权威层）：死亡事件纳管（run failed / 引擎
   * exited → adoptOnProcessDeath）+ boot 分区重认领（initSession）+ 三态判定
   * （record 级视图）+ 该放弃（终态化 failed + 注销 + 终止通知）。装配绑定面
   * （deps/giveUp 编排/sweep 挂点）在 round-supervisor/service-binding.ts——变化轴
   * 独立（通知文案 / 终态化编排 / store 读侧判据只动该文件），本字段只持实例。
   */
  private readonly roundSupervisor: RoundSupervisor = createRoundSupervisorForService({
    getStore: () => this.store,
    getPi: () => this.pi,
    getSessionRootId: () => this.sessionRootId,
    getMainSessionFile: () => this.mainSessionFile,
    finalizeClosed: (record, result) => this.finalizeRecord(record, result, "closed", "gc"),
  });

  // [H1 U6] 旧 chat 域投递/续轮链已整体退役：deliverToRunning 消费链（V2 决策 3）、
  // resumeColdRound（守卫链 + 执行态信号清除 + resume 锚点组装——迁 Continuation
  // dispatchRoundGuarded / dispatchRoundAsync）、onHotPathSettledWatchdogTimeout
  //（热路径 watchdog 载体——迁 Continuation.onWatchdogFire → onRunSettled 失败分支
  // 统一收口，D7）、EPIPE/steer 协议知识（随 interact 面消亡）。

  /**
   * [V2 决策 3 → H1 U2 改写 / U6 定形] chatMode 统一投递入口（message action 的
   * Service 面）——经 ConversationContinuation.onMessage（§3.4 / D4 状态迁移表 /
   * D2 打断语义）：
   *
   *   - running（轮间 idle）→ 新轮派发（新 run + resume 锚点，record.sessionFile 续写）；
   *   - running（有在途轮）→ D2 打断：abort 在途轮 signal + 消息入队，abort 收敛后
   *     drain（打断即杀，宽限语义随长驻消亡放弃）；
   *   - 终态 → guard 分流（closed 硬拒 / 可重连 revive + 非 chatMode 升级格 + D5 gate）。
   *
   * @param record 目标 record（messageHandler 已做归属校验 + 升级 gate）
   * @param text 消息正文
   */
  private async deliverChatMessage(record: ExecutionRecord, text: string): Promise<void> {
    this.assertReady();
    this.continuationFor(record).onMessage(text);
  }

  /**
   * [UF-1] record 绑定 sidecar 写（sessionFile 回填点统一入口）。
   *
   * engine-CLI 化后子 session 文件不含身份 entry（旧 PI_SUBAGENT_SELF_RECORD_ID
   * 注入链消失），跨重启后 coldLookupForAction（findLightById + collectRecords）
   * 失去 id→file 映射，message 一律「not found or not owned」（U4 基线 S6 ❌）。
   * 本方法在 record.sessionFile 被回填的代码点落 `<sessionFile>.record-binding`
   * （id→file + rootSessionId 等身份域），record-store 扫描侧据它重建身份。
   *
   * best-effort 记账面：绑定写失败只 warn（state-marker 内部），不阻断派发主路径；
   * sessionFile 未回填（undefined）时静默跳过（绑定无从谈起）。
   */
  private writeBindingForRecord(record: ExecutionRecord): void {
    const sessionFile = record.sessionFile;
    if (!sessionFile) return;
    writeRecordBinding(sessionFile, {
      v: 1,
      recordId: record.id,
      rootSessionId: record.rootSessionId,
      parentRecordId: record.parentRecordId,
      depth: record.depth,
      agent: record.agent,
      task: record.task,
      slug: record.slug,
      mode: record.mode,
      startedAt: record.startedAt,
      chatMode: record.chatMode === true,
      round: record.round,
      model: record.model,
      thinkingLevel: record.thinkingLevel,
      worktree: record.worktreeHandle !== undefined || record.hadWorktree === true,
      // [H2 S3] 来源身份随绑定落盘：引擎子文件身份面（binding sidecar）是磁盘重建
      // origin 的唯一现行载体，漏写则归档/重启后 workflow record 逃过 D1 投影过滤。
      origin: record.origin,
      parentRunId: record.parentRunId,
    });
  }

  /**
   * [H2 W2] workflow 域统一派发入口（设计 subagent-workflow-record-unification
   * §3.5 / G1 等同语义）：workflow 脚本 agent() 经 pump 薄转调进此（W3 接线；本
   * 单元入口就位，测试直接调用），与手动 subagent 同一 service 编排——共享池
   * （DefaultConcurrencyPool）、record 注册进 store（origin:"workflow" +
   * parentRunId）、journal / no-progress 守护 / spawned-children 治理、终态收口
   * （D7 成功即终态化）。编排接管自 SAR.run 八步迁移（W4 已掏空 SAR.run 为纯转调
   * ffbe595c5，
   * ctxModel 孪生守卫按清单放弃——resolveIdentity 已有 model 解析，禁止双轨）。
   *
   * 顺序红线（D3）：路由/预检/model 校验**先于**池 acquire——失败零池占用；路由
   * 失败/预检命中/嵌套超限同步抛错回脚本且不产生孤儿 record（与 executeViaEngine
   * 「全部同步拒绝发生在 record 创建前」同一不变量）。
   *
   * 错误规格（§3.4）：池排队被 abort → run 域 cancelled 收口（acquirePoolOrFinalize
   * 同款 S1 分支）；record 创建失败 → 同步抛错；引擎死亡 → catch 合成 failed result
   * 回脚本（swallow 语义，脚本观察到失败结果非异常）+ record 由失败路径立即终态化
   * （adopt 豁免——workflow record 无脚本可回，resumable 等待无意义）。
   */
  async executeWorkflowAgent(
    opts: AgentCallOpts,
    parentRunId: string,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<WorkflowAgentResult> {
    this.assertReady();
    // 入口校验与嵌套护栏（与 execute/executeAndAwait 同款 BC-12 / T4②）。
    const execOpts = workflowCallToExecuteOptions(opts);
    this.assertIdleTimeoutMsSafe(execOpts);
    const parentNesting = this.execNesting.current();
    const nestingDepth = parentNesting ? parentNesting.depth + 1 : 0;
    if (nestingDepth > MAX_FORK_DEPTH) {
      throw new ForkDepthExceededError(
        `subagent nesting depth ${nestingDepth} > ${MAX_FORK_DEPTH} (max recursion), refusing to spawn deeper`,
      );
    }

    // ── 八步迁移 ①②③：路由 → 预检 → identity（含非 pi 引擎 model 校验）──
    // 全部先于 record 创建与池 acquire（D3 失败零池占用）。agentConfig 取宽松面
    //（getAgentConfig——路由输入只要 frontmatter engine；显式 ref 解析失败的报错归
    // identity 阶段的 getRequiredAgentConfig，不在路由层重复）。
    const agentConfig = opts.agent ? this.modelService.getAgentConfig(opts.agent) : undefined;
    const routed = routeEngineForHost({
      routing: {
        callEngine: opts.engine,
        agentEngine: agentConfig?.engine,
        globalDefaultEngine: this.modelService.getGlobalConfig().defaultEngine,
      },
      taskModel: opts.model,
      strict: this.modelService.getGlobalConfig().engineRouting?.strict === true,
      probe: (engineId) => getEngine(engineId).probe(),
      piEngine: this.resolveChatEnginePort(),
    });
    const route: EngineRouteResult = routed instanceof Promise ? await routed : routed;
    // ② 预检（capability-gate 单点；AgentCallOpts 直传——TaskShapeForGate 是结构子集）
    assertTaskShapeSupported(route.engineId, route.engine.capabilities(), opts);
    // ③ 非 pi 引擎 model 校验：经 resolveIdentityForEngine 内的 validateModelForEngine
    //（与 chat 域 executeViaEngine 同一入口同一文案；model 源 = 显式 opts.model >
    // agent frontmatter——u-h2 D2-1③ 同款）。
    const isPiRoute = route.engineId === DEFAULT_ENGINE_ID;
    const engineModel = isPiRoute ? undefined : (opts.model ?? agentConfig?.model);
    const identity = isPiRoute
      ? await this.resolveIdentity(execOpts)
      : this.resolveIdentityForEngine(
        route.engine,
        engineModel,
        execOpts.agent ?? DEFAULT_AGENT_NAME,
        agentConfig,
        execOpts,
      );
    if (!isPiRoute && engineModel !== undefined) execOpts.model = engineModel;
    // record 引擎留痕（对齐 executeViaEngine 盖章规则：pi 纯缺省不盖键；pi 兜底盖
    // 'pi'+from；非 pi 盖 engineId）。
    if (!isPiRoute) {
      execOpts.engine = route.engineId;
    } else if (route.engineFallback !== undefined) {
      execOpts.engine = DEFAULT_ENGINE_ID;
    }
    if (route.engineFallback !== undefined) execOpts.engineFallback = route.engineFallback;

    // ── record 注册（origin:"workflow" + parentRunId；record 级 pending:register
    //    照旧——与既有派发路径同款）──
    const record = this.createRecordForMode(identity, execOpts, "background", {
      origin: "workflow",
      parentRunId,
    });
    this.notifyHost.emitPendingRegister(record.id, record.agent);

    const effectiveSignal = signal ?? record.controller?.signal;
    return this.runWorkflowEngineTask(record, opts, identity, route.engine, effectiveSignal, onEvent, stream);
  }

  /**
   * executeWorkflowAgent 的执行核（acquire 后主体 + finally 回收）。八步迁移 ④⑤⑥⑦
   * 的落点：
   *   ④ journal 接线（wireEventJournal 单点；taskId = record.id——真实 record 在
   *      store，不再用 SAR 的占位 id）；
   *   ⑤ no-progress 守护（arm/disarm 键 = record.id（D4）；双刷新源 = journal.onEvent
   *      包装 ∪ stream.onDelta 包装；fire 后失败结果追注恢复指引——M3 语义逐项复刻）；
   *   ⑥ mergeRunSignals（timeoutMs + 守护 abort + 外部 signal 合流）；
   *   ⑦ spawned-children 注册（dispose killAll 收割兜底，键 = record.id）。
   * 池 = DefaultConcurrencyPool 共享（acquirePoolOrFinalize 同链，D3）；成功收口 =
   * settleOneShotOutcome 顶部 D7 origin 分支（closed/gc 立即终态化）。stream 实参
   * 缺省时自构 createBackgroundStream（设计 D2「streaming 由 service 派发路径既有
   * 通道承载」——widget 通道收口点，kickOffChatRound 同款策略，见函数体注释）。
   */
  private async runWorkflowEngineTask(
    record: ExecutionRecord,
    opts: AgentCallOpts,
    identity: ResolvedIdentity,
    engine: EnginePort,
    signal: AbortSignal | undefined,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<WorkflowAgentResult> {
    // [H2 W3 must-fix] stream 实参缺省时自构 background stream——设计 D2「streaming
    // 由 service 派发路径既有通道承载」的实体落点：W3 切换后 pump 不再构造
    // SubagentStream（旁路 record 族退役），workflow agent 的 text_delta widget 通道
    // 在 service 侧收口，与 kickOffChatRound 的 createBackgroundStream 完全同款
    //（含 H1 widget 退役策略：GUI+relay 激活停发私货 / TUI·未激活原样创建 / sink
    // 未注入降级 undefined——照单继承 chat 域现行策略，非行为变化）。显式传 stream
    // 时用传入值（测试注入面保留）。创建先于池 acquire（kickOffChatRound 同序：
    // acquire 失败早退时 stream 尚未 onDelta，无 widget/timer 副作用可泄漏）。
    const effectiveStream =
      stream ?? createBackgroundStream(record.id, this.streamSink, this.uiObservability.getMode(), process.env);
    const pooled = record.mode === "background";
    let acquired = false;
    if (pooled) {
      const acquireFailure = await this.acquirePoolOrFinalize(record, signal, PRIORITY_BACKGROUND);
      if (acquireFailure !== undefined) return mapToWorkflowAgentResult(acquireFailure);
      acquired = true;
    }

    const journal = wireEventJournal({ engineId: engine.id, taskId: record.id, forwardEvents: onEvent });
    let runSignal: MergedRunSignalHandle | undefined;
    let unbindStream: (() => void) | undefined;
    let noProgress: WorkflowNoProgressGuard | undefined;
    // [W4] 在途记账（监督器「该等」判据源；与 kickOffEngineRun/kickOffChatRound 同款
    //——运行期监督对 workflow record 照旧纳管，只豁免 adopt 接管）。
    this.roundSupervisor.noteRunStarted(record.id);
    try {
      // ⑤ arm（池槽已到手、engine.run 派发前——排队窗口不计入 no-progress 静默，
      // kickOffChatRound 同款窗语义）。
      noProgress = armWorkflowNoProgressWatchdog(record.id);
      // ⑥ timeoutMs + 守护 abort 并入同一合流（第三信号源）
      runSignal = mergeRunSignals(
        signal ?? new AbortController().signal,
        opts.timeoutMs,
        noProgress.signal,
      );
      // ⑤ 双刷新源（两路缺一不可——只接 journal 会漏纯流式产出的活性信号）：
      // journal.onEvent 包装（协议事件）∪ stream.onDelta 包装（流式增量反向帧；
      // 内构 stream 同样经本包裹——refresh 与 widget flush 在同一 onDelta 调用点）。
      const journalOnEvent = journal.onEvent;
      const observedEvent = (event: AgentEvent): void => {
        // [H2 A3 修复] live reducer 喂入恢复：W3 删 inproc pi 引擎时，原
        // engines/pi/session-runner.ts agentEvent 出口的 updateFromEvent(record, event)
        // 一并消失，协议化 service 侧未重建——record.turns/totalTokens 在 live 通路
        // 零喂入，终态 entry 落盘同为 0（Gate B A3：workflow agent 实际消耗 LLM 而
        // record 恒 0）。此处恢复 workflow 域喂入：reducer 与 journal-replay /
        // session-view-service 重放路径同源（C5 守护），live ≡ replay 构造性成立；
        // 事件序 = 引擎协议事件序，message_end(usage) 携带 token 增量。
        updateFromEvent(record, event);
        refreshFromProtocolEvent(record.id);
        journalOnEvent(event);
      };
      unbindStream = effectiveStream === undefined ? undefined : bindWorkflowStreamRefresh(effectiveStream, record.id);

      const runCtx: RunContext = {
        taskId: record.id,
        poolKey: JOURNAL_INITIAL_POOL_KEY,
        signal: runSignal.signal,
        ctxModel: identity.resolved.model,
        onEvent: observedEvent,
        onPoolResolved: journal.onPoolResolved,
        ...(effectiveStream !== undefined ? { stream: effectiveStream } : {}),
        ...(record.engineFallback !== undefined ? { engineFallback: record.engineFallback } : {}),
        ...(this.sessionRootId !== null && this.sessionRootId !== ""
          ? { sessionRootId: this.sessionRootId }
          : {}),
        // ⑦ D10 终止链：引擎 spawn 的子进程注册进 spawnedChildren 记账（cancel
        // SIGTERM / dispose killAll 收割兜底，键 = record.id）
        onChildSpawned: (child) => registerSpawnedChildForRecord(record.id, child),
      };
      // 任务声明：opts 直传（D6 合流——AgentCallOpts 即 EnginePort 任务形状，SAR 同款
      // 零映射），model 覆写为 record 留痕词形（resolveIdentity 解析产物，与
      // runAndFinalize 的 taskSpecWithModel 同源权威）。
      const taskSpec: AgentCallOpts = {
        ...opts,
        ...(record.model !== undefined ? { model: record.model } : {}),
      };
      const { handle, outcome } = await engine.run(taskSpec, runCtx);
      journal.backfillHandle(handle);
      record.engineHandle = {
        sessionRef: handle.data.sessionRef,
        poolKey: handle.data.poolKey,
        journalPath: journal.path,
      };
      const result = this.outcomeToAgentResult(record, outcome);
      // D7 收口（origin 分支在 settleOneShotOutcome 函数顶部；aborted 判外部 signal
      // ——timeout/watchdog 的 abort 走失败 result 语义，不映射 cancelled）。
      await this.settleOneShotOutcome(record, result, signal?.aborted === true);
      return noteIfWorkflowNoProgressFired(outcomeToWorkflowResult(outcome), noProgress);
    } catch (err) {
      // swallow（不 re-throw）：脚本观察到合成 failed result 而非异常（引擎死亡
      // engine_crashed 同路）；record 由失败路径立即终态化（finalizeFailed CAS →
      // finalizeRecord；adopt 豁免——workflow record 不保持 resumable 交监督器）。
      const failed = await this.finalizeFailed(record, err);
      return noteIfWorkflowNoProgressFired(mapToWorkflowAgentResult(failed), noProgress);
    } finally {
      // 先摘 stream 包裹与信号桥接（不残留 listener/覆写），再清守护，再归还池槽与
      // journal 收口（SAR 同序）。内构 stream 的 widget 清除（dispose）同经本回收。
      runSignal?.dispose();
      unbindStream?.();
      disarmSettledWatchdog(record.id);
      this.releaseRoundResources(record, pooled && acquired, effectiveStream);
      await journal.close();
      this.roundSupervisor.noteRunEnded(record.id);
    }
  }

  /**
   * chat 域统一执行入口（D2 单轨：全引擎——含 pi——经此进入 EnginePort）。路由
   *（routeEngineForHost：三层 + pi 同步短路 + probe/守卫）已由 execute 完成——这里
   * 只剩 unsupported 预检 → identity（pi 链解析 / 非 pi 按目标引擎校验，
   * [u-h2 D2-1/D2-2]）→ record 创建+盖章 → worktree → detached 引擎 run。
   * 全部同步拒绝发生在 record 创建前（不产生孤儿 record）。
   */
  private async executeViaEngine(
    opts: ExecuteOptions,
    preIdentity: { agent: string; agentConfig: AgentConfig | undefined },
    route: EngineRouteResult,
    mode: ExecutionMode,
  ): Promise<ExecutionHandle> {
    const engine = route.engine;
    // [D3-④ 预检 capabilities 化] 唯一实现 = common/capability-gate（capabilities
    // 驱动，含 maxTurns 扩位）。检查点钉死：execute/executeViaEngine 同步段、record
    // 创建前（engine.capabilities() 同步可得）——承接「全部同步拒绝发生在 record
    // 创建前、不产生孤儿 record」不变量（其后的 kickOffEngineRun 是 fire-and-forget，
    // 检查若只落在 engine.run 内则拒绝异步化为「派发成功 + 静默失败 record」）。
    // [W3 契约变更③补注（协议化能力位方向判定）] 同步拒只覆盖「manifest 少声明」
    // 方向；**manifest 多声明**（声明支持而引擎实际不支持）由首个 run 的协议握手
    // `initialize` 发现 → engine_capability_mismatch 该 run 失败 + record 标 failed，
    // 并**清理 run 前已建的前置副作用**（worktree 经 finalizeFailed → finalizeRecord
    // Step 3b cleanupWorktreeIfBound 清理）。非 gate 位不一致（无论强弱）一律
    // warn 留痕不阻断（诊断面归 EngineClient，设计 §3.3 能力位段）。
    assertTaskShapeSupported(engine.id, engine.capabilities(), opts);

    // identity 按路由结果分支构造（[u-h2 D2-1] 路由先行）：
    //   - pi：pi 链三层解析在路由后执行（现状三层解析链行为零变化；含 resolveModel
    //     失败的跨引擎候选提示，D2-4）；
    //   - 非 pi：跳过 pi registry，model 按目标引擎校验（同步期 throw，record 创建前
    //     ——场景 2 错误；ctxModel 不透传，缺省语义归引擎，D2-1③）。
    const isPiRoute = route.engineId === DEFAULT_ENGINE_ID;
    // [u-h2 D2-1③] 非 pi 的 model 源 = 调用参数 > agent .md frontmatter（作者声明不
    // 忽略）——frontmatter 声明须真正透传给引擎（taskSpec.model 消费 opts.model），
    // 不能只进 record 留痕；无显式 model 时引擎落自身缺省（validateModel(undefined) 裁决）。
    const engineModel = isPiRoute ? undefined : (opts.model ?? preIdentity.agentConfig?.model);
    const identity = isPiRoute
      ? await this.resolveIdentity(opts, preIdentity)
      : this.resolveIdentityForEngine(engine, engineModel, preIdentity.agent, preIdentity.agentConfig, opts);

    // record 盖章路由结果（D5 字节级守护的执行侧落点）：
    //   - pi 纯缺省/显式 pi：不盖 engine 键（pi record entry 序列化产物不得新增 engine
    //     键，undefined 经 JSON 省略）——与旧 pi 主路径 piOpts 剥离语义逐字节一致；
    //   - pi 兜底：engine='pi' + engineFallback 留痕（engine = 实际执行引擎，from=请求
    //     引擎留痕）；
    //   - 非 pi：engine=route.engineId 显式留痕（+engineFallback 如有）+ model 覆写
    //     （frontmatter 声明透传，u-h2 D2-1③）。
    const recordOpts: ExecuteOptions = isPiRoute
      ? route.engineFallback !== undefined
        ? { ...opts, engine: DEFAULT_ENGINE_ID, engineFallback: route.engineFallback }
        : opts.engine === undefined
          ? opts
          : { ...opts, engine: undefined }
      : {
        ...opts,
        ...(engineModel !== undefined ? { model: engineModel } : {}),
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

    if (isPiRoute) {
      if (record.chatMode) {
        // [H1 U2] chat 首轮经 ConversationContinuation（§3.5 终态数据流：轮末分流
        // chatMode → Continuation onRunSettled；one-shot → settleOneShotOutcome 照旧）。
        // 首轮 task = dispatchRound([task])（无 resume——新 session，锚点由 run 应答回填）。
        this.continuationFor(record).startFirstRound(recordOpts.task);
      } else {
        // one-shot background 派发主干（kickOffChatRound 共享部分，D6 保留泛化）。
        this.kickOffChatRound(
          record,
          { ...recordOpts, worktree: worktreeHandle },
          identity,
          record.controller!.signal,
          PRIORITY_BACKGROUND,
        );
      }
    } else {
      // 非 pi 引擎：engine.run 自足执行（handle+outcome），编排侧 journal 接线 + 终态迁移
      this.kickOffEngineRun(record, recordOpts, engine);
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
    // [W4] 在途记账（监督器「该等」判据源）：run 发起即记账，finally 收口重评估。
    this.roundSupervisor.noteRunStarted(record.id);
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
        // [W4] adopted = 走了表 3 行 1 接管分支（record 保持 resumable 交监督器）——
        // 跳过 bg 完成回注（合并单条通知由监督器 sendMergedFailureNotice 承担，
        // route 会再发一条 toNotifyRecord 投影通知 = 双通知，正是 R3 要消除的时序窗口）。
        const adopted = await this.runEngineTask(record, opts, engine, signal);
        // cancel 抢先（closedReason='cancelled'）时 cancelBackground 自己 notify，跳过
        if (!adopted && record.closedReason !== "cancelled") {
          this.collectCoordinator.route(record);
        }
      } finally {
        this.pool.release();
        this.roundSupervisor.noteRunEnded(record.id);
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
  ): Promise<boolean> {
    // [D3-③ journal 接线合一] writer + retarget + 路径权威收敛 common/journal-wiring
    //（与 SAR 同一实现）。chat 域无下游 onEvent 消费者——journal 是事件唯一出口，
    // 不传 forwardEvents。
    const journal = wireEventJournal({ engineId: engine.id, taskId: record.id });
    // [R4 §3.4 不变量 3] 运行中句柄回填：create 应答后（远早于 run resolve）回填
    // record.engineHandle 并经 reportRecordTransition 落 entry——运行中的 GUI 经 entry
    // 重建 record 即拿到 ①②级读取钥匙（sessionRef/dbPath/poolKey/journalPath），
    // 不再等终态回填（详情页中途打开可见当时进度快照）。journalPath 此时已是
    // retarget 后的最终路径（onPoolResolved 在 prepare 期先行触发，writer 是路径权威）。
    // 仅 chat 域接线——workflow 域 SAR 无运行中 record 读取方，刻意不做同类回填（防误扩展）。
    // [F1 修复] 幂等语义 = 按字段补缺，不是整条丢弃：已有值一律不被迟到值覆盖，缺失
    // 字段照常补上。「sessionId 先落、迟到 handleReady 只补 sessionFile」是本 replay
    // 批次新打通且更有价值的形态（close 期 LC-4 后缀反查会在 sessionId 已知后补发
    // sessionFile）——旧守卫「有 sessionId 即整条 return」会把该
    // 回填永久吞掉，令冷续 resume 锚点（anchor.sessionRef.sessionFile）与引擎 interact
    // 定位拿不到 sessionFile（[H1 U6] chatHandleFor 已随 interact 面退役）。poolKey / journalPath 不参与补缺：
    // journalPath 权威归 journal writer（本闭包写入即定稿），poolKey 由 onPoolResolved
    // retarget 与首次回填定稿，迟到值不得重置。仅在确有字段落位时才落 entry——无新字段
    // 不写噪（迟到重复回调即零副作用，GUI 无额外投影）。
    const backfillEngineHandle = (partial: { sessionRef: Record<string, string>; poolKey: string }): void => {
      const current = record.engineHandle;
      if (current === undefined) {
        record.engineHandle = {
          sessionRef: { ...partial.sessionRef },
          poolKey: partial.poolKey,
          journalPath: journal.path,
        };
        this.store.reportRecordTransition(record);
        return;
      }
      const merged: Record<string, string> = { ...current.sessionRef };
      let filled = false;
      for (const [key, value] of Object.entries(partial.sessionRef)) {
        if (value === undefined || value === "") continue; // 空值不是可落位的字段值
        const existing = merged[key];
        if (existing === undefined || existing === "") {
          merged[key] = value;
          filled = true;
        }
      }
      if (!filled) return;
      record.engineHandle = { ...current, sessionRef: merged };
      this.store.reportRecordTransition(record);
    };
    // 对齐点③：journal 路径权威 = 引擎声明的池 key（writer 初始用占位，retarget 后
    // 与 handle.poolKey 同源）。
    // [H2 Gate B 修复] live reducer 喂入恢复（runWorkflowEngineTask observedEvent 同款）：
    // 非 pi 引擎派发此前 onEvent 直连 journal.onEvent——事件只落 ②级 journal，live record
    // 零喂入（turns/totalTokens 恒 0，chat 域 record 与 tool one-shot 经非 pi 引擎同病）。
    // 此处恢复 updateFromEvent 喂入：reducer 与 journal-replay / session-view-service
    // 重放路径同源（C5 守护），live ≡ replay 构造性成立。喂入窗口 = run await 窗口，
    // 终态后残余事件仅写内存 record 不落盘——与 workflow 域修法同一取舍。不接
    // refreshFromProtocolEvent：非 pi 派发无轮次 no-progress 守护（arm 点在轮次域），
    // 恒 no-op 不加。
    const journalOnEvent = journal.onEvent;
    const observedEvent = (event: AgentEvent): void => {
      updateFromEvent(record, event);
      journalOnEvent(event);
    };
    const runCtx: RunContext = {
      taskId: record.id,
      poolKey: JOURNAL_INITIAL_POOL_KEY,
      signal,
      ctxModel: opts.ctxModel,
      onEvent: observedEvent,
      onPoolResolved: journal.onPoolResolved,
      // [R4 §3.4 不变量 3] 运行中句柄回填通道（engine/port.ts RunContext.onHandleReady）
      onHandleReady: backfillEngineHandle,
      // D9①：路由层 fallback 留痕投影进 outcome（zcode 无独立 record 通路）
      ...(record.engineFallback !== undefined ? { engineFallback: record.engineFallback } : {}),
      // [F6] 根 session id 注入（relay 归属键 SESSION_ID 权威源；null/空串不上 wire）
      ...(this.sessionRootId !== null && this.sessionRootId !== ""
        ? { sessionRootId: this.sessionRootId }
        : {}),
      // D10 终止链：engine spawn 的子进程注册进 spawnedChildren 记账
      //（cancelBackground SIGTERM / dispose killAll 收割对非 pi record 生效）
      onChildSpawned: (child) => registerSpawnedChildForRecord(record.id, child),
    };
    try {
      const { handle, outcome } = await engine.run(executeOptionsToEngineTaskSpec(opts), runCtx);
      // engineHandle 终态回填（U2：终态迁移落 entry 前；R4 起为兜底面——运行中回填
      // 已由 onHandleReady 提前落 entry，此处覆写终态权威值）。sessionRef 整体透传——
      // 失败终态 sessionId 缺失时也回填已有部分（dbPath/poolKey），读侧①级降②级
      // 的防御形态；journalPath 取 retarget 后的实际落盘路径（writer 是路径权威）。
      record.engineHandle = {
        sessionRef: handle.data.sessionRef,
        poolKey: handle.data.poolKey,
        journalPath: journal.path,
      };
      await journal.close();
      return await this.finalizeEngineOutcome(record, outcome);
    } catch (err) {
      // engine.run prepare 期 reject（进程创建前）→ failed 终态（与 runAndFinalize catch 同语义）；
      // journal 尽力而为收口（②级数据源写失败已由 writer 内部 warn 收敛）
      await journal.close();
      // [W4 表 3 行 1] 引擎进程死亡（engine_crashed——run 帧已受理后进程死亡/stdin
      // 写失败）且宿主存活 → record 保持 resumable 交监督器接管（禁 completed 谎报、
      // 禁直接 closed 终局——resume 锚点在盘，逻辑任务可续）。prepare 期失败
      // （handshake/protocol/model 拒——进程创建前）维持现状 closed（确定性失败，
      // 保持 resumable 无意义）。
      // [H2 W2 / adopt 豁免点一] workflow origin 豁免 adopt 链：引擎死亡即 run 失败
      // 即 record 终态化（失败路径表），adopt 链「唤醒→guidance→2h 看门狗→giveUp」
      // 对无脚本可回的 record 全程无意义——豁免落空即落入下方 finalizeFailed 立即
      // 终态化（防「无监督、永不终态化、pending 永不注销」的 resumable 僵尸）。
      if (
        err instanceof EngineSdkError &&
        err.code === "engine_crashed" &&
        record.chatMode !== true &&
        record.origin !== "workflow" &&
        record.status === "running"
      ) {
        this.adoptResumableAfterEngineDeath(record, toErrorMessage(err));
        return true;
      }
      await this.finalizeFailed(record, err);
      return false;
    }
  }

  /**
   * [W4 表 3 行 1] 引擎/子进程死亡、宿主存活的 record 处置：run 终态如实记 failed
   * 证据（record.error），record **保持 resumable**（session 文件在盘，逻辑任务可续
   * ——冷路径 resume 可直接续写），交监督器接管（合并单条通知 + 三态判定）。禁止
   * 两个事故方向：completed 谎报（G3）与 closed 直接终局（resume 可能性丢失，等待
   * 无主——2026-09-08 事故环 2/3 的 core 侧形态）。
   *
   * 判据状态源钉死 record 级：写点只动 record 字段（resumable/result/error），
   * 不清镜像不查引擎——引擎进程被动重建（ensureConnected 退避重填镜像）不翻转
   * 本处置（纳管模型：死亡事件纳管、重建不解管）。
   */
  private adoptResumableAfterEngineDeath(record: ExecutionRecord, errMsg: string): void {
    record.error = errMsg;
    record.result = undefined;
    record.resumable = true;
    this.store.reportRecordTransition(record);
    this.roundSupervisor.adoptOnProcessDeath(record, errMsg);
  }

  /**
   * engine.run resolve 的终态迁移：outcome.error → failed（success=false + error 文案）；
   * 否则 done（result=content）。CAS 抢锁（tryTransition）防与 cancelBackground 双收尾。
   *
   * [W4 表 3 行 1] 进程死亡分诊：outcome.error 存在且 **exitCode === null**（引擎侧
   * 进程被信号终止/崩溃的合成 outcome 形态——RemoteEngine 运行中失败合成分支恒
   * exitCode:null，引擎如实上报的 turn 失败带数值 exitCode；engine-client 注释同源
   * 「exitCode null = 被信号杀死，杀链判据」）且宿主存活且非 conversation 形态 →
   * record 保持 resumable 交监督器接管（如实 failed 证据 + 合并通知 + 三态判定），
   * 不再 closed 终局。返回 true = 走了接管分支（调用方跳过 bg 完成回注）。
   */
  private async finalizeEngineOutcome(record: ExecutionRecord, outcome: AgentOutcome): Promise<boolean> {
    if (outcome.sessionFile !== undefined) {
      record.sessionFile = outcome.sessionFile;
      this.writeBindingForRecord(record);
    }
    if (
      outcome.error !== undefined &&
      outcome.exitCode === null &&
      record.chatMode !== true &&
      // [H2 W2 / adopt 豁免点二] workflow origin 豁免（同 runEngineTask catch 分诊点一
      //——豁免落空走下方 tryTransition+finalizeRecord 立即终态化，不交监督器）。
      record.origin !== "workflow" &&
      record.status === "running"
    ) {
      this.adoptResumableAfterEngineDeath(record, outcome.error);
      return true;
    }
    const result = this.outcomeToAgentResult(record, outcome);
    if (tryTransition(record, "closed", "gc")) {
      await this.finalizeRecord(record, result, "closed", "gc");
    }
    return false;
  }

  /**
   * workflow 域"干活 + 收尾"（sync await；[W3] 执行叶 = 协议 engine.run——原 inproc
   * runSpawn 链随 inproc pi 引擎目录 删除消亡，journal 接线 / record 终态迁移语义保持）。
   * 编排分段保持「装配（池槽/worktree）→ 执行 → 回收（finally）→ 错误收口 → 终态收口」。
   */
  private async runAndFinalize(
    record: ExecutionRecord,
    opts: ExecuteOptions,
    identity: ResolvedIdentity,
    signal: AbortSignal | undefined,
    priority: number,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<AgentResult> {
    const pooled = record.mode === "background";
    let acquired = false;
    if (pooled) {
      const acquireFailure = await this.acquirePoolOrFinalize(record, signal, priority);
      if (acquireFailure !== undefined) return acquireFailure;
      acquired = true;
    }

    // worktree 句柄经 executeOptionsToEngineTaskSpec(opts).worktree 直传引擎
    //（AgentCallOpts.worktree 接受 WorktreeHandle——原 runSpawn 显式传参的协议形态）。
    const engine = this.resolveChatEnginePort();
    // journal 接线（D6 第②级，与 kickOffEngineRun 同一实现）：forwardEvents = onEvent
    //（workflow liveRecord 桥接，D-A8）。
    const journal = wireEventJournal({ engineId: engine.id, taskId: record.id, forwardEvents: onEvent });

    let result: AgentResult;
    try {
      const runCtx: RunContext = {
        taskId: record.id,
        poolKey: JOURNAL_INITIAL_POOL_KEY,
        signal,
        ctxModel: identity.resolved.model,
        onEvent: journal.onEvent,
        onPoolResolved: journal.onPoolResolved,
        ...(stream !== undefined ? { stream } : {}),
        ...(record.engineFallback !== undefined ? { engineFallback: record.engineFallback } : {}),
        // [F6] 根 session id 注入（relay 归属键 SESSION_ID 权威源；null/空串不上 wire）
        ...(this.sessionRootId !== null && this.sessionRootId !== ""
          ? { sessionRootId: this.sessionRootId }
          : {}),
        // D10 终止链：引擎 spawn 的子进程注册进 spawnedChildren 镜像记账
        onChildSpawned: (child) => registerSpawnedChildForRecord(record.id, child),
      };
      const { handle, outcome } = await engine.run(this.taskSpecWithModel(opts, record.model), runCtx);
      record.engineHandle = {
        sessionRef: handle.data.sessionRef,
        poolKey: handle.data.poolKey,
        journalPath: journal.path,
      };
      await journal.close();
      result = this.outcomeToAgentResult(record, outcome);
    } catch (err) {
      await journal.close();
      // engine.run prepare 期 reject（进程创建前）→ 合成 failed result + 收尾。
      // swallow（不 re-throw）：sync 调用方拿到合成 failed result，避免异常逃逸到
      // tool 层 + record 卡 running。（[H1 U6] 旧 chatMode 分支 finalizeChatSpawnFailure
      // 已随 resumeColdRound/旧 chat 载体退役——chatMode 轮不经 runAndFinalize，
      // Continuation 轮收口归 onRoundRejected/onRunSettled。）
      return this.finalizeFailed(record, err);
    } finally {
      this.releaseRoundResources(record, pooled && acquired, stream);
    }

    // v4 B-1: status 恒为 closed。cancelled 折入 closed（closedReason='cancelled'）。
    await this.settleOneShotOutcome(record, result, signal?.aborted === true);
    return result;
  }

  /** engine.run taskSpec 装配单一来源（runAndFinalize 与 kickOffChatRound 共用）：
   *  executeOptions 协议映射 + model = record 留痕词形（resolved 解析产物，
   *  joinEngineModelRef 规范形）覆盖——原 identity.resolved 经 runSpawn --model
   *  兜底的协议等价承载。 */
  private taskSpecWithModel(opts: ExecuteOptions, model: string | undefined): AgentCallOpts {
    return { ...executeOptionsToEngineTaskSpec(opts), ...(model !== undefined ? { model } : {}) };
  }

  /**
   * one-shot（非 chatMode）终态收口（原 settleOneShotOutcome 分支）：成功轮消费
   * closeAfterRound 挂起标志；失败/取消一次性销毁。CAS 抢锁失败（cancel/dispose 抢先
   * 终态化）静默跳过。runAndFinalize（workflow 域）与 kickOffChatRound 非 chatMode
   * 分支共用。
   */
  private async settleOneShotOutcome(
    record: ExecutionRecord,
    result: AgentResult,
    aborted: boolean,
  ): Promise<void> {
    // [H2 W2 / D7] workflow origin 成功收口 = 立即终态化（closed/"gc"）——G1 显式例外：
    // SP-5 running-resumable 为「父 agent 可 message 续聊」设计，workflow agent 结果
    // 由脚本返回值承载、无 message 对端，保持 running-idle 会绑架 hasRunning / 恒挂
    // 30 天 idle-gc / 被误升级为对话容器 / goal defer 恒挂（设计 D7 四面连带）。
    // 分支置于现有 CAS 之前：防其先把 memory closedReason 写成 "user-close" 与
    // finalizeRecord 的 "gc" 参数分叉。条件含 !aborted：aborted+success 竞态边缘
    // 照旧落现有 cancelled 分支，不漂移为 gc。自带 tryTransition 抢锁（承接现状
    // 「cancel/dispose 抢先 → 静默跳过」守卫语义）；失败/取消分支照旧终态化
    // （下方既有四分支零改动）。
    if (record.origin === "workflow" && !aborted && result.success) {
      if (tryTransition(record, "closed", "gc")) {
        await this.finalizeRecord(record, result, "closed", "gc");
      }
      return;
    }
    if (!tryTransition(record, "closed", aborted ? "cancelled" : result.success ? "user-close" : "gc")) return;
    if (!aborted && result.success && record.closeAfterRound === true) {
      // [M5] busy 时 close(force:false) 置的标志在本轮完成时消费终态化。
      await this.consumeCloseAfterRound(record, result, "user-close");
    } else if (!aborted && result.success) {
      // [SP-5] one-shot 成功完成 → 保持 running（旧 idle），等待 message 触发 upgrade。
      // [H1 U2 / D7] 共享调用点恒传 success（行为零变化 G3——成功空文本回退
      // doFinalizeRoundToIdle 的 one-shot 兜底 前值 ?? "(empty)"）。
      await this.finalizeRoundToIdle(record, { kind: "success", content: result.text });
    } else if (!aborted && record.closeAfterRound === true) {
      // [M5] 优雅关闭挂起的失败轮：轮已完成即兑现 close 意图终态化（含本轮 result）。
      await this.consumeCloseAfterRound(record, result, "gc");
    } else {
      // 非 chatMode 失败/取消 或其他终态：一次性销毁（archive + worktree cleanup）。
      await this.finalizeRecord(record, result, "closed", aborted ? "cancelled" : "gc");
    }
  }

  /** AgentOutcome → execution AgentResult 单一映射源（workflow run 域映射；
   *  finalizeEngineOutcome 终态 result 复用此处构造——exitCode null = 被信号杀死的
   *  合成终态，error 如实透传）。 */
  private outcomeToAgentResult(record: ExecutionRecord, outcome: AgentOutcome): AgentResult {
    if (outcome.sessionFile !== undefined) {
      record.sessionFile = outcome.sessionFile;
      this.writeBindingForRecord(record);
    }
    return {
      text: outcome.content,
      turns: outcome.usage?.turns ?? 0,
      durationMs: outcome.durationMs ?? Date.now() - record.startedAt,
      success: outcome.error === undefined,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      sessionId: outcome.sessionId ?? record.id,
      toolCalls: [],
      ...(outcome.parsedOutput !== undefined ? { parsedOutput: outcome.parsedOutput } : {}),
    };
  }

  /** [U04 提取·终态收口] closeAfterRound 挂起标志消费（原三处分支的公共收尾序列）：
   *  清标志 + 终态化 closed。reason：成功轮恒 user-close；失败/取消轮用派生值。 */
  private async consumeCloseAfterRound(
    record: ExecutionRecord,
    result: AgentResult,
    reason: ClosedReason,
  ): Promise<void> {
    record.closeAfterRound = undefined;
    await this.finalizeRecord(record, result, "closed", reason);
  }

  /**
   * pi 会话形态轮次的 detached 编排（[W3 协议形态 → H1 U6 定形]）：轮次经协议 run
   *（会话形态 resume{recordId, resume?}）发往 pi-subagent-cli 引擎进程——
   *   - 应答时点 = agent_settled（D7 定案：pi 的 compact/收尾在 agent_end 后执行，
   *     agent_end 即 kill 会截断收尾；one-shot 的 agent_end 即终态语义不归本方法）；
   *   - 流式 delta 经 run 作用域反向通道回流（runId 键 ctx.stream）；[H1 U6] 轮次
   *     相位帧反向通道与 recordId 键路由已随 chat 域相位机退役，
   *     中段刷新 = run 事件通道既有事件、settle 交棒 = run 应答驱动；
   *   - chat 域不接 event journal（pi 子代理 session JSONL 即原生数据源——journal
   *     接线仅 workflow 域 SAR 与非 pi 引擎路径）。
   *
   * [H1 U2 / D6 泛化] 本方法是 pi 引擎 background 派发的共享主干（one-shot 与
   * Continuation 轮同路）。`continuation` 存在 = Continuation 轮（chat 域统一进
   * run 域的新编排）：
   *   - 应答/reject/acquire 打断三分回调回流 Continuation（轮末分流 D7 单点收口）；
   *   - 不终态化 acquire-abort（打断 ≠ cancel——record 保持 running）；
   *   - 轮末通知归属 Continuation 双闸（成功 gate→route / 失败独立载荷过门），
   *     主干尾部回注跳过（防双 route）。
   * `continuation` 缺省 = one-shot 主干（终态收口 settleOneShotOutcome + 尾部回注）。
   */
  private kickOffChatRound(
    record: ExecutionRecord,
    opts: ExecuteOptions,
    identity: ResolvedIdentity,
    signal: AbortSignal | undefined,
    priority: number,
    /** 续聊锚点（协议 ResumeAnchor）：run.params.resume.resume。undefined = 新 session。 */
    resume?: ResumeAnchor,
    /** [H1 U2] Continuation 轮回调面（存在 = 新编排；见方法头注释）。 */
    continuation?: ContinuationRoundHandlers,
  ): void {
    // 创建 streaming 生命周期对象。策略（含 widget 退役步骤 2：GUI + relay 激活时停发
    // 私货、TUI/未激活原样创建、sink 未注入降级 undefined）集中在 createBackgroundStream。
    const stream = createBackgroundStream(record.id, this.streamSink, this.uiObservability.getMode(), process.env);

    // [H1 U6] recordId 键反向通道路由注册段已随 interact 面退役删除——流式 delta
    // 恒经 run 作用域路由（runId 键 ctx.stream），中段守护刷新由 ctx.onEvent 承担。
    const engine = this.resolveChatEnginePort();

    // [W4] 会话形态轮的在途记账：死亡纳管 record 被主 agent resume = 决策收敛
    // （清指引标记与看门狗，回归「该等」）。conversation 形态本就豁免监督域（D8）。
    this.roundSupervisor.noteRunStarted(record.id);
    void (async () => {
      try {
        await this.pool.acquire(priority, this.effectiveMaxConcurrentFor(record), signal);
      } catch {
        // S1: 排队中被 abort（signal.aborted）走 cancelled，与已运行被 abort 一致。
        // [H1 U2] Continuation 轮例外：abort 来源可能是打断（D2——轮级 signal，
        // record 保持 running）而非 cancel（record 级，cancelBackground 已终态化）。
        // 不终态化（abort 不终态化），经 onAbandoned 回流 Continuation（cancel 场景
        // 该回调内终态守卫 early-return，行为等价）。
        if (continuation !== undefined) {
          continuation.onAbandoned();
          return;
        }
        if (signal?.aborted) {
          await this.finalizeAborted(record);
        } else {
          await this.finalizeFailed(record, new Error("aborted"));
        }
        return;
      }
      try {
        // [F-2 轮 arm] 轮开跑（pool 槽已到手、run 协议帧即将派发）挂**中段**无进展
        // 检测——引擎侧 spawn-runner 仅 turn 计数无墙钟，本 arm 是 wedged 轮的唯一熔断
        //（LC-1 场景①：pi 无事件行输出）。refresh 源：① run 事件通道协议事件行
        //（ctx.onEvent，含 text_delta，9 种既有事件）；② settle 交棒——run 应答驱动
        //（Continuation onRunSettled 内 noteRoundSettledFromProtocol；[H1 U6] 旧
        // settled 相位帧消费面已退役）。轮终 disarmRoundFromProtocol 两段一并清。
        // arm 置于 acquire 之后：排队窗口不计入 no-progress 静默（窗语义 = 轮开跑后）。
        // fire 处置按轮形态分流：Continuation 轮 → kill + abort 轮 signal，run 收敛后
        // 经失败分支统一收口（单写者单路）；one-shot 轮 → onOneShotSettledWatchdogTimeout
        //（[A1/G3 回归修复] H1 重构曾误删本形态 arm 点——one-shot 轮 run 无协议超时
        //（engine-client request 不传 timeoutMs = 任务级无超时），无 arm 则楔死 run 永
        // 卡 running + 池槽泄漏 + 无失败通知，违背 G3「one-shot 行为零变化」）。
        if (continuation !== undefined) {
          armMidRoundNoProgress(record.id, {
            onMidTimeout: (fire) => continuation.onWatchdogFire(fire),
            onSettleTimeout: (fire) => continuation.onWatchdogFire(fire),
          });
        } else {
          armMidRoundNoProgress(record.id, {
            onMidTimeout: (fire) => this.onOneShotSettledWatchdogTimeout(record, fire),
            onSettleTimeout: (fire) => this.onOneShotSettledWatchdogTimeout(record, fire),
          });
        }
        // 协议 run：record.chatMode = 会话形态（resume.recordId = 关联键；锚点存在 =
        // 续聊——[H1 U6] 键切换后恒构造 `resume` 键；应答时点 = agent_settled——轮末
        // 分流归属 Continuation onRunSettled）；非 chatMode = 一次性 run（协议面无
        // resume 键，终态语义对齐 settleOneShotOutcome）。
        // [H2 Gate B 修复] live reducer 喂入恢复（runWorkflowEngineTask observedEvent
        // 同款）：W3 删 inproc pi 引擎时，原 engines/pi/session-runner.ts agentEvent
        // 出口的 updateFromEvent(record, event) 一并消失——chat 轮（Continuation）与
        // tool one-shot 在 live 通路零喂入，record.turns/totalTokens 恒 0（journal-
        // replay / session-view-service 重放路径反而保真，live ≡ replay 契约被破坏）。
        // 此处恢复：reducer 与重放路径同源（C5 守护），事件序 = 引擎协议事件序，
        // message_end(usage) 携带 token 增量。Continuation 轮间共用同一 record 实例
        //（continuationFor 绑定），跨轮累积天然持续。喂入窗口 = run await 窗口——
        // cancel/watchdog 抢先终态化后 run 收敛前到达的残余事件仅写内存 record 不落盘
        //（终态 entry 已写，后续无 reportRecordTransition），且事件流随 kill 枯竭，
        // 与 workflow 域修法同一取舍（不加状态守卫，维持单一形态）。中段守护刷新源①
        // 照旧（refreshFromProtocolEvent 在已交棒/已 fire 时幂等 no-op；one-shot 分支
        // 此前不接 onEvent，本修复顺带补齐其刷新源①）。
        const observedEvent = (event: AgentEvent): void => {
          updateFromEvent(record, event);
          refreshFromProtocolEvent(record.id);
        };
        const { outcome } = await engine.run(
          // resume 锚点轮引擎侧覆盖 model 解析（taskSpec 装配单一来源见 taskSpecWithModel）。
          this.taskSpecWithModel(opts, record.model),
          {
            taskId: record.id,
            poolKey: PI_POOL_KEY,
            signal,
            ...(stream !== undefined ? { stream } : {}),
            ctxModel: identity.resolved.model,
            onEvent: observedEvent,
            // [F6] 根 session id 注入（relay 归属键 SESSION_ID 权威源；null/空串不上 wire）。
            // 本方法是 pi 引擎 background 派发的主路径（isPiRoute 恒路由至此，含 workflow
            // 域一次性 run——非 chatMode 不带 resume 键但同经此处），漏注 = pi child exit 13。
            ...(this.sessionRootId !== null && this.sessionRootId !== ""
              ? { sessionRootId: this.sessionRootId }
              : {}),
            // 会话形态参数（conversation 形态必传；续聊带锚点）；一次性 run 不携带。
            ...(record.chatMode
              ? {
                resume: {
                  recordId: record.id,
                  ...(resume !== undefined ? { resume } : {}),
                },
              }
              : {}),
          },
        );
        if (outcome.sessionFile !== undefined) {
          record.sessionFile = outcome.sessionFile;
          // [UF-1] 轮应答锚点落盘：跨重启后 coldLookupForAction 据此解析 id→file。
          this.writeBindingForRecord(record);
        }
        if (record.chatMode && continuation !== undefined) {
          // [H1 U2] 轮末分流：run 应答（= agent_settled）回流 Continuation——round+1 /
          // 通知 / 交棒 / drain 全在 onRunSettled 单点（D7）。
          continuation.onSettled(outcome);
        } else {
          // 一次性 run 终态收口（对齐原 settleOneShotOutcome：成功轮 SP-5 回退
          // running-resumable 等待 upgrade；失败/取消一次性销毁）。
          const result = this.outcomeToAgentResult(record, outcome);
          await this.settleOneShotOutcome(record, result, signal?.aborted === true);
        }
        // background 回注：仅当本路径抢到 CAS 才 notify。cancel 抢先时 closedReason=
        // 'cancelled'（cancelBackground 自己 notify）；[T4①/PS-2] parent-new/parent-fork
        // 是 disposeAllRecords 的编排性关闭（record 已关、告知由 list 的 closedReason
        // 表达）——迟到的完成回注不注入（可能已切换的）新 session。
        // [H1 U2] Continuation 轮跳过——通知归属 Continuation 双闸（成功 gate→route /
        // 失败独立载荷过门），本段回注即双 route。
        if (continuation === undefined && notifyGateAllowsDelivery(record.closedReason)) {
          this.collectCoordinator.route(record);
        }
      } catch (err) {
        // 轮次 run 失败（prepare 期 reject / 引擎进程死亡 / cancel 后未收敛合成终态）：
        // chatMode MF-6——不销毁对话，回退可恢复（session 文件在盘，续聊 run 接续）；
        // 非 chatMode 终态销毁（finalizeFailed）。cancel 抢先时 record 已终态化
        //（Continuation 内终态守卫 / tryTransition 失败跳过），此处仅吞错。
        if (record.chatMode && continuation !== undefined) {
          continuation.onRejected(err);
        } else {
          await this.finalizeFailed(record, err);
        }
        if (err instanceof Error) {
          logger.debug(`[subagent] chat round run error (record=${record.id}): ${err.message}`);
        }
      } finally {
        this.pool.release();
        // streaming widget 清除（轮终，幂等——续轮 delta 落已 dispose 的 stream 为 no-op）。
        stream?.dispose();
        // [W4] 轮收口重评估（死亡纳管 record 的轮终 → 驱动可能又死 → 重新三态判定）。
        this.roundSupervisor.noteRunEnded(record.id);
      }
    })();
  }

  /**
   * [A1 / G3 回归修复] one-shot（非 chatMode）pi background 轮的 settled-watchdog fire
   * 处置（语义对齐 987346fc5 的 onHotPathSettledWatchdogTimeout 非 chatMode 分支——
   * H1 重构误删 arm 点的整链恢复，one-shot 行为零变化）。
   *
   * 与 Continuation 轮（onWatchdogFire → run 收敛后失败分支统一收口）不同：one-shot
   * 轮在本回调内直接收口——kill 子进程 + abort 轮 signal（旧 terminateChatSession
   * cancel 的 H1 后等价杀链）→ CAS（tryTransition closed+gc，防与 cancel/dispose 双
   * 收尾，抢锁失败即跳过）→ finalizeRecord 终态化 → 失败通知。
   *
   * 失败通知按 H1 后失败单发机制接线（Continuation settleRoundFailed 同构）：独立构造
   * BgNotifyRecord 载荷过 notifyGate 门 → notifyHost.notify，不经 route(record)——
   * 失败正文直接取本回调的失败文案，不以 record.result 旧正文冒充（可达性
   * [T2-③/LC-1]：失败原因 + 恢复指引必须可达宿主）。
   *
   * 回调在 timer 触发的同步上下文执行：同步段只做 kill + abort + CAS（不抛），异步
   * 收尾 fire-and-forget 且 catch 归 bestEffort——错误逃出回调 = uncaughtException 崩宿主。
   */
  private onOneShotSettledWatchdogTimeout(record: ExecutionRecord, fire: SettledWatchdogFireInfo): void {
    const windowDesc =
      fire.phase === "mid-round"
        ? `no valid protocol event for ${fire.waitedMs / MS_PER_SECOND / SECONDS_PER_MINUTE} min after prompt (mid-round no-progress)`
        : `no agent_settled within ${fire.waitedMs / MS_PER_SECOND}s after agent_end (settled phase)`;
    logger.warn(
      `[subagents] settled watchdog (${fire.phase}) fired for ${record.id}: ${windowDesc}, ` +
        `terminating (LC-1 wedge recovery)`,
    );
    killRecordChildWithEscalation(record.id, "settled watchdog (one-shot)");
    // abort 轮 signal（ctx.signal 接 record controller——引擎侧杀链驱动）；在途 run 收敛
    // 后走 kickOffChatRound 既有吞错面（CAS 已终态化，其 finalizeFailed 抢锁失败 no-op）。
    record.controller?.abort();
    // fire = 本轮等待窗口终结（timer 回调已自删 entry，此处幂等清防御收尾段残留）。
    disarmRoundFromProtocol(record.id);
    if (!tryTransition(record, "closed", "gc")) {
      return; // 已被 cancel/dispose 抢先终态化——不重复收尾（watchdog disarm 由对方承接）
    }
    const failedResult: AgentResult = {
      text: "",
      turns: record.turnCount,
      durationMs: Date.now() - record.startedAt,
      success: false,
      error:
        `subagent did not reach agent_settled (${windowDesc}; settled watchdog); ` +
        `the process was terminated to bound the wait. ` +
        `Recovery: check state with subagents action:'list', then re-send your message to continue.`,
      sessionId: record.id,
      toolCalls: [],
    };
    void this.finalizeRecord(record, failedResult, "closed", "gc")
      .then(() => {
        // 失败通知（独立载荷过 notifyGate 门——门拦 cancelled/编排性关闭竞态窗）。
        if (!notifyGateAllowsDelivery(record.closedReason)) return;
        // 载荷形态对齐 Continuation settleRoundFailed（closed+failed 文案载体）；
        // sessionFile 不透传（G4：one-shot 通知逐字节——指针行仅 chatMode 语义）。
        this.notifyHost.notify({
          id: record.id,
          status: "closed",
          closedReason: "gc",
          outcome: "failed",
          agent: record.agent,
          ...(record.model !== undefined ? { model: record.model } : {}),
          error: failedResult.error,
          startedAt: record.startedAt,
          endedAt: record.endedAt ?? Date.now(),
        });
      })
      .catch((err: unknown) => bestEffort(err, "settled watchdog one-shot finalize", "error"));
  }

  // [H1 U6] chat 域相位机整族已随旧协议轮次相位通道退役删除（语义迁移归属）：
  //   - handleChatRoundPhase（settled/idle/failed/active 相位分诊）
  //     → settle 交棒 = run 应答驱动（Continuation onRunSettled 内
  //     noteRoundSettledFromProtocol，先于轮终簿记）；armMidRoundNoProgress 挂载 =
  //     kickOffChatRound 轮开跑 arm；中段刷新 = run 事件通道 9 种既有事件。
  //   - armChatIdleTimer（idle 相位帧 → idle timer 挂载）→ 随长驻消亡退役
  //    （每轮 = 新 run，轮末进程随 agent_settled 回收，「5min idle 关闭」无对象——
  //     设计 §2.2#5；30 天 idle-gc 只归档不终态化不变）。
  //   - backfillChatAnchor（idle 帧锚点回填）→ sessionFile 回填改由 run 应答
  //     outcome.sessionFile 承载（+ writeBindingForRecord 落盘，UF-1）。
  //   - onChatRoundFailed（failed 相位分诊）→ Continuation.onRunSettled 失败分支
  //     统一收口（doFinalizeRoundToIdle outcome=failed + 失败通知，D7）。
  //   - settleChatRoundFromResponse（首轮成功 settle 载体）→ 语义按 D7 迁移清单并入
  //     Continuation.settleRoundSuccess（round+1 / result=content / 门→route；
  //     closeAfterRound 消费 chat 域退役、base 推进退役不迁移）。
  //   - terminateChatSession / chatHandleFor（interact cancel/close 终止意图）→
  //     随 interact 面退役：真实杀链 = 轮级 abort signal → 协议 cancel 帧（引擎侧
  //     杀链）+ 镜像置死记账（killRecordChildWithEscalation）+ 引擎退出链收割
  //     （engine-client teardownProcess，红线①）。

  /** [W3] pi 引擎 port 解析（chat 域路由与终止面共用）：registry cli 形态 port，
   *  未注册 = 不可用 stub（engine_not_found，见 pi-host-binding）。 */
  private resolveChatEnginePort(): EnginePort {
    return resolveHostPiEnginePort(() => null);
  }

  /**
   * Continuation 实例解析（ensure 语义）。跨重启 revive（cold-resurrect）会重建新
   * record 对象并 register——缓存实例的 record 绑定不一致时重建（Continuation 的
   * 状态写必须落 store 在册对象）。
   */
  private continuationFor(record: ExecutionRecord): ConversationContinuation {
    const existing = this.continuations.get(record.id);
    if (existing !== undefined && existing.boundRecord === record) return existing;
    const created = new ConversationContinuation(record, {
      dispatchChatRound: (rec, input) => this.dispatchChatRoundForContinuation(rec, input),
      finalizeRoundOutcome: (rec, outcome) => this.finalizeRoundToIdle(rec, outcome),
      routeRecord: (rec) => this.collectCoordinator.route(rec),
      notifyRecord: (n) => this.notifyHost.notify(n),
      killStaleChild: (id) => this.killStaleChildBeforeDispatch(id),
      killRoundChild: (id, source) => this.killRoundChildForWatchdog(id, source),
      upgradeGateAllows: (rec) => this.canUpgradeToConversation(rec),
      reviveClosedRecord: (rec) => {
        // D4 revive 宿主面：register（跨重启重建后不在内存的形态）+ 迁移上报
        //（W16 类外状态写点同构——entry 落盘，live/reload 视图同步）。
        this.store.register(rec);
        this.store.reportRecordTransition(rec);
      },
      reportRecordTransition: (rec) => this.store.reportRecordTransition(rec),
      closeNow: (rec) => this.closeChatIdle(rec),
    });
    this.continuations.set(record.id, created);
    return created;
  }

  /**
   * 泛化派发主干的 Continuation 轮入口（§3.4 ②载荷组装——归自 resumeColdRound
   * 现有实现）：model 身份重建（splitEngineModelRef，防多轮模型漂移探针 P-10）、
   * ExecuteOptions 组装（worktree 句柄 / conversation:true）、detached 交棒
   * kickOffChatRound（priority = background，轮次在 background 跑）。
   */
  private dispatchChatRoundForContinuation(record: ExecutionRecord, input: ContinuationDispatchInput): void {
    const model = splitEngineModelRef(record.model);
    const identity: ResolvedIdentity = {
      agent: record.agent,
      agentConfig: undefined,
      resolved: {
        model: { id: model.id, name: model.name, provider: model.provider, reasoning: false },
        thinkingLevel: record.thinkingLevel,
      },
    };
    const opts: ExecuteOptions = {
      task: input.task,
      slug: record.slug,
      worktree: record.worktreeHandle,
      conversation: true,
    };
    this.kickOffChatRound(record, opts, identity, input.signal, PRIORITY_BACKGROUND, input.resume, {
      onSettled: input.handlers.onSettled,
      onRejected: input.handlers.onRejected,
      onAbandoned: input.handlers.onAbandoned,
      onWatchdogFire: input.handlers.onWatchdogFire,
    });
  }

  /**
   * [红线②派发前兜底] stale-child：镜像在途子进程活着（引擎存活期的状态错配——
   * Continuation 无在途 run 但镜像有活项）→ 镜像置死记账 + 协议 cancel（引擎侧杀链）
   * + 有界退出窗（STALE_CHILD_EXIT_WAIT_MS，pi trap flush 量级）。引擎已死场景的
   * 孤儿由引擎退出链收割兜底（红线①——engine-client teardownProcess，镜像此刻已
   * 整体置死，本兜底查不到，两通道正交）。
   */
  private async killStaleChildBeforeDispatch(recordId: string): Promise<void> {
    if (!hasLiveProcessHandle(recordId)) return;
    killRecordChildWithEscalation(recordId, "stale-child guard (dispatch)");
    await delay(STALE_CHILD_EXIT_WAIT_MS);
  }

  /** watchdog fire 的 kill 手段（kill + 协议 cancel）——run 收敛由杀链驱动，
   *  轮末收口统一回流 Continuation onRunSettled/onRoundRejected（单写者单路）。 */
  private killRoundChildForWatchdog(recordId: string, source: string): void {
    killRecordChildWithEscalation(recordId, source);
  }

  /**
   * [D5 双写点 gate 判据] SP-5 升级（one-shot → chatMode）的 conversation 位检查：
   * record 所属引擎（engine 留痕 ?? 默认引擎）capabilities.conversation 非
   * 'unsupported' 才放行。引擎未注册 = 无法验证续聊能力，fail-closed 拒绝。
   * 消费双写点：①进程内热升级（subagent-actions-core messageHandler）②跨重启冷升级
   *（Continuation D4 revive 格）——zcode 等 unsupported 引擎的 one-shot 收到 message
   * 不升级（含 parent-shutdown 可重连终态经 message 的升级旁路面）。
   */
  canUpgradeToConversation(record: Pick<ExecutionRecord, "engine">): boolean {
    try {
      const engine = getEngine(record.engine ?? DEFAULT_ENGINE_ID);
      return engine.capabilities().conversation !== "unsupported";
    } catch {
      return false;
    }
  }

  /**
   * record 终态化路径的宿主侧收口汇聚点（[H1 U2] Continuation 实例清理——终态后
   * 容器不再接收 message，实例滞留即泄漏；[H1 U6] 路由注销面已随 interact 面退役）。
   */
  private onRecordFinalizedCleanup(recordId: string): void {
    this.continuations.delete(recordId);
  }

  /** 引擎服务面适配器（HostBridgeServiceFace 结构视图）：闭包持有本实例的编排面。
   *  [W3] chat 域轮次交接可选面（takeChatRound/runChatRound/resumeChatRound）随
   *  inproc PiEngine 删除移除——引擎经协议 converse，不再回调宿主编排面。 */
  private piEngineServiceAdapter(): HostBridgeServiceFace {
    return {
      executeAndAwait: (opts, signal, onEvent, stream) => this.executeAndAwait(opts, signal, onEvent, stream),
      getRecordForAction: (id) => this.getRecordForAction(id),
      closeSubagent: (record, force) => this.closeSubagent(record, force),
      cancel: (id) => this.cancel(id),
      collectRecords: (limit, statusFilter) => this.collectRecords(limit, statusFilter),
      reportRecordTransition: (record) => this.store.reportRecordTransition(record),
    };
  }

  /** [D4 聚合连带] 引擎服务面的显式结构视图（SAR 构造 resolveHostPiEnginePort 时
   *  传入的 getService 兼容位消费——W3 后该面无引擎侧消费方，保留使 SAR 调用点
   *  零改动，W8 收口时随签名一并清理）。getter 形态：face 视图（惰性构造）。 */
  get asEngineService(): HostBridgeServiceFace {
    return this.piEngineServiceAdapter();
  }

  /**
   * 对话模式轮次完成收尾：委托 doFinalizeRoundToIdle（record 进 idle，保留内存 + worktree）。
   * 与 finalizeRecord 对称的委托方法，deps 同源注入。[H1 U2 / D7] 入参改轮终 outcome
   * 判别联合（成功 = content / 失败 = reason——result 写入规则归 finalize-record 单点）。
   * Continuation 轮末分流（success/failed 两分支）与 one-shot SP-5 共享调用点（恒
   * success）消费；chatMode 失败回退三旧调用点（watchdog/spawnFailure/roundFailed）
   * 已 outcome 化适配（新编排不可达，删除归 U6）。
   */
  private async finalizeRoundToIdle(
    record: ExecutionRecord,
    outcome: RoundSettlementOutcome,
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
      outcome,
    );
  }

  // ── 域 #15 pool/worktree 资源（R4 RunOrchestration）（R0 重排）──

  /**
   * 分层并发配额：depth 越深可用配额越少（下限 1）。fork 深度护栏在池维度的投影，
   * 公式约定以 concurrency-pool.ts 注释为登记处、此处为唯一代码锚点。
   */
  private effectiveMaxConcurrentFor(record: ExecutionRecord): number {
    return Math.max(1, this.pool.maxConcurrent - record.depth);
  }

  /** [U04 提取·装配] 池槽获取：pooled（background）record 排队 acquire。成功返回 undefined
   *  继续执行；失败返回终态 result 供调用方 early-return（该路径在 try/finally 之前，
   *  不触发轮次资源回收——与原控制流逐字节一致）。 */
  private async acquirePoolOrFinalize(
    record: ExecutionRecord,
    signal: AbortSignal | undefined,
    priority: number,
  ): Promise<AgentResult | undefined> {
    try {
      await this.pool.acquire(priority, this.effectiveMaxConcurrentFor(record), signal);
    } catch {
      // S1: 排队中被 abort（signal.aborted）走 cancelled，与已运行被 abort 一致。
      if (signal?.aborted) return this.finalizeAborted(record);
      return this.finalizeFailed(record, new Error("aborted"));
    }
    return undefined;
  }

  /** [U04 提取·装配] 解析 worktree 参数：boolean → WorktreeHandle | undefined（true/undefined 由 run 内部处理）。 */
  private resolveWorktreeHandle(opts: ExecuteOptions): WorktreeHandle | undefined {
    return typeof opts.worktree === "object" ? opts.worktree : undefined;
  }

  /** [U04 提取·回收] 轮次资源回收（finally 语义，幂等）：池槽归还（仅 pooled 且 acquire
   *  成功）、streaming widget 清除。 */
  private releaseRoundResources(
    _record: ExecutionRecord,
    holdSlot: boolean,
    stream: SubagentStream | undefined,
  ): void {
    if (holdSlot) this.pool.release();
    // 清除 streaming widget（subagent 终态，幂等）
    stream?.dispose();
  }

  // ── 壳生命周期编排与断言（dispose 时序留壳 = R3 检查点③；D4 断言面）（R0 重排）──

  private _disposed = false;
  // [B-7 已清] _seq 死字段（全文件零消费）按 r0-inventory 清单①登记于 R1 删除。

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
    // [v2 D4] settled 重扫 handler 惰化：dispose 后 trailing settled 边沿若仍触发，
    // 旧 handler 不得再跑扫描——notifier 随后将 dispose，notifyBatch 短路返回 false
    // 且不写账，而 E1 dispatched 段不判 accepted 仍统一落标 → 批被标 batchFinalized
    // 而通知从未写账（永久丢失，不可逆）。惰化后通知由下次重启的 E1 首扫兑现
    // （成员无标记，候选可达）。与 initSession revive 重置不冲突：dispose 是终态置
    // disposed，revive 置 null 是新 session 的重新注册，旧 state 对象随旧 handler
    // 闭包保持 disposed 永久惰化。
    if (this.settledRescanState !== null) this.settledRescanState.disposed = true;
    // [dispose stub] 第一时间换 stub，防 trailing ui_request 调到 stale handler 闭包
    // （仍持有 disposed session 的 ctx）产生误导性 console.error。stub 干净降级为 cancelled。
    // 必须在 emit/abort 之前——这些步骤可能同步触发 trailing pump。
    // [D4-④] 原 setUiRequestHandler 方法已删（initSession 参数为唯一注入入口）。
    // [R1/C-3] 原直写聚合字段两行（handler 换 stub + 缺失告警去重重置）收敛为显式接口
    // 方法 disposeSessionUi()——字段所有权在聚合（时序契约注释随迁）。
    this.baselines.disposeSessionUi();
    // [W6 R3 MF-A] dispose 后壳侧应答端同步换 stub（trailing host/askUser 干净降级为
    // cancelled，与 inproc inproc UI 请求队列（已删） 的 trailing 语义同构）。
    setHostUiRequestEndpoint(disposedUiRequestStub);
    // [R0/C1 孤儿进程修复] 先 abort running controllers + kill spawned children，再 dispose 资源。
    // abortRunningControllers 需要在 disposeAllRecords archive 之前执行（archive 后 store 找不到 record）。
    this.store.abortRunningControllers();
    killAllSpawnedChildren();
    // [H1 U2/U6] Continuation 实例全量清理（路由注销面已随 interact 面退役）——
    // dispose 后容器不应再收 message。
    this.continuations.clear();
    // [E9] 批未闭合时缓冲终态成员逐条转 async 写账 + 落 batchFinalized（设计 §3.1.5 E9）。
    // 必须在 disposeAllRecords 之前——它会把活跃 record（含 SP-5 成功回退的
    // running+resumable 缓冲成员）全部 archive 清内存，之后再 getFullRecord 落标只剩
    // 冷 idToFile（无目录扫描则 miss → 跳过落标 → E1 重建误收已转换成员）；先转换取
    // 内存命中，与 flushBatch 出口①同款通路。同样在 flushPendingNotifications 之前
    //（转换条目加入本次 flush）与 notifier/store dispose 之前（写账与 appendEntry
    // 通道仍可用）。仍在跑成员不在此处理——后续 disposeAllRecords 按现有退出路径关闭。
    this.convertPendingSyncBufferToAsync();
    // SP-4: 级联关闭所有活跃 record（parent-shutdown reason）
    // 在 abort/kill 之后执行：先终止子进程，再清理 record 状态。
    this.disposeAllRecords("parent-shutdown");
    // [review MF1] 在途 resume 守卫清空（正常由轮次收尾 finally 清除；此处兜底
    // abort/kill 后仍挂着的条目，防跨 session 复活时残留）
    // flush 待发通知（session_shutdown 尽力投递一次）。
    this.notifyHost.flushPendingNotifications();
    // [T4④ / PS-5] flush 被 isIdle 门拦时的丢失面闭合：attemptDeliver 的 isIdle 二次
    // 复查失败时 pending 挂在 ledger 内存态，随后 dispose 销毁——旧注释「flush 后 dispose
    //（防丢失）」的承诺与行为不符。现把未投递 pending 经 ledger entry 通道复写落盘
    // （notifyId 幂等，重复 entry 由恢复扫描后写覆盖吸收），重启 recoverFromSession 按
    // 账面差集重放补投——「不丢」由落盘账本承接而非本次 flush。
    this.persistUndeliveredNotificationsForReplay();
    this.notifyHost.dispose();
    // [W4] 监督器停机（清 timer + 纳管记账；注册/record 不动——process 档跨 shutdown
    // 存活，重开 session 由 boot 分区重认领 + sweep 对账收口）。
    this.roundSupervisor.dispose();
    this.store.dispose();
  }

  /**
   * [T4④ / PS-5] shutdown flush 被门拦时把未投递 pending 复写落盘（供重启 replay）。
   *
   * 触发条件：flushPendingNotifications 后 ledger 仍有 pending（isIdle 门拦 / sendDelivery
   * 受理失败的残留）且主 agent 非 idle——即本次 shutdown 注定投不出去。落盘动作 =
   * pi.appendEntry 重写 NOTIFY_LEDGER_CUSTOM_TYPE entry（与 ledger.record 同通道同 schema，
   * notifyId 幂等：恢复扫描按后写覆盖 + ack/abandoned 差集去重，重复账面不产生重复投递）。
   * 主 agent idle 时 flush 已投出，无需复写（零开销）。
   */
  private persistUndeliveredNotificationsForReplay(): void {
    try {
      const ledger = getBoundNotifyLedger();
      const pending = ledger?.pendingEntries() ?? [];
      if (pending.length === 0) return;
      if (this.isIdleFn?.() !== false) return; // idle：flush 已投出（或无 gate 场景照旧）
      for (const item of pending) {
        this.pi?.appendEntry(NOTIFY_LEDGER_CUSTOM_TYPE, {
          v: 1,
          notifyId: item.notifyId,
          content: item.content,
          record: item.record,
        });
      }
      logger.warn(
        `[subagents] shutdown flush blocked by busy main agent: ${pending.length} pending notification(s) persisted to ledger for replay on next session_start`,
        { count: pending.length },
      );
    } catch (err) {
      // 落盘复写是防丢失增强，失败不阻断 dispose（账本原 entry 仍随 pi flush 落盘）。
      bestEffort(err, "persistUndeliveredNotificationsForReplay", "error");
    }
  }

  /**
   * [T4② / PS-4] idleTimeoutMs 合法域入口校验（>2^31-1 / 非有限值 fail-fast）。
   *
   * 旧链路：非法值穿透到 agent_settled 回调里的 armIdleTimer → assertSafeTimerDelay
   * throw 被异步 catch 降级——配置错误被吞成静默语义变更（每轮完成通知被 isIdle 放行门
   * 吞 + 进程无回收 timer）。对齐 shared/timer-delay「不静默 clamp」既有裁决：配置错误
   * 显式暴露，错误消息含合法范围（0/负数 = 显式禁用是合法语义，不在本校验域；env 非法值
   * 由 lifecycle-manager 的 warn 回落承接）。execute/executeAndAwait 两入口共用。
   */
  private assertIdleTimeoutMsSafe(opts: ExecuteOptions): void {
    const v = opts.idleTimeoutMs;
    if (v === undefined) return;
    if (!Number.isFinite(v)) {
      throw new Error(
        `subagent idleTimeoutMs = ${v} is not a finite number (NaN/±Infinity). ` +
          `Valid range: a positive millisecond number up to ${MAX_TIMER_DELAY_MS} (2^31-1, Node setTimeout limit), or 0/negative to disable idle GC. ` +
          "Recovery: fix the idleTimeoutMs value and retry.",
      );
    }
    if (v > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `subagent idleTimeoutMs = ${v} exceeds the Node setTimeout limit ` +
          `(${MAX_TIMER_DELAY_MS} ms = 2^31-1); larger delays silently collapse to 1ms and would kill the subagent immediately. ` +
          `Recovery: pass idleTimeoutMs <= ${MAX_TIMER_DELAY_MS}, or omit it for the default (${DEFAULT_IDLE_TIMEOUT_MS}ms), or use 0/negative to disable idle GC.`,
      );
    }
  }
}

// ── [H2 W2] workflow 域派发 helper（executeWorkflowAgent 专用，M3 语义逐项复刻）──

/**
 * [H2 W2 迁移步⑤] workflow 派发路径 no-progress 守护句柄：signal 供 mergeRunSignals
 * 合流（步⑥），fired 供 run 收敛后判定是否追注恢复指引（fire 是异步 timer 事件）。
 * 与 chat 域 armMidRoundNoProgress 同一原语（settled-watchdog）同一量级（30min
 * 连续静默 = 回收层有界兜底，非任务级墙钟）；差异仅 arm 键 = record.id（D4 守护
 * 单点——真实 record 在 store，原 SAR 模块内守护函数随 [H2 W4] 掏空退役）。
 */
interface WorkflowNoProgressGuard {
  signal: AbortSignal;
  fired(): boolean;
}

/**
 * arm workflow 派发路径 no-progress 守护（复用 settled-watchdog 原语，不新造第二套
 * 计时器）。fire 回调契约：timer 同步上下文内只做 warn + AbortController.abort()
 * （abort 幂等不抛）；真正终止由 abort 经 mergedSignal → RemoteEngine
 * wireAbortSignal 阶梯（cancel 帧 → 收敛窗 → killAll）承载。onSettleTimeout 与
 * onMidTimeout 同体（workflow 域无 agent_end 交棒点，同体保证未来接交棒语义不变）。
 */
function armWorkflowNoProgressWatchdog(recordId: string): WorkflowNoProgressGuard {
  const controller = new AbortController();
  let fired = false;
  const fire = (info: SettledWatchdogFireInfo): void => {
    fired = true;
    // 恢复指引闭环（错误 → 权威源 → 重试）：killAll 组杀连带面在此显式出声——
    // 引擎对 cancel 帧 >收敛窗无响应时组杀引擎 CLI，同引擎其余并发 run 会以
    // engine_crashed 失败终态化（失败结果照回脚本、executeAgentCall 重试通道仍在）。
    logger.warn(
      `[subagents] workflow no-progress watchdog (${info.phase}) fired for ${recordId}: ` +
        `no valid protocol event for ${info.waitedMs / MS_PER_SECOND / SECONDS_PER_MINUTE} min after run dispatched — ` +
        `aborting run (cancel frame → settle grace window → killAll if the engine does not settle). ` +
        `Note: a killAll group-kills the engine CLI process, so other concurrent runs on the same ` +
        `engine may end as engine_crashed (they still get a failure result and retry). ` +
        `Recovery: check state with subagents action:'list' includeFinished:true (add includeWorkflow:true to also see workflow-dispatched subagents), then re-dispatch the workflow.`,
    );
    controller.abort();
  };
  armMidRoundNoProgress(recordId, { onMidTimeout: fire, onSettleTimeout: fire });
  return { signal: controller.signal, fired: () => fired };
}

/**
 * streamDelta 刷新接线（守护双刷新源之二）：在**原实例**上包裹 onDelta（先刷新再
 * 委托原实现），返回 unbind 函数由 finally 调用恢复。保持对象 identity（不建代理）
 * ——下游 stream 透传契约要求同一实例，而 host/streamDelta 反向帧只经
 * `ctx.stream.onDelta` 到达，原地包裹是唯一既保 identity 又能观测 delta 的接法。
 */
function bindWorkflowStreamRefresh(stream: SubagentStream, recordId: string): () => void {
  const originalOnDelta = stream.onDelta;
  const hadOwnOnDelta = Object.prototype.hasOwnProperty.call(stream, "onDelta");
  stream.onDelta = (delta: string): void => {
    refreshFromProtocolEvent(recordId);
    originalOnDelta.call(stream, delta);
  };
  return () => {
    if (hadOwnOnDelta) stream.onDelta = originalOnDelta;
    else Reflect.deleteProperty(stream, "onDelta");
  };
}

/**
 * fire 判定 + 追注的单一出口（正常收敛与 catch 两路共用同一判定，消除「两路文案
 * 分叉」）。只对已带 error 的结果追注——成功收敛或被外部 cancel 的形态保持原样，
 * 不伪造失败（M3 U-B2 语义复刻）。
 */
function noteIfWorkflowNoProgressFired(
  result: WorkflowAgentResult,
  guard: WorkflowNoProgressGuard | undefined,
): WorkflowAgentResult {
  return guard?.fired() === true && result.error !== undefined
    ? {
      ...result,
      error:
        `${result.error} | workflow no-progress watchdog fired: the run was aborted after a long ` +
        `silence window with no protocol event or stream delta. ` +
        `Recovery: check state with subagents action:'list' includeFinished:true (add includeWorkflow:true to also see workflow-dispatched subagents), then re-dispatch the workflow.`,
    }
    : result;
}

/**
 * AgentOutcome → workflow AgentResult 直映射（SAR outcomeToRunnerResult 的 service
 * 侧等价物）：保留 usage/sessionFile/worktreePath/failureKind 等引擎层字段——
 * outcomeToAgentResult（execution AgentResult）不含这些字段，经它中转会丢 workflow
 * 消费面（usage 进预算、sessionFile/worktreePath 进 returnMeta、failureKind 进
 * 失败分诊）依赖的字段。
 */
function outcomeToWorkflowResult(outcome: AgentOutcome): WorkflowAgentResult {
  return {
    content: outcome.content,
    ...(outcome.failureKind !== undefined ? { failureKind: outcome.failureKind } : {}),
    parsedOutput: outcome.parsedOutput,
    usage: outcome.usage,
    durationMs: outcome.durationMs,
    error: outcome.error,
    sessionId: outcome.sessionId,
    sessionFile: outcome.sessionFile,
    worktreePath: outcome.worktreePath,
    toolCalls: outcome.toolCalls,
  };
}

/**
 * AgentCallOpts → ExecuteOptions 的最小正向映射（record 创建 + identity 解析消费面；
 * host-task-spec.executeOptionsToEngineTaskSpec 的逆映射）。slug 推导 = 唯一规则
 * （description ?? agent ?? "unknown"，超长按 SLUG_MAX_LENGTH 截断；原 pump
 * dispatchAgentCall trace 命名同源规则随 [H2 W3] 删除）。returnMeta/scene 等
 * worker 层/引擎层独有字段不入 record
 * 消费面（taskSpec 装配走 opts 原样直传，不经本映射）。
 */
function workflowCallToExecuteOptions(opts: AgentCallOpts): ExecuteOptions {
  const agentName = opts.description ?? opts.agent ?? "unknown";
  const slug = agentName.length > SLUG_MAX_LENGTH ? agentName.slice(0, SLUG_MAX_LENGTH) : agentName;
  return {
    task: opts.prompt,
    slug,
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.thinkingLevel !== undefined ? { thinkingLevel: opts.thinkingLevel } : {}),
    ...(opts.skillPath !== undefined ? { skillPath: opts.skillPath } : {}),
    ...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
    ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
    ...(opts.schemaEnv !== undefined ? { schemaEnv: opts.schemaEnv } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.graceTurns !== undefined ? { graceTurns: opts.graceTurns } : {}),
    ...(opts.fork !== undefined ? { fork: opts.fork } : {}),
    ...(opts.forkSource !== undefined ? { forkFromSessionFile: opts.forkSource } : {}),
    ...(opts.worktree !== undefined ? { worktree: opts.worktree } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.conversation !== undefined ? { conversation: opts.conversation } : {}),
    ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
  };
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

/**
 * [U10① D6] 第三宿主最小构造入口：仅凭参数注入构造 SubagentService（无全局查找）。
 *
 * 构造依赖（modelService / getMainSessionFile / uiRequestHandler）全部经 init
 * 参数注入；本工厂是 `new SubagentService(init)` 的薄包装，不读也不写
 * getSubagentService/setSubagentService 的全局槽位——session_start 单例流程
 * 行为零改动，宿主自持实例时用本工厂。构造内部行为与直接 new 逐字等价。
 *
 * @experimental execution 运行时面（设计 docs/design/subagent-core-sink-design.md §3.3 D6）：
 * 一个 minor 周期内允许签名微调，稳定后转常规 semver 承诺。
 */
export function createSubagentService(init: SubagentServiceInit): SubagentService {
  return new SubagentService(init);
}
