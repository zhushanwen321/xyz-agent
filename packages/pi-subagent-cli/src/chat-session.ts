// src/chat-session.ts
//
// [v1.x] chat 会话管理器（chat-domain 设计 §3.2 D1-A 引擎侧 / impl-plan W2）。
//
// chat 域轮次迁入引擎进程后的长驻会话状态面：spawn 长驻 pi rpc 子进程（agent_end 不
// kill——对齐 core chatMode「进程长驻」语义）+ 轮次追踪 + host/roundLifecycle 三相位
// 上报 + interact 控制面（message/close/cancel）。
//
// HostChatRoundTicket 五字段过协议映射（设计 §3.2 D1「五字段过协议映射」逐字段落点）：
//   - record   → run.params.chat.recordId（首轮）/ handle.sessionRef.recordId（interact
//                定位）；resume 锚点 = run.params.chat.resume（冷续）；
//   - opts     → run.params.task + ctx（prompt/maxTurns/conversation/idleTimeoutMs 等引擎
//                消费子集；idleTimeoutMs 本引擎不消费——idle 定时器归 core，见下）；
//   - signal   → run.params.ctx 的 cancel 帧（server 层 AbortController → SIGTERM）与
//                interact cancel（本文件 cancel 收敛语义）；
//   - stream   → host/streamDelta（首轮 runId 键 / 续聊轮 recordId 键——D1-A 裁定：
//                interact 轮无独立 runId）；
//   - priority → 不进协议（core 侧调度，引擎不消费）。
//
// 归属边界（host-bridge.ts 头注裁定，协议形态下的等价复刻）：
//   - idle + activate lock 定时器归 core——本引擎不实现 idle 定时器，只在 agent_settled
//     （pi 的真空闲边界：agent_end 之后、post-run 完成后才 emit）上报 idle 相位（带
//     usage + anchor 回填），core 据此 arm 自己的 idle timer；
//   - sendPromptCommand / EPIPE 兜底 / 冷续轮 resume 归 pi 包（本文件 + stdin-writer）：
//     热路径 message 直写 stdin，冷路径（进程死）返回 engine_session_not_resumable +
//     冷续指引（宿主经新 run chat+resume 接续——D1-A，引擎不自发 resume）。
//
// 轮次边界定义（pi 上游语义，node_modules dist 核实）：
//   - pi 的 agent loop 在排空 steering + followUp 双队列后才 emit agent_end（非 willRetry）
//     → 轮次 = 一次投递到下一次 agent_end（排空）；goal continuation 类扩展注入的
//     followUp 使 agent_end 带 willRetry=true（不算轮终）；
//   - agent_settled = 真空闲边界（agent_end 后 post-run 完成），idle 相位的锚点。

import {
  CANCEL_SETTLE_GRACE_MS,
  getLogger,
  killChain,
  type AgentEvent,
  type AgentUsage,
  type HostRoundLifecycleParams,
  type HostStreamDeltaParams,
  type InteractResult,
  type ProtocolError,
  type ResumeAnchor,
  type UiRequest,
  type UiResponse,
} from "@zhushanwen/subagent-engine-sdk";

import { PI_POOL_KEY } from "./constants.ts";
import { toErrorMessage } from "./error-message.ts";
import type { EngineStream } from "./port-types.ts";
import {
  getActiveChild,
  runSpawnOnce,
  type SpawnRunCallbacks,
  type SpawnRunParams,
  type SpawnRunResult,
} from "./spawn-runner.ts";
import {
  clearEpipeFailure,
  EPIPE_FAILURE_THRESHOLD,
  recordEpipeFailure,
  sendPromptCommand,
} from "./stdin-writer.ts";

const logger = getLogger("chat-session");

/** chat 面杀链优雅窗口（对齐 run 域 PI_KILL_GRACE_MS 现状值 30s——升级路径同构）。 */
const CHAT_KILL_GRACE_MS = 30_000;

