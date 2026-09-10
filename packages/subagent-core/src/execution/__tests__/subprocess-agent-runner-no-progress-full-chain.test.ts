// src/execution/__tests__/subprocess-agent-runner-no-progress-full-chain.test.ts
//
// [M6 / 设计 §4 V5②] workflow 域 no-progress 守护的**全链单测**（秒级窗真跑）。
//
// 背景（K6 → M6）：mid-round 阈值此前是原语内纯常量（30min），无 env/测试 seam 可缩短
// → V5② 只能降级，fire 链被拆成两段验（V5① 假时钟验「到点 → abort」；V5c 真引擎验
// 「abort → killAll」），两段之间的缝只能靠人工审查背书。M6 给 settled-watchdog 加了
// **仅测试可达**的注入口（`_setMidRoundNoProgressWindowMsForTest`，生产恒 30min、不做
// env），使本文件能把整条链收进同一条测试：
//
//   注入秒级窗 → 窗口到点 → watchdog fire（同步段只 abort + warn）
//     → 同一 AbortController 实例的 signal 经 mergeRunSignals 合流为 ctx.signal
//     → RemoteEngine wireAbortSignal 阶梯：cancel 帧 → 3s 收敛窗 → killAll
//     → 在途 run 请求 reject → 合成终态 → SAR error result（附恢复指引）
//
// 「同一实例」的断言策略（本文件的核心）：fire 回调同时设置 fired 与调 controller.abort()，
// 而 fired 为真的唯一产物是 error result 上的 `workflow no-progress watchdog fired` 后缀
// ——该后缀 + cancel 帧（runId = SAR taskId）+ ctx.signal.aborted 三件同时成立，且外部
// signal 全程未 abort、未传 timeoutMs（无第二 abort 源），即证明 abort 确由 watchdog 的
// controller 发出并沿 mergeRunSignals → ctx.signal → wireAbortSignal 全程传播。
//
// 真副作用断言（不靠 mock）：killAll 的连带面 = 邻接 healthy run 以 engine_crashed 失败
// 终态收敛（真进程组杀后在途请求 reject），且 3s 宽限为真实时序（cancel 与 killAll 两次
// 观测的时间差 ≥ CANCEL_SETTLE_GRACE_MS）。
//
// 对端 sessionDir = mkdtempSync 自建自删（禁碰真实数据目录）；本用例用真引擎子进程，
// 不用 fake timers（V5c 同先例）。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CANCEL_SETTLE_GRACE_MS } from "@zhushanwen/subagent-engine-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureCore, resetCoreForTests, type HostServices } from "../../core/host-services.ts";
import { EngineClient } from "../engine/client/engine-client.ts";
import { RemoteEngine, type RemoteEngineManifestSnapshot } from "../engine/client/remote-engine.ts";
import { clearEngines, registerEngine } from "../engine/registry.ts";
import { SubprocessAgentRunner, type SubprocessAgentRunnerDeps } from "../subprocess-agent-runner.ts";
import type { SubagentService } from "../subagent-service.ts";
import {
  _resetSettledWatchdogsForTest,
  _setMidRoundNoProgressWindowMsForTest,
  armMidRoundNoProgress,
  getMidRoundNoProgressWindowMs,
  hasSettledWatchdog,
  isSettledWatchdogDisabled,
  SETTLED_MID_ROUND_NO_PROGRESS_MS,
  SETTLED_WATCHDOG_ENV,
} from "../settled-watchdog.ts";

const FAKE_ENGINE = fileURLToPath(
  new URL("../engine/client/__tests__/__fixtures__/fake-engine.mjs", import.meta.url),
);

/** 与 fake 引擎 initialize 应答逐位一致（gate 位多声明判定「一致放行」基线，V5c 同源）。 */
const FAKE_MATCHED_CAPS = {
  schemaEnforcement: "emulated",
  steer: "unsupported",
  conversation: "unsupported",
  personaInjection: "prompt",
  eventGranularity: "stream",
  sandbox: "emulated",
  sessionRead: "full",
  resume: "cold",
  interrupt: "kill-only",
  permissionMode: "fixed",
  maxTurns: false,
} as const;

/** run 动作脚本：run-params 回显后长 delay——对 cancel 无响应（考验 3s 收敛窗后的杀链）。 */
const HANG_RUN_ACTIONS = JSON.stringify([{ op: "delay", ms: 30_000 }]);

/** 注入的秒级窗长：需明显长于引擎 spawn + 握手耗时（run-params 回显前不得 fire）。 */
const INJECTED_WINDOW_MS = 5_000;

async function waitForTrue(predicate: () => boolean, timeoutMs = 15_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("waitForTrue: condition not met within timeout");
}

