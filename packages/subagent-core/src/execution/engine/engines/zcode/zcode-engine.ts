// src/execution/engine/engines/zcode/zcode-engine.ts
//
// ZcodeEngine（P3 → R4 双模式）：zcode CLI 的 EnginePort 实现。设计权威源：
// docs/architecture/subagent-engine-abstraction.md D10（MVP 引擎集）/ §3.3.4（reviewer@zcode
// 物理数据流）/ §3.3.5（run 错误语义三条）；docs/design/zcode-engine-appserver-resident.md
// §3.3 D1（每引擎实例一条连接）/ D3（abort 链）/ D4（会话自包含）/ D5（capabilities
// 升级序）/ D6（停机面 + 孤儿自愈）/ D7（常驻 HOME）/ §3.4 不变量 1-4。
//
// 双模式分派（R4；D2 降级链的骨架）：
//   - appserver（缺省）：惰性常驻连接（connection.ts + session-channel.ts）上的
//     create→subscribe→send→事件流→终态→read→close；per-session model 经 create
//     参数透传；常驻 HOME = engines/zcode/home-appserver（D7 全量语义见 preparer.ts）；
//     缺省路径带 R5 降级链门控：协议冒烟探针（appserver-probe.ts，结论与 CLI mtime
//     绑定）失败 → 本任务起 spawn 直走；首任务命中漂移类 RPC 错误（-32601/-32602）
//     → 本任务降级 spawn 重跑一次 + 后续任务直走 spawn（标志内存化）；
//   - spawn（XYZ_ZCODE_MODE=spawn 定向 / 降级目标）：原单轮路径**零行为改动**
//     保留（runViaSpawn——launcher/parser 四件套原链路）。
//
// 职责编排（四件套的消费方）：
//   preparer（隔离 HOME 池 + 凭据 config）→ launcher（argv/env/spawn/杀链）
//   → parser（stdout 收集 + 终 JSON + coarse 事件合成）→ reader（read 第①级 sqlite）。
//
// run 错误语义（设计 §3.3.5，两模式共用）：
//   ① prepare 期错误（credential_missing / model_not_available / prompt_too_large /
//      capability 拒绝）在进程创建前 reject，不产生 handle；
//   ② 运行中失败不 reject——合成 engine_run_failed outcome + 正常 handle 返回
//      （record 必须收尾）；
//   ③ abort：appserver 走 D3 链（session/stop → grace → killChain 连坐共享进程）；
//      spawn 走公共杀链（SIGTERM→grace→SIGKILL）——终态同为 exitCode=null + 杀链标记。
//
// schema 仿真接线（D4 emulated 侧）：common/schema-emulation.ts——spawn 前拼 prompt
// 仿真段、终态后三级容错提取 + ajv 校验、失败强化重试一次、仍失败报
// schema_emulation_failed（appserver 路径同接线：prompt 组装共享 buildPrompt，
// 校验/重试编排共享 run 级重试轮）。read 第②级 journal 降级已接线（对齐点①：
// common/journal-replay 复用 live reducer）。

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { getLogger } from "../../../../core/logger.ts";

import {
  buildSchemaEmulationSegment,
  extractAndValidateStructuredOutput,
} from "../../common/schema-emulation.ts";
import { HOST_TIMEOUT_ABORT_REASON, synthesizeTimeoutOutcome } from "../../common/kill-chain.ts";
import { engineTimeoutDetail } from "../../common/errors.ts";
import { replayJournalToSessionView } from "../../common/journal-replay.ts";
import type { EnginePort, EngineRunResult, RunContext } from "../../port.ts";
import type {
  AgentEvent,
  AgentOutcome,
  AgentTaskSpec,
  EngineCapabilities,
  EngineHandle,
  InteractAction,
  InteractResult,
  ProbeReport,
  SessionView,
} from "../../types.ts";
import { resolvePoolDir } from "../../paths.ts";
import {
  ZCODE_ADAPTER_VERSION,
  ZCODE_APPSERVER_ABORT_GRACE_MS,
  ZCODE_APPSERVER_DRIFT_RPC_CODES,
  ZCODE_APPSERVER_ERR_MODEL_CONFIG_MISSING,
  ZCODE_APPSERVER_HARVEST_GRACE_MS,
  ZCODE_APPSERVER_PIDFILE_NAME,
  ZCODE_APPSERVER_POOL_KEY,
  ZCODE_APPSERVER_STOP_TIMEOUT_MS,
  ZCODE_CLI_DEFAULT_PATH,
  ZCODE_ENGINE_ID,
  ZCODE_ERROR_TAIL_CHARS,
  ZCODE_KILL_GRACE_MS,
  ZCODE_MODE_ENV_VAR,
  ZCODE_POOL_DB_RELATIVE_PATH,
} from "./constants.ts";
import { ZCODE_GOLDEN_STDOUT } from "./golden-sample.ts";
import {
  buildZcodeArgv,
  buildZcodeEnv,
  assertZcodeArgvBudget,
  launchZcodeProcess,
  type ZcodeLaunchedProcess,
} from "./launcher.ts";
import {
  buildRunFailedMessage,
  collectZcodeOutput,
  mapZcodeOutcomeUsage,
  mapZcodeUsage,
  parseZcodeTerminal,
  synthesizeCoarseEvents,
  type ZcodeCollectedOutput,
  type ZcodeTerminalPayload,
} from "./parser.ts";
import {
  acquireAppServerHome,
  bootstrapAppServerConfig,
  isLockHeldByUs,
  startLockHeartbeat,
  writeAppServerPidFile,
  type AppServerHomeHandle,
} from "./appserver-home.ts";
import {
  listZcodeModels,
  prepareZcodeHome,
  resolveZcodeModelRef,
  splitZcodeModelRef,
  type ZcodeSourcePaths,
} from "./preparer.ts";
import { readZcodeSessionView } from "./reader.ts";
import { runAppServerSmokeProbe } from "./appserver-probe.ts";
import { AppServerConnection, buildAppServerEnv, isAppServerRpcError } from "./connection.ts";
import { SessionChannel, type SessionCreateParams, type SessionTurnResult } from "./session-channel.ts";

const logger = getLogger("subagents");

/** probe 的版本探测超时（ms）——二进制无响应按探针失败处理，不静默挂死。 */
const PROBE_VERSION_TIMEOUT_MS = 15_000;

// ============================================================
// [R4/R5] 执行模式分派（D2：定向不探不降；缺省探 + 降）
// ============================================================

export type ZcodeRunMode = "appserver" | "spawn";

/** [R5] 三态：undefined = 未定向（缺省路径，探 + 降）；定向值原样。 */
export type ZcodeModePin = ZcodeRunMode | undefined;

/**
 * [R5 D2④] 定向判定：`XYZ_ZCODE_MODE=appserver|spawn` 是**定向**（不探不降——失败
 * 直接上报，不给定向者换通道）；undefined = 缺省（probe 门控 + 首败降级）。
 * deps.processEnv 可注入（测试钉扎三态）。
 */
export function pinnedZcodeMode(env: NodeJS.ProcessEnv = process.env): ZcodeModePin {
  const v = env[ZCODE_MODE_ENV_VAR];
  return v === "appserver" || v === "spawn" ? v : undefined;
}

/**
 * 模式判定（R4 形态保留：二值视图）。缺省/未知值走 appserver——缺省路径的探针/降级
 * 门控由 run() 经 pinnedZcodeMode 三态编排，不经本函数。
 */
export function resolveZcodeMode(env: NodeJS.ProcessEnv = process.env): ZcodeRunMode {
  return pinnedZcodeMode(env) ?? "appserver";
}

