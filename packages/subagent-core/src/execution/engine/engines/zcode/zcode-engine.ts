// src/execution/engine/engines/zcode/zcode-engine.ts
//
// ZcodeEngine：zcode 的 EnginePort 实现（2026-09 起单一 app-server 形态）。
// 设计权威源：docs/architecture/subagent-engine-abstraction.md D10 / §3.3.4 /
// §3.3.5；docs/design/zcode-engine-appserver-resident.md §3.3 D1（每引擎实例一条
// 连接）/ D3（abort 链）/ D4（会话自包含）/ D5（capabilities）/ D6（停机面）。
//
// 2026-09 breaking 重构（用户拍板，理由与代价见设计文档修订节）：
//   - **删除 CLI spawn 降级链**（原 XYZ_ZCODE_MODE=spawn 定向 / probe 冒烟门控 /
//     protocol-drift 首败降级）：zcode 无公开契约，协议漂移不再降级保底，直接报
//     可操作错误（提示核对版本 / 重启 / 改用 engine: pi）。
//   - **删除 HOME 池化，共享宿主 HOME**：spawn env 不覆写 HOME，app-server 共享
//     宿主 ~/.zcode/（会话 db 与 GUI 共写同一 SQLite，WAL 并发安全；凭据经
//     appserver-launcher fs 拦截注入——cli config 读取重定向为「真实文件 + v2
//     provider」合并，同 id 时 v2 优先，机制与漂移面见该文件头注；已接受代价：
//     GUI 会话列表可见 headless 会话、登录态轮换后常驻连接需引擎进程重启才用
//     新凭据）。HOME 依赖副作用（如 pnpm store 路径随 HOME 翻转）随之消失。
//   - journal 分组 key 固定 'shared'（与 pi 引擎 PI_POOL_KEY 同构）：journal 落
//     engineDataDir/engines/zcode/shared/journal-<taskId>.jsonl；handle.dbPath
//     为绝对路径（宿主 ~/.zcode/cli/db/db.sqlite）。
//
// run 错误语义（设计 §3.3.5）：
//   ① prepare 期错误（credential_missing / model_not_available / capability
//      拒绝）在进程创建前 reject，不产生 handle；
//   ② 运行中失败不 reject——合成 engine_run_failed outcome + 正常 handle 返回
//      （record 必须收尾）；
//   ③ abort：D3 链（session/stop → grace → killChain 连坐共享进程）——终态
//      exitCode=null + 杀链标记。
//
// schema 仿真接线（D4 emulated 侧）：common/schema-emulation.ts——prompt 拼仿真段、
// 终态后三级容错提取 + ajv 校验、失败强化重试一次、仍失败报 schema_emulation_failed。
// read 第②级 journal 降级已接线（common/journal-replay 复用 live reducer）。

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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
  ZCODE_APPSERVER_ERR_BUSY_SESSION,
  ZCODE_APPSERVER_ERR_MODEL_CONFIG_MISSING,
  ZCODE_APPSERVER_HARVEST_GRACE_MS,
  ZCODE_APPSERVER_STOP_TIMEOUT_MS,
  ZCODE_CLI_DEFAULT_PATH,
  ZCODE_ENGINE_ID,
  ZCODE_ERROR_TAIL_CHARS,
  ZCODE_HOST_DB_SUFFIX,
  ZCODE_KILL_GRACE_MS,
  ZCODE_SHARED_POOL_KEY,
} from "./constants.ts";
import {
  mapZcodeOutcomeUsage,
  mapZcodeUsage,
  synthesizeCoarseEvents,
  type ZcodeTerminalPayload,
} from "./parser.ts";
import {
  defaultV2ConfigPath,
  listZcodeModels,
  resolveZcodeModelRef,
  splitZcodeModelRef,
  type ZcodeSourcePaths,
} from "./preparer.ts";
import { ensureAppServerLauncher } from "./appserver-launcher.ts";
import { readZcodeSessionView } from "./reader.ts";
import { AppServerConnection, buildAppServerEnv, isAppServerRpcError } from "./connection.ts";
import { SessionChannel, type SessionCreateParams, type SessionTurnResult } from "./session-channel.ts";

const logger = getLogger("subagents");

/** probe 的版本探测超时（ms）——二进制无响应按探针失败处理，不静默挂死。 */
const PROBE_VERSION_TIMEOUT_MS = 15_000;

