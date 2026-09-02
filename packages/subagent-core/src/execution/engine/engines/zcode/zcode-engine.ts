// src/execution/engine/engines/zcode/zcode-engine.ts
//
// ZcodeEngine（P3）：zcode CLI spawn 单轮模式的 EnginePort 实现。设计权威源：
// docs/architecture/subagent-engine-abstraction.md D10（MVP 引擎集 + zcode 首期只做
// spawn 单轮）、§3.3.4（reviewer@zcode 物理数据流）、§3.3.5（run 错误语义三条）。
//
// 职责编排（四件套的消费方）：
//   preparer（隔离 HOME 池 + 凭据 config）→ launcher（argv/env/spawn/杀链）
//   → parser（stdout 收集 + 终 JSON + coarse 事件合成）→ reader（read 第①级 sqlite）。
//
// run 错误语义（设计 §3.3.5）：
//   ① prepare 期错误（credential_missing / model_not_available / prompt_too_large /
//      capability 拒绝）在进程创建前 reject，不产生 handle；
//   ② 运行中失败不 reject——合成 engine_run_failed outcome + 正常 handle 返回
//      （record 必须收尾）；
//   ③ abort 走杀链（SIGTERM→grace→SIGKILL，interrupt: kill-only 无原生中断）后同 ②
//      （exitCode=null + error 含杀链标记）。
//
// schema 仿真接线（D4 emulated 侧）：common/schema-emulation.ts（并行任务 P2 交付，
// 2026-08-25 已就绪并接线）——spawn 前拼 prompt 仿真段、终态后三级容错提取 + ajv
// 校验、失败强化重试一次、仍失败报 schema_emulation_failed。read 第②级 journal 降级
// 已接线（P4 对齐点①：common/journal-replay 复用 live reducer）。

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
  ZCODE_CLI_DEFAULT_PATH,
  ZCODE_ENGINE_ID,
  ZCODE_ERROR_TAIL_CHARS,
  ZCODE_KILL_GRACE_MS,
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
  parseZcodeTerminal,
  synthesizeCoarseEvents,
  type ZcodeCollectedOutput,
  type ZcodeTerminalPayload,
} from "./parser.ts";
import { listZcodeModels, prepareZcodeHome, resolveZcodeModelRef, type ZcodeSourcePaths } from "./preparer.ts";
import { readZcodeSessionView } from "./reader.ts";

const logger = getLogger("subagents");

/** probe 的版本探测超时（ms）——二进制无响应按探针失败处理，不静默挂死。 */
const PROBE_VERSION_TIMEOUT_MS = 15_000;

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
  /** env 基底（测试注入；缺省 process.env）。 */
  processEnv?: NodeJS.ProcessEnv;
}

/** zcode 引擎适配器。 */
export class ZcodeEngine implements EnginePort {
  readonly id = ZCODE_ENGINE_ID;

  private readonly deps: ZcodeEngineDeps;
  private probeCache: ProbeReport | undefined;

  constructor(deps: ZcodeEngineDeps) {
    this.deps = deps;
  }

  /**
   * zcode 链路首期实际接通的能力（D3 链路口径）。声明升级（如 schema 仿真段接入
   * common 层后仍为 emulated；app-server 常驻化后 eventGranularity 升 stream）必须
   * 先改链路再改声明。
   */
  capabilities(): EngineCapabilities {
    return {
      // 无 --json-schema 类通道；公共 schema 仿真层（prompt 约定 + 容错提取 + ajv）
      schemaEnforcement: "emulated",
      // argv-only spawn，无运行中插话通道（app-server 属引擎内部优化，首期不接）
      steer: "unsupported",
      // 无同进程 idle 复用；--resume 是冷启动
      conversation: "unsupported",
      // 无 --append-system-prompt flag（实测拒收）——persona 只能拼进 prompt
      personaInjection: "prompt",
      // stdout 只有终态单 JSON（message_end/turn_end 合成）
      eventGranularity: "coarse",
      // 首期未接 worktree 隔离（公共层 worktree-manager 接入后升 emulated）
      sandbox: "none",
      // sqlite 三级 JOIN 完整重建 turns（reader 实测）
      sessionRead: "full",
      // --resume 冷启动可用（实测）
      resume: "cold",
      // 无原生中断——AbortSignal 走公共杀链（SIGTERM→grace→SIGKILL）
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

  /** D1 主语义：preparer → launcher → parser →（schema 仿真校验 + 一次重试）→ outcome/handle。 */
  async run(task: AgentTaskSpec, ctx: RunContext): Promise<EngineRunResult> {
    const startedAt = Date.now();
    this.rejectUnsupportedTaskShapes(task);

    // ① prepare 期：模型解析（provider 体系校验）+ 隔离 HOME 池引导（凭据 + model.main）
    const modelRef = resolveZcodeModelRef(task.model, this.deps.sources);
    const prepared = prepareZcodeHome({
      engineDataDir: this.deps.engineDataDir(),
      modelRef,
      // D8 池引用计数接线：taskId（chat 域 = record.id）经 RunContext 透传给 preparer
      // 作 refs.json 登记 key（与 journal 文件名同源）
      taskId: ctx.taskId,
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
    // 中止标记（非超时语义，不冒充超时）。?? 兜底是类型收窄（合成器恒写 error）
    outcome.error = isHostTimeoutAbort(ctx)
      ? synthesizeTimeoutOutcome(task, final.output.stdoutText, ZCODE_ENGINE_ID).error ??
        engineTimeoutDetail(final.output.stdoutText)
      : `engine_run_failed: zcode 任务被中止（杀链 SIGTERM→${ZCODE_KILL_GRACE_MS}ms→SIGKILL，宿主合成终态）。` +
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

/** attemptOnce 的三态产物（run 按序编排重试与终态合成）。 */
type AttemptResult =
  | { kind: "aborted"; output: ZcodeCollectedOutput }
  | { kind: "run-failed"; output: ZcodeCollectedOutput; message: string }
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
