// 执行编排 + 记录 + 通知领域 Service。
// 上游：subagent-tool（execute/query/cancel）、TUI（onChange/listRunning/collectRecords）。
// session_start 时经 initSession 注入 pi；modelRegistry/entries 归 ModelConfigService.initModel。

import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";

import { getLogger } from "@zhushanwen/pi-extension-logger";

import type { ExtensionMode } from "./host-mode.ts";

import type { AgentResult as WorkflowAgentResult } from "../orchestration/models/types.ts";
import { displayAgentName } from "../shared/agent-ref.ts";
// D-A10: workflow 侧 AgentResult 映射（executeAndAwait 出口）
import { mapToWorkflowAgentResult } from "./agent-result-mapper.ts";
import { removeAliveMarker, findForeignLiveInstance, writeAliveMarker } from "./alive-store.ts";
import { bestEffort } from "./best-effort.ts";
// [V2 决策 3] lifecycle-manager idle timer：chatMode 统一投递新 turn disarm（防误杀活进程）。
// [M3] hasIdleTimer：piAdapter.hasRunningBackground 排除等待续聊（timer armed）的 record。
import { acquireActivateLock, disarmIdleTimer, hasIdleTimer } from "./lifecycle-manager.ts";
import { type ConcurrencyPool,DefaultConcurrencyPool } from "./concurrency-pool.ts";
import type { DialogGlobalQueue, UiRequestHandler } from "./dialog-queue.ts";
import {
  completeRecord,
  createRecord,
  getFullTextFrom,
  nextRoundBaseTurnIndex,
  project,
  resurrectClosed,
  snapshot,
  tryTransition,
} from "./execution-record.ts";
import { doFinalizeRecord, doFinalizeRoundToIdle } from "./finalize-record.ts";
import { getEngineDataDir } from "./engine/common/data-dir.ts";
import { EngineError } from "./engine/common/errors.ts";
import { JournalWriter } from "./engine/common/event-journal.ts";
import { resolveJournalPath } from "./engine/paths.ts";
import { executeOptionsToEngineTaskSpec } from "./engine/host-task-spec.ts";
import type { EnginePort, RunContext } from "./engine/port.ts";
import { DEFAULT_ENGINE_ID, getEngine } from "./engine/registry.ts";
import { type EngineRouteResult, resolveEngineRouting, routeEngine } from "./engine/routing.ts";
import type { AgentOutcome } from "./engine/types.ts";
import { ManifestStore } from "./manifest-store.ts";
import type { ModelConfigService } from "./model-config-service.ts";
import type { AgentConfig, ModelInfo, ResolvedModel } from "./model-resolver.ts";
import type { BgNotifyRecord, BgNotifier, NotifierHost } from "./notifier.ts";
import { createNotifier } from "./notifier.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "./path-encoding.ts";
import type { StatusFilter } from "./record-store.ts";
import { RecordStore } from "./record-store.ts";
import { MAX_FORK_DEPTH } from "./session-context-resolver.ts";
import { getChildByRecord, killAllSpawnedChildren, registerSpawnedChildForRecord, runSpawn, spawnedChildren, type SessionRunnerContext, type SpawnResumeOpts } from "./session-runner.ts";
import { isIdle, isResumable, hasLiveProcessHandle } from "./lifecycle-predicates.ts";
import { startIdleGc } from "./idle-gc.ts";
import {
  clearEpipeFailure,
  EPIPE_FAILURE_THRESHOLD,
  recordEpipeFailure,
  resetAllEpipeFailures,
  sendPromptCommand,
} from "./stdin-writer.ts";
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
import { isReconnectableFinalReason, ResurrectDeniedError } from "./types.ts";
import { DEFAULT_AGENT_NAME } from "./types.ts";
import { registerGlobalObservability, UiRequestObservability } from "./ui-request-observability.ts";
import { WorktreeManager } from "./worktree-manager.ts";

const logger = getLogger("subagents");

/** SP-2 冷路径按 id 查 record 的 collectRecords 扫描上限（全扫兜底的容量 cap）。 */
const COLD_LOOKUP_SCAN_LIMIT = 1000;

// [v4 A-1] EPIPE 连续失败计数器已迁移到 stdin-writer.ts（stdin 错误域，避免 session-runner
// 反向 import 本文件 helper 产生循环依赖）。同步路径（deliverMessage）与异步路径
//（session-runner child.stdin.on('error')）共用 stdin-writer 的同一计数器。

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

/** Pi ExtensionAPI 的最小接口（duck-typed）。
 *  subagent-service 直接调 pi.sendMessage 发 background 完成通知（BgNotifier 滑动窗口合并），
 *  不委托 pending-notifications EventBus 中继——后者只管 registry 不参与通知发送。 */
interface PiLike {
  appendEntry(customType: string, data?: unknown): void;
  events: { emit(channel: string, data: unknown): void };
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }, // g4-allow: 类型注解——PiLike 接口形状（pi.sendMessage 签面子集），非投递调用
  ): void;
  /** 订阅 pi 事件（D8：notifier 的 settled 边沿订阅用 'agent_settled'）。
   *  pi 0.84.1 的 on 返回 void 且无 off——退订语义由调用侧 disposed 标志包装兑现。
   *  可选：旧测试 mock pi 可能未实现 on，缺省时 notifier 退化为内核退避路径。 */
  on?(event: "agent_settled", handler: () => void): void;
}

/** UI streaming sink 的最小接口（ctx.ui.setWidget 的 duck-typed 子集）。
 *  session_start 时从 ctx.ui 注入，background 执行期间用于把合并后的 text_delta
 *  通过 setWidget 通道转发到 RPC stdout（不经 sendMessage 的持久化路径）。 */
export type { StreamSink } from "./stream-sink.ts";

/** pending-notifications 注册/注销 helper（避免重复代码）。
 *  name 是 GUI pending 通知的显示名——取 basename 短名（displayAgentName），
 *  完整路径仍走 record.agent（env 注入 / 持久化）。 */
function emitPendingRegister(pi: PiLike | null, id: string, name?: string): void {
  pi?.events.emit("pending:register", {
    id,
    type: "subagent",
    name: name ? displayAgentName(name) : id,
  });
}

