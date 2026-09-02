// src/execution/engine/engines/pi/pi-engine.ts
//
// PiEngine：pi 执行链的引擎边界（dual-track-convergence D2 后形态）。设计权威源：
// docs/architecture/subagent-engine-abstraction.md §3.3.1 / D1（四面 + handle 契约 +
// abort 分级）、D3（capabilities 链路接通口径）、docs/design/subagent-dual-track-convergence.md
// §3.3 D2（pi 执行轨物理下沉 + Service 旧轨收敛）。
//
// 四件套物理归属 engines/pi/（launcher=session-runner / parser=spawn-event-adapter /
// preparer=temp-prompt+argv-mirror / reader=reader.ts），本文件是引擎边界：
//   - run：chat 域轮次（ChatRoundTicket 交接——编排层预建 record/identity 后经
//     EnginePort 进入）与 workflow 域（executeAndAwait 委托）两分支；
//   - interact：原生实现（D2——原编排层 deliverMessage/resumeRound 的 pi RPC stdin
//     协议知识下沉：sendPromptCommand 直调 + streamingBehavior 映射 + EPIPE 兜底 +
//     冷路径 resume 交接），编排层经 engine.interact 调用；
//   - read：第①级委托共享 reader readPiSessionView（engines/pi/reader.ts）。
//
// pi 专有语义的隔离点在 task-spec-mapper.ts（effort↔thinkingLevel、persona↔skillPath、
// schemaEnv 派生）——本文件不出现第二个 pi 语义翻译点。

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { getLogger } from "../../../../core/logger.ts";

import type { AgentResult as WorkflowAgentResult } from "../../../../orchestration/models/types.ts";
import type { PiInvocation } from "./pi-invocation.ts";
import { getPiInvocation } from "./pi-invocation.ts";
import type { AgentConfig, ResolvedModel } from "../../../model-resolver.ts";
import type { StatusFilter } from "../../../record-store.ts";
import type { SubagentStream } from "../../../stream-sink.ts";
import type { AgentEvent, AgentResult, ExecutionRecord, ExecuteOptions, SubagentRecord } from "../../../types.ts";
import type { EnginePort, EngineRunResult, RunContext } from "../../port.ts";
import { replayJournalToSessionView } from "../../common/journal-replay.ts";
import type {
  AgentOutcome,
  AgentTaskSpec,
  EngineCapabilities,
  EngineHandle,
  InteractAction,
  InteractResult,
  ProbeReport,
  SessionView,
} from "../../types.ts";
import { taskSpecToExecuteOptions } from "./task-spec-mapper.ts";
import { readPiSessionView } from "./reader.ts";
import type { SessionRunnerContext, SpawnResumeOpts } from "./session-runner.ts";
import { getChildByRecord, spawnedChildren } from "./session-runner.ts";
import { acquireActivateLock, disarmIdleTimer } from "../../../lifecycle-manager.ts";
import {
  clearEpipeFailure,
  EPIPE_FAILURE_THRESHOLD,
  recordEpipeFailure,
  sendPromptCommand,
} from "./stdin-writer.ts";

const logger = getLogger("subagents");

/** pi 引擎的 registry key（D9：缺省引擎 = 'pi'，回填期零风险默认）。 */
export const PI_ENGINE_ID = "pi";

/** pi 适配器版本（handle.adapterVersion 数据源——golden 样本对齐排查锚点）。 */
export const PI_ADAPTER_VERSION = "1.0.0";

/** pi 无隔离池（PI_CODING_AGENT_DIR 全局一份，设计 §3.3.9），poolKey 恒 'shared'。 */
export const PI_POOL_KEY = "shared";

/** probe 的版本探测超时（ms）。二进制无响应时按探针失败处理，不静默挂死（目标 4）。 */
const PROBE_VERSION_TIMEOUT_MS = 10_000;

/** interact 经 sessionFile 兜底定位 record 时的 collectRecords 扫描上限。 */
const INTERACT_SCAN_LIMIT = 1000;