/** 引擎 → 宿主反向通道发射面（server 构造后注入；roundLifecycle/streamDelta 为 v1.x 新面）。 */
export interface ChatHostChannels {
  /** host/streamDelta（续聊轮 recordId 键形态；首轮 runId 键经 server 既有 run wiring）。 */
  streamDelta(params: HostStreamDeltaParams): void;
  /** host/roundLifecycle（三相位；键形态由会话状态决定：首轮 runId / 续聊 recordId）。 */
  roundLifecycle(params: HostRoundLifecycleParams): void;
  /** host/askUser（chat 会话跨 run 存活，runId 固定为 spawn 轮的 runId——W3 消费注意）。 */
  askUser(runId: string, request: UiRequest): Promise<UiResponse>;
}

/** startRound 的宿主回调面（server 注入：首轮事件通知 + run 键 delta + handle 回填）。 */
export interface ChatRoundStartOptions {
  /** spawn 轮的 runId（首轮 roundLifecycle/streamDelta 关联键 + askUser 关联键）。 */
  runId: string;
  /** 首轮 AgentEvent 出口（→ `event` 通知，runId + seq 由 server 层组装）。 */
  onEvent(event: AgentEvent): void;
  /** 首轮 text_delta 出口（runId 键——经 server 既有 stream wiring）。 */
  stream?: EngineStream;
  onHandleReady?(partial: { sessionRef: Record<string, string>; poolKey: string }): void;
  onChildSpawned?(pid: number, recordId: string): void;
}

/** 会话内轮次用量累加器（message_end 增量求和）。 */
interface RoundUsageAcc {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | undefined;
}

/** 长驻 chat 会话（recordId 锚定；子进程退出即消亡——冷续走新 run）。 */
interface ChatSession {
  readonly recordId: string;
  /** spawn 轮的 runId（首轮关联键来源）。 */
  readonly spawnRunId: string;
  sessionFile?: string;
  sessionId?: string;
  /** spawn 轮（首个 run）是否已收口：true = 后续轮事件改用 recordId 关联键（D1-A）。 */
  firstRoundDone: boolean;
  /** 轮次进行中（prompt 已投递、agent_end 排空未到）。 */
  roundActive: boolean;
  /**
   * 轮次 arm 序号（spawn 首轮 = 1，deliverMessage 每次投递递增）。与 settledSeq 比对
   * 判定 agent_settled 到达前是否有新轮 arm（S6：settled→idle 间隙投递场景）。
   */
  armedSeq: number;
  /** 最近一次 settled 相位发射时点的 armedSeq 快照（undefined = 尚未发射过 settled）。 */
  settledSeq: number | undefined;
  usage: RoundUsageAcc;
  lastRoundUsage?: AgentUsage;
  /** 轮终等待体（cancel 收敛判据：settled/idle/failed 相位发射时逐一 resolve）。 */
  readonly roundTerminalWaiters: Set<() => void>;
  /** 优雅关闭标记（close force:false 且轮进行中：agent_settled 后收割子进程）。 */
  closeAfterRound: boolean;
  /** 子进程已退出（会话终态）。 */
  closed: boolean;
  /** 引擎主动杀的原因（failed 相位错误码分诊：cancel/close/superseded vs 外部崩溃）。 */
  killReason: "cancel" | "close" | "superseded" | undefined;
  /** spawn 时 delta 通道是否开启（续聊轮 recordId delta 仅在开启时发射，粒度请求一致）。 */
  readonly streamEnabled: boolean;
}

/** 会话 spawn 执行器（缺省 runSpawnOnce chatMode 形态；测试注入 fake）。 */
export type ChatSpawnExecutor = (
  params: SpawnRunParams,
  callbacks: SpawnRunCallbacks,
) => Promise<SpawnRunResult>;

/** ChatSessionRegistry 构造依赖。 */
export interface ChatSessionRegistryDeps {
  spawnRunner?: ChatSpawnExecutor;
}

