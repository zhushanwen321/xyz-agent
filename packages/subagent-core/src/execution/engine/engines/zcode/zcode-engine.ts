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
//     参数透传；常驻 HOME = engines/zcode/home-appserver（D7 全量语义见 appserver-home.ts）；
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
import { applyPersona } from "../../common/persona-router.ts";
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
  ZCODE_APPSERVER_ERR_BUSY_SESSION,
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
  ZCODE_TURN_MAX_TIMEOUT_ENV,
  parseZcodeTurnTimeoutEnv,
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
import {
  SessionChannel,
  TurnTimeoutError,
  type SessionCreateParams,
  type SessionTurnResult,
} from "./session-channel.ts";

const logger = getLogger("subagents");

/** probe 的版本探测超时（ms）——二进制无响应按探针失败处理，不静默挂死。 */
const PROBE_VERSION_TIMEOUT_MS = 15_000;

/**
 * [RX2-F1] 常见 thoughtLevel 档位（仅作提示基准，非权威值域）：pi 全 7 档
 * （off/minimal/low/medium/high/xhigh/max）恒等透传不拦截——core 引擎层不掌握各模型
 * 真实值域，禁止硬编码枚举做拒收或映射；不在此列的档位只触发一行提示（warnThoughtLevelUncommon）。
 */
