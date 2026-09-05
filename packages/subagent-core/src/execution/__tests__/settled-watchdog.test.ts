// src/execution/__tests__/settled-watchdog.test.ts
//
// [T2-③ / D9 两段式] chatMode settled 等待守护：中段无进展检测 + 收尾段固定上界。
//
// 设计：docs/design/timeout-zcode-turn-and-settled-watchdog.md §6-D9 / §7（两段式
// 重锚定，P0-4 核心）；收尾段 600s 定值由 P-T2c 已执行探针定案（probe/p-t2c-report.md，
// 收尾段 <2ms、compact 30 万 tokens 40.1s、P99×10=401s<600s）；中段 30min 对齐
// KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS 先例。
//
// 覆盖五面（对应单元验收 ①-⑤）：
//   1. 原语单测（settled-watchdog.ts）：两常量值；①中段静默超时按第一段语义触发；
//      ②agent_end 交棒后切换收尾段；③收尾段 settle 到达 disarm 不误杀；④两段各自
//      独立计时（中段已过时间不继承——收尾段从 agent_end 起满 600s 才 fire）；
//      ⑤env XYZ_SUBAGENT_SETTLED_WATCHDOG_MS 覆盖 / ≤0 双段关闭 / 非法回落。
//   2. 首轮挂载集成（runSpawn chatMode）：prompt 发出后挂中段；静默 30min 触发 kill
//      → close → runSpawn 以错误返回且错误含段标注 + 恢复指引（S-B 验收判据）；
//      agent_end 交棒后收尾段 600s 独立计时；正常轮转（agent_end+agent_settled）
//      不误杀。
//   3. 清除点：settled 到达（含 resolveRun 同点）/ close 任一发生即清——挂载点消费
//      同一导出常量（advance 常量值可触发 = 同源断言）。
//
// [时序约束] runSpawn 内部的前置 await 均为微任务级（mock），集成用例在调用 runSpawn
// **之前**启用 fake timers，再用 advanceTimersByTimeAsync(1) 循环 flush 到 spawn 被调
// ——settled watchdog 挂载于 spawn 时，先 waitForSpawn（真实 setTimeout 轮询）后
// useFakeTimers 的话 timer 已挂在真实时钟上，fake 时钟 advance 推不到（MF-3 先例
// 注释的同一原理）。

import { spawn } from "node:child_process";
import * as fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const { FakeChild } = await import("./helpers/spawn-mock.ts");
  return {
    spawn: vi.fn(() => new FakeChild()),
    execFile: vi.fn(
      (
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, stdout?: string, stderr?: string) => void,
      ) => cb(new Error("execFile not configured in this test")),
    ),
  };
});

vi.mock("node:fs", async () => {
  const actual = await import("node:fs");
  return {
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => false),
      appendFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      readdirSync: vi.fn(() => []),
    },
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    promises: actual.promises,
  };
});

vi.mock("../alive-store.ts", () => ({ writeAliveMarker: vi.fn() }));

// chatMode agent_end 早返回（continue），不读 session-pending；统一 count=0 防干扰。
vi.mock("../session-pending.ts", () => ({
  readActivePendingFromSessionFile: vi.fn(() => ({ count: 0, recentUnregister: false })),
  prunePendingCursor: vi.fn(),
  listActivePendingFromSessionFile: vi.fn(() => ({ items: [] })),
}));