/** chat 域轮次的身份快照（编排层 resolveIdentity 的产物形态——引擎侧透传给 launcher；
 *  u-3b D6 任务形状合流后并入 AgentTaskSpec 直出）。 */
export interface ChatRoundIdentity {
  agent: string;
  agentConfig: AgentConfig | undefined;
  resolved: ResolvedModel;
}

/**
 * chat 域预备轮次交接包（D2 单轨）：编排层（executeViaEngine / 冷路径续轮）预建的
 * record/opts/identity/host 上下文经 run 的 ctx.taskId 交接给引擎。存在理由：chat 域
 * 有若干 lossless host 件（identity 解析产物、SessionRunnerContext 回调簇、
 * forkFromSessionFile、resume 选项）不在中立声明 AgentTaskSpec 的字段表内，经本包
 * 透传避免有损往返——u-3b（D6 任务形状合流）后消除双形态。
 */
export interface ChatRoundTicket {
  record: ExecutionRecord;
  opts: ExecuteOptions;
  identity: ChatRoundIdentity;
  ctx: SessionRunnerContext;
  signal: AbortSignal | undefined;
  priority: number;
  stream?: SubagentStream;
  /** resume 选项（冷路径续轮）：重开已 idle 的 session 续聊。undefined = 新 session。 */
  resume?: SpawnResumeOpts;
}

/**
 * PiEngine 委托的编排服务面——SubagentService 的结构子集（鸭子类型：生产实现是
 * SubagentService 单例；测试可注入 fake，不必构造整个 Service）。
 * 为什么用结构接口而非直接 import SubagentService 类型：pi-engine 只依赖它实际消费的
 * 方法面，防 Service 内部演进（增删私有方法）连锁影响引擎适配层。
 *
 * chat 域轮次面（takeChatRound/runChatRound/resumeChatRound/reportRecordTransition）
 * 是可选项：仅 chat 绑定的引擎实例（编排层经适配器构造）提供；SAR 直绑 Service 的
 * workflow 实例不提供——run 恒走 executeAndAwait、interact 的 message 分支不被 SAR
 * 调用，可选面缺失不构成缺陷。
 */
export interface PiEngineService {
  executeAndAwait(
    opts: ExecuteOptions,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<WorkflowAgentResult>;
  getRecordForAction(id: string): ExecutionRecord;
  closeSubagent(record: ExecutionRecord, force: boolean): Promise<void>;
  cancel(id: string): boolean;
  collectRecords(limit: number, statusFilter?: StatusFilter): SubagentRecord[];
  /** chat 域轮次交接（run 的 chat 分支入口）：按 taskId 取走预备包（一次性消费）。 */
  takeChatRound?(taskId: string): ChatRoundTicket | undefined;
  /** 执行预备的 chat 轮次（编排归 Service：pool 槽 + runSpawn + 终态迁移）。 */
  runChatRound?(ticket: ChatRoundTicket): Promise<AgentResult>;
  /** 冷路径续轮（interact message 分支的编排回调：守卫 + record 迁移 + 预备轮次 kick-off）。 */
  resumeChatRound?(record: ExecutionRecord, text: string): void;
  /** record 状态迁移上报（热路径投递后让 runtime 派生缓存失效 / GUI 回流）。 */
  reportRecordTransition?(record: ExecutionRecord): void;
}

/** PiEngine 构造依赖。 */
export interface PiEngineDeps {
  /**
   * 编排服务定位器（惰性求值——服务在 session_start 才注入，构造期可能尚不可用）。
   * 组合根（index.ts registerPiEngine）绑 getSubagentService()；per-session DI 场景
   * （SAR）绑自身持有的服务引用。
   */
  getService: () => PiEngineService | null;
  /**
   * 版本探测执行器（probe check "version" 的执行体）。默认实现 spawn `<command>
   * --version`——测试注入 fake 避免真实子进程（vitest 下 command=node 会真的跑
   * vitest --version，秒级开销且与被测逻辑无关）。
   */
  probeVersion?: (invocation: PiInvocation) => Promise<string | undefined>;
}

/**
 * pi 引擎适配器（EnginePort 实现）。
 *
 * run 的错误语义（设计 §3.3.5 三条，pi 回填口径）：
 *   ① 服务不可用（prepare 期）→ reject，不产生 handle；
 *   ② 运行中失败不 reject——现有链路（runSpawn → collectResult）已把失败收口为
 *      error 字段的 AgentResult，本层照直透传（record 收尾语义不变）；
 *      executeAndAwait 的 throw（嵌套超限 ForkDepthExceededError / worktree 创建失败）
 *      属创建期异常，按 ① 语义向上传播——与 SAR 接线前的 catch 行为闭环一致；
 *   ③ abort：ctx.signal 直通 executeAndAwait 第 2 参（下游 signal → proc.kill，
 *      D1 abort 分级的现链路形态）。
 */
export class PiEngine implements EnginePort {
  readonly id = PI_ENGINE_ID;

