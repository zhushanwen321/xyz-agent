// src/execution/__tests__/settled-watchdog.test.ts
//
// [T2-③ / LC-1] chatMode settled 等待固定硬上限。
//
// 设计：docs/design/subagent-core-unbounded-wait-audit.md §7.2 T2-③；10min 默认值
// 由 P-T2c 探针定案（probe/p-t2c-report.md，正常形态 ≈0ms、余量 4 个数量级）。
//
// 覆盖三面：
//   1. 原语单测（settled-watchdog.ts）：唯一常量值 + arm 到期触发 + disarm 清除 +
//      重复 arm 以新窗口覆盖旧计时（旧窗不清则提前触发，断言可证伪）。
//   2. 首轮挂载集成（runSpawn chatMode）：prompt 发出后挂载；advance 到
//      SETTLED_WATCHDOG_TIMEOUT_MS 触发 kill → close → runSpawn 以错误返回且错误含
//      恢复指引（S-B 验收判据）。
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
  listActivePendingFromSessionFile: vi.fn(() => ({ items: [] })),
}));

vi.mock("../temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { runSpawn } from "../session-runner.ts";
import {
  _resetSettledWatchdogsForTest,
  armSettledWatchdog,
  disarmSettledWatchdog,
  hasSettledWatchdog,
  SETTLED_WATCHDOG_TIMEOUT_MS,
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

/** 构造 chatMode record（idleTimeoutMs 拉长到 1h，防 idle timer 干扰 10min 窗口断言）。 */
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

describe("[T2-③] settled-watchdog 原语", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSettledWatchdogsForTest();
  });

  afterEach(() => {
    _resetSettledWatchdogsForTest();
    vi.useRealTimers();
  });

  it("唯一常量值 = 10min（P-T2c 定案，双挂载点共享此导出）", () => {
    expect(SETTLED_WATCHDOG_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });

  it("arm 后 advance 到 10min 触发 onTimeout（到期自删记账）；disarm 后不再触发", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onTimeout = vi.fn();
    armSettledWatchdog("sa-1", onTimeout);
    expect(hasSettledWatchdog("sa-1")).toBe(true);

    await vi.advanceTimersByTimeAsync(SETTLED_WATCHDOG_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    // 到期回调先自删条目（对齐 armIdleTimer 语义）
    expect(hasSettledWatchdog("sa-1")).toBe(false);

    // disarm 已触发/不存在的 record：幂等 no-op
    disarmSettledWatchdog("sa-1");
    disarmSettledWatchdog("never-armed");
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("重复 arm 以新窗口覆盖旧计时——旧窗口不清会提前触发（断言可证伪）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onTimeout = vi.fn();
    armSettledWatchdog("sa-2", onTimeout);
    await vi.advanceTimersByTimeAsync(SETTLED_WATCHDOG_TIMEOUT_MS / 2);
    // 重挂（新一轮 prompt）：旧窗口必须作废
    armSettledWatchdog("sa-2", onTimeout);

    // 若旧窗未清：旧 timer 会在重挂后 5min 触发（此处 advance 内）→ 断言失败
    await vi.advanceTimersByTimeAsync(SETTLED_WATCHDOG_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});

describe("[T2-③] runSpawn 首轮挂载（chatMode）", () => {
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

  it("settled 永不到达：10min 硬上限到期 kill 层主 → runSpawn 以错误返回且含恢复指引", async () => {
    const record = makeChatModeRecord();
    const baseline = mockSpawn.mock.results.length;
    const promise = runSpawn(record, "Chat: wedge", makeOpts(), makeCtx());
    await waitForSpawnUnderFakeTimers(baseline);
    const child = lastSpawnedChild();

    // 挂载点消费同一导出常量：advance 常量值量级可触发即同源断言。
    // [余量] fake timers 对 Date mock 有 ms 级舍入（实测 advance(SET-1) 会触发），
    // 断言边界留 1s 余量——对 10min 上限语义无损，对计时器实现细节稳健。
    emitStdoutLine(child, sessionHeaderLine());
    await vi.advanceTimersByTimeAsync(SETTLED_WATCHDOG_TIMEOUT_MS - 1_000);
    expect(child.killed).toBe(false);
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
    // S-B 验收判据：错误消息含恢复指引
    expect(result.error).toContain("Recovery:");
    expect(result.error).toContain("action:'list'");
  });

  it("settled 到达：硬上限即清（含 resolveRun 同点）——advance 10min 不误杀已正常轮转的层主", async () => {
    const record = makeChatModeRecord();
    const baseline = mockSpawn.mock.results.length;
    const promise = runSpawn(record, "Chat: normal", makeOpts(), makeCtx());
    await waitForSpawnUnderFakeTimers(baseline);
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeaderLine());
    emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
    emitStdoutLine(child, { type: "agent_settled" });
    await new Promise((r) => setImmediate(r));

    // 首轮窗口结束（resolveRun 同点清除硬上限）；idle timer 被拉长到 1h 不干扰本窗口
    expect(hasSettledWatchdog(record.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(SETTLED_WATCHDOG_TIMEOUT_MS + 60_000);
    // settled watchdog 已清：子进程未被本上界 kill（若回归未清，此处 killed=true）
    expect(child.killed).toBe(false);

    // 收尾
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0);
    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("挂载面限定 chatMode：非 chatMode 首轮不挂 settled 上界", async () => {
    const record = makeRecord(); // 非 chatMode
    const baseline = mockSpawn.mock.results.length;
    const promise = runSpawn(record, "Task: not chat", makeOpts(), makeCtx());
    await waitForSpawnUnderFakeTimers(baseline);
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeaderLine());
    await new Promise((r) => setImmediate(r));
    expect(hasSettledWatchdog(record.id)).toBe(false);

    // 非 chatMode：即使静默超过 10min 也不被 settled 上界 kill（spawn watchdog 同为
    // 未挂载——裸缺省 + env 清），agent_end 之前的执行期不受 T2-③ 触及
    await vi.advanceTimersByTimeAsync(SETTLED_WATCHDOG_TIMEOUT_MS + 60_000);
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