vi.mock("../engine/engines/pi/temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { runSpawn } from "../engine/engines/pi/session-runner.ts";
import {
  _resetSettledWatchdogsForTest,
  armMidRoundNoProgress,
  armSettledWatchdog,
  disarmSettledWatchdog,
  getSettledWatchdogPhase,
  getSettledWatchdogTimeoutMs,
  handoverMidRoundToSettled,
  hasSettledWatchdog,
  isSettledWatchdogDisabled,
  refreshMidRoundNoProgress,
  SETTLED_MID_ROUND_NO_PROGRESS_MS,
  SETTLED_WATCHDOG_ENV,
  SETTLED_WATCHDOG_TIMEOUT_MS,
  type SettledWatchdogFireInfo,
} from "../settled-watchdog.ts";
import { _resetLifecycleState } from "../lifecycle-manager.ts";
import { createRecord } from "../execution-record.ts";
import type { ExecutionRecord } from "../types.ts";
import {
  emitStdoutLine,
  type FakeChild,
  lastSpawnedChild as lastSpawnedChildOf,
  makeCtx,
  makeOpts,
  makeRecord,
} from "./helpers/spawn-mock.ts";

const mockSpawn = vi.mocked(spawn);
const lastSpawnedChild = (): FakeChild => lastSpawnedChildOf(mockSpawn);

function sessionHeaderLine(): Record<string, unknown> {
  return { type: "session", id: "sess-sw", timestamp: "2026-09-01T00:00:00.000Z", cwd: "/tmp/test" };
}

/** 构造 chatMode record（idleTimeoutMs 拉长到 1h，防 idle timer 干扰两段窗口断言）。 */
function makeChatModeRecord(id = "sa-chat-sw"): ExecutionRecord {
  const record = createRecord(id, {
    agent: "general-purpose",
    model: "test-model",
    mode: "sync",
    task: "chat task",
    slug: "chat",
    startedAt: 1_000_000,
    rootSessionId: "root-session",
    parentRecordId: undefined,
    depth: 0,
    chatMode: true,
  });
  record.idleTimeoutMs = 3_600_000;
  return record;
}

/**
 * fake timers 下的 spawn 等待：advanceTimersByTimeAsync(1) 循环 flush 微任务链
 *（runSpawn 前置 await 均为 mock 的微任务级），直到 spawn 被调。
 */
async function waitForSpawnUnderFakeTimers(baseline: number, maxIters = 50): Promise<void> {
  for (let i = 0; i < maxIters && mockSpawn.mock.results.length <= baseline; i++) {
    await vi.advanceTimersByTimeAsync(1);
  }
  if (mockSpawn.mock.results.length <= baseline) {
    throw new Error("spawn was not called under fake timers");
  }
}

// ============================================================
// 原语单测（两段式，验收 ①-⑤）
// ============================================================

describe("[T2-③ / D9] settled-watchdog 两段式原语", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    _resetSettledWatchdogsForTest();
  });

  afterEach(() => {
    _resetSettledWatchdogsForTest();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("两常量值：中段 30min（对齐 keep-alive 先例）+ 收尾段 600s（P-T2c 定案，值不变）", () => {
    expect(SETTLED_MID_ROUND_NO_PROGRESS_MS).toBe(30 * 60 * 1000);
    expect(SETTLED_WATCHDOG_TIMEOUT_MS).toBe(600_000);
    expect(getSettledWatchdogTimeoutMs()).toBe(600_000);
    expect(isSettledWatchdogDisabled()).toBe(false);
  });

  it("验收①：agent_end 前静默超时按第一段语义触发（mid-round 回调 + 段信息；收尾回调不触发）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onMidTimeout = vi.fn();
    const onSettleTimeout = vi.fn();
    armMidRoundNoProgress("sa-1", { onMidTimeout, onSettleTimeout });
    expect(hasSettledWatchdog("sa-1")).toBe(true);
    expect(getSettledWatchdogPhase("sa-1")).toBe("mid-round");

    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS - 1);
    expect(onMidTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onMidTimeout).toHaveBeenCalledTimes(1);
    expect(onMidTimeout).toHaveBeenCalledWith({ phase: "mid-round", waitedMs: SETTLED_MID_ROUND_NO_PROGRESS_MS });
    // 第一段语义：只触发中段回调，收尾回调不参与
    expect(onSettleTimeout).not.toHaveBeenCalled();
    // 到期回调先自删条目（对齐 armIdleTimer 语义）
    expect(hasSettledWatchdog("sa-1")).toBe(false);

    // disarm 已触发/不存在的 record：幂等 no-op
    disarmSettledWatchdog("sa-1");
    disarmSettledWatchdog("never-armed");
    expect(onMidTimeout).toHaveBeenCalledTimes(1);
  });

  it("验收②：agent_end 交棒后切换到收尾段（phase=settled；收尾段从交棒点独立计时）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onMidTimeout = vi.fn();
    const onSettleTimeout = vi.fn();
    armMidRoundNoProgress("sa-2", { onMidTimeout, onSettleTimeout });

    handoverMidRoundToSettled("sa-2");
    expect(getSettledWatchdogPhase("sa-2")).toBe("settled");
    expect(hasSettledWatchdog("sa-2")).toBe(true);

    // 交棒后满收尾段窗长才触发，触发的是收尾回调（段信息 settled + 600s）
    await vi.advanceTimersByTimeAsync(SETTLED_WATCHDOG_TIMEOUT_MS - 1);
    expect(onSettleTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSettleTimeout).toHaveBeenCalledTimes(1);
    expect(onSettleTimeout).toHaveBeenCalledWith({ phase: "settled", waitedMs: SETTLED_WATCHDOG_TIMEOUT_MS });
    expect(onMidTimeout).not.toHaveBeenCalled();
  });

  it("验收③：收尾段内 settle 到达（disarm）则正常解除不误杀", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onMidTimeout = vi.fn();
    const onSettleTimeout = vi.fn();
    armMidRoundNoProgress("sa-3", { onMidTimeout, onSettleTimeout });
    handoverMidRoundToSettled("sa-3");

    // settled 到达（生产接线：handleSdkEvent / close / 收尾统一 disarm，两段一并清）
    disarmSettledWatchdog("sa-3");
    expect(hasSettledWatchdog("sa-3")).toBe(false);

    await vi.advanceTimersByTimeAsync(SETTLED_WATCHDOG_TIMEOUT_MS + 60_000);
    expect(onSettleTimeout).not.toHaveBeenCalled();
    expect(onMidTimeout).not.toHaveBeenCalled();
  });

  it("验收④：两段各自独立计时——中段已过时间不继承进收尾段（D9 交棒语义，构造性断言）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onMidTimeout = vi.fn();
    const onSettleTimeout = vi.fn();
    armMidRoundNoProgress("sa-4", { onMidTimeout, onSettleTimeout });

    // 中段跑了 29min（差 1min 触发）时 agent_end 到达交棒
    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS - 60_000);
    handoverMidRoundToSettled("sa-4");

    // 若收尾段继承中段已过时间，agent_end 后约 10min 即触发；独立计时应满 600s
    await vi.advanceTimersByTimeAsync(SETTLED_WATCHDOG_TIMEOUT_MS - 60_000);
    expect(onSettleTimeout).not.toHaveBeenCalled();
    expect(onMidTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSettleTimeout).toHaveBeenCalledTimes(1);
    expect(onSettleTimeout).toHaveBeenCalledWith({ phase: "settled", waitedMs: SETTLED_WATCHDOG_TIMEOUT_MS });
  });

  it("中段刷新语义：有效事件行重挂同窗（连续静默才触发）；交棒后刷新 no-op（收尾段不刷新）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onMidTimeout = vi.fn();
    const onSettleTimeout = vi.fn();
    armMidRoundNoProgress("sa-5", { onMidTimeout, onSettleTimeout });

    // 静默 29min → 事件刷新 → 再 29min 不触发（若未刷新早已触发）
    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS - 60_000);
    refreshMidRoundNoProgress("sa-5");
    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS - 60_000);
    expect(onMidTimeout).not.toHaveBeenCalled();
    // 刷新后再满 1min 静默触发
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onMidTimeout).toHaveBeenCalledTimes(1);

    // 收尾段不刷新（D9 被否 (b) 方案的否决理由：刷新让收尾段失去唯一可收敛形态）
    const onSettleOnly = vi.fn();
    armSettledWatchdog("sa-5b", onSettleOnly);
    refreshMidRoundNoProgress("sa-5b");
    await vi.advanceTimersByTimeAsync(SETTLED_WATCHDOG_TIMEOUT_MS);
    expect(onSettleOnly).toHaveBeenCalledTimes(1);
  });

  it("handover 幂等：未挂载 / 重复交棒 / 收尾段后再交棒均 no-op（pump 每轮 agent_end 都调）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // 未挂载：no-op
    handoverMidRoundToSettled("sa-6-none");
    expect(hasSettledWatchdog("sa-6-none")).toBe(false);

    const onMidTimeout = vi.fn();
    const onSettleTimeout = vi.fn();
    armMidRoundNoProgress("sa-6", { onMidTimeout, onSettleTimeout });
    // 重复交棒：第二次 no-op（不会叠加/重置收尾段计时）
    handoverMidRoundToSettled("sa-6");
    await vi.advanceTimersByTimeAsync(SETTLED_WATCHDOG_TIMEOUT_MS / 2);
    handoverMidRoundToSettled("sa-6");
    await vi.advanceTimersByTimeAsync(SETTLED_WATCHDOG_TIMEOUT_MS / 2);
    expect(onSettleTimeout).toHaveBeenCalledTimes(1);
    expect(onMidTimeout).not.toHaveBeenCalled();
  });

  it("重复 arm 以新窗口覆盖旧计时（新一轮 prompt：旧中段/残留收尾段一并作废）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onMidTimeout = vi.fn();
    const onSettleTimeout = vi.fn();
    armMidRoundNoProgress("sa-7", { onMidTimeout, onSettleTimeout });
    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS / 2);
    // 新一轮 prompt 重新 arm：旧窗口必须作废（含异常形态下残留的收尾段）
    armMidRoundNoProgress("sa-7", { onMidTimeout, onSettleTimeout });
    expect(getSettledWatchdogPhase("sa-7")).toBe("mid-round");

    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS - 1);
    expect(onMidTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onMidTimeout).toHaveBeenCalledTimes(1);
  });

  // ── 验收⑤：env XYZ_SUBAGENT_SETTLED_WATCHDOG_MS ──

  it("验收⑤a：env >0 覆盖收尾段定值（生效窗长随 fire 信息回传）", async () => {
    vi.stubEnv(SETTLED_WATCHDOG_ENV, "12345");
    _resetSettledWatchdogsForTest(); // 清 env 解析缓存使新 env 生效
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(getSettledWatchdogTimeoutMs()).toBe(12_345);
    expect(isSettledWatchdogDisabled()).toBe(false);

    const onSettleTimeout = vi.fn();
    armSettledWatchdog("sa-8", onSettleTimeout);
    await vi.advanceTimersByTimeAsync(12_345 - 1);
    expect(onSettleTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSettleTimeout).toHaveBeenCalledWith({ phase: "settled", waitedMs: 12_345 });

    // 交棒路径同样消费覆盖值
    const onSettle2 = vi.fn();
    armMidRoundNoProgress("sa-8b", { onMidTimeout: vi.fn(), onSettleTimeout: onSettle2 });
    handoverMidRoundToSettled("sa-8b");
    await vi.advanceTimersByTimeAsync(12_345);
    expect(onSettle2).toHaveBeenCalledWith({ phase: "settled", waitedMs: 12_345 });
  });

  it("验收⑤b：env ≤0 关闭两段（arm no-op + warn 明示三无窗口后果）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubEnv(SETTLED_WATCHDOG_ENV, "0");
    _resetSettledWatchdogsForTest();
    expect(isSettledWatchdogDisabled()).toBe(true);

    const onMidTimeout = vi.fn();
    const onSettleTimeout = vi.fn();
    armMidRoundNoProgress("sa-9", { onMidTimeout, onSettleTimeout });
    // 两段都不挂载（关闭语义：回到「三无窗口」，warn 已明示）
    expect(hasSettledWatchdog("sa-9")).toBe(false);
    handoverMidRoundToSettled("sa-9");
    refreshMidRoundNoProgress("sa-9");
    armSettledWatchdog("sa-9", onSettleTimeout);
    expect(hasSettledWatchdog("sa-9")).toBe(false);

    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS + SETTLED_WATCHDOG_TIMEOUT_MS);
    expect(onMidTimeout).not.toHaveBeenCalled();
    expect(onSettleTimeout).not.toHaveBeenCalled();
  });

  it("验收⑤c：env 非法（非数字）回落默认 + warn 留痕（LC-7 教训：非法回落必须可见）", () => {
    vi.stubEnv(SETTLED_WATCHDOG_ENV, "not-a-number");
    _resetSettledWatchdogsForTest();
    expect(getSettledWatchdogTimeoutMs()).toBe(SETTLED_WATCHDOG_TIMEOUT_MS);
    expect(isSettledWatchdogDisabled()).toBe(false);
  });

  it("验收⑤d：env 未设/空串 = 默认 600s（规则 19：用户显式指定才生效）", () => {
    delete process.env[SETTLED_WATCHDOG_ENV];
    _resetSettledWatchdogsForTest();
    expect(getSettledWatchdogTimeoutMs()).toBe(600_000);

    vi.stubEnv(SETTLED_WATCHDOG_ENV, "  ");
    _resetSettledWatchdogsForTest();
    expect(getSettledWatchdogTimeoutMs()).toBe(600_000);
    expect(isSettledWatchdogDisabled()).toBe(false);
  });
});