/** ZcodeEngine 构造依赖（全部可注入——测试不依赖真机 CLI/真凭据）。 */
export interface ZcodeEngineDeps {
  /**
   * 引擎数据目录（池根：<dir>/engines/zcode/<poolKey>/）。来源通道（宿主 dataDir）
   * 由并行任务/W3 解决——本引擎只消费，见 registration.ts 缺省解析。
   */
  engineDataDir: () => string;
  /** zcode CLI 路径；缺省 ZCODE_CLI_DEFAULT_PATH。 */
  cliPath?: string;
  /** 源 config 路径覆盖（测试注入临时源；缺省读 ~/.zcode）。 */
  sources?: ZcodeSourcePaths;
  /** 版本探测执行器（probe check "version"；测试注入 fake 防真实子进程）。 */
  probeVersion?: (cliPath: string) => Promise<string | undefined>;
  /** spawn 执行器（测试注入 fake 进程）。 */
  launch?: (opts: { cliPath: string; args: string[]; env: NodeJS.ProcessEnv }) => ZcodeLaunchedProcess;
  /** env 基底（测试注入；缺省 process.env——模式分派与 app-server env 组装都经它）。 */
  processEnv?: NodeJS.ProcessEnv;
  /**
   * [R5 D8] 协议冒烟探针总预算（缺省 ZCODE_APPSERVER_PROBE_BUDGET_MS = 10s；测试
   * 注入短预算验证超时降级路径，不真等 10s）。
   */
  probeBudgetMs?: number;
}

/** 常驻运行时（每引擎实例一份；dispose/凭据刷新/池变更时整件丢弃重建）。 */
interface AppServerRuntime {
  conn: AppServerConnection;
  channel: SessionChannel;
  homePoolKey: string;
  homeDir: string;
  /** 在途会话登记（dispose 时 fire session/close 的目标集；settle 后移除）。 */
  activeSessions: Set<string>;
}

/** 已持有的常驻 HOME 记账（锁心跳归属；dispose 不释放——锁随宿主进程存活）。 */
interface AppServerHomeState {
  poolKey: string;
  homeDir: string;
  lockPath: string;
  stopHeartbeat: () => void;
}

/** zcode 引擎适配器。 */
export class ZcodeEngine implements EnginePort {
  readonly id = ZCODE_ENGINE_ID;

  private readonly deps: ZcodeEngineDeps;
  private probeCache: ProbeReport | undefined;
  private appserverRuntime: AppServerRuntime | undefined;
  private homeState: AppServerHomeState | undefined;
  /** 并发任务的首次锁获取在途 promise（重入守卫，见 ensureAppServerHome）。 */
  private homeAcquireInFlight: Promise<AppServerHomeHandle> | undefined;
  /**
   * [R5 D2③] 探针结论（与 CLI 文件 mtime 绑定的内存缓存）：mtime 未变不重探；
   * zcode 升级（mtime 变化）后首个任务前重探。不落盘——进程重启后重探重建。
   */
  private smokeConclusion: { cliMtimeMs: number; ok: boolean; detail: string } | undefined;
  /**
   * [R5 D2②] 漂移降级标志（内存化，不落盘）：首任务运行中命中 -32601/-32602 后置
   * true，本进程后续任务直走 spawn；进程重启后经探针门控重建（重探通过则恢复
   * app-server）。
   */
  private driftDegraded = false;

  constructor(deps: ZcodeEngineDeps) {
    this.deps = deps;
  }

  /**
   * zcode 链路实际接通的能力（D3 链路口径；R4 D5 升级序：eventGranularity
   * coarse→stream——链路先行〔session/event payload.delta → text_delta 实时流出，
   * turn.terminal → turn_end，收尾帧 usage → message_end.usage〕，其余能力位维持
   * 现值。声明升级必须先改链路再改声明（C4 原则）。
   */
  capabilities(): EngineCapabilities {
    return {
      // 无 --json-schema 类通道；公共 schema 仿真层（prompt 约定 + 容错提取 + ajv）
      schemaEnforcement: "emulated",
      // send-while-running 恒 -32010 硬错误（旧实测）——app-server 常驻化不改变此判据
      steer: "unsupported",
      // 无同进程 idle 复用（D4：每任务自包含 create→run→close）；--resume 是冷启动
      conversation: "unsupported",
      // 无 --append-system-prompt flag（实测拒收）——persona 只能拼进 prompt
      personaInjection: "prompt",
      // app-server 推送流实时流出（R4）；spawn 降级路径退化为终态两事件（D2 声明不降级
      // ——降级是任务级兜底非能力级，record 留痕降级事实）
      eventGranularity: "stream",
      // 首期未接 worktree 隔离（公共层 worktree-manager 接入后升 emulated）
      sandbox: "none",
      // sqlite 三级 JOIN 完整重建 turns（reader 实测）
      sessionRead: "full",
      // --resume 冷启动可用（实测）
      resume: "cold",
      // abort 走 D3 链（stop→grace→killChain）但声明维持 kill-only 不升级（改链路
      // 先于改声明；stop 链路经 conformance 真机验证后再评估升 native）
      interrupt: "kill-only",
      // --mode build/edit/plan/yolo 原生权限档位
      permissionMode: "native",
    };
  }

  /** 探针（D7）：二进制存在 + 版本解析 + golden 样本干跑回归（zsub 式逆向契约引擎必做）。 */
  async probe(opts?: { force?: boolean }): Promise<ProbeReport> {
    if (!opts?.force && this.probeCache) return this.probeCache;

    const cliPath = this.deps.cliPath ?? ZCODE_CLI_DEFAULT_PATH;
    // check 1：二进制存在（不在 PATH，固定绝对路径形态——存在性即可用性的第一道判据）
    const binary = this.probeBinaryCheck(cliPath);
    const checks: ProbeReport["checks"] = [binary];

    // check 2：版本解析（存在才尝试——必败进程不再 spawn）
    let engineVersion = "";
    if (binary.ok) {
      const version = await this.probeVersionCheck(cliPath);
      checks.push(version.check);
      engineVersion = version.engineVersion;
    }

    // check 3：golden 样本干跑回归（parser 对实录样本解析——格式漂移入口拦截）
    checks.push(this.probeGoldenCheck());

    const ok = checks.every((c) => c.ok);
    const report: ProbeReport = {
      ok,
      engineVersion,
      checks,
      ...(ok ? {} : { error: this.probeFailureRecovery(cliPath) }),
    };
    this.probeCache = report;
    return report;
  }

  /** check 1：二进制存在性（isFile 才算——同名目录不是可执行入口）。 */
  private probeBinaryCheck(cliPath: string): ProbeReport["checks"][number] {
    const binaryOk = fs.existsSync(cliPath) && fs.statSync(cliPath).isFile();
    return {
      name: "binary",
      ok: binaryOk,
      detail: binaryOk ? cliPath : `zcode CLI 不存在：${cliPath}`,
    };
  }

  /** check 2：`--version` 解析（probeVersion 可注入——测试 fake 防真实子进程）。 */
  private async probeVersionCheck(
    cliPath: string,
  ): Promise<{ check: ProbeReport["checks"][number]; engineVersion: string }> {
    const runVersion = this.deps.probeVersion ?? defaultProbeVersion;
    const version = await runVersion(cliPath);
    const versionOk = version !== undefined && version.length > 0;
    return {
      check: {
        name: "version",
        ok: versionOk,
        detail: versionOk ? version : "zcode --version 返回空或失败",
      },
      engineVersion: version ?? "",
    };
  }

  /** check 3：golden 样本干跑（parser 对实录样本解析——stdout 格式漂移的入口拦截）。 */
  private probeGoldenCheck(): ProbeReport["checks"][number] {
    const golden = parseZcodeTerminal(ZCODE_GOLDEN_STDOUT);
    const goldenOk = golden.ok && golden.payload.sessionId !== undefined && golden.payload.usage !== undefined;
    return {
      name: "golden-regression",
      ok: goldenOk,
      detail: goldenOk
        ? "parser 对 0.16.5 实录样本回归通过（sessionId/response/usage 形状完整）"
        : `解析实录样本失败：${golden.ok ? "字段缺失（sessionId/usage）" : golden.reason}`,
    };
  }

  /** 探针失败的恢复指引（§3.3.3 终态四：版本确认命令 + 探针重跑 + 调研文档路径）。 */
  private probeFailureRecovery(cliPath: string): NonNullable<ProbeReport["error"]> {
    return {
      code: "engine_probe_failed",
      recovery:
        `Run \`node ${cliPath} --version\` 确认 zcode CLI 可用且版本未漂移，然后重跑探针（重新初始化引擎或 probe({force:true})）。` +
        `若 stdout 格式已变：把新样本补录进 golden 库（__tests__/__fixtures__/zcode-golden-spawn.json 与 golden-sample.ts）并更新 parser。` +
        `参照 docs/research/agent-engine-zcode.md。`,
    };
  }