  private readonly deps: PiEngineDeps;
  /** probe 结果缓存（版本变化检测由 P4 接线；force 强探跳过）。 */
  private probeCache: ProbeReport | undefined;

  constructor(deps: PiEngineDeps) {
    this.deps = deps;
  }

  /**
   * pi 链路实际接通的能力（D3 链路接通口径，非 pi RPC 理论能力）。
   * 声明升级（如 steer 接通 rpc stdin 通道后 unsupported → native）必须先改链路再改声明。
   */
  capabilities(): EngineCapabilities {
    return {
      // PI_WORKFLOW_SCHEMA env 注入 + structured-output 扩展（方案 A 唯一校验权威）
      schemaEnforcement: "native",
      // pi RPC 有 steer，但 spawn 链路未接通（session-runner turn-limiter steer no-op）
      steer: "unsupported",
      // chatMode idle 复用 + message/close/cancel 交互面已接通
      conversation: "native",
      // persona 经 --skill / --append-system-prompt flag 通道注入
      personaInjection: "flag",
      // 30+ 事件流（六引擎最细粒度）
      eventGranularity: "stream",
      // 无 OS sandbox；worktree 隔离（公共层）= emulated
      sandbox: "emulated",
      // pi session JSONL 完整重建（session-reconstructor）
      sessionRead: "full",
      // chatMode 同进程 idle 复用（热）+ --session 冷续写
      resume: "native",
      // 现链路 abort = SIGTERM（pi 子进程 trap 后 graceful shutdown）；rpc abort 命令未接通
      interrupt: "kill-only",
      // argv-mirror 镜像主进程 --approve 等 flag
      permissionMode: "native",
    };
  }

  /** 探针（D7）：invocation 可解析（二进制/脚本存在）+ 版本解析。pi 契约稳定（rpc.md
   *  官方），探针取轻量两级——不做干跑回归（那是 zcode 类逆向契约引擎的需求）。 */
  async probe(opts?: { force?: boolean }): Promise<ProbeReport> {
    if (!opts?.force && this.probeCache) return this.probeCache;

    // check 1：invocation 可解析（node 脚本存在 / standalone binary / PATH 可见）。
    // relay:false 显式直连——探针测 pi 本体可解析性，经 relay 探到的是 runtime 健康，语义错位（§5.1）。
    const invocation = getPiInvocation(["--version"], { relay: false });
    const invocationOk = isInvocationResolvable(invocation);
    const checks: ProbeReport["checks"] = [
      {
        name: "invocation",
        ok: invocationOk,
        detail: invocationOk
          ? `${invocation.command} ${invocation.args.join(" ")}`
          : `cannot resolve pi executable: ${invocation.command} (script missing and not on PATH)`,
      },
    ];

    // check 2：版本解析（可解析才尝试——invocation 已失败时不再 spawn 必败进程）
    let engineVersion = "";
    if (invocationOk) {
      const runVersion = this.deps.probeVersion ?? defaultProbeVersion;
      const version = await runVersion(invocation);
      const versionOk = version !== undefined && version.length > 0;
      checks.push({
        name: "version",
        ok: versionOk,
        detail: versionOk ? version : "pi --version returned empty or failed",
      });
      engineVersion = version ?? "";
    }

    const ok = checks.every((c) => c.ok);
    const report: ProbeReport = {
      ok,
      engineVersion,
      checks,
      ...(ok ? {} : {
        // 恢复指引（§3.3.3 终态四）：版本确认命令 + 探针重跑命令
        error: {
          code: "engine_probe_failed",
          recovery:
            `Run \`${invocation.command} --version\` to confirm the pi binary works, then retry the probe. ` +
            `If the binary is missing, reinstall pi (npm i -g @earendil-works/pi-coding-agent) or fix PATH.`,
        },
      }),
    };
    this.probeCache = report;
    return report;
  }