/**
 * [RX2-F1] 常见 thoughtLevel 档位（仅作提示基准，非权威值域）：pi 全 7 档
 * （off/minimal/low/medium/high/xhigh/max）恒等透传不拦截——core 引擎层不掌握各模型
 * 真实值域，禁止硬编码枚举做拒收或映射；不在此列的档位只触发一行提示（warnThoughtLevelUncommon）。
 */
const COMMON_THOUGHT_LEVELS: readonly string[] = ["low", "high", "max"];

/** 宿主 HOME 下 zcode 会话 db 的绝对路径（共享 HOME 形态的 read/handle 锚点）。 */
export function hostZcodeDbPath(): string {
  return path.join(os.homedir(), ...ZCODE_HOST_DB_SUFFIX);
}

/** ZcodeEngine 构造依赖（全部可注入——测试不依赖真机 CLI/真凭据）。 */
export interface ZcodeEngineDeps {
  /**
   * 引擎数据目录（journal 分组根 <dir>/engines/zcode/shared/ 与 stderr 日志落点）。
   * 来源通道（宿主 dataDir）见 registration.ts 缺省解析。
   */
  engineDataDir: () => string;
  /** zcode CLI 路径；缺省 ZCODE_CLI_DEFAULT_PATH。 */
  cliPath?: string;
  /** 源 config 路径覆盖（测试注入临时源；缺省读 ~/.zcode）。 */
  sources?: ZcodeSourcePaths;
  /** 版本探测执行器（probe check "version"；测试注入 fake 防真实子进程）。 */
  probeVersion?: (cliPath: string) => Promise<string | undefined>;
  /** env 基底（测试注入；缺省 process.env——app-server env 组装经它）。 */
  processEnv?: NodeJS.ProcessEnv;
}

/** 常驻运行时（每引擎实例一份；dispose 时整件丢弃）。 */
interface AppServerRuntime {
  conn: AppServerConnection;
  channel: SessionChannel;
  /** 在途会话登记（dispose 时 fire session/close 的目标集；settle 后移除）。 */
  activeSessions: Set<string>;
}

/** zcode 引擎适配器。 */
export class ZcodeEngine implements EnginePort {
  readonly id = ZCODE_ENGINE_ID;

  private readonly deps: ZcodeEngineDeps;
  private probeCache: ProbeReport | undefined;
  private appserverRuntime: AppServerRuntime | undefined;

  constructor(deps: ZcodeEngineDeps) {
    this.deps = deps;
  }

