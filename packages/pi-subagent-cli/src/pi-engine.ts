// src/pi-engine.ts
//
// PiEngine 协议化引擎适配器（W7，impl-plan §2.7）——core engines/pi/pi-engine.ts
// 的引擎进程内形态。
//
// 归属对照（设计 §3.8 D2 表；v1.x chat-domain 设计 §3.2 D1-A 后形态）：
//   - spawn 执行链（runSpawn 本体 / sendPromptCommand / EPIPE 兜底 / stdin 驱动）
//     → 本包 spawn-runner（迁移物）；
//   - chat 域轮次 → [v1.x] 本包承载（chat-session 会话管理器 + run 会话形态分支）：
//     长驻子进程 / 轮终 roundLifecycle 上报 / 冷续 resume / interact 控制面；
//   - HostBridge 编排面（executeAndAwait / record 状态回写 / idle+activate lock 定时器）
//     → core（W3 改线消费本引擎的事件面）；
//   - read：①级 pi 原生读取依赖 core session-reconstructor（§2.7「保持 core」），
//     引擎包 read 走 ②级 journal 重放（SDK journal-replay）→ ③级 outcome-only
//     降级链（deviations 登记：①级留在 core 侧过渡期链路，W10 conformance 定夺）。
//
// capabilities 与 core PiEngine.capabilities() 逐位一致（manifest 快照同源）。

import { execFile } from "node:child_process";

import { buildOutboundChildEnv } from "@zhushanwen/subagent-engine-sdk";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  EngineSdkError,
  getLogger,
  type AgentEvent,
  type AgentOutcome,
  type EngineCapabilities,
  type InteractAction,
  type InteractResult,
  type ProbeReport,
  type SessionView,
  type UiRequest,
  type UiResponse,
} from "@zhushanwen/subagent-engine-sdk";

import { PI_ADAPTER_VERSION, PI_ENGINE_ID, PI_POOL_KEY } from "./constants.ts";
import { toErrorMessage } from "./error-message.ts";
import type { AgentCallOpts, EngineHandle, EnginePort, EngineCtxModel, RunContext } from "./port-types.ts";
import type { PiInvocation } from "./pi-invocation.ts";
import { getPiInvocation } from "./pi-invocation.ts";
import {
  clearEpipeFailure,
  EPIPE_FAILURE_THRESHOLD,
  recordEpipeFailure,
  sendPromptCommand,
  resetAllEpipeFailures,
} from "./stdin-writer.ts";
import {
  getActiveChild,
  killAllActiveChildren,
  type SpawnRunCallbacks,
  type SpawnRunResult,
  runSpawnOnce,
} from "./spawn-runner.ts";
import { ChatSessionRegistry, type ChatHostChannels } from "./chat-session.ts";
import { replayJournalToSessionView } from "./read-fallback.ts";

const logger = getLogger("pi-engine");

/** probe 的版本探测超时（ms）。二进制无响应时按探针失败处理，不静默挂死。 */
const PROBE_VERSION_TIMEOUT_MS = 10_000;

/** PiEngine 构造依赖。 */
export interface PiEngineDeps {
  /**
   * 数据根（协议 initialize 的 hostInfo.dataRoot；subagent session 目录相对它推导）。
   * 缺省读 env XYZ_AGENT_DATA_DIR——两者皆无时 probe 报错（resolveEngineDataDir 语义，
   * 显式报 engine_not_found 附期望路径，不猜 cwd）。
   */
  dataDir?: string;
  /** 版本探测执行器（测试注入 fake 避免真实子进程）。 */
  probeVersion?: (invocation: PiInvocation) => Promise<string | undefined>;
  /** spawn 执行器（测试注入 fake；缺省 runSpawnOnce）。 */
  spawnRunner?: (params: Parameters<typeof runSpawnOnce>[0], callbacks: SpawnRunCallbacks) => Promise<SpawnRunResult>;
}

/** subagent session 目录（core getSubagentSessionDir 的包内等价形态：
 *  <dataDir>/subagents/sessions/<encoded(cwd)>）。 */
function resolveSessionDir(dataDir: string, cwd: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return path.join(dataDir, "subagents", "sessions", encoded);
}

/** 数据根解析：显式注入 > env；皆无 → undefined（run/probe 时显式报错）。 */
function resolveDataRoot(explicit: string | undefined): string | undefined {
  if (explicit !== undefined && explicit !== "") return explicit;
  const env = process.env.XYZ_AGENT_DATA_DIR;
  return env !== undefined && env !== "" ? env : undefined;
}