function emitPendingUnregister(
  pi: PiLike | null,
  id: string,
  reason: string,
): void {
  pi?.events.emit("pending:unregister", {
    id,
    reason,
  });
}

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
   *  initSession 读取后覆盖 this.uiRequestHandler（setUiRequestHandler 的 session 级等价入口）。 */
  uiRequestHandler?: UiRequestHandler;
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
  /** 进程级执行上下文基线（不依赖 ALS 贯穿——pi RPC mode 的 stdin JSONL 是事件回调式
   *  （attachJsonlLineReader stream.on("data")），每个命令是独立异步链，initSession 里
   *  execCtxAls.enterWith 的 store 不会贯穿到后续 tool 调用事件（实测：递归第二层
   *  parentRecordId/depth 丢失而 rootSessionId 正确——rootSessionId 是实例字段所以不受影响）。
   *  基线 = 本进程自己的身份（initSession 从 env 读取，与 sessionRootId 同机制）：
   *  读 ALS store 失败时兜底，保证「本进程派发的 subagent 都是本进程记录的孩子」
   *  这一跨进程树形关系成立。
   *  initSession 设置：有 env PI_SUBAGENT_SELF_RECORD_ID → {recordId: env 值, depth: env DEPTH}；
   *  无 env（根进程）→ null（顶层）。 */
  private execCtxBaseline: { recordId: string | undefined; depth: number } | null = null;
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
  /** background 完成通知器（滑动窗口合并 + 去重）。session_start revive，shutdown dispose。 */
  private readonly notifier: BgNotifier;
  /** [MF#4][MF#2] fork 深度按 async 调用链传递（AsyncLocalStorage），替代共享可变计数器。
   *  主 session=0；fork 进入子 session 期间推进为子深度，供嵌套 fork 经 ALS 读到自身深度作为
   *  parentForkDepth。并发 background fork 各自独立调用链，不再互相压低深度值。
   *  [MF#2] 旧实现用单实例字段跨执行链共享 → 并发下 A 还原深度后 B 读到被压低值 → 护栏失效。 */
  private readonly forkDepthAls = new AsyncLocalStorage<number>();

  /** subagent 执行上下文按 async 调用链传递（当前正在跑的 record 身份 + 递归深度）。
   *  B run() 期间包此 ALS，B 内创建 C 时 createRecordForMode 读到 B 的 recordId/depth，
   *  据此设 C.parentRecordId=B.id、C.depth=B.depth+1。主 session 链上无 store → 顶层。
   *  与 forkDepthAls 独立：后者只数 fork 链（fork=true 才递增），本 ALS 数所有 subagent 嵌套。 */
  private readonly execCtxAls = new AsyncLocalStorage<{ recordId: string | undefined; depth: number }>();

  /** [review MF1] record 级在途 resume 守卫。resumeRound 全部守卫通过后 add，
   *  runAndFinalize 结束（finally，覆盖轮次完成 / MF-6 失败回退 / abort / 终态化所有分支）时
   *  delete（幂等：execute() 新建 record 不在集合，no-op）。窗口 = resume 发起（含 pool.acquire
   *  排队）→ 本轮 runAndFinalize 收尾。窗口内同 record 再次到达 resumeRound（冷路径重入 /
   *  EPIPE 兜底）直接 throw——防两个 pi 子进程以 --session 同一 JSONL 双写 + 前一个脱离
   *  kill 记账成孤儿（deliverMessage 冷路径的 acquireActivateLock 只覆盖 resumeRound 同步段，
   *  锁释放在子进程注册（session-runner spawnedChildren.set）之前，锁空洞由此守卫兜住；
   *  EPIPE 兜底不持锁，同样被覆盖）。child 注册完成后 deliverMessage 走热路径，不经此守卫。 */
  private readonly resumesInFlight = new Set<string>();

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
    this.notifier = createNotifier(this.piAdapter());
    // #11：注册进程级 observability 单例——ui-request-queue.handleUiRequest 经
    // globalThis 桥接（notifyMissingHandlerGlobal）调到同一实例，共享
    // warnedMissingHandlerSessions 去重集合。未注册时 queue 走 fallback warn（不去重）。
    registerGlobalObservability(this.uiObservability);
  }

  // ── 生命周期（index.ts 调）──────────────────────────────

  /** 覆盖 UI 请求 handler（W3: index.ts session_start 时按 mode 注入 handler 后调）。
   *  委托 uiObservability 重置缺失告警去重——新 handler 就位后允许重新 warn。 */
  setUiRequestHandler(handler: UiRequestHandler | undefined): void {
    this.uiRequestHandler = handler;
    this.uiObservability.resetMissingHandlerWarnings();
  }

  /** session-runner handleUiRequest 在 handler 缺失时调用（FR-9 可观测性）。
   *  委托 uiObservability：按 session 去重，同一 session 的多次 UI 请求只 warn 一次。
   *  W2: console.warn 兜底。W3 接入 pi.appendEntry("subagent:ui-request-missing-handler", ...)。 */
  notifyMissingHandler(sessionId: string): void {
    this.uiObservability.notifyMissingHandler(sessionId);
  }

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
    // 读取 mode（W4 守卫透传给 session-runner）+ session 级 handler 覆盖。
    this.uiObservability.setMode(init.mode);
    if (init.uiRequestHandler !== undefined) {
      this.uiRequestHandler = init.uiRequestHandler;
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
    // 子进程读 env 建立基线后，createRecordForMode 读 execCtxAls 自动正确（孙挂到子名下）。
    // 根进程无 env → sessionRootId = init.sessionId（自己是 root），execCtxAls 不 enterWith（顶层）。
    // enterWith 贯穿整个 session 生命周期（与 forkDepthAls 同构，决策 4）。
    const envRoot = process.env[ENV_ROOT_SESSION_ID];
    this.sessionRootId = envRoot ?? init.sessionId;
    const envSelfRecord = process.env[ENV_SELF_RECORD_ID];
    if (envSelfRecord !== undefined && envSelfRecord !== "") {
      const envNestingDepth = Number.parseInt(process.env[ENV_DEPTH] ?? "0", 10);
      const nestingDepth = Number.isNaN(envNestingDepth) ? 0 : envNestingDepth;
      // [ALS 断裂修复] 基线兜底：enterWith 在 pi 事件回调模型下不可靠（见 execCtxBaseline 注释），
      // 基线是 createRecordForMode / 护栏读 ALS store 失败时的权威回退。
      this.execCtxBaseline = { recordId: envSelfRecord, depth: nestingDepth };
      this.execCtxAls.enterWith({ recordId: envSelfRecord, depth: nestingDepth });
      if (process.env.XYZ_AGENT_DEBUG) {
        logger.debug(
          `[subagents] execCtxAls initialized: recordId=${envSelfRecord} depth=${nestingDepth} rootSessionId=${envRoot ?? init.sessionId}`,
        );
      }
    }
    // revive（dispose 的逆操作：/resume /fork /new 后复活）
    this._disposed = false;
    this.store.revive();
    this.notifier.revive();
    // 孤儿终态恢复（residual-fixes）：session_start 主动触发一次——父扩展死后再无人写
    // 终态 entry 的 record 在此判定落盘（否则侧栏永久 running）。放 initSession 末尾：
    // setPi 已注入（appendEntry 可用），sessionRootId 已建立（过滤当前根的 record）。
    // 幂等不 throw，失败不阻断 session_start。
    this.recoverOrphanRecords();
  }

  /** 孤儿终态恢复委托（RecordStore.recoverOrphanRecords 的唯一公开入口，维持 store
   *  private 封装——与 recoverManifestTmpFiles 同模式）。判定语义见 store 侧注释。
   *  随后跑 entry-born 孤儿恢复（无子文件锚的 register-only record，spawn 窗口期死亡，
   *  E2E 实测缺口）——主 session 文件经 getMainSessionFile 注入（构造期可空）。 */
  recoverOrphanRecords(): void {
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
      emitPendingUnregister(this.pi, record.id, "closed");
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
    this.setUiRequestHandler(disposedUiRequestStub);
    // [R0/C1 孤儿进程修复] 先 abort running controllers + kill spawned children，再 dispose 资源。
    // abortRunningControllers 需要在 disposeAllRecords archive 之前执行（archive 后 store 找不到 record）。
    this.store.abortRunningControllers();
    killAllSpawnedChildren();
    // SP-4: 级联关闭所有活跃 record（parent-shutdown reason）
    // 在 abort/kill 之后执行：先终止子进程，再清理 record 状态。
    this.disposeAllRecords("parent-shutdown");
    // [v4 A-1] EPIPE 连续失败计数器清零（计数器已迁移到 stdin-writer，防跨 session 泄漏）
    resetAllEpipeFailures();
    // [review MF1] 在途 resume 守卫清空（正常由 runAndFinalize finally 清除；此处兜底
    // abort/kill 后仍挂着的条目，防跨 session 复活时残留）
    this.resumesInFlight.clear();
    // flush 待发通知后 dispose（防丢失）
    this.notifier.flushPendingNotifications();
    this.notifier.dispose();
    this.store.dispose();
  }

  // ── 执行（subagent-tool 调）────────────────────────────

  /** background 完成回注（record → BgNotifyRecord 映射 + notifier.notify）。
   *  正在执行（running + 活进程 + 非 timer-armed）静默跳过——notify 只对 closed（终态）、
   *  isIdle（chatMode 轮次完成）或 isResumable（SP-5 one-shot 成功完成 / MF-6 失败轮回退）有意义。
   *  SP-1: closed 统一终态（done/failed/crashed 合并），closedReason 携带 L2 原因。 */
  private notifyComplete(record: ExecutionRecord): void {
    const notify = this.toNotifyRecord(record);
    if (notify) this.notifier.notify(notify);
  }

  /** [C-1] chatMode close 终态通知（设计 D2：正文空/本轮增量 + sessionFile 指针行）。
   *
   *  与 notifyComplete 的差异只在 dedup 身份与轮次统计：终态通知必须与最后一轮的轮次通知
   *  区分（轮次通知 key=`id:round`），否则同 key 被 60s dedup 吞——close 后父 agent 永远
   *  收不到带指针行的终态通知（审查 C-1）。故 round 置 undefined（key 回退为裸 id），
   *  轮数改经 totalRounds 进文案 "completed after N rounds."（C-2）。
   *
   *  仅 chatMode close 语义调用（closeChatIdle / closeAfterRoundSettled 终态化成功后）。
   *  one-shot 显式拒绝（G4：one-shot close 路径现状无终态通知，字节不变）；cancel 走
   *  cancelBackground 自己的 notifyComplete，不经本方法。幂等性：两条 close 路径均由
   *  closeSubagent 的 status 分流守卫（closed 后幂等 no-op）/ CAS 抢锁保证只执行一次，
   *  本方法自身不重复发送；迟到的 kickOffBackground.then 通知与轮次通知同 key=`id:round`，
   *  60s 窗内仍被吞，不构成第三条。 */
  /** @param emptyBody true = 终态通知正文置空串（D2 路径②）。W16 P-1 修复后
   *  closeChatIdle 的 doneResult.text 改用 record.result 保真（close 终态
   *  subagent-record entry 的 result 不抹空轮终真实值），「正文空」不再由合成空
   *  text 的副作用承载，改为显式参数——持久化 result 与通知正文两个关注点解耦。 */
  private notifyClosed(record: ExecutionRecord, emptyBody = false): void {
    if (!record.chatMode) return;
    const notify = this.toNotifyRecord(record);
    if (!notify) return;
    notify.round = undefined;
    if (emptyBody) notify.result = "";
    if (record.round != null) notify.totalRounds = record.round;
    this.notifier.notify(notify);
  }

  /** notifier 的 NotifierHost 适配器（绑定到 pi.sendMessage + store 查询）。 */
  private piAdapter(): NotifierHost {
    return {
      sendMessage: (message, options) => {
        this.pi?.sendMessage(message, options);
      },
      hasRunningBackground: () => {
        // [M3] 「在跑的 background 工作」= 有活进程且非等待续聊（idle timer armed）。
        // v4 B-1 把旧 idle 折入 running 且 record 留 store：轮次完成的 chatMode record
        // （timer armed、无在跑轮）与 one-shot 完成后等待 message 升级的 record 都不再计入。
        // 旧判定 `mode === "background"` 对这两类恒 true → 轮次完成通知恒挂 60s 合并窗口
        // （notifier MERGE_WINDOW_MS），主 agent 的续聊回复固定延迟 60s 送达，持续对话（G1）失效。
        return this.store.listRunning().some(
          (r) => r.mode === "background" && hasLiveProcessHandle(r.id) && !hasIdleTimer(r.id),
        );
      },
      isIdle: () => this.isIdleFn?.() ?? true,
      // [must-fix #4 / D8] settled 边沿订阅，与 isIdle 同源（session_start 注入的 pi）。
      // 只注入原生订阅能力；disposed 标志包装（退订语义）在 notifier 的 port 装配完成。
      onAgentSettled: (handler) => { this.pi?.on?.("agent_settled", handler); },
    };
  }

  /** record → BgNotifyRecord（notifier.notify 入参映射，内部不外露）。
   *  v4 B-1：守卫放行 closed（终态，含 cancelled）、isIdle（对话模式轮次完成，notify 主 agent G1）
   *  或 isResumable（running + 无活进程——SP-5 one-shot 成功完成 / MF-6 失败轮回退）。
   *  正在执行（running + 活进程 + 非 timer-armed）返回 undefined（调用方 notifyComplete 跳过）。
   *  SP-1: closed 统一终态，closedReason 由 BgNotifyRecord 携带。 */
  private toNotifyRecord(record: ExecutionRecord): BgNotifyRecord | undefined {
    const snap = snapshot(record);
    const s = snap.status;
    // [N1] isResumable 放行：SP-5 one-shot 成功完成后 finalizeRoundToIdle 把 record 回退
    // running-resumable——进程已死且永不 arm idle timer（armIdleTimer 只在 agent_settled 的
    // chatMode 分支调用），旧守卫（closed / isIdle only）对其恒拒绝 → 完成通知静默丢失，
    // 而 one-shot 失败走 finalizeRecord 保持 closed 反而通知——与 tool 契约「runs once,
    // notifies on completion」完全倒置。isResumable = running + 无活进程，恰为该完成态；
    // 在跑轮的 record 有活进程，不会被误放行。
    if (s !== "closed" && !isIdle(record) && !isResumable(record)) return undefined;
    // closed → BgNotifyRecord.closed（cancelled 区分靠 closedReason）；chatMode 的 isIdle/
    // isResumable（轮次完成或 MF-6 失败轮回退，对话可续）→ running（轮次完成）。
    // isResumable 且非 chatMode（SP-5 one-shot 成功完成）→ closed：对主 agent 的语义是
    // completed（非对话轮次），且只有 closed 分支文案携带 worktree patchFile 的 git apply
    // 提示——one-shot worktree 模式的改动回收依赖该提示（running 分支文案不含 patchFile）。
    const notifyStatus: BgNotifyRecord["status"] =
      s === "closed" || !record.chatMode ? "closed" : "running";
    return {
      id: snap.id,
      status: notifyStatus,
      agent: snap.agent,
      model: snap.model,
      result: snap.result,
      error: snap.error,
      startedAt: snap.startedAt,
      endedAt: snap.endedAt,
      patchFile: record.patchFile,
      // round 透传给 notifier 的 dedup key（对话模式按轮次去重，G1 决策 9）。
      round: record.round,
      // SP-1: closedReason 透传给 notifier（L2 原因，供通知文案按需展示）。
      closedReason: record.closedReason,
      // [wave2] chatMode 条件透传 sessionFile：通知末尾追加 Full transcript 指针行
      //（增量语义的全文恢复通道，见 notifier.buildLlmContent）。one-shot（chatMode
      // falsy）不透传——通知输出逐字节不变（G4），该条件由 message-close 测试的
      // 必选用例锁死（漏加条件时 notifier 单测不红——notifier 层只见最终字段）。
      sessionFile: record.chatMode ? record.sessionFile : undefined,
    };
  }

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

    // 通用嵌套深度护栏（D-033）：execCtxAls 记录所有 subagent 嵌套层级（fork + 非 fork），
    // 每层 +1。MAX_FORK_DEPTH 同时限 fork 链与通用嵌套——非 fork 递归虽不累积 session 体积，
    // 但耗资源且 LLM 易陷入「委派→再委派」死循环。在所有副作用之前拦截，错误直达调用方。
    // 计数基准：顶层 nestingDepth=0，nestingDepth>MAX 被拒。与 fork 体积护栏（parentForkDepth 检查）
    // 互补：本护栏更严（计所有嵌套），混合链下先生效；两者共享 MAX_FORK_DEPTH 上限不漂移。
    // [ALS 断裂修复] getStore() 在 pi 事件回调模型下可能读空（enterWith 不贯穿），基线兜底。
    const parentNesting = this.execCtxAls.getStore() ?? this.execCtxBaseline;
    const nestingDepth = parentNesting ? parentNesting.depth + 1 : 0;
    if (nestingDepth > MAX_FORK_DEPTH) {
      throw new ForkDepthExceededError(
        `subagent nesting depth ${nestingDepth} > ${MAX_FORK_DEPTH} (max recursion), refusing to spawn deeper`,
      );
    }

    // mode 固定 background（sync 模式已删除）
    const mode: ExecutionMode = "background";
    const ctx = this.buildSessionRunnerContext(opts.cwd);

    // ── 1. IDENTITY 解析（确认 → agentConfig → resolveModel）──
    const identity = await this.resolveIdentity(opts);

    // ── 1.5 引擎路由（D4 chat 入口分叉；U2 升级为 routeEngine 编排）──
    // 三层解析（调用参数 > agent frontmatter > config.json defaultEngine）仍是同步纯
    // 函数；解析为非 pi 时升级走 routeEngine（probe 编排 + fallback 三守卫）。时机
    // 选择：路由（含 probe）在 record 创建前完成——兜底时 record 直接按 pi 语义创建 +
    // engineFallback 留痕（D5 字节级守护只约束「无 fallback 的纯缺省路径」，兜底路径
    // 的 entry 允许含 engine/engineFallback 字段）；守卫命中/strict 时 routeEngine 在此
    // throw，不产生孤儿 record。
    const routingInput = {
      callEngine: opts.engine,
      agentEngine: identity.agentConfig?.engine,
      globalDefaultEngine: this.modelService.getGlobalConfig().defaultEngine,
    };
    const routing = resolveEngineRouting(routingInput);
    let route: EngineRouteResult | undefined;
    if (routing.engineId !== DEFAULT_ENGINE_ID) {
      route = await routeEngine({
        routing: routingInput,
        // 守卫 c 判据只看调用方显式指定的 model（resolved model 含 ctxModel 兼底，
        // 恒非空会把一切兜底误判为 model 绑定命中）
        taskModel: opts.model,
        strict: this.modelService.getGlobalConfig().engineRouting?.strict === true,
        probe: (engineId) => getEngine(engineId).probe(),
      });
      if (route.engineId !== DEFAULT_ENGINE_ID) {
        return this.executeViaEngine(opts, identity, route);
      }
      // 兜底成功（典型：默认路由 + probe 失败 + 无守卫命中）→ 落回下方 pi 主路径，
      // record 创建时按 pi 语义 + engine/engineFallback 留痕（engine = 实际执行引擎）
    }
    // D5 字节级守护：无 fallback 的 pi 路由剥掉 opts.engine——createRecordForMode
    // 不盖章（pi record entry 序列化产物不得新增 engine 键，undefined 经 JSON 省略）。
    // 兜底路径显式盖 engine='pi' + engineFallback（见上方时机注释）。
    const piOpts =
      route?.engineFallback !== undefined
        ? { ...opts, engine: DEFAULT_ENGINE_ID, engineFallback: route.engineFallback }
        : opts.engine === undefined
          ? opts
          : { ...opts, engine: undefined };

    // ── 2. RECORD 创建 + 注册 ──
    const record = this.createRecordForMode(identity, piOpts, mode);
    emitPendingRegister(this.pi, record.id, record.agent);

    // ── 2.5 worktree 创建（仅 worktree===true 或已传入 handle 时）──
    // record 先创建，worktree 失败时可 finalizeFailed（record 已在 store 中）。
    // worktree 必须显式开启：worktree===true 创建新 worktree；worktree===undefined/false 不创建。
    // fork 不隐含 worktree（UC-1 fork 可独立使用，fork 仅继承上下文，在 parent cwd 跑）。
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
        // fire-and-forget 清理无害）+ early-failed 返回，不进 kickOffBackground（避免子进程白跑）。
        // 实现约束：赋值 → 终态检查 → kickOffBackground 必须在同一同步段，中间禁止插入 await。
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

    // ── 3. MODE 固定 background：signal/controller、priority 固定 ──
    const signal = record.controller!.signal;
    const priority = PRIORITY_BACKGROUND;

    // ── 4-7. background 包 detached 立即返回 id ──
    // background detached 运行对 tool 层不可见，完成由 notify 驱动新 turn。
    const bgDetails = project(record);
    this.kickOffBackground(record, { ...piOpts, worktree: worktreeHandle }, ctx, identity, signal, priority);
    return { mode: "background", subagentId: record.id, sessionFile: record.sessionFile, details: bgDetails };
  }

  /**
   * 按 id 查内存 running record 的只读快照（G3-002 修复）。
   * 不从 session.jsonl 重建（cancel/list 单点查询只关心内存 running record）。
   * 供 tool 层 cancelHandler 翻译 throw 用（id 不存在 / mode / 终态三种错误）。
   * 不存在返回 undefined。
   */
  findRecord(id: string): RecordSnapshot | undefined {
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
  lookupRecordAnyState(id: string): SubagentRecord | undefined {
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
  // 消费确认制）：SP-5 upgrade 后所有 running record 走 chatMode 分支 → deliverMessage
  // 统一投递（热路径 prompt+streamingBehavior / 冷路径 resume），该方法无生产调用方，
  // 其配套三段消费链（push / message_start shift / redeliverPending 补投）全部不可达，
  // 一并移除（详见各文件同步删除）。

  /**
   * idle 投递：resume spawn 开启新一轮对话（设计决策 6 idle 分支）。
   *
   * record 必须 idle（轮次完成、进程已回收、record 留内存）。手动把 status 设回 "running"
   * （M2-A 边界：idle→running 是恢复非终态，绕过 tryTransition——tryTransition 要求当前态
   * running 才 CAS，idle record 直接进 runAndFinalize 会被 tryTransition 拒绝转态）。
   *
   * resume 参数从 record identity 读（防多轮对话模型漂移，探针 P-10）：sessionFile、
   * model、thinkingLevel 均为 record 身份字段（创建时确定、不可变）。maxTurns/schema 等
   * 执行约束第一版不恢复（设计 §5 拆分 1 待验证检查点），agentConfig 用 undefined
   * （pi --session 续写保留上下文，agent 行为由 session 内 messages 决定；M2-B3 messageHandler 可完善）。
   *
   * detached 编排（参照 kickOffBackground）：不 await，runAndFinalize 在 background 跑。
   * chatMode + done 时 runAndFinalize 的 M2-A 分流自动把 record 重新置 idle。并发槽在
   * runAndFinalize 内重新 acquire（轮次间 idle 已 release）；pool.acquire 是排队模型，
   * 池满时排队等待槽位而非 throw（与 execute 一致）。
   *
   * @param record 目标 record（必须 idle）
   * @param text 新一轮消息正文
   * @throws Error record 非 idle / 无 sessionFile / 无 controller
   */
  resumeRound(record: ExecutionRecord, text: string): void {
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
    // 本轮 runAndFinalize 未收尾）时，再次到达（冷路径重入 / EPIPE 兜底）直接拒绝。
    // 触发链：pi 对同一 assistant message 的 tool calls 顺序执行（sequential），tool1 的
    // deliverMessage 在冷路径 resumeRound 返回即 resolve（早于 spawn 注册完成），tool2
    // 立即执行 → getChildByRecord 仍 undefined → 再次冷路径。无此守卫 → 两次 kickOff →
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
        `session unavailable for subagent ${record.id} (session file missing or unreadable). ` +
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

    // detached 编排：runAndFinalize 在 background 跑，pool 重新 acquire（轮次间 idle 已 release）。
    // chatMode + done 时 M2-A 分流自动 finalizeRoundToIdle（record 回 idle、round+1）。
    // [review MF1] 在途标记在 kickOff 前同步设置：resumeRound 返回即生效，后续重入
    // （冷路径 / EPIPE 兜底）在守卫处被拒；runAndFinalize finally 统一清除。
    this.resumesInFlight.add(record.id);
    this.kickOffBackground(record, opts, ctx, identity, record.controller.signal, PRIORITY_BACKGROUND, resume);
  }

  /**
   * [V2 决策 3] chatMode 统一投递：按**进程死活**分流，不按 record.status。
   *
   * V2 进程长驻——chatMode record 首轮 agent_settled 后进轻量 idle（Step 4a：进程保活、
   * idle timer armed），续聊时进程仍在内存，不该重开 session。故续聊投递不按 status
   *（running/idle 都可能是热路径），而是判进程死活：
   *
   *   热路径（进程活）：prompt + streamingBehavior——pi 权威裁决 busy/idle（F3/F4）。
   *     busy（isStreaming）时 followUp 入队/steer 抢占；idle 时 streamingBehavior 被忽略、
   *     直接开新 turn。不用 steer/followUp 命令、不依赖 clearQueue（F8），结构上消除残留。
   *   冷路径（进程死）：复用 resumeRound 重开 session + prompt（仅崩溃/timeout kill/跨重启命中）。
   *
   * disarm idle timer：新 turn 开始必须 disarm（V2 决策 4），防 turn 期间 idle timer 误杀活进程。
   *
   * status 处理：判活分流后**各自**设 running——热路径手动设 running（新 turn 开始）；
   * 冷路径由 resumeRound 校验 idle 并自行设 running + spawn（故不在此预设 running，否则
   * resumeRound 的 idle 检查会 throw）。resume spawn 后 session-runner 回填 record.pid，
   * 热路径拿到 child 时也顺便刷新 pid（resume 重开进程后 pid 已变）。
   *
   * [review 修复] 曾对比的 deliverToRunning（非 chatMode busy 投递 + pendingMessages
   * 消费确认制）已删除——SP-5 upgrade 后无生产调用方（V2 决策 3 已删消费确认制）。
   *
   * @param record 目标 record（chatMode，running 或 idle）
   * @param text 消息正文
   * @param interrupt true=steer（抢占）/ false=followUp（排队），仅热路径 prompt streamingBehavior 用
   */
  async deliverMessage(record: ExecutionRecord, text: string, interrupt: boolean): Promise<void> {
    this.assertReady();
    // 新 turn，disarm idle timer（防 turn 期间误杀活进程，V2 决策 4）
    disarmIdleTimer(record.id);
    const child = getChildByRecord(record.id);
    if (child && !child.killed) {
      // 热路径：进程活，prompt + streamingBehavior（V2 决策 3，pi 权威裁决 busy/idle）
      record.status = "running";
      // 刷新 pid 内存记账（resume spawn 后 child.pid 已变，顺便更新）
      if (child.pid !== undefined) record.pid = child.pid;
      try {
        sendPromptCommand(child, text, { streamingBehavior: interrupt ? "steer" : "followUp" });
        // 热路径成功，清零 EPIPE 连续失败计数（[v4 A-1] 计数器已迁移到 stdin-writer）
        clearEpipeFailure(record.id);
        // [race-F5] 写后死进程检测：write 同步成功只代表数据进了内核 pipe 缓冲，子进程
        // 可能在读取前死亡（gate/idle kill 竞速）。exitCode/signalCode 已非 null = 进程已死
        //（close 事件可能尚未到达），缓冲中的消息将被静默丢弃。只 warn 留证（含 runId 与
        // 消息类型），不抛错不重试：终态回收已由 kill 路径保证，对死进程重试反而可能二次写。
        if (child.exitCode !== null || child.signalCode !== null) {
          logger.warn(
            `[subagents] deliverMessage: child ${record.id} died around stdin write, message may be lost`,
            {
              msgType: interrupt ? "steer" : "followUp",
              exitCode: child.exitCode,
              signalCode: child.signalCode,
            },
          );
        }
        // 轮始执行态信号清除 + 迁移上报（residual-fixes U3 补全，与冷路径 resumeRound
        // 对称）：新一轮开跑 = 无轮终信号——清上一轮 result（§5.4 isStreaming 公式要求
        // result undefined 才显示 streaming）与 resumable，appendEntry 让 runtime/W18
        // 派生缓存失效、GUI 侧从 waiting 切回 spinner。仅在投递成功后清（失败保留
        // 上一轮信号，EPIPE 兜底走 resumeRound 时由其再清）。
        record.result = undefined;
        record.resumable = undefined;
        this.store.reportRecordTransition(record);
      } catch (err) {
        // EPIPE 兜底：stdin 管道已断，进程实际已死但 close 事件尚未到达。
        // 检测 EPIPE 关键词 → 进程按 dead 处理 → 自动转冷路径 resume + 消息重放。
        // [review MF1] 本兜底不持 activateLock，但与冷路径共用 resumeRound 的在途守卫
        //（resumesInFlight）：resume 已在途时兜底的 resumeRound 调用被拒（throw 行动语言），
        // 不会二次 spawn。
        if (err instanceof Error && err.message.includes("EPIPE")) {
          logger.warn(`[subagents] EPIPE on hot path for ${record.id}, falling back to cold path resume`, {
            detail: err.message,
          });
          // 清理 spawnedChildren 中的死进程条目（让 resumeRound 能重新 spawn）。
          // [M4] 按值守卫：仅当 Map 当前值仍是本次写 EPIPE 的 child 才删——若已被 resume
          // spawn 覆盖为新 child（close 事件先于本 catch 到达的极端时序），不误删新注册
          //（与 session-runner removeChildRegistration 同语义）。
          if (spawnedChildren.get(record.id) === child) {
            spawnedChildren.delete(record.id);
          }
          // 递增连续 EPIPE 计数（[v4 A-1] helper 合并同步/异步路径计数）
          const count = recordEpipeFailure(record.id);
          if (count >= EPIPE_FAILURE_THRESHOLD) {
            // 连续达阈值 EPIPE → 不再尝试 resume，throw 含恢复指引
            clearEpipeFailure(record.id);
            throw new Error(
              `[subagents] EPIPE fallback exhausted for ${record.id}: ${count} consecutive EPIPE failures. ` +
                `Recovery: use action:'close' to clean up, then action:'start' a new subagent.`,
            );
          }
          // 冷路径 resume + 原消息重放（v4 B-1: status 已 running，resumeRound CAS 直接放行）
          this.resumeRound(record, text);
          return;
        }
        // 非 EPIPE 错误——不应发生，重新抛出让调用方处理
        throw err;
      }
    } else {
      // 冷路径：进程死（idle timer reap / 崩溃 / 跨重启），record 应为 idle → resume spawn。
      // D3：acquireActivateLock 双保险——注意锁只覆盖 resumeRound 同步段，释放在子进程注册
      //（session-runner spawnedChildren.set）之前（中间隔 pool.acquire await + tempFile 等异步点）。
      // 真正的单写者守卫是 resumeRound 的 resumesInFlight（[review MF1]）：锁释放后、child
      // 注册前到达的第二次冷路径 message 在 resumeRound 处被拒，不会二次 spawn。
      const releaseLock = await acquireActivateLock(record.id);
      try {
        this.resumeRound(record, text);
      } finally {
        releaseLock();
      }
    }
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
  getRecordForAction(id: string, opts?: { allowReconnect?: boolean }): ExecutionRecord {
    this.assertReady();
    let record = this.store.getMutable(id);
    // SP-2 跨重启恢复：内存未命中时，从磁盘 collectRecords 重建 idle record。
    // reconstructAll 已将跨重启 record（无 sidecar + pid 死）标记为 running（v4 B-1 可续聊语义，非 crashed），
    // 直接转为可变 ExecutionRecord register 进内存，供 message/close action 续操作。
    if (!record) {
      record = this.coldLookupForAction(id, opts?.allowReconnect === true);
    }
    if (!record || record.rootSessionId !== this.sessionRootId) {
      throw new Error(
        `subagent not found or not owned: ${id}. Recovery: use action:'list' to confirm the id; ` +
        `ended subagents cannot be messaged — start a new one; only subagents owned by the current session can be operated on.`,
      );
    }
    // [v4 A-5 / P7] 直接父校验：rootSessionId 已确认 record 属于本 session 树，但递归场景下
    // 孙级 record（parentRecordId = 某子进程的 self recordId）的子进程句柄只存在于其直接父
    // 进程内存。主进程（execCtxBaseline=null）若仅凭 rootSessionId 通过就 message 孙级，会走
    // 冷路径重新 spawn → 双写同一 session 文件（P7 双写者窗口）。统一用 baseline recordId 校验：
    //   - 主进程 baseline=undefined → 只能操作 parentRecordId=undefined 的根层 record
    //   - 子进程 baseline="sa-X"    → 只能操作 parentRecordId="sa-X" 的直接孩子
    // record.parentRecordId===undefined 视作根层，仅主进程可操作（身份缺省的旧/异常 record 归此）。
    const baselineRecordId = this.execCtxBaseline?.recordId ?? undefined;
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

  /** SP-2 冷路径（getRecordForAction 内存未命中分支的提取）：从磁盘重建可变 ExecutionRecord
   *  并 register 进内存。[perf] 先走 idToFile 索引直查（单文件 stat 校验），未命中（进程重启后
   *  尚未扫描、索引未热）才全目录 collectRecords 兜底建索引——跨重启后每条 message 从
   *  「readdir + N×4 stat 全扫」降为单文件校验。
   *  @returns 重建的 record；磁盘也无则 undefined
   *  @throws ResurrectDeniedError 可重连候选被 worktree/异进程活实例守卫拦截 */
  /** 冷查候选定位（coldLookupForAction 步骤 1）：idToFile 索引直查 running 命中，
   *  未命中再全目录 collectRecords 兜底（running，或 allowReconnect 且可重连 closed）。 */
  private findColdLookupCandidate(id: string, allowReconnect: boolean): SubagentRecord | undefined {
    const direct = this.store.findLightById(id);
    return (
      (direct?.status === "running" ? direct : undefined) ??
      this.store
        .collectRecords(COLD_LOOKUP_SCAN_LIMIT, "all", undefined)
        .find((r) => r.id === id && (r.status === "running" || (allowReconnect && this.isReconnectableClosed(r))))
    );
  }

  /** 可重连守卫（coldLookupForAction 步骤 2，[v8.5 D]）：先于任何状态突变与注册。
   *  worktree 绑定丢失 / 异进程活实例以 ResurrectDeniedError 抛出（endedMessageGuard
   *  必须原样透传，不得改写为 fork-from 指引误导 agent 走已被判死的通道）；拒绝时
   *  内存不得残留该记录（findRecord 契约）。 */
  private assertReconnectAllowed(found: SubagentRecord, id: string): void {
    if (found.status !== "closed") return;
    if (found.worktree === true) {
      throw new ResurrectDeniedError(
        `subagent ${id} cannot be transparently resumed: it was created with worktree isolation, ` +
        `and its worktree checkout no longer exists after restart (resuming in place would make spawn cwd fall back to the main repo). ` +
        `Recovery: action:'start' a fresh subagent (with a new worktree if isolation is still needed); ` +
        `its conversation history remains intact at ${found.sessionFile}.`,
      );
    }
    const foreign = found.sessionFile ? findForeignLiveInstance(found.sessionFile) : undefined;
    if (foreign) {
      throw new ResurrectDeniedError(
        `subagent ${id} is not transparently resumable: its previous instance still finishing in another process ` +
        `(pid ${foreign.pid}, startedAt=${new Date(foreign.startedAt).toISOString()}). ` +
        `Resuming in place would double-write ${found.sessionFile}. ` +
        `Recovery: retry once that process exits; if it never exits, action:'start' a fresh subagent and treat the history at ${found.sessionFile} as read-only reference.`,
      );
    }
  }

  /** 磁盘候选重建为可变 record 并 register + 上报（coldLookupForAction 步骤 4）。 */
  private resurrectColdRecord(found: SubagentRecord, id: string): ExecutionRecord {
    const record = createRecord(id, {
      agent: found.agent,
      model: found.model,
      thinkingLevel: found.thinkingLevel,
      mode: found.mode,
      task: found.task,
      slug: found.slug,
      startedAt: found.startedAt,
      rootSessionId: found.rootSessionId,
      parentRecordId: found.parentRecordId,
      depth: found.depth,
      // [v4 A-3] 跨重启恢复入口——message 路径磁盘重建无条件置 chatMode=true（现状机制，
      // V3 方案 A 方向兑现）。改动此处必须带 S3 回归场景（跨重启 message 续聊验证）。
      // V3 SP-5 探针定案：机制已存在，本注释即定案，不再悬置。
      chatMode: true,
      controller: new AbortController(),
    });
    record.sessionFile = found.sessionFile;
    record.round = found.round;
    // [review round2] 跨重启 worktree 绑定丢失防护：原 record 创建时启用了 worktree 隔离
    //（session entry 的 worktree 标志），但 WorktreeHandle 不可序列化、重建后恒缺失。
    // 标记 hadWorktree，resumeRound 守卫据此拒绝续聊（防 spawn cwd 静默回落主 repo 破坏
    // 隔离——正是 worktree 要防的并发写冲突场景）。close 不受影响（closeChatIdle 走
    // doFinalizeRecord，泄漏的 worktree 由 reaper 兜底回收）。
    record.hadWorktree = found.worktree === true;
    // [v8.5 D] 透明重生回边：独立函数不走 tryTransition 单向语义（closed 单向性对正常
    // 执行流完整保留）；准入唯一依据 = A 档 sidecar 真实死因 ∈ 可重连集。死亡语义位由
    // resurrectClosed 清除；register 后立刻上报 transition entry，live/reload 视图同步
    // 翻回 running（等价性由 applyEntry reducer 保证，对齐 SP-2 重建即报告先例）。
    if (found.status !== "running") {
      // [review MF-8] 磁盘终态位同步翻转：record-store buildRecord 分支 2（.finalized
      // 存在 → closed）优先级高于 .alive 活态分支 3，重生若不删 sidecar，任何磁盘扫描
      // （异进程 / reload / session-reader）都会把本进程内存里 running 的 record 报成
      // closed/disconnected——破坏 live ≡ reload，且为跨进程二次 resurrect 开门。
      // best-effort 对齐 BC-4 语义；.alive 刷新为当前进程（后续 resume spawn 会覆盖写）。
      if (record.sessionFile) {
        try {
          fs.rmSync(`${record.sessionFile}.finalized`, { force: true });
          writeAliveMarker(record.sessionFile, { pid: process.pid, id, startedAt: Date.now() });
        } catch (_e) {
          void _e; // best-effort：sidecar 翻转失败不阻断重生主流程
        }
      }
      resurrectClosed(record);
    }
    this.store.register(record);
    if (found.status !== "running") {
      this.store.reportRecordTransition(record);
    }
    return record;
  }

  private coldLookupForAction(id: string, allowReconnect: boolean): ExecutionRecord | undefined {
    const found = this.findColdLookupCandidate(id, allowReconnect);
    if (!found) return undefined;
    // [v8.5 D] 可重连候选的守卫先于任何状态突变与注册（细节见 assertReconnectAllowed）
    this.assertReconnectAllowed(found, id);
    // [review MF-9] 归属校验先于任何持久化副作用：coldLookup 是 getRecordForAction 的
    // 内存未命中分支，若先 resurrect/register/report 再由调用方抛归属错误，会在磁盘/
    // 内存留下幽灵 running record + running transition entry（跨进程双 resurrect 窗口）。
    // rootSessionId 不匹配 → 返回 undefined，由 getRecordForAction 抛统一「not found or
    // not owned」（不区分失败形态，防跨 session 探测）；parentRecordId 跨层不匹配 →
    // 原样抛 direct parent 错误（与外层校验同文案，保留跨层导航指引）。
    if (found.rootSessionId !== this.sessionRootId) {
      return undefined;
    }
    const baselineRecordId = this.execCtxBaseline?.recordId ?? undefined;
    if (found.parentRecordId !== baselineRecordId) {
      throw new Error(
        `subagent ${id} is owned by its direct parent; message it through that parent ` +
        `(see /subagents list, parent=${found.parentRecordId ?? "(root layer)"}). [v4 A-5] cross-layer ` +
        `ownership guard: this process's baseline=${baselineRecordId ?? "(root)"} is not the direct parent of ${id}; ` +
        `operating here would race the owning child process's handle and double-write the session file.`,
      );
    }
    return this.resurrectColdRecord(found, id);
  }

  /** [v8.5 D] 冷查候选过滤：closed 且死因落在可重连集。判定源 = closedReason（buildRecord
   *  归一化后的对外字段：A 档真实死因直通、旧空 sidecar 兑底 disconnected——SubagentRecord
   *  不暴露 raw finalizedReason）；cancelled/user-close/gc 等主动关闭与自然完成死因天然不在集合内。
   *  防线在集合本身而非调用点。 */
  private isReconnectableClosed(r: SubagentRecord): boolean {
    return isReconnectableFinalReason(r.closedReason);
  }

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
  async closeSubagent(record: ExecutionRecord, force: boolean): Promise<void> {
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
        emitUnregister: (id, st) => emitPendingUnregister(this.pi, id, st),
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
    this.notifyClosed(record, true);
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
    this.notifyClosed(record);
  }

  // ── 编排层专用接口（workflow 消费）──────────────────────

  /**
   * workflow 编排层专用：sync-await 接口，内部走 background 管道但返回 Promise<AgentResult>。
   *
   * 与 execute() 的区别（D-A1）：
   *   1. 返回 workflow AgentResult（content 字段），非 ExecutionHandle
   *   2. 不调 kickOffBackground → 不注入 followUp 完成通知（BC-11，结果直接返回 workflow）
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

    // ── BC-12 嵌套护栏：复用 execute() 的 execCtxAls 深度检查 ──
    // [ALS 断裂修复] getStore() 可能读空，基线兜底（与 execute 同）。
    const parentNesting = this.execCtxAls.getStore() ?? this.execCtxBaseline;
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
    emitPendingRegister(this.pi, record.id, record.agent);

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
  onChange(listener: () => void): () => void {
    return this.store.onChange(listener);
  }

  /** 列出 running record 快照（widget 计数用）。 */
  listRunning(): RecordSnapshot[] {
    return this.store.listRunning();
  }

  /** 合并内存(running) + 磁盘(session.jsonl 重建) record（/subagents list + tool list 消费）。
   *  按 rootSessionId 过滤：根进程=本 session（sessionRootId===sessionId）；
   *  子进程=env 贯穿的真 ROOT（sessionRootId≠sessionId）→ 看到整棵 ROOT 树（决策 3）。
   *  [perf] 磁盘源为 light（头部 identity + 状态，无 eventLog/result/turns 等重数据）
   *  ——列表/补全/hasRunning 够用；详情场景调 getFullRecord(id) 懒加载补齐。 */
  collectRecords(limit: number, statusFilter: StatusFilter = "all"): SubagentRecord[] {
    return this.store.collectRecords(limit, statusFilter, this.sessionRootId ?? this.sessionId ?? undefined);
  }

  /** [perf] 单 record 详情懒加载（全量：eventLog/displayItems/result/turns/tokens）。
   *  内存 running record 直接投影；磁盘 record 全量重建（per-file 缓存，stat 戳校验）。
   *  返回 undefined：id 不存在于内存与磁盘。 */
  getFullRecord(id: string): SubagentRecord | undefined {
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
    // B run() 期间包了 execCtxAls，B 内创建 C 时读到 B → C.parentRecordId=B.id, C.depth=B.depth+1。
    // depth 语义：顶层（无父）=0；有父=父 depth+1。靠 recordId 是否存在区分，不用负数魔数。
    // [ALS 断裂修复] getStore() 在 pi 事件回调模型下可能读空（enterWith 不贯穿），
    // 基线兜底——本进程的身份在 initSession 已确定（env 注入），任何上下文下都能正确挂父链。
    const parentCtx = this.execCtxAls.getStore() ?? this.execCtxBaseline;
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
   * 路由到非 pi 引擎的执行入口：routeEngine（注册表校验 + probe/守卫）已由 execute
   * 完成——这里只剩 unsupported 预检 → record 创建+盖章 → detached 引擎 run。
   * 全部同步拒绝发生在 record 创建前（不产生孤儿 record）。
   */
  private executeViaEngine(
    opts: ExecuteOptions,
    identity: ResolvedIdentity,
    route: EngineRouteResult,
  ): ExecutionHandle {
    const engine = route.engine;
    this.assertEngineParamSupport(engine, opts);
    // record 盖章路由结果（D5 仅 pi 缺省不盖章；非 pi 显式留痕，createRecordForMode
    // 经 opts.engine/engineFallback 读入 record identity——engine 为实际执行引擎，
    // fallback 路径 from=请求引擎留痕，probe 通过的常态路径恒缺省）
    const record = this.createRecordForMode(
      identity,
      {
        ...opts,
        engine: route.engineId,
        ...(route.engineFallback !== undefined ? { engineFallback: route.engineFallback } : {}),
      },
      "background",
    );
    emitPendingRegister(this.pi, record.id, record.agent);
    this.kickOffEngineRun(record, opts, engine);
    return { mode: "background", subagentId: record.id, sessionFile: record.sessionFile, details: project(record) };
  }

  /**
   * 非 pi 引擎的 unsupported 参数预检（D11 处置「调用前拒绝」的判据 = capabilities）。
   * conversation / fork / worktree 三参数对首期接入的引擎（zcode）均不可用：
   * conversation 依赖同进程 idle 复用、fork 依赖父 pi session 上下文继承、worktree 依赖
   * 文件隔离（capabilities.sandbox='none'）。同步 throw，文案含 capabilities 依据与恢复指引。
   */
  private assertEngineParamSupport(engine: EnginePort, opts: ExecuteOptions): void {
    const caps = engine.capabilities();
    if (opts.conversation === true && caps.conversation === "unsupported") {
      throw new EngineError(
        "engine_capability_unsupported",
        `engine '${engine.id}' 不支持 conversation（capabilities.conversation = 'unsupported'，` +
          `spawn 单轮模式无同进程 idle 复用，message/close 交互控制面不可用）`,
        `改用 engine: pi（支持 conversation 续聊），或不传该参数（一次性任务默认形态）`,
      );
    }
    if (opts.fork === true || opts.forkFromSessionFile !== undefined) {
      throw new EngineError(
        "engine_capability_unsupported",
        `engine '${engine.id}' 不支持 fork${opts.forkFromSessionFile !== undefined ? "（fork-from 同为父 pi session 上下文继承）" : ""}（fork 依赖父 pi session 上下文继承，` +
          `capabilities.steer = '${caps.steer}'——非 pi 引擎无父 session 分叉通道）`,
        `把所需父上下文写进 task 正文后不传 fork，或改用 engine: pi`,
      );
    }
    if ((opts.worktree === true || typeof opts.worktree === "object") && caps.sandbox === "none") {
      throw new EngineError(
        "engine_capability_unsupported",
        `engine '${engine.id}' 不支持 worktree 隔离（capabilities.sandbox = 'none'，` +
          `引擎未接文件系统隔离层）`,
        `改用 engine: pi（worktree 隔离可用），或不传该参数（在 parent cwd 执行）`,
      );
    }
  }

  /**
   * 非 pi 引擎的 detached 执行编排（与 kickOffBackground 同构的 background 语义）：
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
          this.notifyComplete(record);
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
   * 落 entry 前）→ 终态迁移。bg notify 归编排侧（与 kickOffBackground 收尾通知归编排对称）。
   */
  private async runEngineTask(
    record: ExecutionRecord,
    opts: ExecuteOptions,
    engine: EnginePort,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const journal = new JournalWriter({
      path: resolveJournalPath(getEngineDataDir(), engine.id, "shared", record.id),
      taskId: record.id,
      engineId: engine.id,
    });
    const retargetJournal = (poolKey: string): void => {
      journal.retarget(resolveJournalPath(getEngineDataDir(), engine.id, poolKey, record.id));
    };
    // 对齐点③：journal 路径权威 = 引擎声明的池 key（writer 初始用占位，retarget 后
    // 与 handle.poolKey 同源）。模式对齐 SAR 的 journalingOnEvent：先落盘再转发。
    const runCtx: RunContext = {
      taskId: record.id,
      poolKey: "shared",
      signal,
      ctxModel: opts.ctxModel,
      onEvent: (event) => journal.append(event),
      onPoolResolved: retargetJournal,
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
      // execCtxAls 包在 forkDepthAls 内层：B run() 期间它的 store={recordId:B.id,depth:B.depth}，
      // B 内创建 C 时 createRecordForMode 读到 B → C 挂到 B 名下。两层 ALS 独立但同生命周期。
      result = await this.forkDepthAls.run(effectiveDepth, () =>
        this.execCtxAls.run(
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
    //（同 id:round 60s 内吞，kickOffBackground.then 的 notify 是 no-op，见 notifier.ts L122）。
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

  /** background 的步骤 4-6：包进 detached promise（不 await），execute 立即返回。 */
  private kickOffBackground(
    record: ExecutionRecord,
    opts: ExecuteOptions,
    ctx: SessionRunnerContext,
    identity: ResolvedIdentity,
    signal: AbortSignal | undefined,
    priority: number,
    /** resume 选项（M2-B1）：透传 runAndFinalize→runSpawn。undefined = 新 session。 */
    resume?: SpawnResumeOpts,
  ): void {
    // 创建 streaming 生命周期对象。策略（含 widget 退役步骤 2：GUI + relay 激活时停发
    // 私货、TUI/未激活原样创建、sink 未注入降级 undefined）集中在 createBackgroundStream。
    const stream = createBackgroundStream(record.id, this.streamSink, ctx.mode, process.env);

    void this.runAndFinalize(
      record, opts, ctx, identity, signal, priority,
      undefined, stream, resume,
    )
      .then(() => {
        // background 回注：仅当本路径抢到 CAS（closedReason 非 cancelled）才 notify。
        // cancel 抢先时 closedReason='cancelled'，cancelBackground 自己 notify，此处跳过。
        if (record.closedReason !== "cancelled") {
          this.notifyComplete(record);
        }
      })
      .catch((err: unknown) => {
        // detached 吞错：runAndFinalize 内部已 finalize record（含 emitPendingUnregister），
        // 且 finalizeRecord 的 manifest 写入已降级为 best-effort（失败仅 logger.error + appendEntry，
        // 不外抛）。因此此处不应走到——但作为最后一道兼底，记录调试日志后吞下，不外抛。
        // 完成通知由 finalizeRecord 内的 emitPendingUnregister 承担（pending-notifications 消费）。
        // cancel 抢先时 status=cancelled，cancelBackground 自己 emit，此处无需重复。
        if (err instanceof Error) {
          logger.debug(`[subagent] background finalize error (record=${record.id}): ${err.message}`);
        }
      });
  }

  /** 取消 background record。CAS 抢锁——抢到则 notify + 写 tombstone。 */
  private cancelBackground(record: ExecutionRecord): boolean {
    record.controller?.abort();
    // [M6] 显式 kill + disarm：chatMode 首轮 agent_settled 后 runSpawn 提前 resolveRun(0)
    // 返回，`opts.signal.removeEventListener("abort", onAbort)`（session-runner runSpawn 尾部）
    // 已移除 abort→kill listener；热路径续聊轮（deliverMessage 直接 sendPromptCommand）不再
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
    emitPendingUnregister(this.pi, record.id, "closed");
    // cancel 完成通知（与 kickOffBackground.then 对称——cancel 抢先时 .then 跳过 notify）
    this.notifyComplete(record);
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
        emitUnregister: (id, st) => emitPendingUnregister(this.pi, id, st),
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
        emitUnregister: (id, st) => emitPendingUnregister(this.pi, id, st),
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
      // 轻量 idle 化（选项 1）：设 record.status=idle + round+=1 让 notify 守卫放行 + notify
      // 主 agent，但**不调 doFinalizeRoundToIdle**（不 emitUnregister /
      // 不 redeliver——V2 要删的副作用都不做）。runAndFinalize 检测到 status=idle 后 early return，
      // 不进现有 chatMode 分流。Step 5 删 idle 状态机时统一清理这个过渡 idle。
      // 防箭头函数 this 丢失：用箭头函数捕获 SubagentService 实例 this。
      onRoundSettled: (record) => {
        // v4 B-1：status 保持 running（旧 idle 折入 running）；session-runner 已 arm idle timer，
        // isIdle=true 让 notify 守卫放行（时序：armIdleTimer → onRoundSettled，见 session-runner.ts:670）。
        // round 可能初始 undefined（与 notifier.ts `record.round ?? 0` 兜底一致），
        // 首轮 0+1=1。round 是 notifier dedup key 的组成部分，递增后同 id 下一轮不被 60s dedup 吞。
        record.round = (record.round ?? 0) + 1;
        // [N2][增量] 轮次回复写点（增量语义）：roundText 自 roundBaseTurnIndex 起派生本轮增量
        //（undefined 视为 0——首轮增量 = 全量，与改造前首轮逐字节一致）。成功轮次的 MF-2 原写点
        //（doFinalizeRoundToIdle）不可达——agent_settled 恒 arm idle timer → runAndFinalize 恒
        // early return。写入 record.result 后再 notify；本轮无非空增量且无 lastError（纯工具轮 /
        // interrupt 抢占轮 / 模型空回复）时固定占位 "(no output this round)"（D5：增量语义下沿用
        // 旧 record.result = 上一轮增量 → 本轮通知正文 = 上一轮内容，父 agent 误读为原样重复回复；
        // lastError 兜底保留让失败轮通知可读）。后续 closeAfterRoundSettled 的合成 result 读
        // record.result，同样携带本轮增量。
        const roundText = getFullTextFrom(record, record.roundBaseTurnIndex ?? 0);
        record.result = roundText ||
          (record.lastError ? `round did not complete: ${record.lastError}` : "(no output this round)");
        // 先送达本轮增量（notify），再推进 base / 消费 closeAfterRound——终态通知由
        // closeAfterRoundSettled / closeChatIdle 的 notifyClosed 显式发出（dedup 身份为裸 id，
        // 与本次 round notify 的 id:round key 区分），保证「本轮增量 + 终态通知」都送达；
        // kickOffBackground.then 的冷路径 notifyComplete 仍与本次 round notify 同 key 被 60s
        // dedup 吞（不构成第三条）。
        //
        // 幂等性（覆盖面如实限定）：同步路径 at-least-once——notifyComplete（同步 void）抛错时
        // 推进/消费被跳过 → base 不推进 → 增量未消费，下轮 roundText 必含本轮文本（重发载体为
        // 后续轮次增量拼接）。kickOffBackground.then 的冷路径 notifyComplete 不构成重发通道
        // （notifier dedup.set 与 pending.splice 均先于 sendMessage，同 key `${id}:${round}`——
        // round 已递增——60s 窗内重入被吞）。异步 flush 窗口不保证：合并 timer armed（其他 busy
        // background 在场）或 isIdle 退避期间 notify 的『成功』只是入队，实际 sendMessage 发生在
        // base 推进之后的异步时机；该窗口进程崩溃或 sendMessage 失败 → 丢失不可重发（现状全量
        // 重发的次轮自愈在增量语义下消失），wave1 期恢复通道仅父 agent 经 /subagents 详情读取
        // record.result，wave2 指针行落地后补全。反序（先推进后 notify）在同步路径 notify 失败时
        // 静默丢增量且无任何重算机会，故 notify 后推进是定案。重复发送由 notifier dedup key
        // 60s 窗界定。
        this.notifyComplete(record);
        // R1 观测哨（不变式违反形态）：推进前检查末 turn 未闭合且 text 非空——pi 现序下不可达
        //（带 usage 的 message_end 恒先于 turn_end，settle 时 turn 全闭合，见 types.ts
        // roundBaseTurnIndex 注释的行号锚定），ES1 单测自造事件序列锁不住 pi 层变化；pi 升级若
        // 改变 turn_end/agent_end 时序，此哨兵留痕（该形态下公式仍把文本计入本轮，不丢数据）。
        const lastTurn = record.turns[record.turns.length - 1];
        if (lastTurn !== undefined && !lastTurn.closed && lastTurn.text.length > 0) {
          logger.warn(
            `[subagents] round settle with unclosed non-empty turn (record=${record.id}, turnIndex=${record.turns.length - 1}) — pi turn_end/agent_end ordering may have changed`,
          );
        }
        // [增量] base 推进（notify 之后）：下一轮增量从本轮边界起。滞后空 turn 不计入边界
        //（防御分支，留在下一轮增量内防丢文本——nextRoundBaseTurnIndex 注释）。
        record.roundBaseTurnIndex = nextRoundBaseTurnIndex(record);
        // 轮终迁移持久化（residual-fixes U3 补全）：热路径轮终不经 doFinalizeRoundToIdle
        //（agent_settled 恒 arm idle timer → runAndFinalize 恒 early return，MF-2 原写点
        // 不可达）——不 appendEntry 则 runtime/W18 派生缓存不失效，renderer 停留在
        // register 快照（无 result），chat 等续聊的 waiting 形态显示不出来、spinner
        // 卡死。显式上报：entry 携带本轮 result/round/chatMode（§5.4：result 有值 +
        // chatMode=true → waiting）。closeAfterRound 的终态 entry 在此后追加，序不变。
        this.store.reportRecordTransition(record);
        // [M5] closeAfterRound 消费点：chatMode 每轮完成的统一汇聚点（热路径轮不经
        // runAndFinalize CAS 分支——agent_settled 恒 arm idle timer → runAndFinalize 恒
        // early return，旧消费点对 chatMode 不可达，标志置了无人消费、tool 谎报 closed:true）。
        if (record.closeAfterRound) {
          record.closeAfterRound = undefined;
          void this.closeAfterRoundSettled(record);
        }
      },
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
