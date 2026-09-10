// src/execution/__tests__/subprocess-agent-runner-no-progress-watchdog.test.ts
//
// [M3 决策 9] workflow 域 no-progress 守护补挂的验收测试（设计 §4 V5①）：
//   - arm 落点：SAR.run try 块内、engine.run 派发前（run 期间 armed，收敛后 disarm）
//   - fire 链：fake timers 推进到 30min 窗口 → watchdog controller.abort → 并入
//     mergedSignal 的 ctx.signal abort → 引擎合成 aborted outcome → SAR error result
//     （含恢复指引）→ agent() 收敛（promise 返回而非永挂）
//   - 刷新源两路（缺一不可）：journal.onEvent 包装 ∪ stream.onDelta 包装——持续产出
//     跨窗长也不 fire（接线缺陷须能被本组用例暴露）
//   - journal close（finally 必达）+ 重试面保留（executeAgentCall 照常退避重试，
//     每次重试 per-call 新 taskId = 重新 arm）
//
// K6 修订（M6，替代本节原「不可缩短 → V5② 降级」结论）：env 路线仍关闭——中段阈值是
// 原语内纯常量 SETTLED_MID_ROUND_NO_PROGRESS_MS（settled-watchdog.ts:32「中段阈值 v1
// 不开 env」+ :88 常量定义），env XYZ_SUBAGENT_SETTLED_WATCHDOG_MS 只覆盖收尾段（>0）
// 或两段全关（≤0）；测试 seam 由 _setMidRoundNoProgressWindowMsForTest 打通
// （settled-watchdog.ts:110，生产恒 30min）→ V5②（真跑秒级窗全链）见姊妹文件
// subprocess-agent-runner-no-progress-full-chain.test.ts。本文件继续用 fake timers 走
// 完整 fire 链（V5①），V5c 在独立文件用真引擎进程验证 killAll 组杀邻接。
//
// 测试红线：vitest + fake timers；写删目标全部 mkdtempSync 自建自删（不碰真实数据目录）。

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureCore, resetCoreForTests, type HostServices } from "../../core/host-services.ts";
import { executeAgentCall } from "../../orchestration/execute-agent-call.ts";
import { AgentCall } from "../../orchestration/models/agent-call.ts";
import { Budget } from "../../orchestration/models/budget.ts";
import { Trace } from "../../orchestration/models/trace.ts";
import type { AgentCallOpts, AgentResult, ExecutionTraceNode } from "../../orchestration/models/types.ts";
import { replayJournal } from "../engine/common/event-journal.ts";
import { clearEngines, registerEngine } from "../engine/registry.ts";
import type { EnginePort, EngineRunResult, RunContext } from "../engine/port.ts";
import type { EngineCapabilities, ProbeReport } from "../engine/types.ts";
import { SubprocessAgentRunner, type SubprocessAgentRunnerDeps } from "../subprocess-agent-runner.ts";
import {
  _resetSettledWatchdogsForTest,
  getSettledWatchdogPhase,
  hasSettledWatchdog,
  SETTLED_MID_ROUND_NO_PROGRESS_MS,
  SETTLED_WATCHDOG_ENV,
} from "../settled-watchdog.ts";
import { SubagentStream } from "../stream-sink.ts";
import type { SubagentService } from "../subagent-service.ts";

// ── 测试辅助 ──

const CAPABILITIES: EngineCapabilities = {
  schemaEnforcement: "native",
  steer: "unsupported",
  conversation: "native",
  personaInjection: "flag",
  eventGranularity: "stream",
  sandbox: "emulated",
  sessionRead: "full",
  resume: "native",
  interrupt: "kill-only",
  permissionMode: "native",
  maxTurns: true,
};

const FAKE_HANDLE_DATA = {
  v: 1 as const,
  engineId: "pi",
  sessionRef: {},
  poolKey: "shared",
  adapterVersion: "fake-sar",
};

function successRunResult(content = "OK"): EngineRunResult {
  return {
    handle: { data: { ...FAKE_HANDLE_DATA } },
    outcome: { content, durationMs: 1, engineId: "pi", exitCode: 0 },
  };
}