function emptyUsage(): RoundUsageAcc {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: undefined };
}

function toAgentUsage(acc: RoundUsageAcc): AgentUsage {
  return {
    input: acc.input,
    output: acc.output,
    cacheRead: acc.cacheRead,
    cacheWrite: acc.cacheWrite,
    ...(acc.cost !== undefined ? { cost: acc.cost } : {}),
  };
}

/** 冷续锚点（ResumeAnchor = EngineHandleData 定位键投影，W1 SDK 契约）。 */
function anchorOf(session: ChatSession): ResumeAnchor {
  return {
    sessionRef: {
      recordId: session.recordId,
      ...(session.sessionFile !== undefined ? { sessionFile: session.sessionFile } : {}),
    },
    poolKey: PI_POOL_KEY,
  };
}

/** 轮次关联键：spawn 轮 = runId（W1「run 会话形态首轮」），续聊轮 = recordId（D1-A）。 */
function roundKeyOf(session: ChatSession): { runId: string; recordId?: undefined } | { recordId: string; runId?: undefined } {
  return session.firstRoundDone ? { recordId: session.recordId } : { runId: session.spawnRunId };
}

/** cancel/close 强杀在途轮的 failed 相位错误（引擎主动中止——如实上报，非 completed 谎报）。 */
function roundAbortedError(recordId: string, source: string): ProtocolError {
  return {
    code: "engine_round_aborted",
    message: `chat round for ${recordId} was aborted by host (${source}): in-flight round terminated before settling`,
    recovery: `The session file on disk is intact; dispatch a new run with ctx chat resume to cold-resume the conversation, or start a new chat session.`,
  };
}

/** 子进程异常死亡的 failed 相位错误（非引擎发起——外部信号/崩溃）。 */
function roundCrashedError(recordId: string, exit: { exitCode?: number; signal?: string }): ProtocolError {
  const detail = exit.signal !== undefined ? `signal ${exit.signal}` : `exit code ${String(exit.exitCode)}`;
  return {
    code: "engine_round_crashed",
    message: `pi child for chat session ${recordId} died mid-round (${detail}); last streamed output is incomplete`,
    recovery: `Inspect the engine stderr tee (logs/pi-task-stderr-<pid>.log) for the crash cause, then cold-resume via a new run with ctx chat resume if the session file is intact.`,
  };
}

/** EPIPE 兜底耗尽的 failed 相位错误（stdin 管道断——引擎自知失败，D1-A 点名场景）。 */
function roundEpipeExhaustedError(recordId: string, count: number): ProtocolError {
  return {
    code: "engine_round_epipe_exhausted",
    message: `EPIPE fallback exhausted for ${recordId}: ${count} consecutive stdin write failures (child process likely exited)`,
    recovery: `Use interact close to clean up the dead session, then dispatch a new run with ctx chat resume (or a fresh chat session).`,
  };
}

/** 冷路径统一拒绝（D1 推论：指向冷续 run chat+resume，引擎不自发 resume）。 */
function coldPathReject(recordId: string): InteractResult {
  return {
    ok: false,
    code: "engine_session_not_resumable",
    message:
      `the pi session behind record ${recordId} has no live process in this engine instance (cold path). ` +
      `Recovery: dispatch a new run with ctx chat resume (pi --session cold resume), or start a new chat session.`,
  };
}

/**
 * chat 会话注册表（引擎进程内的长驻会话状态面）。
 *
 * 生命周期：startRound（首轮/冷续 spawn）建立会话 → 首轮 agent_settled 后 run 应答、
 * 进程保活 → interact message 续聊轮（recordId 键事件）→ interact close / cancel /
 * 子进程退出消亡。dispose 收割由 spawn-runner 的 killAllActiveChildren 兜底（PiEngine
 * dispose 调用），会话条目随子进程 close 事件自清。
 */