  /**
   * D1 主语义 + [R5] D2 降级链四步：
   *   ① 定向（XYZ_ZCODE_MODE=appserver|spawn）：不探不降——定向者要的就是这条通道，
   *      失败直接上报（spawn 兜底原路径 / appserver 直连）；
   *   ② 缺省 + 已漂移降级（内存标志）：后续任务直走 spawn（record 标注降级事实）；
   *   ③ 缺省 + 探针门控（结论与 CLI mtime 绑定）：探针失败 → 本任务起直接 spawn；
   *   ④ 缺省 + 探针通过但首任务命中漂移类 RPC 错误（-32601/-32602）→ 本任务降级
   *      spawn 重跑一次（同一任务，结果标注降级）+ 后续任务直走 spawn。
   */
  async run(task: AgentTaskSpec, ctx: RunContext): Promise<EngineRunResult> {
    this.rejectUnsupportedTaskShapes(task);
    const pin = pinnedZcodeMode(this.deps.processEnv ?? process.env);
    if (pin === "appserver") return (await this.runViaAppServer(task, ctx)).result;
    if (pin === "spawn") return this.runViaSpawn(task, ctx);

    // 缺省：probe 门控 + 首败降级（D2）
    if (this.driftDegraded) {
      return this.runViaSpawn(task, ctx, {
        degradedReason:
          "protocol-drift（app-server 首任务命中 -32601/-32602 漂移类错误，本进程后续任务直走 spawn；进程重启后重探重建）",
      });
    }
    // pre-aborted 短路：不触发探针（不 spawn 探针进程），由常驻路径内部合成中止终态
    if (ctx.signal?.aborted !== true) {
      const gate = await this.appServerProbeGate(task);
      if (!gate.ok) {
        return this.runViaSpawn(task, ctx, {
          degradedReason: `probe-failed（协议冒烟探针未通过：${gate.detail}；CLI mtime 变化后首个任务前重探）`,
        });
      }
    }
    const { result, driftCode } = await this.runViaAppServer(task, ctx);
    if (driftCode === undefined) return result;
    // D2② 首败降级：漂移错误 → 标志内存化 + 同一任务 spawn 重跑一次（结果标注）
    this.driftDegraded = true;
    logger.warn(
      `[zcode-engine] app-server 漂移类错误（RPC code ${driftCode}）——本任务降级 spawn 重跑，后续任务直走 spawn`,
      { taskId: ctx.taskId },
    );
    return this.runViaSpawn(task, ctx, {
      degradedReason: `protocol-drift（首任务 app-server 命中 RPC code ${driftCode}，已降级 spawn 重跑本任务；后续任务直走 spawn）`,
    });
  }

  /**
   * [R5 D8] 探针门控：CLI 文件 mtime 与结论绑定——mtime 未变命中缓存不重探；变化
   * （zcode 升级）或首次 → 独立短命连接上跑协议冒烟（appserver-probe.ts；必须用已
   * 引导的常驻 HOME——D7 教训「先 bootstrap 再 probe 否则永远误降级」）。CLI 不存在
   * 按探针失败处理（spawn 路径自身还有 binary 检查兜底）。
   */
  private async appServerProbeGate(task: AgentTaskSpec): Promise<{ ok: boolean; detail: string }> {
    const cliPath = this.deps.cliPath ?? ZCODE_CLI_DEFAULT_PATH;
    let cliMtimeMs: number;
    try {
      cliMtimeMs = fs.statSync(cliPath).mtimeMs;
    } catch {
      return { ok: false, detail: `zcode CLI 不存在：${cliPath}` };
    }
    if (this.smokeConclusion !== undefined && this.smokeConclusion.cliMtimeMs === cliMtimeMs) {
      return this.smokeConclusion; // mtime 未变不重探（D2③）
    }
    const modelRef = resolveZcodeModelRef(task.model, this.deps.sources);
    const home = await this.ensureAppServerHome(modelRef);
    const r = await runAppServerSmokeProbe({
      cliPath,
      homeDir: home.homeDir,
      baseEnv: this.deps.processEnv ?? process.env,
      stderrLogPath: path.join(this.deps.engineDataDir(), "logs", "zcode-appserver-probe-stderr.log"),
      ...(this.deps.probeBudgetMs !== undefined ? { budgetMs: this.deps.probeBudgetMs } : {}),
    });
    this.smokeConclusion = { cliMtimeMs, ok: r.ok, detail: r.detail };
    logger.debug("[zcode-engine] appserver smoke probe", { ok: r.ok, detail: r.detail, cliMtimeMs });
    return this.smokeConclusion;
  }

  // ============================================================
  // [R4] app-server 常驻路径（D1/D3/D4/D7）
  // ============================================================

  /**
   * 常驻路径主编排：常驻 HOME（锁/派生/孤儿回收/凭据刷新——preparer D7 全量）→
   * 惰性连接 + runTurn（事件时序前移：text_delta 流式、终态后 message_end/turn_end）→
   * schema 仿真重试（与 spawn 同编排）→ outcome/handle。poolKey 静态常量，
   * onPoolResolved 在 prepare 期、onHandleReady 在 create 应答后（§3.4 不变量 3）。
   *
   * [R5] 返回附带 driftCode：末轮 attempt 以漂移类 RPC 错误（-32601/-32602）收场时
   * 给出 code（run 编排降级 spawn 重跑）；其余终态（成功/中止/非漂移失败）为
   * undefined——-32004/-32010/-32603 按错误规格表各自上报，不降级。
   */
  private async runViaAppServer(
    task: AgentTaskSpec,
    ctx: RunContext,
  ): Promise<{ result: EngineRunResult; driftCode: number | undefined }> {
    const startedAt = Date.now();
    // pre-aborted 短路：取消先于启动——不创建会话、不触发连接惰性启动（防误杀共享
    // 进程殃及在途任务；spawn 路径无此形态因每任务独占进程）
    if (ctx.signal?.aborted === true) {
      const outcome = this.finalizeOutcome(
        task,
        ctx,
        abortedAppServerAttempt(ctx),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, has: false },
        startedAt,
      );
      // poolKey 锚定：已持有 HOME（含派生场景）用其真实 poolKey；首次即 abort 尚无
      // HOME 可用，退回静态常量（此刻确实无派生事实可锚定）
      const poolKey = this.homeState?.poolKey ?? ZCODE_APPSERVER_POOL_KEY;
      return { result: { handle: this.appServerHandle(poolKey, outcome), outcome }, driftCode: undefined };
    }

    // ① prepare 期：模型解析（provider 体系校验——错误语义与 spawn 同为进程创建前
    // reject）+ 常驻 HOME（锁判定/派生/pidfile 孤儿回收/config 内容 hash 刷新）
    const modelRef = resolveZcodeModelRef(task.model, this.deps.sources);
    const home = await this.ensureAppServerHome(modelRef);
    // 对齐点③（不变量 3）：poolKey 在 prepare 期声明（静态常量或派生目录名），
    // 早于连接建立与首个事件
    ctx.onPoolResolved?.(home.poolKey);

    const cwd = task.cwd ?? process.cwd();
    const schema = isPlainObject(task.schema) ? task.schema : undefined;
    const basePrompt = this.buildPrompt(task, schema);