/** pi 引擎适配器（EnginePort 实现，协议服务器的驱动对象）。 */
export class PiEngine implements EnginePort {
  readonly id = PI_ENGINE_ID;

  private readonly deps: PiEngineDeps;
  private probeCache: ProbeReport | undefined;
  /** [v1.x] chat 会话注册表（长驻会话状态面——见 chat-session.ts 文件头）。 */
  private readonly chatSessions: ChatSessionRegistry;

  constructor(deps: PiEngineDeps = {}) {
    this.deps = deps;
    this.chatSessions = new ChatSessionRegistry(
      deps.spawnRunner !== undefined ? { spawnRunner: deps.spawnRunner } : {},
    );
  }

  /** pi 链路实际接通的能力（与 core PiEngine.capabilities() 逐位一致——manifest 同源）。 */
  capabilities(): EngineCapabilities {
    return {
      // PI_WORKFLOW_SCHEMA env 注入 + structured-output 扩展（方案 A 唯一校验权威）
      schemaEnforcement: "native",
      // pi RPC 有 steer，但 spawn 链路未接通（turn-limiter steer no-op）
      steer: "unsupported",
      // chatMode idle 复用 + message/close/cancel 交互面已接通（v1.x 协议路径：
      // run 会话形态 + chat-session 会话管理器承载轮次）
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
      // 现链路 abort = SIGTERM（pi 子进程 trap 后 graceful shutdown）
      interrupt: "kill-only",
      // argv-mirror 镜像主进程 --approve 等 flag
      permissionMode: "native",
      // turn limiter + spawn watchdog 估算兑现轮数上限
      maxTurns: true,
    };
  }