export class ChatSessionRegistry {
  private readonly executor: ChatSpawnExecutor;
  private channels: ChatHostChannels | undefined;
  private readonly sessions = new Map<string, ChatSession>();

  constructor(deps: ChatSessionRegistryDeps = {}) {
    this.executor = deps.spawnRunner ?? runSpawnOnce;
  }

  /** server 构造后注入反向通道发射面（未注入 = 无宿主面：帧丢弃 + askUser 自动 cancelled）。 */
  bindHostChannels(channels: ChatHostChannels | undefined): void {
    this.channels = channels;
  }

  /** recordId 是否有活会话（interact 路由判据；不建立会话）。 */
  has(recordId: string): boolean {
    const s = this.sessions.get(recordId);
    return s !== undefined && !s.closed;
  }

  /**
   * run 会话形态入口（首轮 + 冷续）：spawn 长驻子进程 + 首轮 prompt，本轮 agent_settled
   * （真空闲）时 resolve（exit 0 口径，进程保活——对齐 inproc chatMode 首轮 resolve 语义）。
   * resume 锚点存在 = 冷续（--session 续写原文件），不存在 = 首轮新建。
   */
  async startRound(params: SpawnRunParams, opts: ChatRoundStartOptions): Promise<SpawnRunResult> {
    // 同 recordId 旧会话残留防御（宿主冷续前未走 close）：先收割旧进程再重建，
    // 保证「每 session 单写进程」（spawn-args 不变量）。
    const stale = this.sessions.get(params.recordId);
    if (stale !== undefined && !stale.closed) {
      stale.killReason = "superseded";
      const oldChild = getActiveChild(params.recordId);
      if (oldChild !== undefined && !oldChild.killed) {
        void killChain(oldChild, {
          graceMs: CHAT_KILL_GRACE_MS,
          unrefTimers: true,
          escalationNote: `chat session ${params.recordId} (source: superseded by cold resume)`,
        });
      }
      this.sessions.delete(params.recordId);
    }

    const session: ChatSession = {
      recordId: params.recordId,
      spawnRunId: opts.runId,
      firstRoundDone: false,
      roundActive: true,
      armedSeq: 1,
      settledSeq: undefined,
      usage: emptyUsage(),
      roundTerminalWaiters: new Set(),
      closeAfterRound: false,
      closed: false,
      killReason: undefined,
      streamEnabled: opts.stream !== undefined,
    };
    this.sessions.set(params.recordId, session);

    const callbacks: SpawnRunCallbacks = {
      onEvent: (event) => {
        this.accumulateUsage(session, event);
        // 首轮事件走 run 通知通道（runId 键）；续聊轮无 runId——协议面仅
        // streamDelta/roundLifecycle 承载（W1 契约），事件不外发（W3 消费注意）。
        if (!session.firstRoundDone) opts.onEvent(event);
      },
      onHandleReady: (partial) => {
        const sf = partial.sessionRef.sessionFile;
        if (typeof sf === "string") session.sessionFile = sf;
        const sid = partial.sessionRef.sessionId;
        if (typeof sid === "string") session.sessionId = sid;
        opts.onHandleReady?.(partial);
      },
      onChildSpawned: opts.onChildSpawned,
      onChildStateChanged: (p) => {
        if (p.state === "exited") this.handleChildExited(session, p);
      },
      onDelta: (delta) => {
        if (!session.firstRoundDone) opts.stream?.onDelta(delta);
        else if (session.streamEnabled) this.channels?.streamDelta({ recordId: session.recordId, delta });
      },
      askUser: (req) => {
        // 会话跨 run 存活，askUser 关联键固定为 spawn 轮 runId（W1 未扩 askUser 载荷面）
        if (this.channels === undefined) return Promise.resolve<UiResponse>({ cancelled: true });
        return this.channels.askUser(session.spawnRunId, req);
      },
      onChatRoundEnd: () => this.handleRoundEnd(session),
      onChatAgentSettled: () => this.handleAgentSettled(session),
    };

    try {
      return await this.executor({ ...params, chatMode: true }, callbacks);
    } finally {
      // spawn 轮收口（agent_settled resolve 或异常退出都算）——后续轮 recordId 键
      session.firstRoundDone = true;
    }
  }