    // ② 首轮执行；schema 任务校验失败时重试一次（强化 JSON 输出指令——与 spawn/
    // structured-output 的重试语义对齐）。重试轮是独立会话的独立 LLM 调用：token
    // 计入 outcome.usage 总量；事件面 text_delta 按实际流出（含失败轮——journal 记录
    // 真实流水），message_end/turn_end 只在最终轮终态后合成（不变量 2/5）。
    const usageAcc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, has: false };
    let final = await this.attemptAppServerTurn(task, ctx, home, modelRef, cwd, basePrompt);
    accumulateUsage(usageAcc, final);
    if (final.kind === "parsed" && final.schemaResult !== undefined && !final.schemaResult.ok && schema !== undefined) {
      const retryPrompt = appendSchemaRetryDirective(basePrompt, final.schemaResult.error);
      const retry = await this.attemptAppServerTurn(task, ctx, home, modelRef, cwd, retryPrompt);
      accumulateUsage(usageAcc, retry);
      final = retry;
    }

    const outcome = this.finalizeOutcome(task, ctx, final, usageAcc, startedAt);
    const driftCode =
      final.kind === "run-failed" && final.rpcCode !== undefined && isDriftRpcCode(final.rpcCode)
        ? final.rpcCode
        : undefined;
    return { result: { handle: this.appServerHandle(home.poolKey, outcome), outcome }, driftCode };
  }

  /** 常驻路径的 handle 合成（poolKey = 常驻 HOME 实际目录名——锚定不变量载体）。 */
  private appServerHandle(poolKey: string, outcome: AgentOutcome): EngineHandle {
    return {
      data: {
        v: 1,
        engineId: ZCODE_ENGINE_ID,
        sessionRef: {
          dbPath: ZCODE_POOL_DB_RELATIVE_PATH,
          ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
        },
        poolKey,
        ...(this.probeCache?.engineVersion !== undefined && this.probeCache.engineVersion !== ""
          ? { engineVersion: this.probeCache.engineVersion }
          : {}),
        adapterVersion: ZCODE_ADAPTER_VERSION,
      },
    };
  }

  /**
   * 单轮常驻执行：runTurn 组合面 + D3 abort 链 + 事件前移（text_delta 实时流出；
   * 终态数据经 read 兜底收口后才 resolve——不变量 1/2）。产出三态与 spawn 同构。
   */
  private async attemptAppServerTurn(
    task: AgentTaskSpec,
    ctx: RunContext,
    home: AppServerHomeHandle,
    modelRef: string,
    cwd: string,
    prompt: string,
  ): Promise<AttemptResult> {
    const rt = this.ensureAppServerRuntime(home);
    const { providerId, modelId } = splitZcodeModelRef(modelRef);
    const denyTools = (task.denyTools ?? []).filter((t) => typeof t === "string" && t.trim() !== "");
    const createParams: SessionCreateParams = {
      workspacePath: cwd,
      mode: "yolo",
      // per-session model（G3）：create 参数透传（A.2 ① strict 对象）——同进程任务
      // 各用各的模型，互不干扰
      model: { providerId, modelId },
      ...(denyTools.length > 0 ? { toolDenylist: denyTools } : {}),
    };

    let currentSessionId: string | undefined;
    let signalSessionCreated: (() => void) | undefined;
    const sessionCreated = new Promise<void>((resolve) => {
      signalSessionCreated = resolve;
    });
    const turn = rt.channel.runTurn(createParams, prompt, {
      // 事件时序前移：payload.delta → text_delta 实时流出（stream 粒度，D5）
      onTextDelta: (delta) => ctx.onEvent?.({ type: "text_delta", delta }),
      onSessionCreated: (sessionId) => {
        currentSessionId = sessionId;
        rt.activeSessions.add(sessionId);
        signalSessionCreated?.();
        // §3.4 不变量 3：create 应答后立即回填（早于 subscribe/send/终态/run resolve）
        ctx.onHandleReady?.({
          sessionRef: { dbPath: ZCODE_POOL_DB_RELATIVE_PATH, sessionId },
          poolKey: home.poolKey,
        });
      },
    });

    // D3 abort 链：signal abort → ① session/stop {sessionId} ② grace 窗口确认终态
    // ③ stop 失败/超时 → killChain 杀共享进程（接受连坐——协议已不可信）→ 在途
    // 其他任务走崩溃路径。capabilities.interrupt 维持 kill-only 不升级（C4）。
    const onAbort = (): void => {
      void this.appServerAbortChain(rt, turn, () => currentSessionId, sessionCreated);
    };
    if (ctx.signal !== undefined) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const r = await turn;
      // stop 优雅生效（终态在 grace 内到达）：宿主已取消——按中止终态收口（record
      // 终态迁移由编排层 CAS 决定，engine 侧保持与 spawn abort 同构语义）
      if (ctx.signal?.aborted === true) return abortedAppServerAttempt(ctx);
      const schema = isPlainObject(task.schema) ? task.schema : undefined;
      return {
        kind: "parsed",
        output: syntheticAppServerOutput(0),
        payload: turnResultToPayload(r),
        ...(schema !== undefined
          ? { schemaResult: extractAndValidateStructuredOutput(r.response, schema) }
          : {}),
      };
    } catch (err) {
      if (ctx.signal?.aborted === true) return abortedAppServerAttempt(ctx);
      return {
        kind: "run-failed",
        output: syntheticAppServerOutput(null),
        message: buildAppServerRunFailedMessage(err, home),
        // [R5] RPC code 透传给 run 编排（-32601/-32602 漂移降级判据；连接级/超时类
        // 错误无 code 不参与降级）
        ...(isAppServerRpcError(err) && err.code !== undefined ? { rpcCode: err.code } : {}),
      };
    } finally {
      if (currentSessionId !== undefined) rt.activeSessions.delete(currentSessionId);
      if (ctx.signal !== undefined) ctx.signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * D3 abort 链执行体（fire-and-forget——与 turn promise 并行推进）：
   * stop 帧（超时 ZCODE_APPSERVER_STOP_TIMEOUT_MS）→ grace 窗口内 turn 落定即止
   * （不杀共享进程）→ 超时 killChain（conn.shutdown 全序：SIGTERM→grace→SIGKILL）。
   * turn 的最终落定由 attempt 主路径 await 收口，本链不直接产出终态。abort 与
   * create 竞态（signal 先到、session 未建立）：等会话建立（带上限）再发 stop——
   * 否则 stop 永远发不出，直接连坐杀共享进程。
   */
  private async appServerAbortChain(
    rt: AppServerRuntime,
    turn: Promise<SessionTurnResult>,
    getSessionId: () => string | undefined,
    sessionCreated: Promise<void>,
  ): Promise<void> {
    let sessionId = getSessionId();
    if (sessionId === undefined) {
      await Promise.race([sessionCreated, delayResolved(ZCODE_APPSERVER_STOP_TIMEOUT_MS, undefined)]);
      sessionId = getSessionId();
    }
    if (sessionId !== undefined) {
      try {
        await rt.conn.request("session/stop", { sessionId }, { timeoutMs: ZCODE_APPSERVER_STOP_TIMEOUT_MS });
      } catch (err) {
        logger.debug(
          `[zcode-engine] session/stop 失败（${errMessage(err)}）——grace 后走 killChain 兜底`,
        );
      }
    }
    const settled = await Promise.race([
      turn.then(
        () => true,
        () => true,
      ),
      delayResolved(ZCODE_APPSERVER_ABORT_GRACE_MS, false),
    ]);
    if (settled) return; // stop 生效：终态在 grace 窗口内到达，共享进程不杀
    logger.warn(
      `[zcode-engine] abort grace 窗口内未见终态——killChain 收割共享进程（接受连坐，在途任务走崩溃路径）`,
    );
    await rt.conn.shutdown({ graceMs: ZCODE_KILL_GRACE_MS });
  }

  // ── 常驻 HOME 与运行时管理（D1/D6/D7）──────────────────────

  /**
   * 每任务的常驻 HOME 保障：已持有（lockfile.pid=本进程）→ 只做凭据刷新比对
   * （config 内容 hash；不一致重写 + 重建连接——在途任务走崩溃路径，换取凭据变更
   * 下一任务生效）；未持有（首任务/锁被夺）→ acquireAppServerHome 全量（锁判定/
   * 派生/接管 + pidfile 孤儿回收/引导）+ 启动锁心跳。
   */
  private async ensureAppServerHome(modelRef: string): Promise<AppServerHomeHandle> {
    const engineDataDir = this.deps.engineDataDir();
    // 并发任务重入守卫：首任务在途的锁获取只跑一次（同进程并发 run 各自走判定循环
    // 会把「自己的活锁」误判成他人活持有 → 派生 -2 → poolKey 漂移触发 teardown 杀
    // 活连接）。在途完成后落回已持有路径（含凭据刷新比对）。
    if (this.homeAcquireInFlight !== undefined) {
      try {
        await this.homeAcquireInFlight;
      } catch (err) {
        // 共享失败不击穿并发任务：首任务 acquire 失败（如凭据缺失）后 homeState 未落，
        // 落到下方自行重走 acquire 一次——成功则本任务正常推进，仍失败则报本任务自身
        // 的错误语义（而非继承首任务的异常实例）
        logger.debug(
          `[zcode-engine] 并发等待的首任务 home acquire 失败（${errMessage(err)}）——自行重走 acquire`,
        );
      }
    }
    if (this.homeState !== undefined && isLockHeldByUs(this.homeState.lockPath)) {
      const boot = bootstrapAppServerConfig({
        homeDir: this.homeState.homeDir,
        modelRef,
        sources: this.deps.sources,
      });
      if (boot.wroteConfig) this.teardownAppServerRuntime("credential-refresh");
      return {
        poolKey: this.homeState.poolKey,
        homeDir: this.homeState.homeDir,
        lockPath: this.homeState.lockPath,
        tookOver: false,
        orphanReap: "not-applicable",
        ...boot,
      };
    }
    const acquire = (async () => {
      const fresh = await acquireAppServerHome({ engineDataDir, modelRef, sources: this.deps.sources });
      if (this.homeState !== undefined) this.homeState.stopHeartbeat();
      this.homeState = {
        poolKey: fresh.poolKey,
        homeDir: fresh.homeDir,
        lockPath: fresh.lockPath,
        stopHeartbeat: startLockHeartbeat(fresh.lockPath),
      };
      logger.debug("[zcode-engine] appserver home acquired", {
        poolKey: fresh.poolKey,
        tookOver: fresh.tookOver,
        orphanReap: fresh.orphanReap,
        wroteConfig: fresh.wroteConfig,
        providers: fresh.providerIds.length,
      });
      if (fresh.wroteConfig || (this.appserverRuntime !== undefined && this.appserverRuntime.homePoolKey !== fresh.poolKey)) {
        this.teardownAppServerRuntime(fresh.wroteConfig ? "credential-refresh" : "home-pool-changed");
      }
      return fresh;
    })();
    this.homeAcquireInFlight = acquire;
    try {
      return await acquire;
    } finally {
      this.homeAcquireInFlight = undefined;
    }
  }

  /**
   * 惰性获取常驻运行时（D1：每引擎实例一条连接，全任务共享）。池 key 未变直接复用
   * （连接自身的崩溃重建在 connection 层内部完成——同一条代码路径，§3.4 不变量 4）；
   * 池变更（派生目录名变化）→ 旧运行时整件丢弃（shutdown fire）+ 新建。常驻进程
   **不进**宿主 spawnedChildren、不调 onChildSpawned（D6——生命周期归 dispose）。
   */
  private ensureAppServerRuntime(home: AppServerHomeHandle): AppServerRuntime {
    if (this.appserverRuntime !== undefined && this.appserverRuntime.homePoolKey === home.poolKey) {
      return this.appserverRuntime;
    }
    if (this.appserverRuntime !== undefined) this.teardownAppServerRuntime("home-pool-changed");
    const conn = new AppServerConnection({
      cliPath: this.deps.cliPath ?? ZCODE_CLI_DEFAULT_PATH,
      // 进程级 --cwd 用稳定 HOME（连接跨任务共享，工作区由 create 的
      // workspace.workspacePath 按任务传递——D10 基线不预设任务级进程 cwd）
      cwd: home.homeDir,
      env: buildAppServerEnv(home.homeDir, this.deps.processEnv ?? process.env),
      stderrLogPath: path.join(this.deps.engineDataDir(), "logs", "zcode-appserver-stderr.log"),
      // 每代进程 spawn 后写 pidfile（D6③ 孤儿回收的数据源；崩溃重建的代同样覆盖写）
      onSpawned: (child) => {
        void writeAppServerPidFile(home.homeDir, child.pid ?? -1).catch((err: unknown) => {
          logger.debug(`[zcode-engine] pidfile 写入失败（best-effort）: ${errMessage(err)}`);
        });
      },
    });
    const rt: AppServerRuntime = {
      conn,
      channel: new SessionChannel(conn),
      homePoolKey: home.poolKey,
      homeDir: home.homeDir,
      activeSessions: new Set<string>(),
    };
    this.appserverRuntime = rt;
    return rt;
  }

  /** 丢弃当前常驻运行时（凭据刷新/池变更）：shutdown fire（killChain 全序），在途任务走崩溃路径。 */
  private teardownAppServerRuntime(reason: string): void {
    const rt = this.appserverRuntime;
    if (rt === undefined) return;
    this.appserverRuntime = undefined;
    // 退订必须在崩溃收割**之后**：channel 的 onClose 收割（failAllTurns）是在途 turn
    // 的快速失败通道，先退订会让它们挂到 turnTimeoutMs（300s）预算耗尽
    void this.shutdownRuntimeAndDisposeChannel(rt).catch((err: unknown) => {
      logger.debug(`[zcode-engine] 常驻连接关闭失败（${reason}，best-effort）: ${errMessage(err)}`);
    });
    logger.debug(`[zcode-engine] appserver runtime torn down (${reason})`, { poolKey: rt.homePoolKey });
  }

  /**
   * [R5 修复 R4 既有竞态] shutdown → 等崩溃收割实际发生 → channel 退订。killChain 在
   * `exit` 事件 resolve，而连接 finalize（onClose → channel 的 failAllTurns）挂
   * `close` 事件——两者之间有一个事件循环窗口：shutdown resolve 后立即退订，在途
   * turn 会错过收割、挂到 turnTimeoutMs（300s）。退订前等 onClose 触发（本方法先于
   * shutdown 订阅；channel 的订阅在构造期更早——其 failAllTurns 先于本 promise
   * resolve 执行）；ZCODE_APPSERVER_HARVEST_GRACE_MS 兜底防 `close` 永不到达时挂死。
   */
  private async shutdownRuntimeAndDisposeChannel(rt: AppServerRuntime): Promise<void> {
    const harvested = new Promise<void>((resolve) => {
      const off = rt.conn.onClose(() => {
        off();
        resolve();
      });
    });
    await rt.conn.shutdown({ graceMs: ZCODE_KILL_GRACE_MS });
    await Promise.race([harvested, delayResolved(ZCODE_APPSERVER_HARVEST_GRACE_MS, undefined)]);
    rt.channel.dispose();
  }

  /**
   * [R1 D6/R4 主体] 引擎停机面：①fire 全部在途会话的 session/close 帧（不等待
   * 应答——D6① 顺序规定：close 帧必须先于 SIGTERM，否则对面来不及处理即被杀）→
   * ②同步 SIGTERM（conn.shutdown 调用内 killChain 前缀同步执行——同步面在返回
   * Promise 前完成）→ ③grace → SIGKILL（异步面，Promise resolve 于进程退出）。
   * 幂等：运行时字段取走即置空，二次调用零副作用；dispose 后首个 run 经
   * ensureAppServerRuntime 自动重建（与崩溃重建同一代码路径，不变量 4）。
   * 锁不释放（随宿主进程存活——活宿主持有语义；进程死锁自然无主可接管）。
   */
  async dispose(): Promise<void> {
    const rt = this.appserverRuntime;
    if (rt === undefined) return;
    this.appserverRuntime = undefined;
    // ①fire 全部在途会话的 session/close 帧（不等待应答——D6① 顺序规定：close 帧
    // 必须先于 SIGTERM，否则对面来不及处理即被杀）
    for (const sessionId of [...rt.activeSessions]) {
      rt.conn.post("session/close", { sessionId });
    }
    // ②③ 同步 SIGTERM（killChain 前缀在 shutdown 调用内同步执行）→ grace → SIGKILL
    //（异步面，resolve 于进程退出）。channel 退订放在崩溃收割之后（exit→close 窗口
    //竞态的修复体，见 shutdownRuntimeAndDisposeChannel——先退订会让在途 turn 挂到
    //turnTimeoutMs）
    await this.shutdownRuntimeAndDisposeChannel(rt);
    // 进程已死：pidfile 成为陈旧记录，清掉（防后续 pid 复用误判）
    try {
      fs.rmSync(path.join(rt.homeDir, ZCODE_APPSERVER_PIDFILE_NAME), { force: true });
    } catch (err) {
      logger.debug(`[zcode-engine] dispose 后 pidfile 清理失败（best-effort）: ${errMessage(err)}`);
    }
  }

  // ============================================================
  // spawn 单轮路径（D2 兜底——R4 起仅 XYZ_ZCODE_MODE=spawn 定向 / R5 降级可达）
  // ============================================================

  /**
   * spawn 路径主编排（原 run 主体，行为零改动）：preparer → launcher → parser → 仿真重试 → outcome/handle。
   * [R5] degrade 参数：降级链落点（探针失败 / 漂移首败重跑 / 降级后直走）——结果经
   * outcome.engineFallback 标注「degraded: spawn + 原因」（D9① 留痕面复用，record
   * 同步投影；capabilities 声明不降级——D2 降级是任务级兜底非能力级）。
   */
  private async runViaSpawn(
    task: AgentTaskSpec,
    ctx: RunContext,
    degrade?: { degradedReason: string },
  ): Promise<EngineRunResult> {
    const startedAt = Date.now();
    this.rejectUnsupportedTaskShapes(task);

    // ① prepare 期：模型解析（provider 体系校验）+ 隔离 HOME 池引导（凭据 + model.main）
    const modelRef = resolveZcodeModelRef(task.model, this.deps.sources);
    const prepared = prepareZcodeHome({
      engineDataDir: this.deps.engineDataDir(),
      modelRef,
      sources: this.deps.sources,
    });
    // 对齐点③：把实际池 key 声明给宿主（journal writer 重定向到 handle.poolKey 同源
    // 的路径——单一权威，宿主不再两边推导）；须在首个事件 emit 前（终态后合成，天然满足）
    ctx.onPoolResolved?.(prepared.poolKey);
    logger.debug("[zcode-engine] isolated home prepared", {
      poolKey: prepared.poolKey,
      wroteConfig: prepared.wroteConfig,
      modelRef,
      taskId: ctx.taskId,
    });

    const cwd = task.cwd ?? process.cwd();
    const schema = isPlainObject(task.schema) ? task.schema : undefined;
    const basePrompt = this.buildPrompt(task, schema);

    // ②-④ 首轮执行；schema 任务校验失败时重试一次（强化 JSON 输出指令——与
    // structured-output 的重试语义对齐，设计 §3.3.3 schema_emulation_failed 行）。
    // 重试轮产生的新 session 是独立 LLM 调用：token 计入 outcome.usage 总量，
    // 事件只在最终轮终态后一次性合成（不变量 5：事件 emit 完成先于 run resolve）。
    const usageAcc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, has: false };
    let final = await this.attemptOnce(task, ctx, prepared, cwd, basePrompt);
    accumulateUsage(usageAcc, final);
    if (final.kind === "parsed" && final.schemaResult !== undefined && !final.schemaResult.ok && schema !== undefined) {
      const retryPrompt = appendSchemaRetryDirective(basePrompt, final.schemaResult.error);
      const retry = await this.attemptOnce(task, ctx, prepared, cwd, retryPrompt);
      accumulateUsage(usageAcc, retry);
      final = retry;
    }

    const outcome = this.finalizeOutcome(task, ctx, final, usageAcc, startedAt);

    const handle: EngineHandle = {
      data: {
        v: 1,
        engineId: ZCODE_ENGINE_ID,
        sessionRef: {
          // 相对池目录自描述（设计 §3.3.6）——read 时经 resolvePoolDir + 此相对路径重定位
          dbPath: ZCODE_POOL_DB_RELATIVE_PATH,
          ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
        },
        poolKey: prepared.poolKey,
        ...(this.probeCache?.engineVersion !== undefined && this.probeCache.engineVersion !== ""
          ? { engineVersion: this.probeCache.engineVersion }
          : {}),
        adapterVersion: ZCODE_ADAPTER_VERSION,
      },
    };
    if (degrade !== undefined) {
      // 降级标注：engineFallback 是 outcome 上唯一的元信息留痕面（D9① 同一通道）。
      // ctx 已带路由级 fallback（pi→zcode）时保 from、reason 追加降级事实——两层
      // 留痕合并不丢信息。
      const prior = outcome.engineFallback;
      outcome.engineFallback = {
        from: prior?.from ?? "zcode:appserver",
        reason: `${prior !== undefined ? `${prior.reason}；` : ""}degraded: spawn（${degrade.degradedReason}）`,
      };
    }
    return { handle, outcome };
  }

  /** 终态合成（extension-conventions 函数 80 行上限，从 run 提取）：aborted / run-failed / parsed 三分支。 */
  private finalizeOutcome(
    task: AgentTaskSpec,
    ctx: RunContext,
    final: AttemptResult,
    usageAcc: { input: number; output: number; cacheRead: number; cacheWrite: number; has: boolean },
    startedAt: number,
  ): AgentOutcome {
    const outcome: AgentOutcome = {
      engineId: ZCODE_ENGINE_ID,
      content: "",
      durationMs: Date.now() - startedAt,
      ...(typeof task.worktree === "object" && task.worktree !== null ? { worktreePath: task.worktree.path } : {}),
      // D9① fallback 留痕：路由层经 RunContext 投影（zcode 无 record 通路，outcome 是
      // 唯一留痕面；pi 引擎另有 record 投影）
      ...(ctx.engineFallback !== undefined ? { engineFallback: ctx.engineFallback } : {}),
    };
    const emit = (event: AgentEvent): void => {
      ctx.onEvent?.(event);
    };

    if (final.kind === "aborted") {
      this.applyAbortedOutcome(outcome, task, ctx, final, emit);
    } else if (final.kind === "run-failed") {
      this.applyRunFailedOutcome(outcome, final, emit);
    } else {
      this.applyParsedOutcome(outcome, final, usageAcc, emit);
    }
    return outcome;
  }

  /** abort 合成终态：exitCode=null（record 正常收尾，不留僵尸）。 */
  private applyAbortedOutcome(
    outcome: AgentOutcome,
    task: AgentTaskSpec,
    ctx: RunContext,
    final: Extract<AttemptResult, { kind: "aborted" }>,
    emit: (event: AgentEvent) => void,
  ): void {
    outcome.exitCode = null;
    // 对齐点④：宿主超时（mergeTimeoutSignal 的 timeout abort）统一走公共合成终态
    // （common/kill-chain.synthesizeTimeoutOutcome——engine_timeout 文案 SSOT：stdout
    // 尾部 + 「可用 engine: pi 重跑」建议）；用户主动 cancel 维持 engine_run_failed
    // 中止标记（非超时语义，不冒充超时）。?? 兜底是类型收窄（合成器恒写 error）。
    // appserver 路径经 abortMessage 描述 D3 链形态（与 spawn 杀链文案分立）
    outcome.error = isHostTimeoutAbort(ctx)
      ? synthesizeTimeoutOutcome(task, final.output.stdoutText, ZCODE_ENGINE_ID).error ??
        engineTimeoutDetail(final.output.stdoutText)
      : final.abortMessage ??
        `engine_run_failed: zcode 任务被中止（杀链 SIGTERM→${ZCODE_KILL_GRACE_MS}ms→SIGKILL，宿主合成终态）。` +
          `stdout 尾部: ${final.output.stdoutText.slice(-ZCODE_ERROR_TAIL_CHARS)}`;
    emit({ type: "error", message: outcome.error });
  }

  /** run-failed 合成终态：错误信息由 buildRunFailedMessage 产出（已含恢复指引），直接透传。 */
  private applyRunFailedOutcome(
    outcome: AgentOutcome,
    final: Extract<AttemptResult, { kind: "run-failed" }>,
    emit: (event: AgentEvent) => void,
  ): void {
    outcome.exitCode = final.output.exitCode;
    outcome.error = final.message;
    emit({ type: "error", message: outcome.error });
  }

  /** parsed 合成终态：content/sessionId/usage 落位 + schema 校验分流 + coarse 事件。 */
  private applyParsedOutcome(
    outcome: AgentOutcome,
    final: Extract<AttemptResult, { kind: "parsed" }>,
    usageAcc: { input: number; output: number; cacheRead: number; cacheWrite: number; has: boolean },
    emit: (event: AgentEvent) => void,
  ): void {
    const payload = final.payload;
    outcome.content = payload.response;
    outcome.exitCode = final.output.exitCode;
    if (payload.sessionId !== undefined) outcome.sessionId = payload.sessionId;
    // usage：token 四项取两轮之和（重试的 LLM 调用真实发生），contextTokens/turns 取末轮
    if (usageAcc.has) {
      const last = payload.outcomeUsage;
      outcome.usage = {
        input: usageAcc.input,
        output: usageAcc.output,
        cacheRead: usageAcc.cacheRead,
        cacheWrite: usageAcc.cacheWrite,
        cost: 0,
        contextTokens: last?.contextTokens ?? usageAcc.input + usageAcc.output + usageAcc.cacheRead + usageAcc.cacheWrite,
        turns: last?.turns ?? 1,
      };
    }
    if (final.schemaResult !== undefined) {
      if (final.schemaResult.ok) {
        // D4 硬分流的 emulated 侧产出：公共仿真层的 ajv 校验结果即 parsedOutput
        outcome.parsedOutput = final.schemaResult.parsed;
      } else {
        // 两轮（原始 + 强化重试）均未通过三级容错提取/ajv 校验
        outcome.error =
          `schema_emulation_failed: zcode 输出经两轮（含强化 prompt 重试）仍未通过 schema 校验。` +
          `末轮失败原因: ${final.schemaResult.error}。原始输出尾部: ${final.schemaResult.tail}。` +
          `恢复指引：简化 schema 或拆小任务后重派；需要强 schema 约束时改用 engine: pi（native schema 注入）。`;
        emit({ type: "error", message: outcome.error });
      }
    }
    // coarse 事件（不变量 5：事件 emit 完成先于 run resolve——journal 完整性）
    for (const ev of synthesizeCoarseEvents(payload.response, payload.usage)) emit(ev);
  }

  /**
   * 单轮执行（launch → collect → parse → schema 校验）。产出三态之一给 run 编排：
   * aborted（我方杀链）/ run-failed（非零退出或解析失败）/ parsed（含 schema 校验结果）。
   */
  private async attemptOnce(
    task: AgentTaskSpec,
    ctx: RunContext,
    prepared: ReturnType<typeof prepareZcodeHome>,
    cwd: string,
    prompt: string,
  ): Promise<AttemptResult> {
    // ② argv 组装 + 字节估算（超限抛 prompt_too_large——进程创建前；公共预算权威）
    const args = buildZcodeArgv({ cwd, prompt, denyTools: task.denyTools });
    const cliPath = this.deps.cliPath ?? ZCODE_CLI_DEFAULT_PATH;
    assertZcodeArgvBudget("node", cliPath, args);

    // ③ launch：spawn 单轮（stdin ignore；HOME=池目录；嵌套标记经公共 nesting-guard）
    const launch = this.deps.launch ?? launchZcodeProcess;
    const env = buildZcodeEnv(prepared.homeDir, this.deps.processEnv ?? process.env);
    let proc: ZcodeLaunchedProcess;
    try {
      proc = launch({ cliPath, args, env });
    } catch (err) {
      // spawn 同步失败（node 缺失等）：进程未创建，按 prepare 期语义 reject
      throw new Error(
        `[engine_run_failed] 无法启动 zcode CLI（${cliPath}）：${err instanceof Error ? err.message : String(err)}。` +
          `恢复指引：确认 node 在 PATH 且 ${cliPath} 存在（probe 可探测），或改用 engine: pi。`,
      );
    }

    // [U0 D10] 终止链路径①：spawn 成功后同步注册子进程句柄进宿主 spawnedChildren
    // 记账（port.ts 契约「spawn 成功后同步回调」）——cancelBackground SIGTERM /
    // dispose killAll 收割兜底对引擎 record 生效，防 controller 丢失/竞态场景下孤儿进程
    ctx.onChildSpawned?.(proc.child);

    // abort 分级（D1）：zcode 无原生中断（interrupt: kill-only），AbortSignal 直通
    // SIGTERM → grace → SIGKILL 杀链，终态由宿主合成
    const onAbort = (): void => {
      void proc.abort(ZCODE_KILL_GRACE_MS);
    };
    if (ctx.signal !== undefined) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    // ④ parser：有界收集 + 终 JSON
    const output = await collectZcodeOutput(proc);
    if (ctx.signal !== undefined) ctx.signal.removeEventListener("abort", onAbort);

    if (proc.killedByUs()) return { kind: "aborted", output };
    if (output.exitCode !== 0) {
      return {
        kind: "run-failed",
        output,
        message: buildRunFailedMessage({
          cliPath,
          exitCode: output.exitCode,
          stdoutTail: output.stdoutText,
          stderrTail: output.stderrTail,
          modelRef: prepared.modelRef,
          configPath: prepared.configPath,
        }),
      };
    }
    const terminal = parseZcodeTerminal(output.stdoutText);
    if (!terminal.ok) {
      return {
        kind: "run-failed",
        output,
        message: buildRunFailedMessage({
          cliPath,
          exitCode: output.exitCode,
          stdoutTail: output.stdoutText,
          stderrTail: output.stderrTail,
          parseReason: terminal.reason,
          modelRef: prepared.modelRef,
          configPath: prepared.configPath,
        }),
      };
    }
    const schema = isPlainObject(task.schema) ? task.schema : undefined;
    return {
      kind: "parsed",
      output,
      payload: terminal.payload,
      ...(schema !== undefined
        ? { schemaResult: extractAndValidateStructuredOutput(terminal.payload.response, schema) }
        : {}),
    };
  }

  /**
   * D1 可选面：zcode 首期不支持 conversation（capabilities 声明）——同步拒绝、
   * 不创建进程，文案给可操作建议（A11）。
   */
  async interact(_handle: EngineHandle, _action: InteractAction): Promise<InteractResult> {
    return {
      ok: false,
      code: "engine_capability_unsupported",
      message:
        "zcode 引擎不支持 conversation 交互控制面（capabilities.conversation = 'unsupported'，" +
        "spawn 单轮模式无同进程 idle 复用）。恢复指引：改用单次 subagent 调用重新派发任务，" +
        "或使用 engine: 'pi'（chatMode idle 复用，支持 message/close/cancel）。",
    };
  }

  /**
   * D6 read 三级降级：①sqlite 原生读取 → ②宿主 event journal 重放（对齐点①接线：
   * replayJournalToSessionView 复用 live reducer，重放等价性见 §3.3.6）→ ③outcome-only。
   * sessionId 缺失（解析失败的 run 无法在共享池 db 内定位 session）跳过①级；②级
   * 依赖 handle.journalPath（宿主 run 后回填）。
   */
  /** [U7] 模型可发现性：v2 桌面登录态聚合（带凭据 provider × models），失败安全返回清单本身可能为空。 */
  listModels(): Array<{ id: string; name?: string }> {
    return listZcodeModels(this.deps.sources);
  }

  async read(handle: EngineHandle): Promise<SessionView> {
    if (handle.data.engineId !== ZCODE_ENGINE_ID) {
      return { engineId: ZCODE_ENGINE_ID, turns: [], source: "outcome-only" };
    }
    const sessionId = handle.data.sessionRef["sessionId"];
    const dbPathRaw = handle.data.sessionRef["dbPath"];
    if (typeof sessionId === "string" && typeof dbPathRaw === "string") {
      // 相对路径锚定池目录（handle.poolKey 自描述）；绝对路径（未来形态）直用
      const dbPath = path.isAbsolute(dbPathRaw)
        ? dbPathRaw
        : path.join(resolvePoolDir(this.deps.engineDataDir(), ZCODE_ENGINE_ID, handle.data.poolKey), dbPathRaw);
      try {
        return await readZcodeSessionView(dbPath, sessionId);
      } catch (err) {
        logger.warn("[zcode-engine] native session read failed, degrade to journal replay", {
          dbPath,
          sessionId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // ②级：journal 重放（journalPath 缺省 / 文件不存在 / 无事件 → undefined 落③级）
    const journaled = replayJournalToSessionView(handle, ZCODE_ENGINE_ID);
    if (journaled !== undefined) return journaled;
    return { engineId: ZCODE_ENGINE_ID, turns: [], source: "outcome-only" };
  }

  // ── 内部 ──

  /**
   * prepare 期的能力拒绝（进程创建前）：fork 是 pi 专属（AgentTaskSpec.fork 契约：
   * 其他引擎按 capabilities 拒绝）；conversation 是 interact 控制面的 task 标志，
   * zcode 无此面（A11：同步拒绝 + 可操作建议，无进程创建）；maxTurns 是 pi 引擎
   * 专属（turn limiter + spawn watchdog 估算依赖 pi 的 turn_end 事件流）——zcode
   * 无 turn_end 语义，静默丢弃会造成「传了上限却失控」的假象，显式拒绝（U4，
   * 同 fork 模式）。
   */
  private rejectUnsupportedTaskShapes(task: AgentTaskSpec): void {
    if (task.fork === true) {
      throw new ZcodeTaskShapeError(
        "engine_capability_unsupported",
        "zcode 引擎不支持 fork（pi 专属会话分叉语义）。恢复指引：去掉 fork 参数重派，或使用 engine: 'pi'。",
      );
    }
    if (task.conversation === true) {
      throw new ZcodeTaskShapeError(
        "engine_capability_unsupported",
        "zcode 引擎不支持 conversation 模式（spawn 单轮，无同进程 idle 复用）。" +
          "恢复指引：改用单次调用（去掉 conversation），或使用 engine: 'pi'。",
      );
    }
    if (task.maxTurns !== undefined) {
      throw new ZcodeTaskShapeError(
        "engine_capability_unsupported",
        "zcode 引擎不支持 maxTurns（pi 引擎专属 turn limiter；zcode 无 turn_end 语义，无法兑现轮数上限）。" +
          "恢复指引：去掉 maxTurns 参数重派，或使用 engine: 'pi'。",
      );
    }
  }

  /**
   * persona 拼接后的完整 prompt（personaInjection: 'prompt'——zcode 无 flag 通道）：
   * appendSystemPrompt 段在前（人设/约束语境），task 正文居中，schema 仿真段尾置
   * （common/schema-emulation 公共层产出，D4 emulated 侧——zcode 无 native schema 通道）。
   */
  private buildPrompt(task: AgentTaskSpec, schema: object | undefined): string {
    const segments: string[] = [...(task.persona?.appendSystemPrompt ?? [])];
    segments.push(task.task);
    if (schema !== undefined) segments.push(buildSchemaEmulationSegment(schema));
    return segments.join("\n\n");
  }
}

// ── 模块级辅助（run 的重试编排件） ──

/**
 * attempt 的三态产物（两模式共用；run 按序编排重试与终态合成）。appserver 路径的
 * output 为合成形态（stdoutText 恒空——其失败素材在 message/abortMessage 内）。
 */
type AttemptResult =
  | { kind: "aborted"; output: ZcodeCollectedOutput; abortMessage?: string }
  | { kind: "run-failed"; output: ZcodeCollectedOutput; message: string; rpcCode?: number }
  | {
      kind: "parsed";
      output: ZcodeCollectedOutput;
      payload: ZcodeTerminalPayload;
      schemaResult?: { ok: true; parsed: unknown } | { ok: false; error: string; tail: string };
    };

/** Record 形状 guard（task.schema 的运行时窄化——Record<string, unknown> 不满足 ajv 的 object 入参）。 */
function isPlainObject(v: unknown): v is object {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 错误/日志出声用的 message 提取（非 Error 值不抛二次异常）。 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** [R5 D2] 漂移类 RPC code 判据（错误规格表第 1 行：-32601 方法不存在 / -32602 参数变形）。 */
function isDriftRpcCode(code: number): boolean {
  return (ZCODE_APPSERVER_DRIFT_RPC_CODES as readonly number[]).includes(code);
}

/** ms 后 resolve 指定值（abort 链 grace 窗口的 race 材料；unref 不阻塞进程退出）。 */
function delayResolved<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(value), ms);
    if (typeof t.unref === "function") t.unref();
  });
}