  /** 探针（D7）：invocation 可解析（二进制/脚本存在）+ 版本解析。relay:false 显式
   *  直连——探针测 pi 本体可解析性，经 relay 探到的是 runtime 健康，语义错位。 */
  async probe(opts?: { force?: boolean }): Promise<ProbeReport> {
    if (!opts?.force && this.probeCache) return this.probeCache;

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

  /** run 的引擎侧实现：协议 RunParams → spawn-runner 单次执行。
   *
   * run 期间事件经 ctx.onEvent（server 层 → `event` 通知）；session 身份经
   * ctx.onHandleReady（→ host/handleReady）；子进程 pid/状态经镜像回调上报。
   * 抛错语义（core PiEngine.run ①）：prepare 期失败 reject，不产生 handle。
   *
   * [v1.x] ctx.chat 存在 = chat 会话形态（首轮/冷续）：委托 chat-session 长驻执行
   * （agent_end 不 kill、agent_settled resolve——本轮收口进程保活，续聊经 interact）。 */
  async run(task: AgentCallOpts, ctx: RunContext): Promise<{ handle: EngineHandle; outcome: AgentOutcome }> {
    const dataDir = resolveDataRoot(this.deps.dataDir);
    if (dataDir === undefined) {
      throw new EngineSdkError(
        "engine_not_found",
        "pi-subagent-cli cannot resolve the engine data root (neither initialize hostInfo.dataRoot nor env XYZ_AGENT_DATA_DIR is set)",
        "The host must pass hostInfo.dataRoot at initialize, or inject XYZ_AGENT_DATA_DIR into the engine child env. Expected shape: <xyz-agent dataDir> (sessions live under <dataDir>/subagents/sessions/).",
      );
    }
    // pi 无隔离池（poolKey 恒 'shared'）——恒值声明，宿主 journal writer 无需重定向
    ctx.onPoolResolved?.(PI_POOL_KEY);

    const cwd = task.cwd ?? process.cwd();
    if (ctx.chat !== undefined) {
      return this.runChatRound(task, ctx, dataDir, cwd);
    }
    const spawn = this.deps.spawnRunner ?? runSpawnOnce;
    const callbacks: SpawnRunCallbacks = {
      onEvent: (event: AgentEvent) => ctx.onEvent?.(event),
      onHandleReady: (partial) => ctx.onHandleReady?.(partial),
      onChildSpawned: (pid) => {
        ctx.onChildSpawned?.({ pid, killed: false });
      },
      ...(ctx.stream !== undefined
        ? { onDelta: (delta: string) => ctx.stream?.onDelta(delta) }
        : {}),
      ...(this.askUserHandler !== undefined
        ? { askUser: (req: UiRequest) => this.askUserHandler!(req) }
        : {}),
    };

    const result = await spawn(
      {
        recordId: ctx.taskId,
        task: task.prompt,
        agentName: task.description ?? task.agent ?? "workflow-agent",
        model: ctx.ctxModel !== undefined
          ? `${(ctx.ctxModel as EngineCtxModel).provider}/${(ctx.ctxModel as EngineCtxModel).id}`
          : task.model,
        ...(task.thinkingLevel !== undefined ? { thinkingLevel: task.thinkingLevel } : {}),
        sessionDir: resolveSessionDir(dataDir, cwd),
        cwd,
        ...(task.schemaEnv !== undefined ? { schemaEnv: task.schemaEnv } : {}),
        ...(task.maxTurns !== undefined ? { maxTurns: task.maxTurns } : {}),
        ...(task.graceTurns !== undefined ? { graceTurns: task.graceTurns } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        ...(task.skillPath !== undefined ? { skillPaths: [task.skillPath] } : {}),
        ...(task.appendSystemPrompt !== undefined ? { appendSystemPrompt: task.appendSystemPrompt } : {}),
      },
      callbacks,
    );

    return {
      handle: {
        data: {
          v: 1,
          engineId: PI_ENGINE_ID,
          sessionRef: {
            recordId: ctx.taskId,
            ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
            ...(result.sessionFile !== undefined ? { sessionFile: result.sessionFile } : {}),
          },
          poolKey: PI_POOL_KEY,
          adapterVersion: PI_ADAPTER_VERSION,
        },
      },
      outcome: toOutcome(result),
    };
  }

  /**
   * [v1.x] run 会话形态主体（首轮/冷续，chat-domain 设计 §3.2 D1-A）：spawn 长驻子进程
   * + 首轮 prompt，本轮 agent_settled（真空闲）resolve（进程保活）。record 锚定键 =
   * chat.recordId（区别于一次性 run 的 runId 锚定——interact/roundLifecycle 据此定位）；
   * resume 锚点存在 = 冷续（--session 续写原文件），不存在 = 首轮新建。
   */
  private async runChatRound(
    task: AgentCallOpts,
    ctx: RunContext,
    dataDir: string,
    cwd: string,
  ): Promise<{ handle: EngineHandle; outcome: AgentOutcome }> {
    const chat = ctx.chat!;
    const resumeFile = refString(chat.resume?.sessionRef ?? {}, "sessionFile");
    const result = await this.chatSessions.startRound(
      {
        recordId: chat.recordId,
        task: task.prompt,
        agentName: task.description ?? task.agent ?? "chat-agent",
        model: ctx.ctxModel !== undefined
          ? `${(ctx.ctxModel as EngineCtxModel).provider}/${(ctx.ctxModel as EngineCtxModel).id}`
          : task.model,
        ...(task.thinkingLevel !== undefined ? { thinkingLevel: task.thinkingLevel } : {}),
        sessionDir: resolveSessionDir(dataDir, cwd),
        cwd,
        ...(task.schemaEnv !== undefined ? { schemaEnv: task.schemaEnv } : {}),
        ...(task.maxTurns !== undefined ? { maxTurns: task.maxTurns } : {}),
        ...(task.graceTurns !== undefined ? { graceTurns: task.graceTurns } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        ...(task.skillPath !== undefined ? { skillPaths: [task.skillPath] } : {}),
        ...(task.appendSystemPrompt !== undefined ? { appendSystemPrompt: task.appendSystemPrompt } : {}),
        ...(resumeFile !== undefined ? { resumeSessionFile: resumeFile } : {}),
      },
      {
        runId: ctx.taskId,
        onEvent: (event: AgentEvent) => ctx.onEvent?.(event),
        ...(ctx.stream !== undefined ? { stream: ctx.stream } : {}),
        onHandleReady: (partial) => ctx.onHandleReady?.(partial),
        onChildSpawned: (pid) => {
          ctx.onChildSpawned?.({ pid, killed: false });
        },
      },
    );

    return {
      handle: {
        data: {
          v: 1,
          engineId: PI_ENGINE_ID,
          sessionRef: {
            recordId: chat.recordId,
            ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
            ...(result.sessionFile !== undefined ? { sessionFile: result.sessionFile } : {}),
          },
          poolKey: PI_POOL_KEY,
          adapterVersion: PI_ADAPTER_VERSION,
        },
      },
      outcome: toOutcome(result),
    };
  }

  /**
   * D1 交互控制面。[v1.x] chat 会话（chat-session 命中）优先路由：
   *   - message：热路径 sendPromptCommand + streamingBehavior（interrupt=steer 抢占/
   *     缺省 followUp 排队——pi 上游语义）+ EPIPE 兜底（耗尽 → roundLifecycle failed）；
   *     冷路径（进程死）→ engine_session_not_resumable + 冷续指引（宿主发新 run chat+resume）；
   *   - close：force=杀链立即收割 / 缺省=优雅（轮收口后收割）；
   *   - cancel：D3 收敛语义（受理 → 等轮终相位 → 超 CANCEL_SETTLE_GRACE_MS 杀链升级）。
   *
   * 未命中（一次性 run 的活跃子进程 / 冷句柄）走下方既有路径：message 热路径直写、
   * close = SIGTERM、cancel = SIGTERM（无收敛等待——run 域 cancel 帧另有 AbortController
   * 通道，收敛由 run 应答承载）。
   */
  async interact(handle: EngineHandle, action: InteractAction): Promise<InteractResult> {
    try {
      const recordId = refString(handle.data.sessionRef, "recordId");
      if (recordId === undefined) return notResumable(handle);
      if (this.chatSessions.has(recordId)) {
        if (action.kind === "cancel") return this.chatSessions.cancel(recordId);
        if (action.kind === "close") return this.chatSessions.close(recordId, action.payload?.force === true);
        return this.chatSessions.deliverMessage(recordId, action.payload, action.interrupt === true);
      }
      if (action.kind === "cancel") {
        const child = getActiveChild(recordId);
        if (child === undefined) return { ok: true, delivered: true };
        child.kill("SIGTERM");
        return { ok: true, delivered: true };
      }
      if (action.kind === "close") {
        killRecordChild(recordId);
        return { ok: true, delivered: true };
      }
      // message：热路径（进程活）sendPromptCommand 直写 stdin
      const child = getActiveChild(recordId);
      if (child === undefined || child.killed) {
        return {
          ok: false,
          code: "engine_session_not_resumable",
          message:
            `the pi session behind this handle has no live process in this engine instance (cold path). ` +
            `Recovery: dispatch a new run with ctx resume (pi --session cold resume), or start a new subagent.`,
        };
      }
      try {
        sendPromptCommand(child, action.payload, {
          streamingBehavior: action.interrupt === true ? "steer" : "followUp",
        });
        clearEpipeFailure(recordId);
        return { ok: true, delivered: true };
      } catch (err) {
        if (err instanceof Error && err.message.includes("EPIPE")) {
          const count = recordEpipeFailure(recordId);
          if (count >= EPIPE_FAILURE_THRESHOLD) {
            clearEpipeFailure(recordId);
            throw new Error(
              `[subagents] EPIPE fallback exhausted for ${recordId}: ${count} consecutive EPIPE failures. ` +
                `Recovery: use action:'close' to clean up, then action:'start' a new subagent.`,
            );
          }
          return {
            ok: false,
            code: "engine_session_not_resumable",
            message: `EPIPE on hot path for ${recordId} (stdin pipe broken, child likely exited; attempt ${count}/${EPIPE_FAILURE_THRESHOLD}). Recovery: retry after close, or start a new subagent run.`,
          };
        }
        throw err;
      }
    } catch (err) {
      return {
        ok: false,
        code: "engine_interact_failed",
        message: toErrorMessage(err),
      };
    }
  }

  /**
   * read 三级降级（协议化形态）：②级 journal 重放（SDK journal-replay 纯投影）
   * → ③级 outcome-only。①级 pi 原生读取（session-reconstructor）按 §2.7 保持
   * core，不随迁（deviations 登记）。
   */
  async read(handle: EngineHandle): Promise<SessionView> {
    const sessionFile = refString(handle.data.sessionRef, "sessionFile");
    const journaled = replayJournalToSessionView(handle, PI_ENGINE_ID);
    if (journaled !== undefined) return journaled;
    void sessionFile;
    return { engineId: PI_ENGINE_ID, turns: [], source: "outcome-only" };
  }

  /** dispose：全量收割活跃子进程 + 清 EPIPE 计数（幂等）。 */
  async dispose(): Promise<void> {
    killAllActiveChildren();
    resetAllEpipeFailures();
  }

  // ── 反向通道注入面（server 构造后接线 host/askUser） ──

  private askUserHandler: ((req: UiRequest) => Promise<UiResponse>) | undefined;

  /** server 层注入 host/askUser 两阶段等待体（ui-request-queue 消费）。 */
  bindAskUser(handler: ((req: UiRequest) => Promise<UiResponse>) | undefined): void {
    this.askUserHandler = handler;
  }

  /**
   * server 层注入 [v1.x] chat 会话的反向通道发射面（host/roundLifecycle、recordId 键
   * host/streamDelta、会话级 host/askUser）。会话跨 run 存活，绑定是引擎进程生命周期
   * 级（区别于一次性 run 的 per-run askUser 绑定）。
   */
  bindHostChannels(channels: ChatHostChannels | undefined): void {
    this.chatSessions.bindHostChannels(channels);
  }
}

/** SpawnRunResult → AgentOutcome（core workflowResultToOutcome 的引擎侧等价）。 */
function toOutcome(result: SpawnRunResult): AgentOutcome {
  return {
    content: result.content,
    ...(result.failureKind !== undefined ? { failureKind: result.failureKind } : {}),
    ...(result.parsedOutput !== undefined ? { parsedOutput: result.parsedOutput } : {}),
    ...(result.usage !== undefined
      ? { usage: toOutcomeUsage(result) }
      : {}),
    durationMs: result.durationMs,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
    ...(result.sessionFile !== undefined ? { sessionFile: result.sessionFile } : {}),
    toolCalls: result.toolCalls.map((tc) => ({
      name: tc.toolName,
      input: tc.args === undefined ? "" : JSON.stringify(tc.args),
    })),
    engineId: PI_ENGINE_ID,
  };
}

/** usage 域映射（collector 聚合面 → AgentOutcomeUsage 的必填字段装配）。 */
function toOutcomeUsage(result: SpawnRunResult): import("@zhushanwen/subagent-engine-sdk").AgentOutcomeUsage {
  const u = result.usage!;
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    cost: u.cost ?? 0,
    contextTokens: u.input + u.cacheRead,
    turns: result.turns,
  };
}

/** sessionRef 取 string 值的运行时 guard。 */
function refString(ref: Record<string, string>, key: string): string | undefined {
  const v = ref[key];
  return typeof v === "string" ? v : undefined;
}

/** 杀单个 record 的活跃子进程（SIGTERM；升级链由 killAll 兜底）。 */
function killRecordChild(recordId: string): void {
  const child = getActiveChild(recordId);
  if (child === undefined || child.killed) return;
  child.kill("SIGTERM");
}

/** 死/不可定位 handle 的统一拒绝（D1 推论：指向冷续路径）。 */
function notResumable(handle: EngineHandle): InteractResult {
  return {
    ok: false,
    code: "engine_session_not_resumable",
    message:
      `the pi session behind this handle is not resumable via interact (record not found for ` +
      `sessionRef ${JSON.stringify(handle.data.sessionRef)}). Recovery: use a cold resume path ` +
      `(pi --session with the session file), or start a new subagent.`,
  };
}

/** 默认版本探测：spawn `<command> --version`（probe 超时按探针失败处理）。 */
async function defaultProbeVersion(invocation: PiInvocation): Promise<string | undefined> {
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      execFile(
        invocation.command,
        invocation.args,
        { encoding: "utf8", timeout: PROBE_VERSION_TIMEOUT_MS, env: buildOutboundChildEnv({ parentEnv: process.env }) },
        (err: Error | null, stdout: string) => {
          if (err) reject(err);
          else resolve(stdout.trim().split("\n")[0]?.trim() || undefined);
        },
      );
    });
  } catch (err) {
    // 版本探测是 best-effort（失败经 checks 反映进 ProbeReport），debug 级留线索
    logger.debug(
      `[pi-engine] probe version check failed (best-effort continue): ${toErrorMessage(err)}`,
    );
    return undefined;
  }
}

/**
 * invocation 是否可解析：非 PATH 依赖形态直接认；PATH 形态扫 PATH 目录核实。
 */
function isInvocationResolvable(invocation: PiInvocation): boolean {
  if (invocation.command !== "pi") return true;
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === "") continue;
    try {
      if (fs.existsSync(path.join(dir, "pi"))) return true;
    } catch (err) {
      logger.debug(
        `[pi-engine] PATH dir probe failed (continue scanning): ${dir}: ${toErrorMessage(err)}`,
      );
    }
  }
  return false;
}