  /** D1 主语义：映射中立声明 → ExecuteOptions，委托 executeAndAwait（行为零变化）。 */
  async run(task: AgentTaskSpec, ctx: RunContext): Promise<EngineRunResult> {
    const service = this.requireService();
    // [D2 单轨] chat 域轮次：编排层（executeViaEngine / 冷路径续轮）预建的
    // record/identity/host 上下文经 ctx.taskId 交接（ChatRoundTicket）。chat 域任务
    // 声明由 ticket lossless 携带（identity / SessionRunnerContext /
    // forkFromSessionFile / resume 不在 AgentTaskSpec 字段表内，task 形参仅满足
    // port 签名）——workflow 域（SAR）无 ticket，走下方 executeAndAwait 分支；
    // u-3b（D6 任务形状合流）消除双形态。
    const ticket = service.takeChatRound?.(ctx.taskId);
    if (ticket) return this.runChatTicket(service, ticket);
    const opts = taskSpecToExecuteOptions(task, {
      ctxModel: ctx.ctxModel,
      // 解耦形态兜底（schema 缺失时才生效，派生优先——见 mapper 注释）
      ...(ctx.schemaEnv !== undefined ? { schemaEnvFallback: ctx.schemaEnv } : {}),
    });
    // P4 引擎留痕（D9①）：record 侧投影——实际执行引擎 id 恒 pi（本引擎身份）；
    // engineFallback 由路由层经 RunContext 透传（无 fallback 缺省，record 字段零噪声）
    opts.engine = PI_ENGINE_ID;
    if (ctx.engineFallback !== undefined) opts.engineFallback = ctx.engineFallback;
    // pi 无隔离池（PI_CODING_AGENT_DIR 全局一份，poolKey 恒 'shared'）——恒值声明，
    // 宿主 journal writer 无需重定向（对齐点③的 pi 侧闭合）
    ctx.onPoolResolved?.(PI_POOL_KEY);
    // ctx.stream / onEvent / signal 直通——与 SAR 接线前的传参完全一致（双通道互斥设计
    // 保持在 service/session-runner 内，引擎层不二次包装）
    const wfResult = await service.executeAndAwait(opts, ctx.signal, ctx.onEvent, ctx.stream);
    return {
      handle: this.buildHandle(wfResult, ctx),
      outcome: workflowResultToOutcome(wfResult, ctx),
    };
  }