/** appserver 路径的合成 output（无 stdout 可收集——exitCode 语义：0=正常轮；null=中止/连接级失败）。 */
function syntheticAppServerOutput(exitCode: number | null): ZcodeCollectedOutput {
  return { exitCode, stdoutText: "", stderrTail: "" };
}

/** appserver 路径的 aborted 三态（abortMessage 描述 D3 链形态——与 spawn 杀链文案分立）。 */
function abortedAppServerAttempt(ctx: RunContext): AttemptResult {
  void ctx;
  return {
    kind: "aborted",
    output: syntheticAppServerOutput(null),
    abortMessage:
      `engine_run_failed: zcode 任务被中止（app-server abort 链：session/stop → ${ZCODE_APPSERVER_ABORT_GRACE_MS}ms grace 确认 → ` +
      `超时 killChain SIGTERM→${ZCODE_KILL_GRACE_MS}ms→SIGKILL 收割共享进程，在途任务走崩溃路径）。`,
  };
}

/** runTurn 终态 → parser 载荷形态（usage 映射与 spawn 路径同源：parser.mapZcodeUsage 一族）。 */
function turnResultToPayload(r: SessionTurnResult): ZcodeTerminalPayload {
  return {
    response: r.response,
    sessionId: r.sessionId,
    ...(mapZcodeUsage(r.usage) !== undefined ? { usage: mapZcodeUsage(r.usage) } : {}),
    ...(mapZcodeOutcomeUsage(r.usage, undefined) !== undefined
      ? { outcomeUsage: mapZcodeOutcomeUsage(r.usage, undefined) }
      : {}),
  };
}