  /**
   * interact message 热路径：prompt + streamingBehavior 直写 stdin（pi 权威裁决
   * busy/idle：busy 时 followUp 入队 / steer 抢占，idle 时开新 turn——pi 上游语义，
   * abort 不清 followUp 队列）。冷路径（无活进程）→ engine_session_not_resumable +
   * 冷续指引（宿主发新 run chat+resume 接续，D1-A）。
   */
  deliverMessage(recordId: string, text: string, interrupt: boolean): InteractResult {
    const session = this.sessions.get(recordId);
    const child = getActiveChild(recordId);
    if (session === undefined || session.closed || child === undefined || child.killed) {
      return coldPathReject(recordId);
    }
    try {
      sendPromptCommand(child, text, {
        streamingBehavior: interrupt ? "steer" : "followUp",
      });
      clearEpipeFailure(recordId);
      session.roundActive = true;
      // 新轮身份递增（S6）：与旧轮的 settledSeq 快照区分，agent_settled 据此识别
      // 「settled→idle 间隙投递」，不清新轮的 roundActive
      session.armedSeq += 1;
      return { ok: true, delivered: true };
    } catch (err) {
      if (err instanceof Error && err.message.includes("EPIPE")) {
        const count = recordEpipeFailure(recordId);
        if (count >= EPIPE_FAILURE_THRESHOLD) {
          clearEpipeFailure(recordId);
          // 引擎自知失败（EPIPE 兜底耗尽）→ failed 相位如实上报（设计 D1-A 点名场景）
          session.roundActive = false;
          this.emitPhase(session, { phase: "failed", error: roundEpipeExhaustedError(recordId, count) });
          return {
            ok: false,
            code: "engine_interact_failed",
            message: `EPIPE fallback exhausted for ${recordId}: ${count} consecutive failures. Recovery: close the session, then cold-resume via run chat resume or start a new chat.`,
          };
        }
        return {
          ok: false,
          code: "engine_session_not_resumable",
          message: `EPIPE on hot path for ${recordId} (stdin pipe broken, child likely exited; attempt ${count}/${EPIPE_FAILURE_THRESHOLD}). Recovery: retry after close, or cold-resume via run chat resume.`,
        };
      }
      return {
        ok: false,
        code: "engine_interact_failed",
        message: toErrorMessage(err),
      };
    }
  }

  /**
   * interact close：force = 立即杀链收割（在途轮 → failed aborted）；缺省 = 优雅关闭
   * （在途轮标记 closeAfterRound，agent_settled 收口后收割——对齐 inproc closeSubagent
   * 的 force 分流）；idle 态（无在途轮）立即收割（对齐 closeChatIdle 的进程回收）。
   */
  close(recordId: string, force: boolean): InteractResult {
    const session = this.sessions.get(recordId);
    const child = getActiveChild(recordId);
    if (session === undefined || session.closed || child === undefined) {
      return { ok: true, delivered: true };
    }
    if (force || !session.roundActive) {
      if (session.roundActive) session.killReason = "close";
      void killChain(child, {
        graceMs: CHAT_KILL_GRACE_MS,
        unrefTimers: true,
        escalationNote: `chat session ${recordId} (source: interact close${force ? " force" : ""})`,
      });
      return { ok: true, delivered: true };
    }
    session.closeAfterRound = true;
    return { ok: true, delivered: true };
  }

