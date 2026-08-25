// src/execution/engine/engines/pi/pi-engine.ts
//
// PiEngine（P1 回填）：现有 pi spawn 执行链的引擎适配器。设计权威源：
// docs/architecture/subagent-engine-abstraction.md §3.3.1（PiEngine = 现有 spawn 链回填，
// 行为零变化）、D1（四面 + handle 契约 + abort 分级）、D3（capabilities 链路接通口径）。
//
// 定位是「薄适配层」而非重新实现：不物理移动 session-runner.ts / pi-invocation.ts 等
// 现有文件（现有 40+ 测试的 import 路径零变化），run 委托 SubagentService.executeAndAwait
// （其内 runSpawn 即 pi 引擎本体），interact 委托现有 chatMode 交互面
// （getRecordForAction + deliverMessage / closeSubagent / cancel 直通），read 复用
// session-reconstructor（pi JSONL 原生读取——P5 下沉为共享 reader 模块的现状本体）。
//
// pi 专有语义的隔离点在 task-spec-mapper.ts（effort↔thinkingLevel、persona↔skillPath、
// schemaEnv 派生）——本文件只做委托与形态映射，不出现第二个 pi 语义翻译点。

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { getLogger } from "@zhushanwen/pi-extension-logger";

import type { AgentResult as WorkflowAgentResult } from "../../../../orchestration/models/types.ts";
import type { PiInvocation } from "../../../pi-invocation.ts";
import { getPiInvocation } from "../../../pi-invocation.ts";
import type { StatusFilter } from "../../../record-store.ts";
import { reconstructFromFile } from "../../../session-reconstructor.ts";
import type { SubagentStream } from "../../../stream-sink.ts";
import type {
  AgentEvent,
  AgentUsageTotal,
  ExecutionRecord,
  ExecuteOptions,
  InternalToolCall,
  SubagentRecord,
  ToolCall,
  Turn,
} from "../../../types.ts";
import type { EnginePort, EngineRunResult, RunContext } from "../../port.ts";
import type {
  AgentOutcome,
  AgentTaskSpec,
  EngineCapabilities,
  EngineHandle,
  InteractAction,
  InteractResult,
  ProbeReport,
  ReplayedTurn,
  SessionView,
} from "../../types.ts";
import { taskSpecToExecuteOptions } from "./task-spec-mapper.ts";

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

/**
 * PiEngine 委托的编排服务面——SubagentService 的结构子集（鸭子类型：生产实现是
 * SubagentService 单例；测试可注入 fake，不必构造整个 Service）。
 * 为什么用结构接口而非直接 import SubagentService 类型：pi-engine 只依赖它实际消费的
 * 方法面，防 Service 内部演进（增删私有方法）连锁影响引擎适配层。
 */
export interface PiEngineService {
  executeAndAwait(
    opts: ExecuteOptions,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<WorkflowAgentResult>;
  getRecordForAction(id: string): ExecutionRecord;
  deliverMessage(record: ExecutionRecord, text: string, interrupt: boolean): Promise<void>;
  closeSubagent(record: ExecutionRecord, force: boolean): Promise<void>;
  cancel(id: string): boolean;
  collectRecords(limit: number, statusFilter?: StatusFilter): SubagentRecord[];
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

    // check 1：invocation 可解析（node 脚本存在 / standalone binary / PATH 可见）
    const invocation = getPiInvocation(["--version"]);
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
    const opts = taskSpecToExecuteOptions(task, {
      ctxModel: ctx.ctxModel,
      // 解耦形态兜底（schema 缺失时才生效，派生优先——见 mapper 注释）
      ...(ctx.schemaEnv !== undefined ? { schemaEnvFallback: ctx.schemaEnv } : {}),
    });
    // ctx.stream / onEvent / signal 直通——与 SAR 接线前的传参完全一致（双通道互斥设计
    // 保持在 service/session-runner 内，引擎层不二次包装）
    const wfResult = await service.executeAndAwait(opts, ctx.signal, ctx.onEvent, ctx.stream);
    return {
      handle: this.buildHandle(wfResult, ctx),
      outcome: workflowResultToOutcome(wfResult),
    };
  }