/**
 * appserver 路径运行中失败的结构化文案（错误规格表）：-32603 "Model config is
 * missing" → engine_credential_missing（与 prepare 期同码——错误定位常驻 HOME config）；
 * 其余（连接崩溃/会话失败/漂移类透传——漂移降级归 R5）→ engine_run_failed + 恢复指引。
 */
function buildAppServerRunFailedMessage(err: unknown, home: AppServerHomeHandle): string {
  if (
    isAppServerRpcError(err) &&
    err.code === ZCODE_APPSERVER_ERR_MODEL_CONFIG_MISSING &&
    /Model config is missing/.test(err.message)
  ) {
    return (
      `engine_credential_missing: app-server 报 "Model config is missing"（常驻 HOME ${home.homeDir} 的 config.json ` +
      `无可用模型配置）。恢复指引：在 ZCode 桌面端登录并配置 provider 凭据后重跑本任务（引擎将在下任务重写常驻 config 并重建连接）。`
    );
  }
  const code = isAppServerRpcError(err) && err.code !== undefined ? `（code ${err.code}）` : "";
  return (
    `engine_run_failed: app-server 会话执行失败${code}: ${errMessage(err).slice(-ZCODE_ERROR_TAIL_CHARS)}。` +
    `恢复指引：直接重跑本任务（连接崩溃后自动重建进程）；若持续失败，跑 probe 核对协议漂移（R5 降级链）或改用 engine: pi。`
  );
}