  /**
   * D1 交互控制面：message 分支原生实现（D2——原编排层 deliverMessage/resumeRound 的
   * pi RPC stdin 协议知识下沉引擎边界）；close=closeSubagent / cancel=cancel 委托编排面。
   * message 的 interrupt（steer 抢占 vs followUp 排队）映射为 pi streamingBehavior——
   * pi 权威裁决 busy/idle：busy 时 followUp 入队/steer 抢占，idle 时开新 turn。
   */
  async interact(handle: EngineHandle, action: InteractAction): Promise<InteractResult> {
    const service = this.requireService();
    try {
      if (action.kind === "cancel") {
        const recordId = this.resolveRecordId(service, handle);
        if (!recordId) return notResumable(handle);
        return service.cancel(recordId)
          ? { ok: true, delivered: true }
          : { ok: false, code: "engine_interact_failed", message: `cancel returned false for ${recordId} (record already finalized or unknown)` };
      }
      const record = this.resolveRecord(service, handle);
      if (!record) return notResumable(handle);
      return await this.interactRecord(record, action);
    } catch (err) {
      // 投递/交互面以 throw 表达业务拒绝（not ready / EPIPE 兜底耗尽等，文案自带行动语言）
      // ——转结构化失败，调用方拿 code+message 而非异常
      return {
        ok: false,
        code: "engine_interact_failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * interact 的 record 锚定形态（编排层直传已归属校验的 record——chat 域编排面
   * deliverChatMessage 的调用入口；port face interact = handle 解析 + 本方法）。
   * 不做二次 store 查找/归属校验：调用方（编排层）持有同一 record 对象，与旧直调
   * 形态的字段读写逐字节一致。
   */
  async interactRecord(record: ExecutionRecord, action: InteractAction): Promise<InteractResult> {
    const service = this.requireService();
    try {
      return await this.interactRecordInner(service, record, action);
    } catch (err) {
      // 投递/交互面以 throw 表达业务拒绝（not ready / EPIPE 兜底耗尽等，文案自带行动语言）
      // ——转结构化失败，调用方拿 code+message 而非异常
      return {
        ok: false,
        code: "engine_interact_failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** interact 两形态的公共主体（cancel 归 handle 形态——record 锚定形态的调用方用
   *  编排层 cancel，不走这里）。 */
  private async interactRecordInner(
    service: PiEngineService,
    record: ExecutionRecord,
    action: InteractAction,
  ): Promise<InteractResult> {
    if (action.kind === "message") {
      await this.deliverPrompt(service, record, action.payload, action.interrupt === true);
      return { ok: true, delivered: true };
    }
    if (action.kind === "close") {
      await service.closeSubagent(record, action.payload?.force === true);
      return { ok: true, delivered: true };
    }
    throw new Error(
      `[pi-engine] cancel is handle-form only (record-anchored callers use the orchestration cancel). ` +
        `Recovery: internal wiring error — use interact(handle, {kind:'cancel'}) instead.`,
    );
  }

  /**
   * message 投递原生实现（协议知识下沉的本体，V2 决策 3）：按**进程死活**分流，不按
   * record.status——
   *
   *   热路径（进程活）：prompt + streamingBehavior 直写 child.stdin（sendPromptCommand）。
   *   冷路径（进程死）：acquireActivateLock + 编排侧续轮回调（resumeChatRound——重开
   *     session + prompt；仅崩溃/timeout kill/跨重启命中）。
   *
   * EPIPE 兜底：stdin 管道断（进程实际已死但 close 事件未到）→ 按值守卫清理死句柄 +
   * 连续失败计数 → 冷路径 resume + 原消息重放；连续达阈值（防死循环）throw 行动语言。
   */
  private async deliverPrompt(
    service: PiEngineService,
    record: ExecutionRecord,
    text: string,
    interrupt: boolean,
  ): Promise<void> {
    // 新 turn，disarm idle timer（防 turn 期间误杀活进程，V2 决策 4）
    disarmIdleTimer(record.id);
    const child = getChildByRecord(record.id);
    if (child && !child.killed) {
      // 热路径：进程活（running/idle 都可能是热路径——V2 进程长驻，idle 态进程仍在内存）
      record.status = "running";
      // 刷新 pid 内存记账（resume spawn 后 child.pid 已变，顺便更新）
      if (child.pid !== undefined) record.pid = child.pid;
      try {
        sendPromptCommand(child, text, { streamingBehavior: interrupt ? "steer" : "followUp" });
        // 热路径成功，清零 EPIPE 连续失败计数（[v4 A-1] 计数器在 stdin-writer）
        clearEpipeFailure(record.id);
        // [race-F5] 写后死进程检测：write 同步成功只代表数据进了内核 pipe 缓冲，子进程
        // 可能在读取前死亡（gate/idle kill 竞速）。exitCode/signalCode 已非 null = 进程已死
        //（close 事件可能尚未到达），缓冲中的消息将被静默丢弃。只 warn 留证（含消息类型），
        // 不抛错不重试：终态回收已由 kill 路径保证，对死进程重试反而可能二次写。
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
        // 轮始执行态信号清除 + 迁移上报（residual-fixes U3 补全，与冷路径续轮对称）：
        // 新一轮开跑 = 无轮终信号——清上一轮 result（§5.4 isStreaming 公式要求
        // result undefined 才显示 streaming）与 resumable，appendEntry 让 runtime/W18
        // 派生缓存失效、GUI 侧从 waiting 切回 spinner。仅在投递成功后清（失败保留
        // 上一轮信号，EPIPE 兜底走续轮时由其再清）。
        record.result = undefined;
        record.resumable = undefined;
        service.reportRecordTransition?.(record);
      } catch (err) {
        // EPIPE 兜底：stdin 管道已断，进程实际已死但 close 事件尚未到达。
        // 检测 EPIPE 关键词 → 进程按 dead 处理 → 自动转冷路径 resume + 消息重放。
        // 本兜底不持 activateLock，但与冷路径共用续轮的在途守卫（编排侧
        // resumesInFlight）：resume 已在途时兜底的续轮调用被拒（throw 行动语言），
        // 不会二次 spawn。
        if (err instanceof Error && err.message.includes("EPIPE")) {
          logger.warn(`[subagents] EPIPE on hot path for ${record.id}, falling back to cold path resume`, {
            detail: err.message,
          });
          // 清理 spawnedChildren 中的死进程条目（让续轮能重新 spawn）。
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
          // 冷路径 resume + 原消息重放（v4 B-1: status 已 running，续轮守卫直接放行）
          this.requireResumeFace(service)(record, text);
          return;
        }
        // 非 EPIPE 错误——不应发生，重新抛出让调用方处理
        throw err;
      }
      return;
    }
    // 冷路径：进程死（idle timer reap / 崩溃 / 跨重启），record 应为 idle-resumable → resume spawn。
    // D3：acquireActivateLock 双保险——注意锁只覆盖续轮同步段，释放在子进程注册
    //（session-runner spawnedChildren.set）之前（中间隔 pool.acquire await + tempFile 等异步点）。
    // 真正的单写者守卫是续轮的在途守卫（编排侧 resumesInFlight）：锁释放后、child
    // 注册前到达的第二次冷路径 message 在续轮处被拒，不会二次 spawn。
    const releaseLock = await acquireActivateLock(record.id);
    try {
      this.requireResumeFace(service)(record, text);
    } finally {
      releaseLock();
    }
  }

  /** chat 域轮次执行回调的守卫提取（可选项缺失 = 引擎绑定形态错误——chat 编排面
   *  必须由 chat 绑定的适配器提供；静默 no-op 会丢消息，宁可显式 throw）。 */
  private requireResumeFace(service: PiEngineService): (record: ExecutionRecord, text: string) => void {
    const resume = service.resumeChatRound;
    if (!resume) {
      throw new Error(
        `[pi-engine] chat resume face unavailable on this engine binding (workflow-only service binding). ` +
          `Recovery: internal wiring error — message delivery requires the chat-bound engine instance; report this.`,
      );
    }
    return resume;
  }

  /**
   * chat 轮次执行（run 的 chat 分支主体）：编排归 Service（runChatRound——pool 槽 +
   * runSpawn + 终态迁移，行为零变化），引擎侧构造 handle/outcome。chat 编排不消费
   * 返回值（notify/终态迁移在编排侧 kickOff 回调），handle/outcome 是 port 契约的
   * 形态完备（interact/read 以 recordId/sessionFile 定位）。
   */
  private async runChatTicket(service: PiEngineService, ticket: ChatRoundTicket): Promise<EngineRunResult> {
    const runChatRound = service.runChatRound;
    if (!runChatRound) {
      throw new Error(
        `[pi-engine] chat round runner unavailable on this engine binding (workflow-only service binding). ` +
          `Recovery: internal wiring error — chat rounds require the chat-bound engine instance; report this.`,
      );
    }
    const result = await runChatRound(ticket);
    const sessionFile = ticket.record.sessionFile;
    return {
      handle: {
        data: {
          v: 1,
          engineId: PI_ENGINE_ID,
          // pi 定位符：recordId（interact 控制面 key）+ sessionFile（read 第①级）
          sessionRef: {
            recordId: ticket.record.id,
            ...(sessionFile !== undefined ? { sessionFile } : {}),
          },
          poolKey: PI_POOL_KEY,
          adapterVersion: PI_ADAPTER_VERSION,
        },
      },
      outcome: chatResultToOutcome(result, sessionFile, ticket.record.worktreeHandle?.path),
    };
  }

  /**
   * D6 read 三级降级：①pi session JSONL 原生读取（readPiSessionView——共享 reader
   * 单一实现，sessionRead: 'full' 的依据）→ ②宿主 event journal 重放（P4 接线：
   * common/journal-replay 复用 live reducer，重放等价性见 §3.3.6）→ ③outcome-only。
   */
  async read(handle: EngineHandle): Promise<SessionView> {
    const sessionFile = refString(handle.data.sessionRef, "sessionFile");
    const native = sessionFile !== undefined ? await readPiSessionView(sessionFile) : undefined;
    if (!native) {
      // ②级：journal 重放（journalPath 缺省 / 文件不存在 / 无事件 → undefined 落③级）
      const journaled = replayJournalToSessionView(handle, PI_ENGINE_ID);
      if (journaled !== undefined) return journaled;
      return { engineId: PI_ENGINE_ID, turns: [], source: "outcome-only" };
    }
    return native;
  }

  // ── 内部 ──

  private requireService(): PiEngineService {
    const service = this.deps.getService();
    if (!service) {
      throw new Error(
        `[pi-engine] SubagentService unavailable (initSession not called or extension disposed). ` +
          `Recovery: ensure the subagent-workflow extension is initialized in this session before dispatching.`,
      );
    }
    return service;
  }

  /** run 出口构造可持久化 handle（自描述：engineId + sessionRef + poolKey + 版本）。 */
  private buildHandle(wfResult: WorkflowAgentResult, ctx: RunContext): EngineHandle {
    const sessionFile = wfResult.sessionFile;
    return {
      data: {
        v: 1,
        engineId: PI_ENGINE_ID,
        // pi 定位符：sessionFile（read 第①级）；recordId 由宿主 record 层补记
        //（executeAndAwait 不外露 record id，交互定位走 resolveRecord 的扫描兜底）
        sessionRef: sessionFile !== undefined ? { sessionFile } : {},
        poolKey: ctx.poolKey !== "" ? ctx.poolKey : PI_POOL_KEY,
        adapterVersion: PI_ADAPTER_VERSION,
      },
    };
  }

  /** interact 定位 record：sessionRef.recordId 直查；缺省时按 sessionFile 扫描兜底。 */
  private resolveRecord(service: PiEngineService, handle: EngineHandle): ExecutionRecord | undefined {
    const recordId = this.resolveRecordId(service, handle);
    if (recordId === undefined) return undefined;
    try {
      return service.getRecordForAction(recordId);
    } catch {
      return undefined;
    }
  }

  private resolveRecordId(service: PiEngineService, handle: EngineHandle): string | undefined {
    if (handle.data.engineId !== PI_ENGINE_ID) return undefined;
    const recordId = refString(handle.data.sessionRef, "recordId");
    if (recordId !== undefined) return recordId;
    const sessionFile = refString(handle.data.sessionRef, "sessionFile");
    if (sessionFile === undefined) return undefined;
    // sessionFile 兜底：扫描 record 清单匹配定位符（interact 频率低，扫描成本可接受）
    const found = service
      .collectRecords(INTERACT_SCAN_LIMIT, "all")
      .find((r) => r.sessionFile === sessionFile);
    return found?.id;
  }
}

// ── 模块级纯函数（可单测）──

/** sessionRef 取 string 值的运行时 guard（Record 索引读经 typeof 收窄，非裸取）。 */
function refString(ref: Record<string, string>, key: string): string | undefined {
  const v = ref[key];
  return typeof v === "string" ? v : undefined;
}

/** 默认版本探测：spawn `<command> --version`（probe 超时按探针失败处理）。 */
async function defaultProbeVersion(invocation: PiInvocation): Promise<string | undefined> {
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      execFile(
        invocation.command,
        invocation.args,
        { encoding: "utf8", timeout: PROBE_VERSION_TIMEOUT_MS },
        (err: Error | null, stdout: string) => {
          if (err) reject(err);
          else resolve(stdout.trim().split("\n")[0]?.trim() || undefined);
        },
      );
    });
  } catch (err) {
    // 版本探测是 best-effort（失败经 checks 反映进 ProbeReport，不影响执行主流程），
    // debug 级留诊断线索即可，不刷 info/warn
    logger.debug(
      `[pi-engine] probe version check failed (best-effort continue): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

/**
 * invocation 是否可解析：非 PATH 依赖形态（node+script / standalone binary）直接认
 * （command 是已存在的绝对路径）；PATH 形态（command === "pi"）扫 PATH 目录核实。
 */
function isInvocationResolvable(invocation: PiInvocation): boolean {
  if (invocation.command !== "pi") return true;
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === "") continue;
    try {
      if (fs.existsSync(path.join(dir, "pi"))) return true;
    } catch (err) {
      // 单目录探测失败（权限等）继续扫下一个——debug 级留线索即可
      logger.debug(
        `[pi-engine] PATH dir probe failed (continue scanning): ${dir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return false;
}

/** execution AgentResult（chat 轮次）→ AgentOutcome（port 契约形态完备；chat 编排
 *  侧不消费——终态迁移/notify 在编排层）。 */
function chatResultToOutcome(
  result: AgentResult,
  sessionFile: string | undefined,
  worktreePath: string | undefined,
): AgentOutcome {
  return {
    content: result.text,
    ...(result.parsedOutput !== undefined ? { parsedOutput: result.parsedOutput } : {}),
    durationMs: result.durationMs,
    ...(result.error !== undefined ? { error: result.error } : {}),
    sessionId: result.sessionId,
    ...(sessionFile !== undefined ? { sessionFile } : {}),
    ...(worktreePath !== undefined ? { worktreePath } : {}),
    // toolCalls 不映射（execution ToolCall ≠ AgentOutcome 的 orchestration ToolCallEntry，
    // chat 编排侧不消费本 outcome——终态记账在编排层 record 通路）
    engineId: PI_ENGINE_ID,
  };
}

/** orchestration AgentResult → AgentOutcome（补 engineId；exitCode 无来源缺省）。 */
function workflowResultToOutcome(wf: WorkflowAgentResult, ctx?: RunContext): AgentOutcome {
  return {
    content: wf.content,
    parsedOutput: wf.parsedOutput,
    usage: wf.usage,
    durationMs: wf.durationMs,
    error: wf.error,
    sessionId: wf.sessionId,
    sessionFile: wf.sessionFile,
    worktreePath: wf.worktreePath,
    toolCalls: wf.toolCalls,
    engineId: PI_ENGINE_ID,
    // D9① fallback 留痕（路由层经 RunContext 透传；无 fallback 缺省）
    ...(ctx?.engineFallback !== undefined ? { engineFallback: ctx.engineFallback } : {}),
  };
}

/** 死 handle 的统一拒绝（D1 推论：engine_session_not_resumable 指向 cold resume 路径）。 */
function notResumable(handle: EngineHandle): InteractResult {
  return {
    ok: false,
    code: "engine_session_not_resumable",
    message:
      `the pi session behind this handle is not resumable via interact (record not found for ` +
      `sessionRef ${JSON.stringify(handle.data.sessionRef)}). Idle-process reuse does not survive a main-session ` +
      `reload. Recovery: use a cold resume path (pi --session / --resume with the session file), or start a new subagent.`,
  };
}