  /**
   * zcode 链路实际接通的能力（D3 链路口径。声明升级必须先改链路再改声明（C4 原则）。
   */
  capabilities(): EngineCapabilities {
    return {
      // 无 --json-schema 类通道；公共 schema 仿真层（prompt 约定 + 容错提取 + ajv）
      schemaEnforcement: "emulated",
      // send-while-running 恒 -32010 硬错误（旧实测）——app-server 常驻化不改变此判据
      steer: "unsupported",
      // 无同进程 idle 复用（D4：每任务自包含 create→run→close）
      conversation: "unsupported",
      // 无 --append-system-prompt flag（实测拒收）——persona 只能拼进 prompt
      personaInjection: "prompt",
      // app-server 推送流实时流出（session/event payload.delta → text_delta）
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

  /** 探针（D7）：二进制存在 + 版本解析（zcode 无公开契约，版本漂移的入口信号）。 */
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

  /** 探针失败的恢复指引（§3.3.3 终态四：版本确认命令 + 探针重跑 + 调研文档路径）。 */
  private probeFailureRecovery(cliPath: string): NonNullable<ProbeReport["error"]> {
    return {
      code: "engine_probe_failed",
      recovery:
        `Run \`node ${cliPath} --version\` 确认 zcode CLI 可用且版本未漂移，然后重跑探针（重新初始化引擎或 probe({force:true})）。` +
        `若 app-server 协议已漂移（RPC 错误），重启 ZCode 或固定 zcode 版本后重试。` +
        `参照 docs/research/agent-engine-zcode.md。`,
    };
  }

  /** D1 主语义：唯一通道 = app-server 常驻连接（spawn 降级链已删除）。 */
  async run(task: AgentTaskSpec, ctx: RunContext): Promise<EngineRunResult> {
    this.rejectUnsupportedTaskShapes(task);
    return this.runViaAppServer(task, ctx);
  }

  // ============================================================
  // app-server 常驻路径（D1/D3/D4）
  // ============================================================

  /**
   * 常驻路径主编排：模型解析（v2 单源校验）→ 惰性连接 + runTurn（事件时序前移：
   * text_delta 流式、终态后 message_end/turn_end）→ schema 仿真重试 → outcome/handle。
   * poolKey 固定 'shared'（共享宿主 HOME，无池），onPoolResolved 在 prepare 期、
   * onHandleReady 在 create 应答后（§3.4 不变量 3）。
   */
  private async runViaAppServer(task: AgentTaskSpec, ctx: RunContext): Promise<EngineRunResult> {
    const startedAt = Date.now();
    // pre-aborted 短路：取消先于启动——不创建会话、不触发连接惰性启动（防误杀共享
    // 进程殃及在途任务）
    if (ctx.signal?.aborted === true) {
      return this.abortedAppServerRun(task, ctx, startedAt);
    }

    // ① prepare 期：模型解析（provider 体系校验——错误语义为进程创建前 reject）
    const modelRef = resolveZcodeModelRef(task.model, this.deps.sources);
    this.warnIgnoredCtxModel(task, ctx, modelRef);
    // [RX2-F1] 非常见档位出声一行（不拦截透传）；放主编排而非 attemptAppServerTurn——
    // schema 重试轮会二次进 attempt，warn 只应随任务出声一次
    this.warnThoughtLevelUncommon(task, ctx);
    // 对齐点③（不变量 3）：poolKey 在 prepare 期声明，早于连接建立与首个事件
    ctx.onPoolResolved?.(ZCODE_SHARED_POOL_KEY);

    const cwd = task.cwd ?? process.cwd();
    const schema = isPlainObject(task.schema) ? task.schema : undefined;
    const basePrompt = this.buildPrompt(task, schema);

    // ② 首轮执行 + schema 仿真重试（重试语义与不变量注释见 runAppServerAttemptsWithRetry）
    const usageAcc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, has: false };
    const final = await this.runAppServerAttemptsWithRetry(task, ctx, modelRef, cwd, basePrompt, schema, usageAcc);

    const outcome = this.finalizeOutcome(task, ctx, final, usageAcc, startedAt);
    return { handle: this.appServerHandle(outcome), outcome };
  }

  /** pre-aborted 短路收口：合成中止 outcome + 'shared' 锚定 handle。 */
  private abortedAppServerRun(task: AgentTaskSpec, ctx: RunContext, startedAt: number): EngineRunResult {
    // 对齐点③（不变量 3）：onPoolResolved 必须先于首个事件 emit——本分支
    // finalizeOutcome 经 applyAbortedOutcome emit error 事件
    ctx.onPoolResolved?.(ZCODE_SHARED_POOL_KEY);
    const outcome = this.finalizeOutcome(
      task,
      ctx,
      abortedAppServerAttempt(ctx),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, has: false },
      startedAt,
    );
    return { handle: this.appServerHandle(outcome), outcome };
  }

  /**
   * 首轮执行 + schema 仿真重试编排：schema 任务校验失败时重试一次（强化 JSON 输出
   * 指令）。重试轮是独立会话的独立 LLM 调用：token 计入 outcome.usage 总量；事件面
   * text_delta 按实际流出（含失败轮——journal 记录真实流水），message_end/turn_end
   * 只在最终轮终态后合成（不变量 2/5）。
   */
  private async runAppServerAttemptsWithRetry(
    task: AgentTaskSpec,
    ctx: RunContext,
    modelRef: string,
    cwd: string,
    basePrompt: string,
    schema: object | undefined,
    usageAcc: { input: number; output: number; cacheRead: number; cacheWrite: number; has: boolean },
  ): Promise<AttemptResult> {
    let final = await this.attemptAppServerTurn(task, ctx, modelRef, cwd, basePrompt);
    accumulateUsage(usageAcc, final);
    if (final.kind === "parsed" && final.schemaResult !== undefined && !final.schemaResult.ok && schema !== undefined) {
      const retryPrompt = appendSchemaRetryDirective(basePrompt, final.schemaResult.error);
      const retry = await this.attemptAppServerTurn(task, ctx, modelRef, cwd, retryPrompt);
      accumulateUsage(usageAcc, retry);
      final = retry;
    }
    return final;
  }

  /** 常驻路径的 handle 合成（poolKey 固定 'shared'；dbPath = 宿主 HOME 绝对路径）。 */
  private appServerHandle(outcome: AgentOutcome): EngineHandle {
    return {
      data: {
        v: 1,
        engineId: ZCODE_ENGINE_ID,
        sessionRef: {
          dbPath: hostZcodeDbPath(),
          ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
        },
        poolKey: ZCODE_SHARED_POOL_KEY,
        ...(this.probeCache?.engineVersion !== undefined && this.probeCache.engineVersion !== ""
          ? { engineVersion: this.probeCache.engineVersion }
          : {}),
        adapterVersion: ZCODE_ADAPTER_VERSION,
      },
    };
  }