  /**
   * interact cancel（D3 协议层收敛语义，对齐 run 域 cancel 形态）：
   * 受理（SIGTERM——run 域 AbortController→SIGTERM 同构）→ 等待目标轮次终态相位
   * （roundLifecycle settled/idle/failed）→ 超 CANCEL_SETTLE_GRACE_MS 未收敛走与
   * run 域同构的杀链升级（SIGTERM → grace → SIGKILL）。应答在收敛/升级完成后返回
   * （协议层收敛语义）；无在途轮时无收敛对象，受理即返回（进程回收经 close 事件收口）。
   */
  async cancel(recordId: string): Promise<InteractResult> {
    const session = this.sessions.get(recordId);
    if (session === undefined || session.closed) {
      return { ok: true, delivered: true };
    }
    const child = getActiveChild(recordId);
    if (child === undefined) {
      this.sessions.delete(recordId);
      return { ok: true, delivered: true };
    }
    const roundInFlight = session.roundActive;
    // 等待体先于 kill 注册：SIGTERM 的同步收口路径（pi trap 后事件先于本函数
    // await 点到达）不丢终态信号
    const settle = roundInFlight ? this.waitForRoundTerminal(session, CANCEL_SETTLE_GRACE_MS) : undefined;
    session.killReason = "cancel";
    child.kill("SIGTERM");
    if (settle === undefined) {
      return { ok: true, delivered: true };
    }
    if (await settle) {
      return { ok: true, delivered: true };
    }
    // 收敛超时 → 杀链升级（run 域同构兜底；failed 相位由 close 事件触发）
    logger.warn(
      `[chat-session] cancel for ${recordId} did not settle within ${CANCEL_SETTLE_GRACE_MS}ms, escalating kill chain`,
    );
    const reaped = this.waitForRoundTerminal(session, CANCEL_SETTLE_GRACE_MS + CHAT_KILL_GRACE_MS);
    void killChain(child, {
      graceMs: CHAT_KILL_GRACE_MS,
      unrefTimers: true,
      escalationNote: `chat session ${recordId} (source: interact cancel settle timeout)`,
    });
    await reaped;
    return { ok: true, delivered: true };
  }

  // ── 内部：轮次相位处置 ──

  /** agent_end（非 willRetry，队列排空）：本轮收敛 → settled 相位（带本轮用量）。 */
  private handleRoundEnd(session: ChatSession): void {
    if (session.closed || !session.roundActive) {
      // 子进程已退（failed 已发射）/ 非我方投递开启的轮（如扩展在 idle 后自发
      // continuation）——无对应宿主轮次，不发射
      return;
    }
    session.roundActive = false;
    // 记录 settled 所属轮次身份（S6）：handleAgentSettled 比对 armedSeq 判定间隙投递
    session.settledSeq = session.armedSeq;
    const usage = toAgentUsage(session.usage);
    session.lastRoundUsage = usage;
    session.usage = emptyUsage();
    this.emitPhase(session, { phase: "settled", usage });
  }

  /** agent_settled（真空闲）：idle 相位（usage + anchor 回填）+ 优雅关闭收割。 */
  private handleAgentSettled(session: ChatSession): void {
    if (session.closed) return;
    // 仅当 settled（agent_end）以来无新轮 arm 时清 roundActive（S6）：agent_settled 属于
    // 发出 settled 帧的那一轮；settled→idle 间隙宿主投递的新轮（armedSeq 已前进）不能被
    // 旧轮的空闲边界清位——否则该轮 agent_end 会被 handleRoundEnd 的 !roundActive 守卫
    // 拦截，settled 相位永不发射（core watchdog 的 noteRoundSettled 消费面降级）。
    if (session.armedSeq === session.settledSeq) {
      session.roundActive = false;
    }
    this.emitPhase(session, {
      phase: "idle",
      ...(session.lastRoundUsage !== undefined ? { usage: session.lastRoundUsage } : {}),
      anchor: anchorOf(session),
    });
    if (session.closeAfterRound) {
      session.closeAfterRound = false;
      const child = getActiveChild(session.recordId);
      if (child !== undefined && !child.killed) {
        void killChain(child, {
          graceMs: CHAT_KILL_GRACE_MS,
          unrefTimers: true,
          escalationNote: `chat session ${session.recordId} (source: close after round)`,
        });
      }
    }
  }