/** 跨重试轮累计 token 用量（重试的 LLM 调用真实发生）。 */
function accumulateUsage(acc: { input: number; output: number; cacheRead: number; cacheWrite: number; has: boolean }, r: AttemptResult): void {
  if (r.kind !== "parsed") return;
  const u = r.payload.usage;
  if (u === undefined) return;
  acc.has = true;
  acc.input += u.input;
  acc.output += u.output;
  acc.cacheRead += u.cacheRead;
  acc.cacheWrite += u.cacheWrite;
}

/** 强化重试 prompt：首战校验失败后追加更明确的 JSON 输出指令（structured-output 重试语义）。 */
function appendSchemaRetryDirective(basePrompt: string, validationError: string): string {
  return (
    basePrompt +
    "\n\n## Retry: Structured Output Failed\n" +
    `Your previous answer failed schema validation: ${validationError}\n` +
    "Answer again. Output ONLY the JSON value conforming to the schema above — " +
    "no prose, no markdown fences, no extra text."
  );
}

/** prepare 期能力拒绝的载体（code 进 message 前缀，调用方可程序化分流）。 */
class ZcodeTaskShapeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ZcodeTaskShapeError";
    this.code = code;
  }
}

/** 宿主超时 abort 判别（对齐点④）：signal.reason 带超时标记 = 超时杀链合成终态路径。 */
function isHostTimeoutAbort(ctx: RunContext): boolean {
  return ctx.signal?.aborted === true && ctx.signal.reason === HOST_TIMEOUT_ABORT_REASON;
}

/** 默认版本探测：`node <cli> --version`（首行 trim；超时按探针失败处理）。 */
async function defaultProbeVersion(cliPath: string): Promise<string | undefined> {
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      execFile(
        "node",
        [cliPath, "--version"],
        { encoding: "utf8", timeout: PROBE_VERSION_TIMEOUT_MS },
        (err: Error | null, stdout: string) => {
          if (err) reject(err);
          else resolve(stdout.trim().split("\n")[0]?.trim() || undefined);
        },
      );
    });
  } catch (err) {
    logger.debug(
      `[zcode-engine] probe version check failed (best-effort continue): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}