const COMMON_THOUGHT_LEVELS: readonly string[] = ["low", "high", "max"];

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
  /**
   * [P0-1 U4] 引擎停机标志（dispose 置位，不重置——dispose 后首个 run 走重建路径
   * 不受影响）：瞬时重试判定据此排除 dispose 收割引发的崩溃形态——停机后的重试轮
   * 会经 ensureAppServerRuntime 惰性重建进程（复活已停机引擎），违背 dispose 防泄漏
   * 语义。teardown（凭据刷新/池变更）不走此标志：其崩溃重试用新 HOME/凭据重建属
   * 合法续跑。
   */
  private disposed = false;

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
    // D2② 首败降级：漂移错误 → 标志内存化 + 同一任务 spawn 重跑一次（结果标注）。
    // [RX2-F3] skipCtxModelWarn：appserver 首跑已出声过 ctxModel 忽略留痕，同任务
    // spawn 重跑再 warn 一遍是噪音（探针场景同款自我要求）——重跑侧跳过。
    this.driftDegraded = true;
    logger.warn(
      `[zcode-engine] app-server 漂移类错误（RPC code ${driftCode}）——本任务降级 spawn 重跑，后续任务直走 spawn`,
      { taskId: ctx.taskId },
    );
    return this.runViaSpawn(task, ctx, {
      degradedReason: `protocol-drift（首任务 app-server 命中 RPC code ${driftCode}，已降级 spawn 重跑本任务；后续任务直走 spawn）`,
      skipCtxModelWarn: true,
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
   * 常驻路径主编排：常驻 HOME（锁/派生/孤儿回收/凭据刷新——appserver-home D7 全量）→
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
      return this.abortedAppServerRun(task, ctx, startedAt);
    }

    // ① prepare 期：模型解析（provider 体系校验——错误语义与 spawn 同为进程创建前
    // reject）+ 常驻 HOME（锁判定/派生/pidfile 孤儿回收/config 内容 hash 刷新）
    const modelRef = resolveZcodeModelRef(task.model, this.deps.sources);
    this.warnIgnoredCtxModel(task, ctx, modelRef);
    // [RX2-F1] 非常见档位出声一行（不拦截透传）；放主编排而非 attemptAppServerTurn——
    // schema 重试轮会二次进 attempt，warn 只应随任务出声一次
    this.warnThoughtLevelUncommon(task, ctx);
    const home = await this.ensureAppServerHome(modelRef);
    // 对齐点③（不变量 3）：poolKey 在 prepare 期声明（静态常量或派生目录名），
    // 早于连接建立与首个事件
    ctx.onPoolResolved?.(home.poolKey);

    const cwd = task.cwd ?? process.cwd();
    const schema = isPlainObject(task.schema) ? task.schema : undefined;
    const basePrompt = this.buildPrompt(task, schema);

    // ② 首轮执行 + schema 仿真重试（重试语义与不变量注释见 runAppServerAttemptsWithRetry）
    const usageAcc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, has: false };
    const final = await this.runAppServerAttemptsWithRetry(task, ctx, home, modelRef, cwd, basePrompt, schema, usageAcc);

    const outcome = this.finalizeOutcome(task, ctx, final, usageAcc, startedAt);
    return { result: { handle: this.appServerHandle(home.poolKey, outcome), outcome }, driftCode: driftCodeOf(final) };
  }

  /** pre-aborted 短路收口（常驻路径专用）：合成中止 outcome + 池锚定 handle。 */
  private abortedAppServerRun(
    task: AgentTaskSpec,
    ctx: RunContext,
    startedAt: number,
  ): { result: EngineRunResult; driftCode: number | undefined } {
    // poolKey 锚定：已持有 HOME（含派生场景）用其真实 poolKey；首次即 abort 尚无
    // HOME 可用，退回静态常量（此刻确实无派生事实可锚定）
    const poolKey = this.homeState?.poolKey ?? ZCODE_APPSERVER_POOL_KEY;
    // 对齐点③（不变量 3）：onPoolResolved 必须先于首个事件 emit——本分支
    // finalizeOutcome 经 applyAbortedOutcome emit error 事件，缺本调用会把事件落
    // shared 占位池，与 handle.poolKey 漂移（契约同正常路径 prepare 期声明）
    ctx.onPoolResolved?.(poolKey);
    const outcome = this.finalizeOutcome(
      task,
      ctx,
      abortedAppServerAttempt(ctx),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, has: false },
      startedAt,
    );
    return { result: { handle: this.appServerHandle(poolKey, outcome), outcome }, driftCode: undefined };
  }

  /**
   * 首轮执行 + 双重试编排（常驻路径）：
   * - **schema 仿真重试**（既有语义）：parsed 但校验失败时重试一次（强化 JSON 输出
   *   指令——与 spawn/structured-output 的重试语义对齐）。
   * - **瞬时失败自动重试一次**（[P0-1 U4/D6]）：末次 attempt 为 timeout 类（idle/
   *   ceiling）或连接崩溃类失败且非用户 abort、非漂移码 → 用新会话重跑一次（attempt
   *   本就每次新建会话）。重试轮 prompt 用 basePrompt 原样重跑（失败形态非 schema），
   *   文案补「已自动重试一次」句（retried 标记仅对真实发生的重试生效）。
   *
   * 两次重试一次封顶各自独立（D6 被否①：多次重试/指数退避不做——重跑一轮=整任务
   * 重算，一次封顶）。组合序：瞬时重试在前、schema 重试在后——瞬时重试轮 parsed 且
   * 校验失败时仍进 schema 重试（末次 attempt 语义，schema 重试编排保持现状不动）。
   *
   * 重试轮是独立会话的独立 LLM 调用：token 计入 outcome.usage 总量；事件面
   * text_delta 按实际流出（含失败轮——journal 记录真实流水），message_end/turn_end
   * 只在最终轮终态后合成（不变量 2/5）。
   */
  private async runAppServerAttemptsWithRetry(
    task: AgentTaskSpec,
    ctx: RunContext,
    home: AppServerHomeHandle,
    modelRef: string,
    cwd: string,
    basePrompt: string,
    schema: object | undefined,
    usageAcc: { input: number; output: number; cacheRead: number; cacheWrite: number; has: boolean },
  ): Promise<AttemptResult> {
    const attemptStartedAt = Date.now();
    let final = await this.attemptAppServerTurn(task, ctx, home, modelRef, cwd, basePrompt);
    accumulateUsage(usageAcc, final);
    // [P0-1 U4/D6] 瞬时失败自动重试一次：判据 = run-failed 且 transient 形态标记
    // （类型化，不经字符串反推）+ 非用户已取消 + 非漂移码（防御性——transient 形态
    // 构造处即无 rpcCode，漂移类有专属 R5 降级链语义）+ 非引擎停机（dispose 收割
    // 引发的崩溃不重试——停机后惰性重建 = 复活进程，违背 dispose 防泄漏语义）。
    // 预算继承（P-Z4）：显式总上界预算下重试轮上界 = 剩余（总 − 已耗尽），剩余不足
    // 最小下限不重试直接终态化；重试轮启动即 journal 出声（D6：重试事实记入 journal）。
    if (
      final.kind === "run-failed" &&
      final.transient !== undefined &&
      ctx.signal?.aborted !== true &&
      !this.disposed &&
      !(final.rpcCode !== undefined && isDriftRpcCode(final.rpcCode))
    ) {
      const budget = resolveTransientRetryBudget(explicitTurnBudgetMs(), Date.now() - attemptStartedAt);
      if (budget.state === "depleted") {
        logger.warn(
          `[zcode-engine] 末次 attempt 瞬时失败（${final.transient}）——显式总上界预算剩余不足 ${ZCODE_TURN_RETRY_MIN_BUDGET_MS}ms，不重试直接终态化（预算继承：重试不重置总预算）`,
        );
      } else {
        logger.warn(
          `[zcode-engine] 末次 attempt 瞬时失败（${final.transient}）——止损链已终局，新会话自动重试一次` +
            (budget.state === "inherit"
              ? `（预算继承：重试轮总上界=剩余 ${budget.remainingMs}ms，不重置总预算）`
              : "（无显式总上界预算，重试轮走 env/默认上界）"),
        );
        const retry = await this.attemptAppServerTurn(task, ctx, home, modelRef, cwd, basePrompt, {
          // 预算继承传递点（D2 内部传参面）：显式预算 → 剩余值；无显式预算 → 缺省
          // （channel 侧走同一 env/默认，与首轮行为一致）
          ...(budget.state === "inherit" ? { turnTimeoutMs: budget.remainingMs } : {}),
          // 重试事实进文案：「已自动重试一次」句仅对真实发生的重试生效（未重试形态
          // 不含——与行为一致，§5.2 F-1/F-4）
          retried: true,
        });
        accumulateUsage(usageAcc, retry);
        final = retry;
      }
    }
    if (final.kind === "parsed" && final.schemaResult !== undefined && !final.schemaResult.ok && schema !== undefined) {
      const retryPrompt = appendSchemaRetryDirective(basePrompt, final.schemaResult.error);
      const retry = await this.attemptAppServerTurn(task, ctx, home, modelRef, cwd, retryPrompt);
      accumulateUsage(usageAcc, retry);
      final = retry;
    }
    return final;
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
   *
   * @param opts turnTimeoutMs：显式总上界传参面（D2 内部传参点）——U4/D6 预算继承
   *   向重试轮传剩余值；缺省不传（channel 走 env→默认，首轮行为）。
   *   retried：瞬时重试轮标记——失败文案补「已自动重试一次」句（F-1/F-4）。
   */
  private async attemptAppServerTurn(
    task: AgentTaskSpec,
    ctx: RunContext,
    home: AppServerHomeHandle,
    modelRef: string,
    cwd: string,
    prompt: string,
    opts: { turnTimeoutMs?: number; retried?: boolean } = {},
  ): Promise<AttemptResult> {
    const rt = this.ensureAppServerRuntime(home);
    const { providerId, modelId } = splitZcodeModelRef(modelRef);
    const createParams = buildAppServerCreateParams(task, providerId, modelId, cwd);

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
      // 显式总上界传参（D2/U4：缺省缺席——channel 侧 resolveTurnTimerMs 走 env→默认）
      ...(opts.turnTimeoutMs !== undefined ? { turnTimeoutMs: opts.turnTimeoutMs } : {}),
    });

    // D3 abort 链：signal abort → ① session/stop {sessionId} ② grace 窗口确认终态
    // ③ stop 失败/超时 → killChain 杀共享进程（接受连坐——协议已不可信）→ 在途
    // 其他任务走崩溃路径。capabilities.interrupt 维持 kill-only 不升级（C4）。
    // [P0-1 U2] 用户取消入口 = escalateOn:"turn-settled"（grace 窗口确认 turn 落定，
    // 现状语义零改动）；channel 超时判死（TurnTimeoutError）走 catch 分流的
    // escalateOn:"stop-outcome" 入口（stop 应答三态裁决）。
    const onAbort = (): void => {
      void this.appServerAbortChain(rt, turn, () => currentSessionId, sessionCreated, { escalateOn: "turn-settled" });
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
      return parsedAppServerAttempt(task, r);
    } catch (err) {
      if (ctx.signal?.aborted === true) return abortedAppServerAttempt(ctx);
      // [P0-1 U2] 超时入口（D3 v1.1）：turn 已被 channel 判死 reject——升级判据不能
      // 再挂在 turn 落定上（race 恒真，killChain 结构性不可达的 v1 击穿点），改以
      // stop 应答三态裁决。await 链终局（非 fire-and-forget）：outcome 止损文案与
      // 重试时序（D6，u-z4）都依赖链终局信号——止损完成前不合成终态。
      if (err instanceof TurnTimeoutError) {
        const stopPath = await this.appServerAbortChain(
          rt,
          turn,
          () => currentSessionId,
          sessionCreated,
          { escalateOn: "stop-outcome" },
        );
        // [P0-1 U4] timeout 类（idle/ceiling 都算）是 D6 明文的可重试形态——结构化
        // 标记（TurnTimeoutError 类型化判据，不经字符串匹配，D4 同精神）
        return timeoutAppServerAttempt(err, currentSessionId, stopPath, { retried: opts.retried });
      }
      // [P0-1 U4] 连接崩溃收割形态（failAllTurns 的错误，D6 第二可重试形态）判据：
      // 非 RPC error（服务端无明确应答——有应答即精确错误归类，非瞬时崩溃面）且
      // conn 不存活。时序可靠性：catch 时刻紧随 onClose 收割，连接重建仅由
      // conn.request 惰性触发——本链路中 runTurn finally 的 closeSession 对死连接
      // 短路（channel 侧 !alive 守卫）、stop 只属 abort/超时入口（前者已被
      // signal.aborted 短路、后者走上一分支）——此刻无 request 可重建，判据可靠。
      if (!isAppServerRpcError(err) && !rt.conn.alive) {
        return failedAppServerAttempt(err, home, currentSessionId, { retried: opts.retried, transient: "conn-closed" });
      }
      return failedAppServerAttempt(err, home, currentSessionId, { retried: opts.retried });
    } finally {
      if (currentSessionId !== undefined) rt.activeSessions.delete(currentSessionId);
      if (ctx.signal !== undefined) ctx.signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * killChain 后等待连接 finalize 实际完成（child 置空 + onClose 广播）再宣告链终局：
   * shutdown resolve 于 `exit` 事件，而 finalize 挂 `close`（stdio 排空）——两者之间的
   * 事件窗口内 conn.child 仍非 null，紧接的下一任务 request 会复用垂死进程（写入成功
   * 但必败，走崩溃路径）而非触发重建。与 shutdownRuntimeAndDisposeChannel 的
   * HARVEST_GRACE 同款 race 形态（close 永不到达不挂死）。超时入口的 await 链终局
   * 语义（D6 重试时序依据）因此是「进程收割确认完成」而非「SIGTERM 已发出」。
   */
  private async awaitConnFinalized(rt: AppServerRuntime): Promise<void> {
    if (!rt.conn.alive) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => finish(), ZCODE_APPSERVER_HARVEST_GRACE_MS);
      if (typeof timer.unref === "function") timer.unref();
      const off = rt.conn.onClose(() => finish());
      function finish(): void {
        clearTimeout(timer);
        off(); // Set.delete 幂等——并发触发无副作用
        resolve();
      }
    });
  }

  /**
   * D3 abort 链执行体（双入口分岔，P0-1 U2 参数化——设计
   * timeout-zcode-turn-and-settled-watchdog.md §6 D3 v1.1）：
   * - **用户取消入口**（`escalateOn: "turn-settled"`，现状语义零改动；fire-and-forget——
   *   与 turn promise 并行推进）：stop 帧（超时 ZCODE_APPSERVER_STOP_TIMEOUT_MS）→
   *   grace 窗口内 turn 落定即止（不杀共享进程）→ 超窗 killChain（conn.shutdown 全序：
   *   SIGTERM→grace→SIGKILL）。turn 的最终落定由 attempt 主路径 await 收口，本链不
   *   直接产出终态。abort 与 create 竞态（signal 先到、session 未建立）：等会话建立
   *   （带上限）再发 stop——否则 stop 永远发不出，直接连坐杀共享进程。
   * - **超时入口**（`escalateOn: "stop-outcome"`，channel 判死后由 catch await 链终局）：
   *   turn 已 reject，对它 race 恒真不可用（v1 击穿点）——升级判据改挂在 **stop 应答
   *   三态**：①成功应答 → 服务端接受停 turn，止损确认，链终止；②协议性 error 应答
   *   （有 error 帧即控制面活的证据，多因 runTurn finally 的 closeSession 先行关会话，
   *   健康形态竞态）→ 链终止**不升级**（止损由 close 回收 + 服务端自治承担；把
   *   「stop 报错」一律升级会误杀健康共享进程并连坐并发任务）；③超时/写入失败/进程
   *   死等连接级失败（控制面死）→ killChain 升级。判据实现依据：error 应答帧 reject
   *   携带 number code（isAppServerRpcError）；连接级失败是无 code 的新 Error
   *   （connection.request 三态 reject 形态）。返回值即止损路径（超时入口的 outcome
   *   文案素材——D3 强制可观测面）。
   */
  private async appServerAbortChain(
    rt: AppServerRuntime,
    turn: Promise<SessionTurnResult>,
    getSessionId: () => string | undefined,
    sessionCreated: Promise<void>,
    entry: { escalateOn: "turn-settled" | "stop-outcome" },
  ): Promise<AbortChainStopPath> {
    const graceRaceThenKill = async (): Promise<AbortChainStopPath> => {
      const settled = await Promise.race([
        turn.then(
          () => true,
          () => true,
        ),
        delayResolved(ZCODE_APPSERVER_ABORT_GRACE_MS, false),
      ]);
      if (settled) return "settled-in-grace"; // stop 生效：终态在 grace 窗口内到达，共享进程不杀
      logger.warn(
        `[zcode-engine] abort grace 窗口内未见终态——killChain 收割共享进程（接受连坐，在途任务走崩溃路径）`,
      );
      await rt.conn.shutdown({ graceMs: ZCODE_KILL_GRACE_MS });
      await this.awaitConnFinalized(rt);
      return "escalated-kill";
    };

    let sessionId = getSessionId();
    if (sessionId === undefined) {
      await Promise.race([sessionCreated, delayResolved(ZCODE_APPSERVER_STOP_TIMEOUT_MS, undefined)]);
      sessionId = getSessionId();
      if (sessionId === undefined) {
        // 会话始终未建立：超时入口实际不可达（TurnTimeoutError 只能发生在 openTurn
        // 挂 timer 后，彼时 create 已成功），防御分支——无会话即无在途任务可止损；
        // 用户取消入口保持既有语义：跳过 stop，grace race 兜底（create 竞态挂死形态）
        if (entry.escalateOn === "stop-outcome") return "no-session";
        return graceRaceThenKill();
      }
    }
    // [u-z2 修复轮] alive 守卫（与 closeSession 的 `!conn.alive` return 同款防御，
    // 对称补齐）：进程在 turn 判死/abort 与本链发 stop 之间 finalize 完成的微窗口内，
    // request 首行 ensureStarted 会惰性 spawn 新一代进程再写 stop 帧——凭空拉起无人
    // 使用的进程，且 stop-outcome 入口会拿到新进程的「成功应答」误报止损确认。
    // 不 alive = 连接级失败形态（进程已死即已收割）：超时入口直接落杀链终局（等同
    // 三态的连接级失败分支）；用户取消入口跳过 stop 落回 grace race（turn 已被
    // failAllTurns 收割则立即 settled，语义零变化）。
    if (!rt.conn.alive) {
      if (entry.escalateOn === "stop-outcome") return "stop-unreachable-killed";
      return graceRaceThenKill();
    }
    try {
      await rt.conn.request("session/stop", { sessionId }, { timeoutMs: ZCODE_APPSERVER_STOP_TIMEOUT_MS });
    } catch (err) {
      if (entry.escalateOn === "stop-outcome") {
        if (isAppServerRpcError(err)) {
          // ② 协议性 error：控制面活、会话已被回收（健康形态竞态）——不升级
          logger.debug(
            `[zcode-engine] session/stop 报协议性 error（${errMessage(err)}）——会话已回收，控制面存活，不升级杀链`,
          );
          return "stop-rejected";
        }
        // ③ 连接级失败（请求超时/写入失败/进程死）：控制面死，只有杀进程能止损
        logger.warn(
          `[zcode-engine] session/stop 无应答（${errMessage(err)}）——升级 killChain 收割共享进程（超时入口，接受连坐）`,
        );
        await rt.conn.shutdown({ graceMs: ZCODE_KILL_GRACE_MS });
        await this.awaitConnFinalized(rt);
        return "stop-unreachable-killed";
      }
      logger.debug(
        `[zcode-engine] session/stop 失败（${errMessage(err)}）——grace 后走 killChain 兜底`,
      );
    }
    if (entry.escalateOn === "stop-outcome") return "stop-acked"; // ① 成功应答：止损确认，链终止
    return graceRaceThenKill();
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
   * [P0-1 U5/D7] grace race 输掉（close 迟到/永不到达——stdio 被孙进程持有排空不
   * 尽等病态形态）时，channel.dispose() 内置的 dispose 收割（failAllTurns 先于退订，
   * SessionChannel.dispose）兜底在途 turn——退化终点从「挂满 turn 自身 idle/总上界
   * 预算」收敛为「grace 窗口内明确失败」（设计 §3.4 退化路径闭合）；race 窗口与
   * awaitConnFinalized 同源同量级（ZCODE_APPSERVER_HARVEST_GRACE_MS）。正常 close
   * 先到时 onClose 收割先行，dispose 收割幂等 no-op（零回归）。
   */
  private async shutdownRuntimeAndDisposeChannel(rt: AppServerRuntime): Promise<void> {
    const harvested = new Promise<void>((resolve) => {
      const off = rt.conn.onClose(() => {
        off();
        resolve();
      });
    });
    await rt.conn.shutdown({ graceMs: ZCODE_KILL_GRACE_MS });
    // close 未在 grace 内到达 → 输掉 race → channel.dispose() 的内置收割兜底
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
    // [P0-1 U4] 停机标志先行：在途任务的瞬时重试判定据此短路（dispose 收割引发的
    // 崩溃不再触发重试轮——重试轮会经惰性重建复活已停机引擎）
    this.disposed = true;
    const rt = this.appserverRuntime;
    if (rt === undefined) return;
    this.appserverRuntime = undefined;
    // ①fire 全部在途会话的 session/close 帧（不等待应答——D6① 顺序规定：close 帧
    // 必须先于 SIGTERM，否则对面来不及处理即被杀）。进程已死（child=null，如崩溃
    // 收割与 activeSessions 清理之间的微拍）则整体跳过：post 会经 ensureStarted 惰性
    // 拉起新进程再被同次 dispose 杀掉——无意义的 spawn+kill 循环（D6 dispose=防泄漏
    // 语义不制造新进程），且对面进程已不在，close 帧也没有送达对象。同步循环内
    // alive 不会中途翻转（进程退出是异步事件，本轮循环不可重入）
    if (rt.conn.alive) {
      for (const sessionId of [...rt.activeSessions]) {
        rt.conn.post("session/close", { sessionId });
      }
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
   * [RX2-F3] degrade.skipCtxModelWarn（内部标志）：漂移首败重跑场景置 true——该任务
   * 的 appserver 首跑已输出过 ctxModel 忽略留痕，spawn 重跑侧跳过防同 taskId 双份
   * 相同 warn；warnEffortUnsupportedBySpawn 不受此标志影响（降级重跑时最终结果出自
   * spawn，其出声合理，保持现状）。探针失败/降级直走两个落点不置位——任务此前未走
   * 过 appserver，spawn 侧的 warn 是首次出声。
   */
  private async runViaSpawn(
    task: AgentTaskSpec,
    ctx: RunContext,
    degrade?: { degradedReason: string; skipCtxModelWarn?: boolean },
  ): Promise<EngineRunResult> {
    const startedAt = Date.now();
    this.rejectUnsupportedTaskShapes(task);
    this.warnEffortUnsupportedBySpawn(task, ctx);

    // ① prepare 期：模型解析（provider 体系校验）+ 隔离 HOME 池引导（凭据 + model.main）
    const modelRef = resolveZcodeModelRef(task.model, this.deps.sources);
    if (degrade?.skipCtxModelWarn !== true) this.warnIgnoredCtxModel(task, ctx, modelRef);
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

    // ②-④ 首轮执行 + schema 仿真重试（重试语义与不变量注释见 runSpawnAttemptsWithRetry）
    const usageAcc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, has: false };
    const final = await this.runSpawnAttemptsWithRetry(task, ctx, prepared, cwd, basePrompt, schema, usageAcc);

    const outcome = this.finalizeOutcome(task, ctx, final, usageAcc, startedAt);

    const handle: EngineHandle = this.buildSpawnEngineHandle(prepared, outcome);
    if (degrade !== undefined) {
      // 降级标注（engineFallback 留痕面合并语义见 applyDegradeFallback）
      applyDegradeFallback(outcome, degrade.degradedReason);
    }
    return { handle, outcome };
  }

  /**
   * 首轮执行 + schema 仿真重试编排（spawn 路径）：schema 任务校验失败时重试一次（强化
   * JSON 输出指令——与 structured-output 的重试语义对齐，设计 §3.3.3
   * schema_emulation_failed 行）。重试轮产生的新 session 是独立 LLM 调用：token 计入
   * outcome.usage 总量，事件只在最终轮终态后一次性合成（不变量 5：事件 emit 完成先于
   * run resolve）。
   */
  private async runSpawnAttemptsWithRetry(
    task: AgentTaskSpec,
    ctx: RunContext,
    prepared: ReturnType<typeof prepareZcodeHome>,
    cwd: string,
    basePrompt: string,
    schema: object | undefined,
    usageAcc: { input: number; output: number; cacheRead: number; cacheWrite: number; has: boolean },
  ): Promise<AttemptResult> {
    let final = await this.attemptOnce(task, ctx, prepared, cwd, basePrompt);
    accumulateUsage(usageAcc, final);
    if (final.kind === "parsed" && final.schemaResult !== undefined && !final.schemaResult.ok && schema !== undefined) {
      const retryPrompt = appendSchemaRetryDirective(basePrompt, final.schemaResult.error);
      const retry = await this.attemptOnce(task, ctx, prepared, cwd, retryPrompt);
      accumulateUsage(usageAcc, retry);
      final = retry;
    }
    return final;
  }

  /** spawn 路径的 handle 合成（poolKey = 隔离池目录名；探针版本可留痕）。 */
  private buildSpawnEngineHandle(
    prepared: ReturnType<typeof prepareZcodeHome>,
    outcome: AgentOutcome,
  ): EngineHandle {
    return {
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

  /**
   * run-failed 合成终态：错误信息由 buildRunFailedMessage 产出（已含恢复指引）直接透传；
   * appserver 路径附带的会话 id 落 outcome.sessionId（错误规格表 -32004 行「含会话 id」
   * ——appServerHandle 据此写 handle.sessionRef，run-failed 不再恒缺）。
   */
  private applyRunFailedOutcome(
    outcome: AgentOutcome,
    final: Extract<AttemptResult, { kind: "run-failed" }>,
    emit: (event: AgentEvent) => void,
  ): void {
    outcome.exitCode = final.output.exitCode;
    if (final.sessionId !== undefined) outcome.sessionId = final.sessionId;
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

  /**
   * [u-h2 D2-2] 派发同步期 model 校验：委托 resolveZcodeModelRef（与 run prepare 期
   * 同一函数——canonicalRef 归一化、短名缺省 provider、凭据与清单校验单一权威，无双实现）。
   * modelRef undefined = 返回引擎缺省模型 canonical 全名（ZCODE_FALLBACK_DEFAULT_MODEL，
   * D2-1 ctxModel 不透传的承接面）。校验失败原样抛 ZcodePrepareError，由编排层
   * （engine/model-validation.ts）包装成「引擎与模型不配套」文案。
   */
  validateModel(modelRef: string | undefined): { canonicalRef: string } {
    return { canonicalRef: resolveZcodeModelRef(modelRef, this.deps.sources) };
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
   * [F15b] spawn 路径的 effort 丢弃信号：spawn CLI 无 thoughtLevel 类 flag（协议
   * 通道是 appserver 路径专属），effort 只能丢弃——但静默丢弃会让调用方误以为推理
   * 档位已生效，故出声留痕（引擎现成信号风格：logger.warn，同漂移降级先例）。
   * 诊断语义：effort 是可忽略档位（降档不改变任务正确性），warn 留痕而非硬拒绝
   * （与 maxTurns「传了上限却失控」的假象不同质性）。
   */
  private warnEffortUnsupportedBySpawn(task: AgentTaskSpec, ctx: RunContext): void {
    const effort = task.effort?.trim();
    if (effort === undefined || effort === "") return;
    logger.warn(
      `[zcode-engine] effort=${effort} 被忽略：zcode spawn 不支持 thoughtLevel 通道（CLI 无对应 flag），任务按引擎缺省推理档位执行；需要 effort 请走 appserver 模式`,
      { taskId: ctx.taskId },
    );
  }

  /**
   * [RX2-F1] appserver 路径的非常见档位提示：effort → thoughtLevel 恒等透传（F15a），
   * 全 7 档放行不拦截——但部分档位（off/minimal/medium/xhigh 等）不在部分模型的合法
   * 值域内（如 GLM-5.3 仅接受 low/high/max），app-server 侧对不支持的档位 warn-skip
   * （会话照常但档位静默失效），调用方无从察觉。此处仅对 COMMON_THOUGHT_LEVELS 之外
   * 的档位出声一行提示（措辞是「若不支持将被忽略/回落」的或然警告，非无效断言）；
   * 是否真不支持由目标模型决定，core 不做权威校验（引擎层不掌握各模型值域）。
   */
  private warnThoughtLevelUncommon(task: AgentTaskSpec, ctx: RunContext): void {
    const thoughtLevel = task.effort?.trim();
    if (thoughtLevel === undefined || thoughtLevel === "") return;
    if (COMMON_THOUGHT_LEVELS.includes(thoughtLevel)) return;
    logger.warn(
      `[zcode-engine] effort=${thoughtLevel} 已透传为 thoughtLevel（非常见档位）：若目标模型不支持该档位将被忽略/回落到模型缺省推理档位（常见档位：${COMMON_THOUGHT_LEVELS.join("/")}）；档位是否生效以模型实际行为为准`,
      { taskId: ctx.taskId },
    );
  }

  /**
   * [F16b] ctxModel 忽略留痕：ctxModel 是 pi 链路的第三层兜底（port.ts 契约——
   * 依赖 pi resolveModel 链的引擎才消费它），zcode 自带 provider 体系与缺省模型
   * （resolveZcodeModelRef：requested > ZCODE_FALLBACK_DEFAULT_MODEL），不消费
   * ctxModel。「调用方给了 ctxModel 但 task.model 未显式指定」时出声一行，说明
   * 实际落引擎缺省模型（含实际 model id）——防静默降档无据可查。只在「ctx 有模型
   * 但被忽略」场景输出：显式 task.model 走正常解析链、ctx 本就无模型属预期缺省，
   * 均不出声（避免噪音）。探针期（appServerProbeGate）不调用——同一任务的正式
   * run 链路必经此处，双份输出是噪音。[RX2-F3] 漂移首败的 spawn 重跑同理由调用方
   * 带 degrade.skipCtxModelWarn 跳过——appserver 首跑已出声过，同任务双份相同 warn
   * 是噪音（与探针场景同一自我要求）。
   */
  private warnIgnoredCtxModel(task: AgentTaskSpec, ctx: RunContext, modelRef: string): void {
    if (ctx.ctxModel === undefined) return;
    const requested = task.model?.trim();
    if (requested !== undefined && requested !== "") return;
    logger.warn(
      `[zcode-engine] ctx.ctxModel（${ctx.ctxModel.id}）被忽略——ctxModel 是 pi 链路兜底，zcode 不消费；` +
        `task.model 未显式指定，实际使用引擎缺省模型 ${modelRef}`,
      { taskId: ctx.taskId },
    );
  }

  /**
   * persona 拼接后的完整 prompt（personaInjection: 'prompt'——zcode 无 flag 通道）：
   * persona 段经 common/persona-router.applyPersona 按 capabilities 路由产出
   * （agentRef/skillPath 引用行 + appendSystemPrompt 正文统一拼装，S5 接线——替换
   * 原手拼 appendSystemPrompt 段，skillPath/agentRef 不再丢弃），task 正文居中，
   * schema 仿真段尾置（common/schema-emulation 公共层产出，D4 emulated 侧——zcode
   * 无 native schema 通道）。
   */
  private buildPrompt(task: AgentTaskSpec, schema: object | undefined): string {
    const segments: string[] = [];
    if (task.persona !== undefined) {
      const routed = applyPersona(task.persona, this.capabilities());
      if (routed.promptSegment !== "") segments.push(routed.promptSegment);
    }
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
  | {
      kind: "run-failed";
      output: ZcodeCollectedOutput;
      message: string;
      rpcCode?: number;
      /** appserver 路径失败时已建立的会话 id（错误规格表 -32004 行：按任务失败上报含会话 id）。 */
      sessionId?: string;
      /**
       * [P0-1 U4/D6] 瞬时失败形态标记（重试判定判据——类型化字段，不经字符串
       * 反推）：timeout = channel 判死（TurnTimeoutError，idle/ceiling 都算——D6
       * 明文两类均可重试）；conn-closed = 连接崩溃收割（failAllTurns 形态，判据 =
       * 非 RPC error 且 conn 不存活——catch 时刻重建仅由 conn.request 惰性触发，
       * 此前无 request，判据可靠）。缺席 = 非瞬时形态（RPC 错误/status=error 终态/
       * send 未送达等），不参与重试（D6 被否③：status='error' 终态 v1 不重试）。
       */
      transient?: "timeout" | "conn-closed";
    }
  | {
      kind: "parsed";
      output: ZcodeCollectedOutput;
      payload: ZcodeTerminalPayload;
      schemaResult?: { ok: true; parsed: unknown } | { ok: false; error: string; tail: string };
    };

/**
 * [P0-1 U4/D6] 瞬时失败自动重试的最小剩余预算下限（ms）：显式总上界预算下，剩余
 * 低于此值不再重试直接终态化（D6「剩余不足一个最小下限（如 5min）」——重跑一轮
 * 整任务的最小耗时估计，剩余更小的重试注定再被上界回收，白烧一轮 token）。
 * 单消费方（本文件重试编排），故为模块常量不进 constants.ts（跨文件共享才上移）。
 */
export const ZCODE_TURN_RETRY_MIN_BUDGET_MS = 300_000;

/** resolveTransientRetryBudget 的判定结果（可判别联合——inherit 分支剩余值必有）。 */
export type ZcodeTurnRetryBudget =
  | { state: "inherit"; remainingMs: number }
  | { state: "depleted" }
  | { state: "unbounded" };

/**
 * [P0-1 U4/D6 预算继承] 重试轮预算判定（纯函数，P-Z4 探针「显式预算下重试轮不
 * 重置总预算」的数学本体——剩余 = 总预算 − 已耗尽）：显式总上界预算存在时重试轮
 * 上界收窄为剩余（不重置），剩余不足最小下限则不重试；非显式（env 未设/非法/
 * ≤0 显式关闭）为 unbounded——无「总预算」可言，重试轮走 env/默认全新上界（与
 * 首轮同源，行为一致），不受预算门禁。
 */
export function resolveTransientRetryBudget(
  totalBudgetMs: number | undefined,
  consumedMs: number,
): ZcodeTurnRetryBudget {
  if (totalBudgetMs === undefined) return { state: "unbounded" };
  const remainingMs = totalBudgetMs - consumedMs;
  return remainingMs >= ZCODE_TURN_RETRY_MIN_BUDGET_MS
    ? { state: "inherit", remainingMs }
    : { state: "depleted" };
}

/**
 * 显式总上界预算读取（P-Z4 门禁的「显式」判定——D6「显式设置了 turnTimeoutMs
 * （env 或内部传参）」在引擎侧的唯一来源是 env；引擎内部传参点只用于向重试轮传
 * 剩余值）：env 设置为正数 → 显式预算；未设/非法（走默认）与 ≤0（显式关闭上界）
 * 均非显式预算（undefined → unbounded）。读 process.env 直连（与 session-channel
 * 的 resolveTurnTimerMs 同源同通道，vi.stubEnv 可测——D2 env 通道一致性）。
 */
function explicitTurnBudgetMs(): number | undefined {
  const parsed = parseZcodeTurnTimeoutEnv(process.env[ZCODE_TURN_MAX_TIMEOUT_ENV]);
  return parsed.state === "valid" && parsed.ms > 0 ? parsed.ms : undefined;
}

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
 * -32010 → 单会话一任务是结构保证（busy 不排队不打断），文案引导附带 sessionId/state
 * 流水报告；其余（连接崩溃/会话失败/漂移类透传——漂移降级归 R5）→ engine_run_failed +
 * 恢复指引。sessionId 已建立时随文案透出（错误规格表 -32004 行「按任务失败上报含会话 id」）。
 *
 * retried（[P0-1 U4] §5.2 F-4「已重试 1 次」）：仅在瞬时重试真实发生后为 true——
 * 兜底行恢复指引补「已自动重试一次仍失败」句（未重试形态不含，与行为一致）；专属
 * 归类行（credential/busy）有独立恢复指引，不掺重试事实（错误规格表行的归类语义优先）。
 */
function buildAppServerRunFailedMessage(err: unknown, home: AppServerHomeHandle, sessionId?: string, retried = false): string {
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
  if (isAppServerRpcError(err) && err.code === ZCODE_APPSERVER_ERR_BUSY_SESSION) {
    const sid = sessionId !== undefined ? `（会话 id: ${sessionId}）` : "";
    return (
      `engine_run_failed: app-server 报 -32010${sid}（send 时该会话已有轮在跑，busy 不排队不打断）。` +
      `单会话一任务是结构保证，出现即 bug；请附带 sessionId 与 state 流水（连接/会话事件日志）上报问题。`
    );
  }
  const code = isAppServerRpcError(err) && err.code !== undefined ? `（code ${err.code}）` : "";
  const sid = sessionId !== undefined ? `（会话 ${sessionId}）` : "";
  const retryNote = retried
    ? `恢复指引：直接重跑本任务（瞬时故障已自动重试一次仍失败；重试用的是崩溃后自动重建的新会话）。`
    : `恢复指引：直接重跑本任务（连接崩溃后自动重建进程）；`;
  return (
    `engine_run_failed: app-server 会话执行失败${code}${sid}: ${errMessage(err).slice(-ZCODE_ERROR_TAIL_CHARS)}。` +
    `${retryNote}若持续失败，跑 probe 核对协议漂移（R5 降级链）或改用 engine: pi。`
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

/** create 参数组装（A.2 ① strict 键集：空白 thoughtLevel / 空 deny 清单不设键）。 */
function buildAppServerCreateParams(
  task: AgentTaskSpec,
  providerId: string,
  modelId: string,
  cwd: string,
): SessionCreateParams {
  const denyTools = (task.denyTools ?? []).filter((t) => typeof t === "string" && t.trim() !== "");
  // effort → thoughtLevel（A.2 ① 键集内）：空白串归一为不设键——strict 对象下
  // 空值键位无语义且防 -32602 变形拒收（与 denyTools 空清单不设键同款纪律）
  const thoughtLevel = task.effort?.trim();
  return {
    workspacePath: cwd,
    mode: "yolo",
    // per-session model（G3）：create 参数透传（A.2 ① strict 对象）——同进程任务
    // 各用各的模型，互不干扰
    model: { providerId, modelId },
    ...(thoughtLevel !== undefined && thoughtLevel !== "" ? { thoughtLevel } : {}),
    ...(denyTools.length > 0 ? { toolDenylist: denyTools } : {}),
  };
}

/**
 * 权威终态 status 提取（P0-1 U3/D5② + ⛔P-Z2 降级路径约束「只消费
 * source="turn.terminal" 的 status」）：turn.terminal 到达（先到/迟到）时 u-z1 的
 * lastTerminalStatus 必有记录（channel 无条件先记再 settle/不改写落定）；缺席说明
 * 终态仅由 final-frame 宽松判定落定（恒 settle success，不可信）——无权威 status
 * 可消费，不据此判失败。
 */
function authoritativeTerminalStatus(r: SessionTurnResult): string | undefined {
  if (r.lastTerminalStatus !== undefined) return r.lastTerminalStatus;
  return r.terminal.source === "turn.terminal" ? r.terminal.status : undefined;
}

/**
 * 失败终态判据（⛔P-Z2 门修正）：真实 status 枚举 = ["success","interrupted",
 * "failed"]（app-server dist schema f.enum 实证，**无 "error"**——v1 判据
 * `=== "error"` 对真实 failed 终态漏分流即假成功，本修复轮根修）。裁决：
 *   - "failed" → run-failed（模型/服务端真实失败——§5.2 F-3）；
 *   - "interrupted" → 不分流（用户中断，不属引擎失败——随宿主 abort 主路径收口，
 *     引擎侧不抢先把它终态化为失败）；
 *   - "error" → 保留为容错分支（非真实枚举，防协议漂移/旧版本形态再滑入假成功；
 *     假成功代价 >> 误报失败代价，取并集防御）。
 */
function isFailedTerminalStatus(status: string | undefined): boolean {
  return status === "failed" || status === "error";
}

/**
 * [P0-1 U3/D5②] appserver 轮成功收口的 parsed 三态（read 兜底后的 response + schema
 * 校验）。失败终态（isFailedTerminalStatus，"interrupted" 不在其中——不误判失败）
 * 先分流（§3.2 缺陷 B 不再假成功；schema 校验对失败形态无意义——失败终态的
 * response 是错误尾部，非结构化输出候选）。
 */
function parsedAppServerAttempt(task: AgentTaskSpec, r: SessionTurnResult): AttemptResult {
  if (isFailedTerminalStatus(authoritativeTerminalStatus(r))) {
    return failedTerminalAppServerAttempt(r);
  }
  const schema = isPlainObject(task.schema) ? task.schema : undefined;
  return {
    kind: "parsed",
    output: syntheticAppServerOutput(0),
    payload: turnResultToPayload(r),
    ...(schema !== undefined
      ? { schemaResult: extractAndValidateStructuredOutput(r.response, schema) }
      : {}),
  };
}

/**
 * [P0-1 U3/D5② + ⛔P-Z2 门修正] failed 终态的 run-failed 合成（§5.2 F-3 文案）：
 * exitCode=null 异常终态、无 rpcCode（终态失败非 RPC error 帧，不参与漂移降级）、
 * sessionId 留痕同 failedAppServerAttempt。错误详情优先级：terminal 帧 errorCode/
 * errorMessage（⛔P-Z2 实证——真实 failed 终态的错误详情只在 terminal 帧，read/
 * delta 携带不了）> read 兜底/delta 聚合尾部（F-3 原文案，降级为兜底）> 「无返回
 * 内容」（P-Z2 降级形态：final-frame 先到且 read 无错误信息——不伪造错误详情，
 * 覆盖面收窄但不假成功）。
 */
function failedTerminalAppServerAttempt(r: SessionTurnResult): AttemptResult {
  const status = authoritativeTerminalStatus(r);
  const detail = r.lastTerminalError;
  const detailParts: string[] = [];
  if (detail?.code !== undefined) detailParts.push(`errorCode: ${detail.code}`);
  if (detail?.message !== undefined) detailParts.push(detail.message);
  // 错误详情优先级（⛔P-Z2）：terminal 帧详情 > read 兜底/delta 聚合尾部 > 无返回内容
  let body: string;
  if (detailParts.length > 0) {
    body = `服务端错误：${detailParts.join("：")}。`;
  } else {
    const tail = r.response.trim();
    body =
      tail !== ""
        ? `服务端返回尾部：${tail.slice(-ZCODE_ERROR_TAIL_CHARS)}。`
        : "服务端无返回内容（read 兜底/delta 聚合均为空）。";
  }
  return {
    kind: "run-failed",
    output: syntheticAppServerOutput(null),
    message:
      `engine_run_failed: app-server 终态 status=${status}（会话 ${r.sessionId}）。${body}\n` +
      `👉 恢复指引：错误内容来自模型/服务端；直接重跑，若持续出现核对 ZCode 桌面端凭据与模型配置（engine_credential_missing 同族排查）。`,
    sessionId: r.sessionId,
  };
}

/** appserver 轮失败收口的 run-failed 三态（结构化文案 + RPC code 透传 + 会话 id 留痕）。 */
function failedAppServerAttempt(
  err: unknown,
  home: AppServerHomeHandle,
  currentSessionId: string | undefined,
  opts: { retried?: boolean; transient?: "timeout" | "conn-closed" } = {},
): AttemptResult {
  return {
    kind: "run-failed",
    output: syntheticAppServerOutput(null),
    message: buildAppServerRunFailedMessage(err, home, currentSessionId, opts.retried === true),
    // [R5] RPC code 透传给 run 编排（-32601/-32602 漂移降级判据；连接级/超时类
    // 错误无 code 不参与降级）
    ...(isAppServerRpcError(err) && err.code !== undefined ? { rpcCode: err.code } : {}),
    // [P0-1 U4/D6] 瞬时失败形态标记（重试判定判据——timeout 形态走
    // timeoutAppServerAttempt，此处只承载 conn-closed）
    ...(opts.transient !== undefined ? { transient: opts.transient } : {}),
    // 错误规格表 -32004 行「按任务失败上报（含会话 id）」：create 成功后运行中失败
    // （-32004/-32010 等）时留痕会话 id——经 applyRunFailedOutcome 落 outcome.sessionId
    // 与 handle.sessionRef（create 阶段失败无会话，缺省不带）
    ...(currentSessionId !== undefined ? { sessionId: currentSessionId } : {}),
  };
}

/**
 * D3 abort 链的止损路径终局（P0-1 U2）：超时入口的 outcome 文案素材（D3 强制可观测
 * 面——r3 SG-4，A2/A11 验收断言「outcome 止损路径为 stop 已送达 / 升级杀链」的载体）；
 * settled-in-grace / escalated-kill 两值只由用户取消入口产生，超时入口不可达（保留
 * 联合完整供文案兜底）。
 */
type AbortChainStopPath =
  | "stop-acked"
  | "stop-rejected"
  | "stop-unreachable-killed"
  | "no-session"
  | "settled-in-grace"
  | "escalated-kill";

/**
 * [P0-1 U2] channel 判死（TurnTimeoutError）后的收口三态：engine_timeout 前缀
 * （D4——与 engine_run_failed 分流，下游按前缀分流不经字符串反推超时语义），走
 * run-failed kind 承载（exitCode=null 异常终态口径与杀链超时合成终态一致；无
 * rpcCode——超时不属漂移类，不参与降级）。sessionId 留痕同 failedAppServerAttempt。
 * [P0-1 U4/D6] timeout 类（idle/ceiling 都算）恒标 transient——D6 明文的可重试形态；
 * retried 时文案补「已自动重试一次」句（F-1）。
 */
function timeoutAppServerAttempt(
  err: TurnTimeoutError,
  currentSessionId: string | undefined,
  stopPath: AbortChainStopPath,
  opts: { retried?: boolean } = {},
): AttemptResult {
  return {
    kind: "run-failed",
    output: syntheticAppServerOutput(null),
    message: buildAppServerTimeoutMessage(err, currentSessionId, stopPath, opts.retried === true),
    transient: "timeout",
    ...(currentSessionId !== undefined ? { sessionId: currentSessionId } : {}),
  };
}

/** 止损路径的可观测文案（§5.2 F-1：stop 已送达 / stop 无应答已升级杀链两分支各具名）。 */
function stopPathText(stopPath: AbortChainStopPath): string {
  switch (stopPath) {
    case "stop-acked":
      return "session/stop 已送达（服务端接受停 turn）";
    case "stop-rejected":
      return "session/stop 报协议性 error（会话已被回收，控制面存活——止损由会话回收承担，不升级杀链）";
    case "stop-unreachable-killed":
      return `session/stop 无应答已升级杀链（SIGTERM→${ZCODE_KILL_GRACE_MS}ms→SIGKILL 收割共享进程）`;
    case "no-session":
      return "会话未建立（任务未开始执行，无在途消耗）";
    default:
      // settled-in-grace / escalated-kill 只属用户取消入口；超时入口不可达，防御兜底
      return "grace 窗口内终态落定或已走杀链";
  }
}

/**
 * 超时族 outcome 文案（D4 + §5.2 F-1/F-2，两形态有别）：idle 主判定静默时长 + 最后
 * 事件时刻（诊断面）；ceiling 总上界判死附 env 自救通道（XYZ_ZCODE_TURN_MAX_TIMEOUT_MS
 * 可调/0 关闭——§2 目标 5 的用户可见出口）。恢复指引共段：重跑 + 连通性排查 + engine: pi。
 * retried（[P0-1 U4] §5.2 F-1 样例句，u-z2 留的补句义务）：仅在瞬时重试真实发生后
 * 为 true——恢复指引补「瞬时故障已自动重试一次仍超时；重试在止损链终局后启动，无
 * 新旧任务双跑窗」句（未重试形态不含，与行为一致）。
 */
function buildAppServerTimeoutMessage(
  err: TurnTimeoutError,
  sessionId: string | undefined,
  stopPath: AbortChainStopPath,
  retried = false,
): string {
  const sid = sessionId !== undefined ? `（会话 ${sessionId}）` : "";
  const lastEventText =
    err.lastEventAt !== undefined
      ? `，最后事件 ${new Date(err.lastEventAt).toISOString()}`
      : "，整轮未观察到任何事件（进程假死/协议静默形态）";
  const head =
    err.kind === "idle"
      ? `engine_timeout: zcode turn 连续静默 ${err.thresholdMs}ms（idle 判定${lastEventText}，总耗时 ${err.elapsed}ms）${sid}。`
      : `engine_timeout: zcode turn 总上界 ${err.thresholdMs}ms 内未观察到终态（chatty-wedge 判定——事件流仍活跃而终态未到达，总耗时 ${err.elapsed}ms）${sid}。`;
  const selfHelp =
    err.kind === "ceiling"
      ? `若本任务属合法超长任务（预期超过 ${err.thresholdMs}ms），重跑前设 ${ZCODE_TURN_MAX_TIMEOUT_ENV} 为更大毫秒值或 0 关闭总上界（关闭后 chatty 形态不再自动回收，静默 wedged 仍由 idle 层兜底——自行权衡）。`
      : "";
  const rerunGuide = retried
    ? `👉 恢复指引：直接重跑本任务（瞬时故障已自动重试一次仍超时；重试在止损链终局后启动，无新旧任务双跑窗）；`
    : `👉 恢复指引：直接重跑本任务；`;
  return (
    `${head}止损路径：${stopPathText(stopPath)}。\n` +
    `${rerunGuide}${selfHelp}若持续出现，检查 ZCode 桌面端模型连通性或改用 engine: pi。`
  );
}

/** [R5] 末轮 attempt 的漂移类 RPC code 提取（-32601/-32602 → run 编排降级判据；其余 undefined）。 */
function driftCodeOf(final: AttemptResult): number | undefined {
  return final.kind === "run-failed" && final.rpcCode !== undefined && isDriftRpcCode(final.rpcCode)
    ? final.rpcCode
    : undefined;
}

/** 降级留痕（outcome.engineFallback 唯一通道；路由级 fallback 已存在时合并不覆盖）。 */
function applyDegradeFallback(outcome: AgentOutcome, degradedReason: string): void {
  const prior = outcome.engineFallback;
  outcome.engineFallback = {
    from: prior?.from ?? "zcode:appserver",
    reason: `${prior !== undefined ? `${prior.reason}；` : ""}degraded: spawn（${degradedReason}）`,
  };
}

/** prepare 期能力拒绝的载体（code 进 message 前缀，调用方可程序化分流）。
 *  [U10① D6] execution 运行时面错误族成员：export 供宿主 instanceof 分流（纯追加，零逻辑改动）。 */
export class ZcodeTaskShapeError extends Error {
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
