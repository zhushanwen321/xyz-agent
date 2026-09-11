// 执行编排 + 记录领域 Service（D4 按变化轴拆分后的编排核：execute/executeAndAwait 入口、
// record 生命周期、cancel）。通知簇 → notify-host.ts；轮次结算闭包内联于
// settleChatRoundFromResponse（原 round-settlement.ts 已随 W3 inproc 删除收敛于此）；冷路径复活 → cold-resurrect.ts。
// 上游：subagent-tool（execute/query/cancel）、TUI（onChange/collectRecords）。
// session_start 时经 initSession 注入 pi；modelRegistry/entries 归 ModelConfigService.initModel。

import { AsyncLocalStorage } from "node:async_hooks";

import { getLogger } from "../core/logger.ts";

import type { ExtensionMode } from "./host-mode.ts";

import type { AgentResult as WorkflowAgentResult } from "../orchestration/models/types.ts";
import { MAX_TIMER_DELAY_MS } from "../shared/timer-delay.ts";
// D-A10: workflow 侧 AgentResult 映射（executeAndAwait 出口）
import { mapToWorkflowAgentResult } from "./agent-result-mapper.ts";
import { removeAliveMarker } from "./alive-store.ts";
import { bestEffort } from "./best-effort.ts";
import { CollectCoordinator } from "./collect-coordinator.ts";
import { DEFAULT_COLLECT_SYNC } from "./config.ts";
// [V2 决策 3] lifecycle-manager idle timer：chatMode 统一投递新 turn disarm（防误杀活进程）；
// idle 相位帧（协议 host/roundLifecycle）= arm 锚点（W3 v1.x——引擎不实现 idle 定时器）。
// [T4②] DEFAULT_IDLE_TIMEOUT_MS：assertIdleTimeoutMsSafe 错误文案的缺省时长基准。
// （[M3] hasIdleTimer / hasLiveProcessHandle 的 piAdapter.hasRunningBackground 过滤随通知簇
// 在 notify-host.ts 消费，不经本文件。）
import { armIdleTimer, disarmIdleTimer, DEFAULT_IDLE_TIMEOUT_MS } from "./lifecycle-manager.ts";
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
import { doFinalizeRecord, doFinalizeRoundToIdle, type RoundSettlementOutcome } from "./finalize-record.ts";
// [H1 U2] chat 域统一进 run 域：ConversationContinuation（§3.4 全规格）——每 chatMode
// record 一个实例，message/close 编排与轮末分流（D7）的唯一承接组件。
import {
  ConversationContinuation,
  type ContinuationDispatchInput,
  type ContinuationRoundHandlers,
} from "./conversation-continuation.ts";
import { assertTaskShapeSupported } from "./engine/common/capability-gate.ts";
import { ExecutionNestingContext } from "./engine/common/nesting-guard.ts";
import { JOURNAL_INITIAL_POOL_KEY, wireEventJournal } from "./engine/common/journal-wiring.ts";
import { executeOptionsToEngineTaskSpec } from "./engine/host-task-spec.ts";
import type { AgentCallOpts } from "../orchestration/models/types.ts";
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
import type { AgentOutcome, EngineHandle } from "./engine/types.ts";
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
// [u-t2a T2②/T2③ + W4 协议事件面] settled watchdog：chatMode 轮 settled 等待两段守护。
// W3 起事件接线 = 协议事件流（arm 点 = 轮开始；refresh 源 = streamDelta/轮次生命周期
// 帧；W4 三入口与旧原语逐一同构，见 settled-watchdog.ts 尾段）。
import {
  armMidRoundNoProgress,
  disarmRoundFromProtocol,
  disarmSettledWatchdog,
  noteRoundSettledFromProtocol,
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
import type { HostRoundLifecycleParams, ProtocolError, ResumeAnchor } from "@zhushanwen/subagent-engine-sdk";
import type { StreamSink, SubagentStream } from "./stream-sink.ts";
import { createBackgroundStream } from "./stream-sink.ts";
import { writeCancelledState, writeRecordBinding } from "./state-marker.ts";
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
import { toErrorMessage } from "../core/error-message.ts";

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
 * inproc UI 请求队列（已删） 的 catch 分支打 `[subagents] uiRequestHandler threw` 误导性
 * logger.error（看起来像 bug，实际是预期竞态；三层兜底已确保功能正确）。
 *
 * stub 始终返回 {cancelled:true}，不调 ctx.ui、不捕获任何 ctx，让 trailing ui_request
 * 干净降级为 cancelled（等价于子进程主动取消）。
 *
 * 不置 undefined —— 那会让 trailing ui_request 走 inproc UI 请求队列（已删） 的 handler-missing
 * 分支触发 notifyMissingHandlerGlobal warn，噪声性质从 threw-error 变 missing-handler，
 * 没真正解决。 */
const disposedUiRequestStub: UiRequestHandler = () => Promise.resolve({ cancelled: true });

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
  /** L2 跨子进程全局 dialog 串行队列（进程单例）。子进程退出时经引擎镜像层
   *  （SpawnedChildrenMirror → notifyChildProcessExited）取消该 pid 的挂起请求（SR-4）。 */
  dialogQueue?: DialogGlobalQueue;
  /** [竞态修复] 主 agent 是否空闲查询（ctx.isIdle），透传给 notifier 的 flush isIdle gate。
   *  避免 background 完成通知在 agent_end→finishRun 窗口里走错 sendMessage 分支丢失。
   *  可选：未注入时 notifier flush 不 gate（原行为）。 */
  isIdle?: () => boolean;
}

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
  private readonly pool: ConcurrencyPool;
  private readonly store: RecordStore;
  private readonly modelService: ModelConfigService;
  private readonly cwd: string;
  private readonly worktreeManager: WorktreeManager;
  private readonly getMainSessionFile: (() => string | undefined) | undefined;
  /** UI 请求 handler（进程级，可被 setUiRequestHandler / initSession 覆盖）。 */
  private uiRequestHandler: SubagentServiceInit["uiRequestHandler"];
  /** L2 dialog 串行队列（进程级）。SR-4：子进程退出时经引擎镜像层
   *  （SpawnedChildrenMirror → notifyChildProcessExited）取消该子进程的挂起请求。 */
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
   * [F6] 当前根 session id 的只读访问——引擎接线方（SAR 等）构造 RunContext 注入
   * `ctx.sessionRootId`（pi 引擎 relay 归属键 SESSION_ID 权威源）。initSession 后有值
   * （根进程 = 本 session id；嵌套 = env 贯穿的真 ROOT）。
   */
  getSessionRootId(): string | null {
    return this.sessionRootId;
  }
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
   *  createNotifier(this.piAdapter()) 逐字节等价。session_start revive，shutdown dispose。
   *  [sync-collect 合并] toNotifyRecord/notify/notifyBatch 随批路由需要由 host 导出
   *  （collectCoordinator 闭包与 E9/E1 直发路径消费，见 notify-host.ts 接口注释）。 */
  private readonly notifyHost: NotifyHost = createNotifyHost({
    getPi: () => this.pi,
    listRunning: () => this.store.listRunning(),
    getIsIdle: () => this.isIdleFn,
  });

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
   *  前一个脱离 kill 记账成孤儿。本 Set 是当前唯一的结构化防双写者守卫（历史上的
   *  acquireActivateLock 串行锁接线点已随协议化重构消失，该机制已删除）。
   *  child 注册完成后投递走热路径，不经此守卫。 */
  private readonly resumesInFlight = new Set<string>();

  /**
   * [W3 chat 域收口] chat 轮次反向通道路由表（recordId 键）：首轮 run chat 注册、
   * interact 续聊轮复用——host/streamDelta（recordId 分支）与 host/roundLifecycle
   * （recordId 键）的分发目标（EngineClient.recordRoutes 经
   * EnginePort.registerChatRoundRoute 注册）。record 终态化路径注销（[F-5 修复]
   * 汇聚点 = doFinalizeRecord 的 onFinalized 钩子 + cancelBackground /
   * disposeAllRecords 两处直连终态化路径显式注销）。
   */
  private readonly chatRoundRoutes = new Map<string, () => void>();

  /**
   * [H1 U2] ConversationContinuation 实例表（recordId 键）：chatMode record 的续聊
   * 编排承载（§3.4）。创建点 = chatMode 首轮派发前 / message 到达（SP-5 升级后）；
   * 清理点 = record 终态化路径（onRecordFinalizedCleanup，与 chatRoundRoutes 注销
   * 同汇聚点）。cold-resurrect 跨重启重建会创建新 record 对象——continuationFor
   * 对缓存实例做绑定一致性检查，换新即重建。
   */
  private readonly continuations = new Map<string, ConversationContinuation>();

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
    this.uiRequestHandler = init.uiRequestHandler;
    // [W6 R3 MF-A] 壳侧应答端登记：cli 形态引擎经 host/askUser 反向请求消费（discovery
    // portFactory 构造 EngineClient 时读取该登记）。
    setHostUiRequestEndpoint(init.uiRequestHandler);
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
      // [W6 R3 MF-A] session 级覆盖同步进壳侧应答端登记（三态：null = 显式清空）。
      setHostUiRequestEndpoint(this.uiRequestHandler);
    }
    // SR-4：注入 L2 dialog 队列（child close 清理路径）。undefined 时 buildSessionRunnerContext
    // 透传 undefined，session-runner onClose 跳过 L2 清理（仅清 L1，保留旧行为）。
    if (init.dialogQueue !== undefined) {
      this.dialogQueue = init.dialogQueue;
    }
    this.initForkDepthBaseline();
    // [递归可见性] 跨进程身份贯穿（设计 recursive-subagent-visibility.md）。
    // 父进程 spawn 时注入 env 描述「子进程自己的身份」（rootSessionId / selfRecordId /
    // depth / rootCwd），语义与基线建立见 initExecContextBaseline。根进程无 env →
    // sessionRootId = init.sessionId（自己是 root），execCtxAls 不 enterWith（顶层）。
    const envRoot = process.env[ENV_ROOT_SESSION_ID];
    this.sessionRootId = envRoot ?? init.sessionId;
    this.initExecContextBaseline(envRoot, init.sessionId);
    // revive（dispose 的逆操作：/resume /fork /new 后复活）
    this._disposed = false;
    // [v2 D4] settled 重扫状态随 revive 重置：新 session 的 E1 若再判「仍有 running」
    // 可重新注册。旧 handler 闭包捕获旧 state：正常时序（session_shutdown →
    // session_start）下已随 dispose() 惰化；未经 dispose 的时序残留仍会在 settled
    // 边沿执行——其扫描 this.mainSessionFile 当前值（非注册时的旧文件），行为等价于
    // 新 session 多注册一次扫描，由账本 sync-batch:<hash> 幂等 + batchFinalized 候选
    // 过滤收敛，无跨 session 污染面。
    this.settledRescanState = null;
    this.store.revive();
    this.notifyHost.revive();
    // 孤儿终态恢复（放 initSession 末尾：setPi 已注入（appendEntry 可用）、
    // sessionRootId 已建立（过滤当前根的 record）；单扫描者判据见 recoverOrphansIfRootProcess）
    this.recoverOrphansIfRootProcess();
    // [W4] boot 分区 + 注册对账 sweep（须在孤儿恢复之后——依赖关系见两方法注释：
    // 孤儿恢复把「重启前在途」record 直断 closed、把 resumable 形态保留 running 落
    // entry，监督器重认领消费后者；sweep 再对终态 record 补发注销落盘——表 3 行 2
    // 「注销经对账 sweep 保证落盘」的编排点）。
    this.roundSupervisor.bootPartition();
    runPendingReconcileSweepForService(
      {
        getStore: () => this.store,
        getPi: () => this.pi,
        getSessionRootId: () => this.sessionRootId,
        getMainSessionFile: () => this.mainSessionFile,
        finalizeClosed: (record, result) => this.finalizeRecord(record, result, "closed", "gc"),
      },
      (process.env[ENV_SELF_RECORD_ID] ?? "") !== "",
    );
  }

  /**
   * [SPAWN fork depth 跨进程传递] fork 链深度基线：子进程被父 spawn 时，父通过 env
   * PI_SUBAGENT_FORK_DEPTH 传入当前 fork 链深度。子进程 session_start 时读取作为
   * forkDepthAls 基线，使后续嵌套 spawn fork 能从正确深度递增。未设置（顶层主
   * session）→ 基线 0。enterWith 贯穿整个 session 生命周期。
   */
  private initForkDepthBaseline(): void {
    const envDepth = process.env.PI_SUBAGENT_FORK_DEPTH;
    if (envDepth !== undefined && envDepth !== "") {
      const base = Number.parseInt(envDepth, 10);
      if (!Number.isNaN(base) && base > 0) {
        this.forkDepthAls.enterWith(base);
        this.forkDepthBaseline = base;
      }
    }
  }

  /**
   * [递归可见性] exec 上下文基线：子进程读 env PI_SUBAGENT_SELF_RECORD_ID / DEPTH
   * 建立身份基线后，createRecordForMode 读嵌套上下文自动正确（孙挂到子名下）。
   * enterWith 贯穿整个 session 生命周期（与 forkDepthAls 同构，决策 4）。
   */
  private initExecContextBaseline(envRoot: string | undefined, sessionId: string): void {
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
          `[subagents] execNesting initialized: recordId=${envSelfRecord} depth=${nestingDepth} rootSessionId=${envRoot ?? sessionId}`,
        );
      }
    }
  }

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
   *  E2E 实测缺口）——主 session 文件经 getMainSessionFile 注入（构造期可空）。 */
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

  /** session 结束清理（清定时器，丢弃 pending 通知）。幂等。
   *
   * [M-7] dispose 顺序假设：pending:unregister emit 依赖 pending-notifications 扩展的
   * listener 仍然存活。若 pending-notifications 先于本扩展执行 session_shutdown（后注册
   * 先执行的语义下会如此），listener 已注销，unregister 事件被静默丢弃。这是可接受的
   * 退化——进程退出后两侧状态本就不保证一致，下次 session_start 的 crash recovery 会修正。 */
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
    // [D4-④] 原 setUiRequestHandler 方法已删（initSession 参数为唯一注入入口），
    // 此处内联其方法体（赋值 + 缺失告警去重重置）。
    this.uiRequestHandler = disposedUiRequestStub;
    this.uiObservability.resetMissingHandlerWarnings();
    // [W6 R3 MF-A] dispose 后壳侧应答端同步换 stub（trailing host/askUser 干净降级为
    // cancelled，与 inproc inproc UI 请求队列（已删） 的 trailing 语义同构）。
    setHostUiRequestEndpoint(disposedUiRequestStub);
    // [R0/C1 孤儿进程修复] 先 abort running controllers + kill spawned children，再 dispose 资源。
    // abortRunningControllers 需要在 disposeAllRecords archive 之前执行（archive 后 store 找不到 record）。
    this.store.abortRunningControllers();
    killAllSpawnedChildren();
    // [W3] chat 反向通道路由全量注销（inproc 轮次交接包清空的协议形态替位）。
    // [H1 U2] 经汇聚点——路由注销 + Continuation 实例清理一并完成。
    for (const recordId of [...this.chatRoundRoutes.keys()]) {
      this.onRecordFinalizedCleanup(recordId);
    }
    // [H1 U2] Continuation 实例全量清理：Continuation 轮不注册 chat 路由（run 应答
    // 驱动），上循环按 chatRoundRoutes 键遍历覆盖不到——dispose 后容器不应再收 message。
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
    this.resumesInFlight.clear();
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
   * [V2 决策 3 → W3 协议形态] chatMode 统一投递入口（message action 的 Service 面）
   * ——经协议 interact（message action）发往 pi-subagent-cli 引擎进程。协议知识
   * （stdin prompt 命令 + streamingBehavior 映射 + EPIPE 兜底）在引擎进程内
   * （chat-session.deliverMessage）；编排层按结构化结果分流：
   *
   *   受理（引擎侧进程活）：prompt + streamingBehavior——pi 权威裁决 busy/idle。
   *   冷路径（engine_session_not_resumable = 进程死/无活进程）：冷路径续轮
   *     （resumeColdRound → run chat + resume 锚点接续，仅崩溃/timeout kill/跨重启命中）。
   *   其他拒绝（EPIPE 兜底耗尽 / engine_interact_failed）：业务拒绝原样 throw
   *     （文案自带行动语言——与 inproc 形态逐字节一致）。
   *
   * @param record 目标 record（chatMode，running 或 idle）
   * @param text 消息正文
   * @param interrupt true=steer（抢占）/ false=followUp（排队）
   */
  /**
   * [V2 决策 3 → H1 U2 改写] chatMode 统一投递入口（message action 的 Service 面）
   * ——经 ConversationContinuation.onMessage（§3.4 / D4 状态迁移表 / D2 打断语义）：
   *
   *   - running（轮间 idle）→ 新轮派发（新 run + resume 锚点，record.sessionFile 续写）；
   *   - running（有在途轮）→ D2 打断：abort 在途轮 signal + 消息入队，abort 收敛后
   *     drain（「等真轮终相位」的宽限语义随长驻消亡放弃——打断即杀正是打断的本意）；
   *   - 终态 → guard 分流（closed 硬拒 / 可重连 revive + 非 chatMode 升级格 + D5 gate）。
   *
   * [H1 U2 边界] 旧 interact 热路径（engine.interact message）/ 冷路径分流
   * （engine_session_not_resumable → resumeColdRound）编排体随本改写退役为死代码
   * （deliverChatMessage 不再触达 interact；删除归 U6）。interrupt 参数随 steer/
   * followUp 语义退役（D2 统一打断：在途轮存在即打断入队，不再区分抢占/排队）——
   * 参数保留签名兼容（U6 清理）。
   *
   * @param record 目标 record（messageHandler 已做归属校验 + 可重连 revive）
   * @param text 消息正文
   * @param _interrupt 退役参数（D2 打断统一语义，见上）
   */
  private async deliverChatMessage(record: ExecutionRecord, text: string, _interrupt: boolean): Promise<void> {
    this.assertReady();
    this.continuationFor(record).onMessage(text);
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

    // [W3 协议形态] 冷续锚点 = record identity（防多轮对话模型漂移，探针 P-10）：
    // sessionFile 经 resume.sessionRef 携带（引擎 --session 续写原文件）；model/
    // thinkingLevel 属 record 身份字段（锚点轮引擎侧覆盖解析）。原 SpawnResumeOpts
    // 形态随 inproc pi 引擎目录 删除，锚点载体 = 协议 ResumeAnchor（W1 SDK 契约）。
    const resume: ResumeAnchor = {
      sessionRef: {
        recordId: record.id,
        ...(record.sessionFile !== undefined ? { sessionFile: record.sessionFile } : {}),
      },
      poolKey: PI_POOL_KEY,
    };

    // 重建 resolved：锚点轮的模型解析兜底（ctxModel 第三层）。从 record.model
    // （createRecordForMode 写入的 "provider/id" 或无斜杠 ref——契约变更④）拆分构造
    // 最小 ModelInfo；拆分与写入侧同源（splitEngineModelRef）：无斜杠 ref 的 provider
    // 为空串（旧行为 "unknown" 会给续轮注入虚构 provider），整串进 name。
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
      task: text,
      slug: record.slug,
      worktree: record.worktreeHandle,
      // 冷续轮同样是 chat 会话形态（run.params.chat 必传 + conversation gate 放行）。
      conversation: true,
    };

    // detached 编排：轮次在 background 跑（协议 run chat + resume），pool 重新
    // acquire（轮次间 idle 已 release）。chatMode 轮终 settle 分流自动
    // finalizeRoundToIdle（record 回 idle、round+1）。
    // [review MF1] 在途标记在 kickOff 前同步设置：本方法返回即生效，后续重入
    // （冷路径重入）在守卫处被拒；轮次收尾 finally 统一清除。
    this.resumesInFlight.add(record.id);
    this.kickOffChatRound(record, opts, identity, record.controller.signal, PRIORITY_BACKGROUND, resume);
  }

  /**
   * [T2③] 热路径轮 settled watchdog 到期处置（对齐 u-t2a 首轮形态：kill + 该轮失败
   * 终态化 + 失败通知，error 含 'settled watchdog' 标记与恢复指引）。
   *
   * [D9 两段式] 两段（mid-round 无进展 / settled 收尾段上界）共用本处置，fire 信息
   *（段 + 窗长）由原语注入，失败文案按段分叉窗长语义。
   *
   * 与首轮的差异：runSpawn 已返回（无收尾链路承接 settledWatchdogFired 标记），失败
   * 终态化在本回调内完成。chatMode 按 MF-6 语义回退 running-resumable（与首轮 watchdog
   * 经 runAndFinalize 失败分支的最终形态一致——对话可冷路径复活）；非 chatMode 终态
   * 销毁。CAS（tryTransition closed+gc）防与 cancel/dispose 双收尾，抢锁失败即跳过。
   *
   * 回调在 timer 触发的同步上下文执行：同步段只做 kill + CAS（不抛），异步收尾
   * fire-and-forget 且 catch 归 bestEffort——错误逃出回调 = uncaughtException 崩宿主。
   */
  private onHotPathSettledWatchdogTimeout(record: ExecutionRecord, fire: SettledWatchdogFireInfo): void {
    const windowDesc =
      fire.phase === "mid-round"
        ? `no valid protocol event for ${fire.waitedMs / MS_PER_SECOND / SECONDS_PER_MINUTE} min after prompt (mid-round no-progress)`
        : `no agent_settled within ${fire.waitedMs / MS_PER_SECOND}s after agent_end (settled phase)`;
    logger.warn(
      `[subagents] settled watchdog (${fire.phase}) fired for ${record.id}: ${windowDesc}, ` +
        `terminating (LC-1 wedge recovery)`,
    );
    killRecordChildWithEscalation(record.id, "settled watchdog (hot path)");
    // [W3] 子进程在引擎进程内——终止经协议 interact cancel（SIGTERM → 引擎侧
    // settle 等待 → 杀链升级）；镜像置死位由上方 killRecordChildWithEscalation 记账。
    this.terminateChatSession(record, "cancel", "settled watchdog (hot path)");
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
    if (!tryTransition(record, "closed", "gc")) {
      return; // 已被 cancel/dispose 抢先终态化——不重复收尾（watchdog disarm 由对方承接）
    }
    // [H1 U2 / D7] chatMode 失败轮 outcome 入参化（result = 前值 ?? 失败摘要 +
    // lastError 写入归 doFinalizeRoundToIdle）；非 chatMode 终态销毁照旧。
    const finalize: Promise<void> = record.chatMode
      ? this.finalizeRoundToIdle(record, { kind: "failed", reason: failedResult.error ?? "settled watchdog" })
      : this.finalizeRecord(record, failedResult, "closed", "gc").then(() => undefined);
    void finalize
      // [D4-①] 通知簇搬移 notify-host 后的遗留调用点修正：this.notifyComplete 方法已
      // 不存在（其余三处调用点均 this.notifyHost.notifyComplete），旧引用 throw
      // TypeError 被本 .catch 吞掉 → settled watchdog 失败通知静默丢失
      .then(() => this.collectCoordinator.route(record))
      .catch((err: unknown) => bestEffort(err, "settled watchdog hot-path finalize", "error"));
  }

  // [T2⑧ / PS-3] 非 EPIPE 热路径写失败后的 idle timer 再武装已随 D2 投递下沉迁移落位：
  // 挂载点在 PiEngine.deliverPrompt 的非 EPIPE catch（engine/inproc pi-engine（已删） 的
  // rearmIdleTimerAfterHotPathFailure，该文件归 engine 域）——编排层 interactRecord 的
  // 结构化结果无法区分「stdin 写失败」与业务拒绝，盲目 re-arm 会误武装。

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
  // [T5③ / PS-7b] running 候选异进程活实例守卫（findForeignLiveInstance 探针，
  // ResurrectDeniedError）已随迁 cold-resurrect.ts 的 findColdLookupCandidate
  //（与 closed 候选守卫 assertReconnectAllowed 对称）。

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
    });
  }

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
        // 随即立即终态化（closeChatIdle 承接 closeChatIdle 原「无在跑轮」收口职责的
        // 全路径——closeAfterRound 挂起标志在 chat 域退役，不再有「轮完成时终态化」
        // 的等待窗；消费点 closeAfterRoundSettled 对新编排不可达，删除归 U6）。
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
    this.terminateChatSession(record, "close", "closeChatIdle");
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
    // 回收保活进程（Path A：轮次完成后进程仍活）+ disarm idle timer（终态化后无其他 kill 路径）。
    // [T2④ / LC-2] 终止语义收敛（30s 升级 SIGKILL，终态化后无后续回收通道）；
    // settled 等待窗口同步终结（disarm 幂等）。[W3] 实际终止经协议 interact close
    // force（引擎进程内的子进程），镜像置死位由 killRecordChildWithEscalation 记账。
    disarmIdleTimer(record.id);
    disarmSettledWatchdog(record.id);
    disarmRoundFromProtocol(record.id);
    killRecordChildWithEscalation(record.id, "closeAfterRoundSettled");
    this.terminateChatSession(record, "close", "closeAfterRoundSettled");
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

  /** [perf] 单 record 详情懒加载（全量：eventLog/displayItems/result/turns/tokens）。
   *  内存 running record 直接投影；磁盘 record 全量重建（per-file 缓存，stat 戳校验）。
   *  返回 undefined：id 不存在于内存与磁盘。 */
  private getFullRecord(id: string): SubagentRecord | undefined {
    return this.store.getFullRecord(id);
  }

  // ── 执行内部：身份解析 + record 创建 ──────────

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
    // 定位（chatHandleFor）拿不到 sessionFile。poolKey / journalPath 不参与补缺：
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
    const runCtx: RunContext = {
      taskId: record.id,
      poolKey: JOURNAL_INITIAL_POOL_KEY,
      signal,
      ctxModel: opts.ctxModel,
      onEvent: journal.onEvent,
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
      if (
        err instanceof EngineSdkError &&
        err.code === "engine_crashed" &&
        record.chatMode !== true &&
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
   * 分层并发配额：depth 越深可用配额越少（下限 1）。fork 深度护栏在池维度的投影，
   * 公式约定以 concurrency-pool.ts 注释为登记处、此处为唯一代码锚点。
   */
  private effectiveMaxConcurrentFor(record: ExecutionRecord): number {
    return Math.max(1, this.pool.maxConcurrent - record.depth);
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

  // ── 执行内部：run + finalize（workflow 域 sync 面；chat 域轮次走 kickOffChatRound）──

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
      // tool 层 + record 卡 running。
      if (record.chatMode) return this.finalizeChatSpawnFailure(record, err);
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

  /** [U04 提取·错误收口] MF-6（决策 6 spec §3.1）：chatMode（含 resume）spawn/创建失败
   *  不销毁对话——回退 idle（可恢复），让 agent 可重试 message 或 close。与一次性模式
   *  （finalizeFailed 终态销毁）区分。返回合成 failed result（swallow，不 re-throw）。 */
  private async finalizeChatSpawnFailure(record: ExecutionRecord, err: unknown): Promise<AgentResult> {
    const errMsg = toErrorMessage(err);
    const failedResult: AgentResult = {
      text: "",
      turns: record.turnCount,
      durationMs: Date.now() - record.startedAt,
      success: false,
      error: errMsg,
      sessionId: record.id,
      toolCalls: [],
    };
    disarmRoundFromProtocol(record.id);
    if (tryTransition(record, "closed", "gc")) {
      // 回退 idle（[H1 U2 / D7] outcome 入参：record.result 前值 ?? 失败摘要，
      // notify 可读）。旧 chat 载体调用点（新编排不可达，删除归 U6）。
      await this.finalizeRoundToIdle(record, { kind: "failed", reason: errMsg });
    }
    return failedResult;
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
   * pi chat 域轮次的 detached 编排（[W3 协议形态]）：轮次经协议 run（会话形态
   * chat{recordId, resume?}）发往 pi-subagent-cli 引擎进程——
   *   - 应答时点 = 首轮 agent_settled（W2 契约：idle 帧先于应答帧；outcome = 本轮
   *     内容非会话终态）→ 应答到达即本轮 settle；
   *   - 流式 delta / 轮次生命周期经 host/streamDelta + host/roundLifecycle 反向通道
   *     回流：首轮 runId 键（RunContext.stream / onRoundLifecycle）、续聊轮 recordId
   *     键（chatRoundRoutes 注册的 recordId 路由）；
   *   - recordId 路由在本方法注册（首轮 + 冷续轮替换式重注册），record 终态化路径注销。
   * chat 域不接 event journal（pi 子代理 session JSONL 即原生数据源；与迁移前产物
   * 形态一致——journal 接线仅 workflow 域 SAR 与非 pi 引擎 chat 路径）。
   *
   * [H1 U2 / D6 泛化] 本方法是 pi 引擎 background 派发的共享主干（one-shot 与
   * Continuation 轮同路）。`continuation` 存在 = Continuation 轮（chat 域统一进
   * run 域的新编排）：
   *   - 应答/reject/acquire 打断三分回调回流 Continuation（轮末分流 D7 单点收口）；
   *   - 不注册 recordId 键路由与 runId 键 onRoundLifecycle——settle 交棒改 run 应答
   *     驱动（onRunSettled 内 noteRoundSettledFromProtocol），旧相位机消费
   *     （handleChatRoundPhase 的 idle timer 挂载/failed 分诊）对新编排是双簿记面；
   *   - 不终态化 acquire-abort（打断 ≠ cancel——record 保持 running）；
   *   - 轮末通知归属 Continuation 双闸（成功 gate→route / 失败独立载荷过门），
   *     主干尾部回注跳过（防双 route）。
   * `continuation` 缺省 = 旧形态（one-shot 主干 + 旧 chat 载体——后者对新编排不可达，
   * 死代码删除归 U6）。
   */
  private kickOffChatRound(
    record: ExecutionRecord,
    opts: ExecuteOptions,
    identity: ResolvedIdentity,
    signal: AbortSignal | undefined,
    priority: number,
    /** 冷续锚点（M2-B1 协议形态）：run.params.chat.resume。undefined = 新 session。 */
    resume?: ResumeAnchor,
    /** [H1 U2] Continuation 轮回调面（存在 = 新编排；见方法头注释）。 */
    continuation?: ContinuationRoundHandlers,
  ): void {
    // 创建 streaming 生命周期对象。策略（含 widget 退役步骤 2：GUI + relay 激活时停发
    // 私货、TUI/未激活原样创建、sink 未注入降级 undefined）集中在 createBackgroundStream。
    const stream = createBackgroundStream(record.id, this.streamSink, this.uiObservability.getMode(), process.env);

    // 注册 recordId 键反向通道路由（替换式——冷续轮重注册）：interact 续聊轮的
    // streamDelta / roundLifecycle 分发目标；首轮流式 delta 走 ctx.stream（runId 键），
    // 本路由的 onStreamDelta 承担中段守护刷新 + dispose 后的续轮 delta（幂等 no-op）。
    // 仅 chat 会话形态注册（一次性 run 无反向轮次面）。
    // [H1 U2] Continuation 轮不注册——run 应答驱动的新编排无 interact 面，相位机
    // 消费（idle timer 挂载 / failed 分诊）归 Continuation/主干承接，注册即双簿记。
    const prevUnregister = this.chatRoundRoutes.get(record.id);
    prevUnregister?.();
    const engine = this.resolveChatEnginePort();
    if (record.chatMode && continuation === undefined) {
      this.chatRoundRoutes.set(
        record.id,
        engine.registerChatRoundRoute?.(record.id, {
          onStreamDelta: (delta) => {
            refreshFromProtocolEvent(record.id);
            stream?.onDelta(delta);
          },
          onRoundLifecycle: (phase) => this.handleChatRoundPhase(record, phase),
        }) ?? (() => {}),
      );
    }

    // [W4] 冷路径 resume 轮的在途记账：死亡纳管 record 被主 agent resume = 决策收敛
    // （清指引标记与看门狗，回归「该等」）。热路径轮（deliverChatMessage）不经此处，
    // 其「该等」由 hasLiveProcess 判据覆盖（进程活）——conversation 形态本就豁免监督域。
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
        // [F-2 首轮/冷续轮 arm 重接] 轮开跑（pool 槽已到手、run 协议帧即将派发）挂
        // **中段**无进展检测——被删的 inproc stdout-pump 是首轮唯一中段守护，协议化后
        // 引擎侧 spawn-runner 仅 turn 计数无墙钟，本 arm 是首轮 wedged 的唯一熔断
        // （LC-1 场景①：pi 无事件行输出）。refresh 源（对照热路径的 arm/refresh 形态，
        // 同一守护实例语义）：① runId 键协议事件行（ctx.onEvent，含 text_delta）；
        // ② settle 交棒——Continuation 轮 = run 应答驱动（onRunSettled 内
        // noteRoundSettledFromProtocol）；旧形态 = settled 相位帧。idle 相位
        // disarmRoundFromProtocol 两段一并清。
        // arm 置于 acquire 之后：排队窗口不计入 no-progress 静默（窗语义 = 轮开跑后）。
        armMidRoundNoProgress(record.id, {
          onMidTimeout: (fire) =>
            continuation !== undefined
              ? continuation.onWatchdogFire(fire)
              : this.onHotPathSettledWatchdogTimeout(record, fire),
          onSettleTimeout: (fire) =>
            continuation !== undefined
              ? continuation.onWatchdogFire(fire)
              : this.onHotPathSettledWatchdogTimeout(record, fire),
        });
        // 协议 run：chatMode = 会话形态（chat.recordId = 关联键；resume 存在 = 续聊；
        // 应答时点 = agent_settled——轮末分流归属 Continuation onRunSettled（新编排）
        // 或 settleChatRoundFromResponse（旧载体，U6 删））；非 chatMode = 一次性 run
        //（协议面无 chat 键，终态语义对齐原 settleOneShotOutcome）。
        const { outcome } = await engine.run(
          // resume 锚点轮引擎侧覆盖 model 解析（taskSpec 装配单一来源见 taskSpecWithModel）。
          this.taskSpecWithModel(opts, record.model),
          {
            taskId: record.id,
            poolKey: PI_POOL_KEY,
            signal,
            ...(stream !== undefined ? { stream } : {}),
            ctxModel: identity.resolved.model,
            // [F6] 根 session id 注入（relay 归属键 SESSION_ID 权威源；null/空串不上 wire）。
            // 本方法是 pi 引擎 background 派发的主路径（isPiRoute 恒路由至此，含 workflow
            // 域一次性 run——非 chatMode 不带 chat 键但同经此处），漏注 = pi child exit 13。
            ...(this.sessionRootId !== null && this.sessionRootId !== ""
              ? { sessionRootId: this.sessionRootId }
              : {}),
            // chat 会话形态参数（conversation 形态必传；续聊带锚点）；一次性 run 不携带。
            ...(record.chatMode
              ? {
                chat: {
                  recordId: record.id,
                  ...(resume !== undefined ? { resume } : {}),
                },
                // 首轮 runId 键生命周期帧（旧形态）：守护交棒 / idle 定时器挂载 / failed
                // 分诊。Continuation 轮不挂（run 应答驱动，见方法头注释）。
                ...(continuation === undefined
                  ? { onRoundLifecycle: (phase: HostRoundLifecycleParams) => this.handleChatRoundPhase(record, phase) }
                  : {}),
                // 中段守护刷新源①：首轮协议事件行（message_*/tool_*/turn_end——有效
                // 事件到达即刷新；chat 域不接 journal，事件仅作活性信号消费）。
                onEvent: () => refreshFromProtocolEvent(record.id),
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
        } else if (record.chatMode) {
          // 本轮 settle（应答 = 首轮 agent_settled）：round+1 / 增量通知 / closeAfterRound 消费。
          this.settleChatRoundFromResponse(record, outcome);
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
        } else if (record.chatMode) {
          await this.finalizeChatSpawnFailure(record, err);
        } else {
          await this.finalizeFailed(record, err);
        }
        if (err instanceof Error) {
          logger.debug(`[subagent] chat round run error (record=${record.id}): ${err.message}`);
        }
      } finally {
        this.pool.release();
        // 在途 resume 守卫清除（幂等；冷续轮收尾）+ streaming widget 清除（轮终，幂等——
        // 续轮 delta 落已 dispose 的 stream 为 no-op，与 inproc 形态逐点一致）。
        this.resumesInFlight.delete(record.id);
        stream?.dispose();
        // [W4] 轮收口重评估（死亡纳管 record 的轮终 → 驱动可能又死 → 重新三态判定）。
        this.roundSupervisor.noteRunEnded(record.id);
      }
    })();
  }

  /**
   * [W3] chat 轮次生命周期帧消费（host/roundLifecycle，runId 键首轮 / recordId 键续聊轮
   * 经本方法收敛）。相位 → 宿主编排语义（W4 协议事件面三入口）：
   *   - settled：轮收敛——settled-watchdog 中段让位收尾段（noteRoundSettledFromProtocol）；
   *   - idle：轮收口进 idle 稳态——两段守护一并清（disarmRoundFromProtocol）+ 冷续锚点
   *     回填（sessionFile/engineHandle，idle 帧先于 run 应答帧）+ **idle 定时器挂载**
     *     （引擎不实现 idle 定时器——core arm，W2 交接契约）；
   *   - failed：轮异常终止（engine_round_aborted / engine_round_crashed /
   *     engine_round_epipe_exhausted）——record 如实标 failed（禁 completed 谎报），
   *     chatMode 按 MF-6 回退可恢复（onChatRoundFailed）；
   *   - active：轮内心跳（F3）——只刷新中段无进展守护（refreshFromProtocolEvent，
   *     与 streamDelta 路同款），不处置 record。续聊轮「仅工具输出、零正文」时
   *     delta 通道无帧，active 是该形态下守护的唯一刷新源。
   */
  private handleChatRoundPhase(record: ExecutionRecord, phase: HostRoundLifecycleParams): void {
    switch (phase.phase) {
      case "settled":
        noteRoundSettledFromProtocol(record.id);
        break;
      case "idle":
        disarmRoundFromProtocol(record.id);
        this.armChatIdleTimer(record);
        if (phase.anchor !== undefined) {
          this.backfillChatAnchor(record, phase.anchor);
        }
        break;
      case "failed":
        this.onChatRoundFailed(record, phase.error);
        break;
      case "active":
        // 轮内心跳（F3）：与 streamDelta 路同款刷新——续聊轮「仅工具输出、零正文」
        // 时 delta 通道无帧，active 是中段守护的唯一刷新源。不处置 record（非终态）。
        refreshFromProtocolEvent(record.id);
        break;
    }
  }

  /**
   * [W3] idle 相位 = idle 定时器锚点（原 session-runner handleAgentSettledForChatMode
   * 的 armIdleTimer 段）：挂载降级链（配置值 → DEFAULT 兜底 + warn）语义保持；超时
   * 处置 = 引擎侧进程回收（协议 interact close force）——idle timer SIGTERM 的协议形态。
   */
  private armChatIdleTimer(record: ExecutionRecord): void {
    const onTimeout = (): void => {
      killRecordChildWithEscalation(record.id, "idle timer");
      this.terminateChatSession(record, "close", "idle timer");
    };
    try {
      armIdleTimer(record.id, onTimeout, record.idleTimeoutMs);
    } catch (err) {
      bestEffort(err, "armIdleTimer (chat idle phase)", "error");
      try {
        armIdleTimer(record.id, onTimeout, DEFAULT_IDLE_TIMEOUT_MS);
        logger.warn(
          `[subagents] idleTimeoutMs invalid for ${record.id}, fell back to DEFAULT_IDLE_TIMEOUT_MS (${DEFAULT_IDLE_TIMEOUT_MS}ms) — idle GC and round notification gate stay active`,
        );
      } catch (fallbackErr) {
        bestEffort(fallbackErr, "armIdleTimer fallback (chat idle phase)", "error");
      }
    }
  }

  /** [W3] idle 帧锚点回填（冷续锚点 = 引擎侧会话滚动/compaction 后的最新定位）。 */
  private backfillChatAnchor(
    record: ExecutionRecord,
    anchor: { sessionRef: Record<string, string>; poolKey: string; journalPath?: string },
  ): void {
    const sessionFile = anchor.sessionRef["sessionFile"];
    if (typeof sessionFile === "string" && sessionFile !== "") {
      record.sessionFile = sessionFile;
      // [UF-1] 锚点回填即绑定落盘（idle 帧先于 run 应答帧——本点先于轮应答写点生效）。
      this.writeBindingForRecord(record);
    }
    // engineHandle 回填（①级读取钥匙；幂等守卫——终态回填已落则不覆盖）。
    if (record.engineHandle === undefined || record.engineHandle.sessionRef["sessionId"] === undefined) {
      record.engineHandle = {
        sessionRef: { ...anchor.sessionRef },
        poolKey: anchor.poolKey,
        ...(anchor.journalPath !== undefined ? { journalPath: anchor.journalPath } : {}),
      };
    }
    this.store.reportRecordTransition(record);
  }

  /**
   * [W3] chat 轮 failed 相位分诊：错误如实落 record（失败相位错误码——engine_round_
   * aborted（宿主 cancel/close）/ engine_round_crashed（子进程外部死亡）/
   * engine_round_epipe_exhausted（EPIPE 兜底耗尽）），禁 completed 谎报。chatMode 按
   * MF-6 不销毁对话——回退可恢复（finalizeRoundToIdle + 通知），冷续 run 接续；
   * record 已终态（cancel/close 抢先）= 迟到帧，幂等跳过。
   */
  private onChatRoundFailed(record: ExecutionRecord, error: ProtocolError): void {
    disarmRoundFromProtocol(record.id);
    if (record.status !== "running") return;
    const errMsg = `${error.code}: ${error.message}`;
    record.lastError = errMsg;
    // [H1 U2 / D7] 失败轮载体并入 Continuation（新编排不可达本方法——旧相位机
    // failed 分诊，删除归 U6）；outcome 入参化后 result/lastError 写入规则统一归
    // doFinalizeRoundToIdle（此处 lastError 重复写为同值，幂等无害）。
    void this.finalizeRoundToIdle(record, { kind: "failed", reason: errMsg })
      .then(() => {
        if (notifyGateAllowsDelivery(record.closedReason)) {
          this.collectCoordinator.route(record);
        }
      })
      .catch((err: unknown) => bestEffort(err, "chat round failed finalize", "error"));
  }

  /**
   * [W3] 首轮 run 应答到达（= 首轮 agent_settled，W2 契约）的本轮 settle：round+1 /
   * 轮次增量通知 / base 推进 / reportRecordTransition / closeAfterRound 消费——语义
   * 权威自持于此（原 round-settlement.ts createRoundSettler 已删，本闭包为其唯一后继），
   * 唯一偏差 = 轮次文本源：协议形态下 live turns 留在引擎进程内，core 以应答
   * outcome.content（W2「outcome = 本轮内容」）为增量权威，record.turns 派生不可用。
   * idle 定时器挂载不在此处——idle 相位帧先于应答帧到达，armChatIdleTimer 已锚定。
   */
  private settleChatRoundFromResponse(record: ExecutionRecord, outcome: AgentOutcome): void {
    if (record.status !== "running") return; // 终态（cancel/close 抢先）——迟到应答幂等跳过
    record.round = (record.round ?? 0) + 1;
    const roundText = outcome.content;
    record.result = roundText ||
      (record.lastError ? `round did not complete: ${record.lastError}` : "(no output this round)");
    // 先送达本轮增量（notify），再推进 base
    //（notify 后推进：notify 失败时 base 不推进，增量并入下一轮防丢文本）。
    // [T4①/PS-2] 通知门与 kickOff 回注同款：parent-new/parent-fork 编排性关闭后
    // 迟到的应答 settle 不注入（可能已切换的）新 session；cancelled 由 cancelBackground
    // 自行 notify。
    if (notifyGateAllowsDelivery(record.closedReason)) {
      this.collectCoordinator.route(record);
    }
    record.roundBaseTurnIndex = record.turnCount;
    this.store.reportRecordTransition(record);
    // [M5] closeAfterRound 消费：chatMode 轮次完成的统一汇聚点（优雅关闭在本轮
    // 完成时兑现终态化）。
    if (record.closeAfterRound) {
      record.closeAfterRound = undefined;
      void this.closeAfterRoundSettled(record);
    }
  }

  /** [W3] chat 域引擎终止意图（协议面）：cancel = interact cancel（引擎侧 SIGTERM →
   *  settle 等待 → 杀链升级）；close = interact close force（立即杀链收割）。fire-and-forget
   *  ——失败 best-effort 留证（宿主组级收割兜底 = EngineClient killAll，dispose 路径）。 */
  private terminateChatSession(
    record: ExecutionRecord,
    kind: "cancel" | "close",
    source: string,
  ): void {
    void (async () => {
      const engine = this.resolveChatEnginePort();
      const handle = this.chatHandleFor(record);
      const result = kind === "cancel"
        ? await engine.interact(handle, { kind: "cancel" })
        : await engine.interact(handle, { kind: "close", payload: { force: true } });
      if (!result.ok) {
        logger.debug(
          `[subagents] terminateChatSession (${kind}, ${source}) rejected for ${record.id}: ${result.message}`,
        );
      }
    })().catch((err: unknown) =>
      bestEffort(err, `terminateChatSession (${kind}, ${source})`, "debug"),
    );
  }

  /** chat record 的协议 interact handle（engineHandle 缺省时按 recordId 合成——
   *  引擎侧 interact 定位键 = sessionRef.recordId；sessionFile 有值时一并携带）。 */
  private chatHandleFor(record: ExecutionRecord): EngineHandle {
    const known = record.engineHandle;
    return {
      data: {
        v: 1,
        engineId: record.engine ?? DEFAULT_ENGINE_ID,
        sessionRef: {
          recordId: record.id,
          ...(known?.sessionRef["sessionFile"] !== undefined
            ? { sessionFile: known.sessionRef["sessionFile"] }
            : record.sessionFile !== undefined
              ? { sessionFile: record.sessionFile }
              : {}),
        },
        poolKey: known?.poolKey ?? PI_POOL_KEY,
        ...(known?.journalPath !== undefined ? { journalPath: known.journalPath } : {}),
        adapterVersion: "subagent-core/host-bridge",
      },
    };
  }

  /** [W3] pi 引擎 port 解析（chat 域路由与终止面共用）：registry cli 形态 port，
   *  未注册 = 不可用 stub（engine_not_found，见 pi-host-binding）。 */
  private resolveChatEnginePort(): EnginePort {
    return resolveHostPiEnginePort(() => null);
  }

  /** [W3] record 终态化路径的 chat 反向通道路由注销（幂等）。 */
  private unregisterChatRoundRoute(recordId: string): void {
    const unregister = this.chatRoundRoutes.get(recordId);
    if (unregister !== undefined) {
      this.chatRoundRoutes.delete(recordId);
      unregister();
    }
  }

  // ── [H1 U2] ConversationContinuation 装配与 host 面 ───────────────────

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
    const record = this.store.getMutable(recordId);
    if (record !== undefined) {
      this.terminateChatSession(record, "cancel", "stale-child guard (dispatch)");
    }
    await delay(STALE_CHILD_EXIT_WAIT_MS);
  }

  /** watchdog fire 的 kill 手段（kill + 协议 cancel）——run 收敛由杀链驱动，
   *  轮末收口统一回流 Continuation onRunSettled/onRoundRejected（单写者单路）。 */
  private killRoundChildForWatchdog(recordId: string, source: string): void {
    killRecordChildWithEscalation(recordId, source);
    const record = this.store.getMutable(recordId);
    if (record !== undefined) {
      this.terminateChatSession(record, "cancel", source);
    }
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
   * record 终态化路径的宿主侧收口汇聚点（[F-5] chat 轮路由注销 + [H1 U2]
   * Continuation 实例清理——终态后容器不再接收 message，实例滞留即泄漏）。
   */
  private onRecordFinalizedCleanup(recordId: string): void {
    this.unregisterChatRoundRoute(recordId);
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
    // [W3] chatMode 的实际终止经协议 interact cancel（引擎进程内 SIGTERM → settle
    // 等待 → 杀链升级；首轮在途 run 的 abort 帧由 controller.signal 经 RemoteEngine
    // cancel 分级另行承载，两路幂等）。
    killRecordChildWithEscalation(record.id, "cancelBackground");
    disarmIdleTimer(record.id);
    disarmSettledWatchdog(record.id);
    disarmRoundFromProtocol(record.id);
    this.onRecordFinalizedCleanup(record.id);
    if (record.chatMode) {
      this.terminateChatSession(record, "cancel", "cancelBackground");
    }
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
    // 写终态 sidecar（best-effort，sessionFile 可能为 undefined——窗口期 cancel）。
    if (record.sessionFile) {
      writeCancelledState(record.sessionFile, record.endedAt ?? Date.now());
    }
    this.store.archive(record);
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