  /**
   * D1 可选面：chatMode 交互控制面直通现有实现（message=deliverMessage /
   * close=closeSubagent / cancel=cancel）。message 的 interrupt 语义（steer 抢占 vs
   * followUp 排队）中立 action 未携带——P1 恒 false（followUp，与 tool 面默认一致）；
   * 后续 wave 如需抢占语义再扩展 InteractAction（设计 §3.3.5 的载荷形状）。
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
      if (action.kind === "message") {
        await service.deliverMessage(record, action.payload, false);
        return { ok: true, delivered: true };
      }
      await service.closeSubagent(record, action.payload?.force === true);
      return { ok: true, delivered: true };
    } catch (err) {
      // 现有交互面以 throw 表达业务拒绝（not ready / EPIPE 兜底耗尽等，文案自带行动语言）
      // ——转结构化失败，调用方拿 code+message 而非异常
      return {
        ok: false,
        code: "engine_interact_failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * D6 read 第①级：pi session JSONL 原生读取（session-reconstructor——完整重建
   * turns/usage，sessionRead: 'full' 的依据）。降级：无 sessionRef / 文件缺失损坏 →
   * outcome-only（第②级 journal 属 P2，落地后插在本分支之前）。
   */
  async read(handle: EngineHandle): Promise<SessionView> {
    const sessionFile = refString(handle.data.sessionRef, "sessionFile");
    const recon = sessionFile !== undefined ? reconstructFromFile(sessionFile) : undefined;
    if (!recon) {
      return { engineId: PI_ENGINE_ID, turns: [], source: "outcome-only" };
    }
    return {
      engineId: PI_ENGINE_ID,
      // recon.id 是 subagent record id——pi 链路的 sessionId 约定即 header id 兜底
      // record.id（collectResult 同源），此处沿用同一约定
      sessionId: recon.id,
      turns: recon.turns.map(toReplayedTurn),
      usage: aggregateUsage(recon.turns),
      source: "native",
    };
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

/** orchestration AgentResult → AgentOutcome（补 engineId；exitCode/engineFallback P1 无来源）。 */
function workflowResultToOutcome(wf: WorkflowAgentResult): AgentOutcome {
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

/** Turn → ReplayedTurn：剥离内部态（_status/startedTs），closed 恒 true（§3.3.6）。 */
function toReplayedTurn(turn: Turn): ReplayedTurn {
  return {
    text: turn.text,
    thinking: turn.thinking,
    toolCalls: turn.toolCalls.map(stripToolCall),
    closed: true,
  };
}

/** InternalToolCall → ToolCall（导出纯净形状，不泄漏 running/done/failed 内部状态机）。 */
function stripToolCall(tc: InternalToolCall): ToolCall {
  return {
    toolName: tc.toolName,
    ...(tc.args !== undefined ? { args: tc.args } : {}),
    ...(tc.result !== undefined ? { result: tc.result } : {}),
    ...(tc.isError !== undefined ? { isError: tc.isError } : {}),
  };
}

/** 各 turn usageDelta 聚合为 AgentUsageTotal（无任何 usage 数据时 undefined）。 */
function aggregateUsage(turns: Turn[]): AgentUsageTotal | undefined {
  let acc: AgentUsageTotal | undefined;
  for (const turn of turns) {
    const d = turn.usageDelta;
    if (!d) continue;
    if (!acc) acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, total: 0 };
    acc.input += d.input;
    acc.output += d.output;
    acc.cacheRead += d.cacheRead;
    acc.cacheWrite += d.cacheWrite;
    acc.cost += d.cost ?? 0;
  }
  if (acc) acc.total = acc.input + acc.output + acc.cacheRead + acc.cacheWrite;
  return acc;
}