  /**
   * 单轮常驻执行：runTurn 组合面 + D3 abort 链 + 事件前移（text_delta 实时流出；
   * 终态数据经 read 兜底收口后才 resolve——不变量 1/2）。
   */
  private async attemptAppServerTurn(
    task: AgentTaskSpec,
    ctx: RunContext,
    modelRef: string,
    cwd: string,
    prompt: string,
  ): Promise<AttemptResult> {
    const rt = this.ensureAppServerRuntime();
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
          sessionRef: { dbPath: hostZcodeDbPath(), sessionId },
          poolKey: ZCODE_SHARED_POOL_KEY,
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
      // 终态迁移由编排层 CAS 决定）
      if (ctx.signal?.aborted === true) return abortedAppServerAttempt(ctx);
      return parsedAppServerAttempt(task, r);
    } catch (err) {
      if (ctx.signal?.aborted === true) return abortedAppServerAttempt(ctx);
      return failedAppServerAttempt(err, currentSessionId);
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

  // ── 常驻运行时管理（D1/D6）──────────────────────

  /**
   * 惰性获取常驻运行时（D1：每引擎实例一条连接，全任务共享；连接自身的崩溃重建在
   * connection 层内部完成——同一条代码路径，§3.4 不变量 4）。常驻进程不进宿主
   * spawnedChildren、不调 onChildSpawned（D6——生命周期归 dispose）。进程级 --cwd
   * 用引擎数据目录（连接跨任务共享的中性位置，工作区由 create 的
   * workspace.workspacePath 按任务传递——D10 基线不预设任务级进程 cwd）。
   * spawn 经 fs 拦截 wrapper（appserver-launcher：cli config 读取重定向为
   * 「真实文件 + v2 provider 注入」——CLI 形态 app-server 在共享宿主 HOME 下的
   * 唯一凭据供数通路，机制与漂移面见该文件头注）。
   */
  private ensureAppServerRuntime(): AppServerRuntime {
    if (this.appserverRuntime !== undefined) return this.appserverRuntime;
    const cliPath = this.deps.cliPath ?? ZCODE_CLI_DEFAULT_PATH;
    const engineDataDir = this.deps.engineDataDir();
    const launcherScript = ensureAppServerLauncher(engineDataDir);
    const env = buildAppServerEnv(this.deps.processEnv ?? process.env);
    env.ZCODE_ENG_CLI_PATH = cliPath;
    env.ZCODE_ENG_V2_CONFIG = this.deps.sources?.v2ConfigPath ?? defaultV2ConfigPath();
    const conn = new AppServerConnection({
      cliPath,
      cwd: engineDataDir,
      env,
      launcherScript,
      stderrLogPath: path.join(engineDataDir, "logs", "zcode-appserver-stderr.log"),
    });
    const rt: AppServerRuntime = {
      conn,
      channel: new SessionChannel(conn),
      activeSessions: new Set<string>(),
    };
    this.appserverRuntime = rt;
    return rt;
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
   * [R1 D6 主体] 引擎停机面：①fire 全部在途会话的 session/close 帧（不等待
   * 应答——D6① 顺序规定：close 帧必须先于 SIGTERM，否则对面来不及处理即被杀）→
   * ②同步 SIGTERM（conn.shutdown 调用内 killChain 前缀同步执行——同步面在返回
   * Promise 前完成）→ ③grace → SIGKILL（异步面，Promise resolve 于进程退出）。
   * 幂等：运行时字段取走即置空，二次调用零副作用；dispose 后首个 run 经
   * ensureAppServerRuntime 自动重建（与崩溃重建同一代码路径，不变量 4）。
   */
  async dispose(): Promise<void> {
    const rt = this.appserverRuntime;
    if (rt === undefined) return;
    this.appserverRuntime = undefined;
    // ①fire 全部在途会话的 session/close 帧（不等待应答——D6① 顺序规定：close 帧
    // 必须先于 SIGTERM，否则对面来不及处理即被杀）。进程已死（child=null，如崩溃
    // 收割与 activeSessions 清理之间的微拍）则整体跳过：post 会经 ensureStarted 惰性
    // 拉起新进程再被同次 dispose 杀掉——无意义的 spawn+kill 循环（D6 dispose=防泄漏
    // 语义不制造新进程）。同步循环内 alive 不会中途翻转（进程退出是异步事件，本轮
    // 循环不可重入）
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
    // （common/kill-chain.synthesizeTimeoutOutcome——engine_timeout 文案 SSOT + 「可用
    // engine: pi 重跑」建议）；用户主动 cancel 维持 engine_run_failed 中止标记（非超时
    // 语义，不冒充超时）。?? 兜底是类型收窄（合成器恒写 error）。
    outcome.error = isHostTimeoutAbort(ctx)
      ? synthesizeTimeoutOutcome(task, final.output.stdoutText, ZCODE_ENGINE_ID).error ??
        engineTimeoutDetail(final.output.stdoutText)
      : final.abortMessage ??
        `engine_run_failed: zcode 任务被中止（app-server abort 链收口，宿主合成终态）。` +
          `输出尾部: ${final.output.stdoutText.slice(-ZCODE_ERROR_TAIL_CHARS)}`;
    emit({ type: "error", message: outcome.error });
  }

  /**
   * run-failed 合成终态：错误信息由 buildAppServerRunFailedMessage 产出（已含恢复
   * 指引）直接透传；附带的会话 id 落 outcome.sessionId（错误规格表 -32004 行「含会话
   * id」——appServerHandle 据此写 handle.sessionRef，run-failed 不再恒缺）。
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
   * D1 可选面：zcode 首期不支持 conversation（capabilities 声明）——同步拒绝、
   * 不创建进程，文案给可操作建议（A11）。
   */
  async interact(_handle: EngineHandle, _action: InteractAction): Promise<InteractResult> {
    return {
      ok: false,
      code: "engine_capability_unsupported",
      message:
        "zcode 引擎不支持 conversation 交互控制面（capabilities.conversation = 'unsupported'，" +
        "每任务自包含会话，无同进程 idle 复用）。恢复指引：改用单次 subagent 调用重新派发任务，" +
        "或使用 engine: 'pi'（chatMode idle 复用，支持 message/close/cancel）。",
    };
  }

  /** [U7] 模型可发现性：v2 桌面登录态聚合（带凭据 provider × models），失败安全返回清单本身可能为空。 */
  listModels(): Array<{ id: string; name?: string }> {
    return listZcodeModels(this.deps.sources);
  }

  /**
   * D6 read 三级降级：①sqlite 原生读取 → ②宿主 event journal 重放（对齐点①接线：
   * replayJournalToSessionView 复用 live reducer，重放等价性见 §3.3.6）→ ③outcome-only。
   * sessionId 缺失（解析失败的 run 无法定位 session）跳过①级；②级依赖
   * handle.journalPath（宿主 run 后回填）。dbPath：新 handle 恒绝对路径（宿主
   * ~/.zcode/cli/db/db.sqlite，tier1 精确匹配白名单见方法体）；旧 records（池时代）
   * 的相对路径仍按 poolKey 锚定解析（read 兼容旧数据，池目录不存在时自然落②级
   * journal 降级）。
   */
  async read(handle: EngineHandle): Promise<SessionView> {
    if (handle.data.engineId !== ZCODE_ENGINE_ID) {
      return { engineId: ZCODE_ENGINE_ID, turns: [], source: "outcome-only" };
    }
    const sessionId = handle.data.sessionRef["sessionId"];
    const dbPathRaw = handle.data.sessionRef["dbPath"];
    if (typeof sessionId === "string" && typeof dbPathRaw === "string") {
      // 绝对路径 tier1 白名单（与 runtime subagent-engine-history 同判）：handle/
      // record 来自 append-only JSONL（不可信面），仅放行宿主真实 db 的精确匹配，
      // 其余绝对路径拒绝 ①级 sqlite 读取、降 journal 重放——防任意文件读
      let dbPath: string | undefined;
      if (path.isAbsolute(dbPathRaw)) {
        if (dbPathRaw === hostZcodeDbPath()) dbPath = dbPathRaw;
        else {
          logger.warn("[zcode-engine] record dbPath 非宿主 db 绝对路径，拒绝 ①级读取降 journal", {
            dbPath: dbPathRaw,
          });
        }
      } else {
        dbPath = path.join(
          resolvePoolDir(this.deps.engineDataDir(), ZCODE_ENGINE_ID, handle.data.poolKey),
          dbPathRaw,
        );
      }
      if (dbPath !== undefined) {
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
   * 专属（turn limiter 依赖 pi 的 turn_end 事件流）——zcode 无 turn_end 语义，
   * 静默丢弃会造成「传了上限却失控」的假象，显式拒绝（U4，同 fork 模式）。
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
        "zcode 引擎不支持 conversation 模式（每任务自包含会话，无同进程 idle 复用）。" +
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
   * 均不出声（避免噪音）。
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
   * （agentRef/skillPath 引用行 + appendSystemPrompt 正文统一拼装，S5 接线），
   * task 正文居中，schema 仿真段尾置（common/schema-emulation 公共层产出）。
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

/** app-server 路径的合成 output 形态（stdoutText 恒空——失败素材在 message 内）。 */
interface AttemptOutput {
  exitCode: number | null;
  stdoutText: string;
  stderrTail: string;
}

/**
 * attempt 的三态产物（run 按序编排重试与终态合成）。
 */
type AttemptResult =
  | { kind: "aborted"; output: AttemptOutput; abortMessage?: string }
  | {
      kind: "run-failed";
      output: AttemptOutput;
      message: string;
      /** appserver 路径失败时已建立的会话 id（错误规格表 -32004 行：按任务失败上报含会话 id）。 */
      sessionId?: string;
    }
  | {
      kind: "parsed";
      output: AttemptOutput;
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

/** ms 后 resolve 指定值（abort 链 grace 窗口的 race 材料；unref 不阻塞进程退出）。 */
function delayResolved<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(value), ms);
    if (typeof t.unref === "function") t.unref();
  });
}

/** appserver 路径的合成 output（无 stdout 可收集——exitCode 语义：0=正常轮；null=中止/连接级失败）。 */
function syntheticAppServerOutput(exitCode: number | null): AttemptOutput {
  return { exitCode, stdoutText: "", stderrTail: "" };
}

/** appserver 路径的 aborted 三态（abortMessage 描述 D3 链形态）。 */
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

/** runTurn 终态 → 载荷形态（usage 映射：parser.mapZcodeUsage 一族）。 */
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
 * missing" → engine_credential_missing（共享宿主 HOME——凭据在 ZCode 桌面端管理）；
 * -32010 → 单会话一任务是结构保证（busy 不排队不打断），文案引导附带 sessionId/state
 * 流水报告；其余（连接崩溃/会话失败/协议漂移）→ engine_run_failed + 恢复指引
 * （漂移不再降级 spawn——直接报错）。sessionId 已建立时随文案透出。
 */
function buildAppServerRunFailedMessage(err: unknown, sessionId?: string): string {
  if (
    isAppServerRpcError(err) &&
    err.code === ZCODE_APPSERVER_ERR_MODEL_CONFIG_MISSING &&
    /Model config is missing/.test(err.message)
  ) {
    return (
      `engine_credential_missing: app-server 报 "Model config is missing"（宿主 HOME 的 zcode 配置无可用模型）。` +
      `恢复指引：在 ZCode 桌面端登录并配置 provider 凭据后重跑本任务（常驻连接在引擎进程重启后生效新凭据）。`
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
  return (
    `engine_run_failed: app-server 会话执行失败${code}${sid}: ${errMessage(err).slice(-ZCODE_ERROR_TAIL_CHARS)}。` +
    `恢复指引：直接重跑本任务（连接崩溃后自动重建进程）；若持续失败（疑似 zcode 升级后协议漂移——` +
    `-32601/-32602 类错误），重启 ZCode 或固定 zcode 版本后重试，或改用 engine: pi。`
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

/** appserver 轮成功收口的 parsed 三态（read 兜底后的 response + schema 校验）。 */
function parsedAppServerAttempt(task: AgentTaskSpec, r: SessionTurnResult): AttemptResult {
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

/** appserver 轮失败收口的 run-failed 三态（结构化文案 + 会话 id 留痕）。 */
function failedAppServerAttempt(err: unknown, currentSessionId: string | undefined): AttemptResult {
  return {
    kind: "run-failed",
    output: syntheticAppServerOutput(null),
    message: buildAppServerRunFailedMessage(err, currentSessionId),
    // 错误规格表 -32004 行「按任务失败上报（含会话 id）」：create 成功后运行中失败
    // （-32004/-32010 等）时留痕会话 id——经 applyRunFailedOutcome 落 outcome.sessionId
    // 与 handle.sessionRef（create 阶段失败无会话，缺省不带）
    ...(currentSessionId !== undefined ? { sessionId: currentSessionId } : {}),
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