  /** 子进程退出：会话消亡；在途轮 → failed 相位（引擎主动杀 = aborted / 否则 crashed）。 */
  private handleChildExited(
    session: ChatSession,
    exit: { exitCode?: number; signal?: string },
  ): void {
    if (session.closed) return;
    session.closed = true;
    const hadRound = session.roundActive;
    session.roundActive = false;
    // 仅当注册表条目仍是本会话对象时才删（S5）：superseded 场景下新会话可能已重建并
    // 占用同 recordId 键——真实子进程的 exit 事件异步到达（晚于 startRound 的 stale
    // 防御重建），旧会话迟到的消亡不得清掉新会话条目（否则 interact 控制面对活会话
    // 失效：deliverMessage/cancel/close 全部 lookup 落空）。
    if (this.sessions.get(session.recordId) === session) {
      this.sessions.delete(session.recordId);
    }
    // 无在途轮的进程回收（idle 态 cancel/close、dispose）非轮次事件——不发射
    if (!hadRound) return;
    if (session.killReason !== undefined) {
      this.emitPhase(session, { phase: "failed", error: roundAbortedError(session.recordId, session.killReason) });
      return;
    }
    this.emitPhase(session, { phase: "failed", error: roundCrashedError(session.recordId, exit) });
  }

  /**
   * 相位发射（关联键 = 首轮 runId / 续聊 recordId）+ 轮终等待体逐一 resolve。
   * superseded 会话抑制宿主发射（S5，守卫放单一咽喉点而非仅 handleChildExited）：
   * 同 recordId 冷续 run 已重建会话，旧会话残留终态帧（killChain 杀死在途轮的 failed、
   * SIGTERM 优雅收口竞态下的 settled+idle——pi trap 语义先收口再退）以 recordId 键发射
   * 会与新会话在途轮同键串扰，core 可能把旧轮终态误配到新轮（误终态化）。superseded
   * 信号本身 = 新 run 的 start（宿主主动发起），core 无需旧会话帧。等待体仍逐一
   * resolve：cancel 等待中 killReason 被后续冷续覆写为 superseded 的极端时序下收敛
   * 不悬挂。
   */
  private emitPhase(
    session: ChatSession,
    phase: { phase: "settled"; usage?: AgentUsage } | { phase: "idle"; usage?: AgentUsage; anchor?: ResumeAnchor } | { phase: "failed"; error: ProtocolError },
  ): void {
    if (session.killReason === "superseded") {
      logger.debug(
        `[chat-session] suppress ${phase.phase} phase for superseded session ${session.recordId} (record cold-resumed by a new run)`,
      );
    } else {
      this.channels?.roundLifecycle({ ...roundKeyOf(session), ...phase } as HostRoundLifecycleParams);
    }
    for (const w of session.roundTerminalWaiters) w();
    session.roundTerminalWaiters.clear();
  }

  /** message_end 用量累加（轮内增量；interact 轮无 event 通知通道，用量经相位帧回填）。 */
  private accumulateUsage(session: ChatSession, event: AgentEvent): void {
    if (event.type !== "message_end" || event.usage === undefined) return;
    session.usage.input += event.usage.input;
    session.usage.output += event.usage.output;
    session.usage.cacheRead += event.usage.cacheRead;
    session.usage.cacheWrite += event.usage.cacheWrite;
    if (event.usage.cost !== undefined) {
      session.usage.cost = (session.usage.cost ?? 0) + event.usage.cost;
    }
  }

  /** 轮终等待（cancel 收敛判据；超时 resolve false——不清理其他等待体）。 */
  private waitForRoundTerminal(session: ChatSession, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        session.roundTerminalWaiters.delete(done);
        resolve(false);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      session.roundTerminalWaiters.add(done);
    });
  }
}