/** fake 引擎收到 run 帧后回显的 run-params 事件（run 已派发的确定性同步点）。 */
function sawRunParams(events: unknown[]): boolean {
  return events.some(
    (e) =>
      (e as { type?: string; message?: string }).type === "error" &&
      typeof (e as { message?: string }).message === "string" &&
      (e as { message: string }).message.startsWith("run-params:"),
  );
}

describe("M6 V5② workflow no-progress 秒级窗全链（真引擎）", () => {
  let dataDir = "";
  const logs: Array<{ level: string; component: string; message: string }> = [];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "m6-v5b2-full-chain-"));
    logs.length = 0;
    _resetSettledWatchdogsForTest();
    // 宿主 shell export 隔离：守护开关 env 必须处于「未设」基线（空串 = 未设）。
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
    vi.unstubAllEnvs();
    _resetSettledWatchdogsForTest();
    resetCoreForTests();
    clearEngines();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("默认值守护：生产中段窗恒 30min；测试注入不改常量且可复位（防将来重构手滑）", () => {
    expect(SETTLED_MID_ROUND_NO_PROGRESS_MS).toBe(30 * 60 * 1000);
    expect(getMidRoundNoProgressWindowMs()).toBe(SETTLED_MID_ROUND_NO_PROGRESS_MS);

    _setMidRoundNoProgressWindowMsForTest(1_500);
    expect(getMidRoundNoProgressWindowMs()).toBe(1_500);
    // 注入是覆盖值的读取，不污染常量本体（生产路径读到的默认值不变）。
    expect(SETTLED_MID_ROUND_NO_PROGRESS_MS).toBe(30 * 60 * 1000);

    _resetSettledWatchdogsForTest();
    expect(getMidRoundNoProgressWindowMs()).toBe(SETTLED_MID_ROUND_NO_PROGRESS_MS);
  });

  it("U-B3 env ≤0 的 warn 明示 workflow 域 no-progress 熔断连带失效（只改文案，不动开关语义）", () => {
    vi.stubEnv(SETTLED_WATCHDOG_ENV, "0");
    // 惰性首读触发解析 + warn 留痕。
    expect(isSettledWatchdogDisabled()).toBe(true);
    const warn = logs.find((l) => l.level === "warn" && l.message.includes(SETTLED_WATCHDOG_ENV));
    expect(warn).toBeDefined();
    // 文案必须覆盖 M3 复用同一原语带来的 workflow 域连带后果（修复前只提 chat 域）。
    expect(warn?.message).toContain("workflow");
    expect(warn?.message).toContain("no-progress");
    expect(warn?.message).toContain("SAR.run");

    // 开关语义不动：arm 仍 no-op（本条目只补文案与注释，不新增 env、不改行为）。
    const fired: string[] = [];
    armMidRoundNoProgress("sa-env-off", {
      onMidTimeout: () => fired.push("mid"),
      onSettleTimeout: () => fired.push("settle"),
    });
    expect(hasSettledWatchdog("sa-env-off")).toBe(false);
    expect(fired).toEqual([]);
  });

  it("V5② 窗口到点 → fire → abort → 合流 → 取消帧 → 3s 宽限 → killAll → error result（真引擎，秒级窗）", async () => {
    _setMidRoundNoProgressWindowMsForTest(INJECTED_WINDOW_MS);

    const client = new EngineClient({
      engineId: "pi",
      command: process.execPath,
      args: [FAKE_ENGINE, "--engine-id", "pi", "--run-actions", HANG_RUN_ACTIONS],
      hostKind: "test",
      dataDir,
      envPrefixes: [],
    });
    const manifest: RemoteEngineManifestSnapshot = { capabilities: { ...FAKE_MATCHED_CAPS } };
    const engine = new RemoteEngine({ engineId: "pi", client, dataDir, hostKind: "test", manifest });

    // ctx.signal 捕获点：SAR 经 registry 解析到**同一实例**，故该包装对 SAR 的
    // engine.run 调用同样生效——这是「合流后的 signal 交给引擎」的观测面。
    const ctxSignals = new Map<string, AbortSignal>();
    const realRun = engine.run.bind(engine);
    engine.run = (task, ctx) => {
      if (ctx.signal !== undefined) ctxSignals.set(ctx.taskId, ctx.signal);
      return realRun(task, ctx);
    };

    clearEngines();
    registerEngine("pi", () => engine);

    const cancelSpy = vi.spyOn(client, "cancelRun");
    const killAllSpy = vi.spyOn(client, "killAll");

    // SAR 构造：pi 已注册 → resolveHostPiEnginePort 取上面的真引擎（不消费 service）。
    const partial: { asEngineService?: unknown } = {};
    const service = partial as unknown as SubagentService;
    partial.asEngineService = service;
    const deps: SubprocessAgentRunnerDeps = { subagentService: service };
    const sar = new SubprocessAgentRunner(deps);

    const externalA = new AbortController();
    const eventsA: unknown[] = [];
    const runA = sar.run({ prompt: "wedged", agent: "worker", cwd: dataDir }, externalA.signal, (e) =>
      eventsA.push(e),
    );

    try {
      // 邻接 healthy run：直连同一引擎实例，killAll 组杀连带的真副作用断言对象。
      const eventsB: unknown[] = [];
      const runB = engine.run(
        { prompt: "healthy" },
        {
          taskId: "run-b",
          poolKey: "shared",
          signal: new AbortController().signal,
          onEvent: (e) => eventsB.push(e),
        },
      );

      // 确定性同步点：两路 run 帧均已到达引擎（run-params 回显）。该事件同时经 SAR 的
      // observedEvent 刷新了中段窗——故此刻必然仍在窗内。
      await waitForTrue(() => sawRunParams(eventsA) && sawRunParams(eventsB));
      const tAfterDispatch = Date.now();

      const taskIdA = [...ctxSignals.keys()].find((k) => k.startsWith("sa-"));
      expect(taskIdA).toBeDefined();
      const ctxSignalA = ctxSignals.get(taskIdA ?? "");
      expect(ctxSignalA).toBeDefined();
      const ctxSignal = ctxSignalA as AbortSignal;

      // ── 窗口内：未 fire、未 abort ──
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(ctxSignal.aborted).toBe(false);
      expect(externalA.signal.aborted).toBe(false);
      expect(hasSettledWatchdog(taskIdA ?? "")).toBe(true);
      // 合流事实：守护源已并入 → 引擎拿到的不是外部 signal 本身（mergeRunSignals 新对象）。
      expect(ctxSignal).not.toBe(externalA.signal);

      // ── 窗口到点：fire → abort → 取消帧 ──
      await waitForTrue(() => cancelSpy.mock.calls.length > 0);
      const cancelAt = Date.now();
      // 由注入窗长驱动（不是立即 fire）——从 run-params 刷新点起接近注入值。
      expect(cancelAt - tAfterDispatch).toBeGreaterThanOrEqual(INJECTED_WINDOW_MS - 1_000);
      // 阶梯第 1 跳：watchdog controller.abort() → mergedSignal(= ctx.signal) abort →
      // wireAbortSignal → cancel 帧（runId = SAR taskId，"abort" 为 wire 侧常量）。
      expect(cancelSpy).toHaveBeenCalledWith(taskIdA, "abort");
      expect(ctxSignal.aborted).toBe(true);
      expect(externalA.signal.aborted).toBe(false);

      // ── 3s 收敛窗后：killAll（真时序）──
      await waitForTrue(() => killAllSpy.mock.calls.length > 0);
      const killAllAt = Date.now();
      expect(killAllAt - cancelAt).toBeGreaterThanOrEqual(CANCEL_SETTLE_GRACE_MS - 500);

      const [a, b] = await Promise.all([runA, runB]);

      // ── 真终态 + 恢复指引 ──
      // `workflow no-progress watchdog fired` 后缀是 fired() 为真的唯一产物（fire 回调
      // 同时置 fired 并 abort）——它与 cancel 帧、ctx.signal.aborted 三件同时成立，且无
      // 第二 abort 源，即证明 abort 出自 watchdog 的 controller 并全程传播。
      expect(a.error).toContain("aborted before terminal answer");
      expect(a.error).toContain("workflow no-progress watchdog fired");
      expect(a.error).toContain("re-dispatch the workflow");
      expect(hasSettledWatchdog(taskIdA ?? "")).toBe(false);
      // fire warn 留痕（含 killAll 连带面提示）。
      const warn = logs.find(
        (l) => l.level === "warn" && l.message.includes("workflow no-progress watchdog"),
      );
      expect(warn).toBeDefined();
      expect(warn?.component).toBe("subagents");
      expect(warn?.message).toContain("killAll");

      // ── 真 killAll 副作用：邻接 healthy run 以 engine_crashed 收敛（非 mock 断言，
      //    来自真进程组杀后在途请求 reject → RemoteEngine 合成 outcome）。G1 字面保持。
      expect(b.outcome.error).toContain("engine_crashed");
      expect(b.outcome.exitCode).toBeNull();
      expect(killAllSpy).toHaveBeenCalled();
    } finally {
      await client.dispose().catch(() => {});
    }
  }, 30_000);
});