// ============================================================
// runSpawn 首轮挂载集成（chatMode）
// ============================================================

describe("[T2-③ / D9] runSpawn 首轮挂载（chatMode）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("XYZ_SUBAGENT_SPAWN_WATCHDOG_MS", "");
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
  });

  it("验收①挂载面：agent_end 前静默超 30min（中段语义）→ kill 层主 → runSpawn 错误返回含段标注 + 恢复指引", async () => {
    const record = makeChatModeRecord();
    const baseline = mockSpawn.mock.results.length;
    const promise = runSpawn(record, "Chat: mid-round wedge", makeOpts(), makeCtx());
    await waitForSpawnUnderFakeTimers(baseline);
    const child = lastSpawnedChild();

    // prompt 发出后挂中段：advance 到中段窗长触发（原 10min 全程窗已不存在——
    // advance 10min 静默不再误杀，是对 P0-4 的直接回归断言）
    emitStdoutLine(child, sessionHeaderLine());
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS - 10 * 60 * 1000 - 1_000);
    expect(child.killed).toBe(false);
    // [余量] fake timers 对 Date mock 有 ms 级舍入，断言边界留 1s 余量（对阈值语义无损）
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGTERM");

    // kill → close：runSpawn 以错误返回（设计 §6.2 首轮窗口形态）
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 143);
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toContain("settled watchdog");
    expect(result.error).toContain("agent_settled");
    expect(result.error).toContain("mid-round no-progress");
    // S-B 验收判据：错误消息含恢复指引
    expect(result.error).toContain("Recovery:");
    expect(result.error).toContain("action:'list'");
  });

  it("验收②挂载面：agent_end 交棒后收尾段 600s 独立计时——中段 30min 不再适用，600s 到期 kill + settled 段文案", async () => {
    const record = makeChatModeRecord();
    const baseline = mockSpawn.mock.results.length;
    const promise = runSpawn(record, "Chat: settle never arrives", makeOpts(), makeCtx());
    await waitForSpawnUnderFakeTimers(baseline);
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeaderLine());
    // agent_end 到达：交棒收尾段（中段静默 30min 判定随之失效）
    emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
    await new Promise((r) => setImmediate(r));

    // 收尾段从 agent_end 起独立计时：满 600s 前不触发（600s < 中段 30min——本推进
    // 段内无论收尾段还是残留中段都不该 fire）
    await vi.advanceTimersByTimeAsync(SETTLED_WATCHDOG_TIMEOUT_MS - 2_000);
    expect(child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGTERM");

    child.stdout.end();
    child.stderr.end();
    child.emit("close", 143);
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toContain("settled watchdog");
    expect(result.error).toContain("settled phase");
    expect(result.error).toContain("after agent_end");
    expect(result.error).toContain("Recovery:");
  });

  it("验收③挂载面：agent_end + agent_settled 正常轮转即清——advance 两段窗长合计不误杀已正常轮转的层主", async () => {
    const record = makeChatModeRecord();
    const baseline = mockSpawn.mock.results.length;
    const promise = runSpawn(record, "Chat: normal", makeOpts(), makeCtx());
    await waitForSpawnUnderFakeTimers(baseline);
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeaderLine());
    emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
    emitStdoutLine(child, { type: "agent_settled" });
    await new Promise((r) => setImmediate(r));

    // 首轮窗口结束（resolveRun 同点清除两段守护）；idle timer 被拉长到 1h 不干扰
    expect(hasSettledWatchdog(record.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS + SETTLED_WATCHDOG_TIMEOUT_MS + 60_000);
    // settled watchdog 已清：子进程未被本守护 kill（若回归未清，此处 killed=true）
    expect(child.killed).toBe(false);

    // 收尾
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0);
    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("挂载面限定 chatMode：非 chatMode 首轮不挂 settled 守护（中段/收尾段均无）", async () => {
    const record = makeRecord(); // 非 chatMode
    const baseline = mockSpawn.mock.results.length;
    const promise = runSpawn(record, "Task: not chat", makeOpts(), makeCtx());
    await waitForSpawnUnderFakeTimers(baseline);
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeaderLine());
    await new Promise((r) => setImmediate(r));
    expect(hasSettledWatchdog(record.id)).toBe(false);

    // 非 chatMode：即使静默超过中段窗长也不被 settled 守护 kill（spawn watchdog 同为
    // 未挂载——裸缺省 + env 清），agent_end 之前的执行期不受 T2-③ 触及
    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS + 60_000);
    expect(child.killed).toBe(false);

    // agent_end（count=0）→ final kill（既有语义）
    emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
    await new Promise((r) => setImmediate(r));
    expect(child.killed).toBe(true);

    child.stdout.end();
    child.stderr.end();
    child.emit("close", 143);
    const result = await promise;
    expect(result.success).toBe(true);
  });
});

// fire info 类型形状守卫（挂载点回调签名消费；编译期校验的运行时锚定）
describe("[T2-③ / D9] SettledWatchdogFireInfo 形状", () => {
  it("fire 信息的段与窗长字段齐全（挂载点文案分叉的契约面）", () => {
    const mid: SettledWatchdogFireInfo = { phase: "mid-round", waitedMs: SETTLED_MID_ROUND_NO_PROGRESS_MS };
    const settled: SettledWatchdogFireInfo = { phase: "settled", waitedMs: SETTLED_WATCHDOG_TIMEOUT_MS };
    expect(mid.phase).toBe("mid-round");
    expect(settled.phase).toBe("settled");
  });
});