/** 复刻 RemoteEngine 对 abort 的处置：不 reject，合成 aborted error outcome。 */
function abortedRunResult(): EngineRunResult {
  return {
    handle: { data: { ...FAKE_HANDLE_DATA } },
    outcome: {
      content: "",
      error: "engine_run_failed: run run-x aborted before terminal answer",
      exitCode: null,
      engineId: "pi",
    },
  };
}

function makeBaseOpts(): AgentCallOpts {
  return { prompt: "test task", agent: "worker", cwd: "/some/path" };
}

type RunImpl = (task: AgentCallOpts, ctx: RunContext) => Promise<EngineRunResult>;

/**
 * 装配「注册 pi 引擎替身 + mock SubagentService」的 SAR harness——run 实现由用例注入
 *（捕获 RunContext / 挂 abort 监听 / 立即返回失败等）。
 */
function makeHarness(runImpl: RunImpl): { sar: SubprocessAgentRunner; runSpy: ReturnType<typeof vi.fn> } {
  const runSpy = vi.fn(runImpl);
  const port: EnginePort = {
    id: "pi",
    capabilities: () => CAPABILITIES,
    probe: async (): Promise<ProbeReport> => ({ ok: true, engineVersion: "fake", checks: [] }),
    run: runSpy,
    interact: async () => ({ ok: false, code: "engine_interact_failed", message: "not supported in this test" }),
    read: async () => ({ engineId: "pi", turns: [], source: "outcome-only" }),
  };
  clearEngines();
  registerEngine("pi", () => port);
  // partial mock：SAR 构造器只经 asEngineService 取引擎服务面（已注册 pi 时不被消费）。
  const partial: { asEngineService?: unknown } = {};
  const service = partial as unknown as SubagentService;
  partial.asEngineService = service;
  const deps: SubprocessAgentRunnerDeps = { subagentService: service };
  return { sar: new SubprocessAgentRunner(deps), runSpy };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeAgentCallAndTrace(): { call: AgentCall; trace: Trace } {
  const trace = new Trace();
  const traceNode: ExecutionTraceNode = {
    stepIndex: 0,
    agent: "test-agent",
    task: "test task",
    model: "default",
    status: "pending",
  };
  trace.append(traceNode);
  return { call: new AgentCall(0, makeBaseOpts(), traceNode), trace };
}

/** RunContext.signal 是可选字段；SAR 必然传入合并 signal——缺失即测试装配错误。 */
function runSignalOf(ctx: RunContext): AbortSignal {
  if (ctx.signal === undefined) throw new Error("RunContext.signal missing in test harness");
  return ctx.signal;
}

// ── 用例 ──

describe("M3 workflow 域 no-progress 守护（SAR.run 落点）", () => {
  let dataDir = "";
  const logs: Array<{ level: string; component: string; message: string }> = [];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "sar-no-progress-"));
    logs.length = 0;
    _resetSettledWatchdogsForTest();
    // 宿主 shell export 隔离：中段守护的开关 env 必须处于「未设」基线（空串 = 未设）。
    vi.stubEnv(SETTLED_WATCHDOG_ENV, "");
    const host: HostServices = {
      dataRoot: () => dataDir,
      log: (level, component, message) => {
        logs.push({ level, component, message });
      },
    };
    configureCore(host);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    _resetSettledWatchdogsForTest();
    resetCoreForTests();
    clearEngines();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  // ── arm 落点 + disarm ──

  it("V5①-a run 期间 armed（mid-round）+ merged signal 不等于外部 signal；收敛后 disarm", async () => {
    const gate = deferred<EngineRunResult>();
    let captured: RunContext | undefined;
    const { sar } = makeHarness((_task, ctx) => {
      captured = ctx;
      return gate.promise;
    });

    const external = new AbortController();
    const runPromise = sar.run(makeBaseOpts(), external.signal);
    await Promise.resolve();

    expect(captured).toBeDefined();
    const taskId = captured!.taskId;
    expect(taskId.startsWith("sa-")).toBe(true);
    expect(hasSettledWatchdog(taskId)).toBe(true);
    expect(getSettledWatchdogPhase(taskId)).toBe("mid-round");
    // 合流后 signal 是新对象（守护 abort 源已并入）——外部 signal 未被直接交给引擎
    expect(runSignalOf(captured!)).not.toBe(external.signal);
    expect(runSignalOf(captured!).aborted).toBe(false);

    gate.resolve(successRunResult("hello"));
    const result = await runPromise;

    expect(result.content).toBe("hello");
    expect(result.error).toBeUndefined();
    expect(hasSettledWatchdog(taskId)).toBe(false);
  });

  // ── fire 链（fake timers 推进到窗口）──

  it("V5①-b 静默推进 30min → fire（abort 触发）→ 引擎收敛 → error result 含恢复指引；warn 留痕", async () => {
    vi.useFakeTimers();
    let captured: RunContext | undefined;
    const { sar } = makeHarness(
      (_task, ctx) =>
        new Promise<EngineRunResult>((resolve) => {
          captured = ctx;
          // 复刻 RemoteEngine wireAbortSignal：abort → cancel 帧 → （本替身）合成 aborted outcome
          runSignalOf(ctx).addEventListener("abort", () => resolve(abortedRunResult()), { once: true });
        }),
    );

    const external = new AbortController();
    const runPromise = sar.run(makeBaseOpts(), external.signal);
    await Promise.resolve();

    const taskId = captured!.taskId;
    expect(runSignalOf(captured!).aborted).toBe(false);

    // 推进到窗口（差 1ms 不 fire，再补 1ms 到窗口）
    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS - 1);
    expect(runSignalOf(captured!).aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    // fire：watchdog abort 并入 mergedSignal → 引擎侧 abort 观察点被触发
    expect(runSignalOf(captured!).aborted).toBe(true);

    const result = await runPromise;
    expect(result.error).toContain("aborted before terminal answer");
    expect(result.error).toContain("workflow no-progress watchdog fired");
    expect(result.error).toContain("re-dispatch the workflow");
    // 收敛后 disarm
    expect(hasSettledWatchdog(taskId)).toBe(false);
    // fire warn 留痕（含 killAll 连带面提示）
    const warn = logs.find((l) => l.level === "warn" && l.message.includes("workflow no-progress watchdog"));
    expect(warn).toBeDefined();
    expect(warn!.message).toContain("killAll");
    expect(warn!.component).toBe("subagents");
  });

  // ── 刷新源①：journal.onEvent 包装 ──

  it("V5①-c 刷新源①（journal.onEvent）：持续有效事件跨 2 倍窗长不 fire", async () => {
    vi.useFakeTimers();
    const gate = deferred<EngineRunResult>();
    let captured: RunContext | undefined;
    const { sar } = makeHarness((_task, ctx) => {
      captured = ctx;
      return gate.promise;
    });

    const runPromise = sar.run(makeBaseOpts(), new AbortController().signal);
    await Promise.resolve();
    const taskId = captured!.taskId;

    const half = Math.floor(SETTLED_MID_ROUND_NO_PROGRESS_MS / 2);
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(half);
      captured!.onEvent?.({ type: "turn_end" });
      expect(runSignalOf(captured!).aborted).toBe(false);
    }
    // 总推进 2 倍窗长——靠事件刷新存活（刷新源接线缺陷会让此处 fire）
    expect(hasSettledWatchdog(taskId)).toBe(true);
    expect(getSettledWatchdogPhase(taskId)).toBe("mid-round");

    gate.resolve(successRunResult());
    const result = await runPromise;
    expect(result.error).toBeUndefined();
    expect(hasSettledWatchdog(taskId)).toBe(false);
  });

  // ── 刷新源②：stream.onDelta 包装 ──

  it("V5①-d 刷新源②（stream.onDelta）：持续 delta 跨 2 倍窗长不 fire；原 stream identity 与委托保持不变", async () => {
    vi.useFakeTimers();
    const gate = deferred<EngineRunResult>();
    let captured: RunContext | undefined;
    const { sar } = makeHarness((_task, ctx) => {
      captured = ctx;
      return gate.promise;
    });

    const onDelta = vi.fn();
    const fakeStream = { onDelta, dispose: vi.fn() };
    const runPromise = sar.run(
      makeBaseOpts(),
      new AbortController().signal,
      undefined,
      fakeStream as unknown as SubagentStream,
    );
    await Promise.resolve();
    const taskId = captured!.taskId;

    // identity 保持（既有契约：SAR 透传同一 stream 实例）
    expect(captured!.stream).toBe(fakeStream);

    const half = Math.floor(SETTLED_MID_ROUND_NO_PROGRESS_MS / 2);
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(half);
      captured!.stream!.onDelta("x");
      expect(runSignalOf(captured!).aborted).toBe(false);
    }
    expect(hasSettledWatchdog(taskId)).toBe(true);
    // 委托原实现照常（包装不吞 delta）
    expect(onDelta).toHaveBeenCalledTimes(4);

    gate.resolve(successRunResult());
    await runPromise;
    expect(hasSettledWatchdog(taskId)).toBe(false);
  });

  // ── U-B1：生产形态（SubagentStream 类实例 = onDelta 在原型上）的还原分支 ──
  //
  // 既有两处 stream 用例（本文件 V5①-d 与 subprocess-agent-runner.test.ts「U1 stream
  // 透传」）都用**对象字面量**造 stream（onDelta 是自有属性）→ 只覆盖 bind 还原的
  // hadOwnOnDelta === true 分支。生产形态是 SubagentStream 类实例（原型方法）→ 实际走
  // Reflect.deleteProperty 分支，此前零覆盖（偏差登记的「无残留覆写」缺证据）。

  it("U-B1 生产形态 stream（类实例，onDelta 在原型上）→ 还原走 deleteProperty 分支：无残留自有属性且原型实现仍可达", async () => {
    vi.useFakeTimers();
    const gate = deferred<EngineRunResult>();
    let captured: RunContext | undefined;
    const { sar } = makeHarness((_task, ctx) => {
      captured = ctx;
      return gate.promise;
    });

    const sink = { setWidget: vi.fn() };
    const stream = new SubagentStream("rec-u-b1", sink);
    // 前置事实：类实例的 onDelta 在原型上（生产形态与对象字面量用例的分野）。
    expect(Object.prototype.hasOwnProperty.call(stream, "onDelta")).toBe(false);
    expect(stream.onDelta).toBe(SubagentStream.prototype.onDelta);

    const runPromise = sar.run(makeBaseOpts(), new AbortController().signal, undefined, stream);
    await Promise.resolve();
    const taskId = captured!.taskId;

    // 运行中：包裹生效（自有属性），且刷新接线真的有效——delta 跨半窗不 fire。
    expect(Object.prototype.hasOwnProperty.call(stream, "onDelta")).toBe(true);
    expect(stream.onDelta).not.toBe(SubagentStream.prototype.onDelta);
    await vi.advanceTimersByTimeAsync(Math.floor(SETTLED_MID_ROUND_NO_PROGRESS_MS / 2) + 1);
    stream.onDelta("x");
    expect(runSignalOf(captured!).aborted).toBe(false);
    expect(sink.setWidget).toHaveBeenCalledTimes(1); // leading edge 立即 flush = 原型实现被委托

    gate.resolve(successRunResult());
    await runPromise;

    // 还原：deleteProperty 分支（不是回写自有属性）——hasOwnProperty 回归 false。
    expect(Object.prototype.hasOwnProperty.call(stream, "onDelta")).toBe(false);
    expect(stream.onDelta).toBe(SubagentStream.prototype.onDelta);

    // 直调仍达原型实现：trailing edge 走 timer 合并，推进后 sink 再收一次。
    stream.onDelta("y");
    await vi.advanceTimersByTimeAsync(200);
    expect(sink.setWidget).toHaveBeenCalledTimes(2);
    expect(sink.setWidget).toHaveBeenLastCalledWith("subagent-stream-rec-u-b1", ["xy"]);
    expect(hasSettledWatchdog(taskId)).toBe(false);
  });

  it("V5①-e stream 未传时不 arm 失败（onEvent 一路即可覆盖）", async () => {
    vi.useFakeTimers();
    const gate = deferred<EngineRunResult>();
    let captured: RunContext | undefined;
    const { sar } = makeHarness((_task, ctx) => {
      captured = ctx;
      return gate.promise;
    });
    const runPromise = sar.run(makeBaseOpts(), new AbortController().signal);
    await Promise.resolve();
    expect(captured!.stream).toBeUndefined();
    gate.resolve(successRunResult());
    await runPromise;
    expect(hasSettledWatchdog(captured!.taskId)).toBe(false);
  });

  // ── journal close（finally 必达）──

  it("V5①-f fire 收敛后 journal 仍完成 flush/close（事件可重放）", async () => {
    vi.useFakeTimers();
    let captured: RunContext | undefined;
    const { sar } = makeHarness(
      (_task, ctx) =>
        new Promise<EngineRunResult>((resolve) => {
          captured = ctx;
          runSignalOf(ctx).addEventListener("abort", () => resolve(abortedRunResult()), { once: true });
        }),
    );

    const runPromise = sar.run(makeBaseOpts(), new AbortController().signal);
    await Promise.resolve();
    captured!.onEvent?.({ type: "turn_end" });
    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS);
    const result = await runPromise;
    expect(result.error).toBeDefined();

    // run 终态 finally 已 close → 落盘文件可重放（未 close 会缺文件/内容）
    const journalDir = join(dataDir, "engines", "pi", "shared");
    const files = readdirSync(journalDir).filter((f) => f.startsWith("journal-") && f.endsWith(".jsonl"));
    expect(files.length).toBe(1);
    expect(replayJournal(join(journalDir, files[0] ?? ""))).toEqual([{ type: "turn_end" }]);
  });

  // ── U-B2：catch 路径恢复指引（纵深防御；单一出口）──

  it("U-B2 fire 后 catch 路径同样追注恢复指引（单一出口：backfillHandle 抛错强制走 catch）", async () => {
    vi.useFakeTimers();
    let captured: RunContext | undefined;
    const { sar } = makeHarness(
      (_task, ctx) =>
        new Promise<EngineRunResult>((resolve) => {
          captured = ctx;
          // fire 的 abort 到达后返回**缺 handle** 的结果 → SAR 紧接着的
          // journal.backfillHandle(handle) 抛 TypeError → 走 catch 分支。这是 fire 后
          // try 块内「非 engine.run 抛点」的真实形态（U-B2 纵深防御的靶子；审查已论证
          // engine.run 自身在该形态下必走 RemoteEngine 合成 outcome 而非 throw）。
          runSignalOf(ctx).addEventListener(
            "abort",
            () =>
              resolve({
                handle: undefined as unknown as EngineRunResult["handle"],
                outcome: {
                  content: "",
                  error: "engine_run_failed: run aborted (test shape)",
                  exitCode: null,
                  engineId: "pi",
                },
              }),
            { once: true },
          );
        }),
    );

    const runPromise = sar.run(makeBaseOpts(), new AbortController().signal);
    await Promise.resolve();
    const taskId = captured!.taskId;
    expect(hasSettledWatchdog(taskId)).toBe(true);

    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS);
    const result = await runPromise;

    expect(result.error).toBeDefined();
    // catch 路径的失败同样带恢复指引（修复前该路径是无指引的裸 error——单一出口消除分叉）。
    expect(result.error).toContain("workflow no-progress watchdog fired");
    expect(result.error).toContain("re-dispatch the workflow");
    // 收敛后 disarm
    expect(hasSettledWatchdog(taskId)).toBe(false);
  });

  // ── 重试面保留 ──

  it("V5①-g 重试面保留：executeAgentCall 对 error result 照常退避重试 3 次，每次重试全新 taskId（重新 arm）", async () => {
    vi.useFakeTimers();
    const taskIds: string[] = [];
    const { sar } = makeHarness((_task, ctx) => {
      taskIds.push(ctx.taskId);
      return Promise.resolve(abortedRunResult());
    });

    const { call, trace } = makeAgentCallAndTrace();
    const budget = new Budget();
    const controller = new AbortController();
    const done = executeAgentCall(call, sar, budget, controller.signal, trace);
    // 退避基数 1s/2s（第 3 次达到 MAX_ATTEMPTS 不再退避）
    await vi.advanceTimersByTimeAsync(10_000);
    await done;

    expect(call.attempts).toBe(3);
    expect(taskIds.length).toBe(3);
    // per-call taskId 互异 = 每次重试都是全新 SAR.run 调用（天然重新 arm 新窗口）
    expect(new Set(taskIds).size).toBe(3);
    for (const id of taskIds) {
      expect(hasSettledWatchdog(id)).toBe(false);
    }
    const node = trace.toArray()[0];
    expect(node?.status).toBe("failed");
    const finalResult = node?.result as AgentResult | undefined;
    expect(finalResult?.error).toBeDefined();
  });
});
