// src/execution/__tests__/keep-alive-no-progress.test.ts
//
// [T2-① / P-T2 降级路径 B] keep-alive 裸缺省无进展检测上界。
//
// 设计：docs/design/subagent-core-unbounded-wait-audit.md §7.2 T2-① + impl-plan §5
// P-T2 裁决（probe/p-t2-report.md）：历史 89 样本 96.6% keep-alive 窗口 >30min、
// 长尾 95.5h 合法（parent-shutdown 收敛）——固定 30min 上限被数据否定，按设计降级
// 路径 B 落地为无进展检测语义：
//   - 裸缺省（无 maxTurns 无 env）：keep-alive 期间任何子进程 stdout 活动刷新计时，
//     仅连续静默达 KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS（30min）才处置；
//   - 显式 maxTurns / env：行为不变（既有固定时长等待，不挂无进展 timer——opt-out
//     语义保留）。
//
// mock 布局与 run-spawn-edges.test.ts 一致（FakeChild + mock session-pending）。

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

vi.mock("../alive-store.ts", () => ({
  writeAliveMarker: vi.fn(),
  // [T5②] keep-alive 心跳刷新读取现有 marker id（缺失兜底 record.id）
  readAliveMarker: vi.fn(() => undefined),
  isProcessAlive: vi.fn(() => false),
}));

// keep-alive 判定：本文件统一 count>0（有活跃后代 → keep-alive 分支）。
vi.mock("../session-pending.ts", () => ({
  readActivePendingFromSessionFile: vi.fn(() => ({ count: 1, recentUnregister: false })),
  listActivePendingFromSessionFile: vi.fn(() => ({ items: [] })),
}));

vi.mock("../temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import {
  KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS,
  maxTurnsToWatchdogMs,
  runSpawn,
  SPAWN_WATCHDOG_ENV,
} from "../session-runner.ts";
import { readActivePendingFromSessionFile } from "../session-pending.ts";
import {
  emitStdoutLine,
  type FakeChild,
  lastSpawnedChild as lastSpawnedChildOf,
  makeCtx,
  makeOpts,
  makeRecord,
  waitForSpawn as waitForSpawnOf,
} from "./helpers/spawn-mock.ts";

const mockSpawn = vi.mocked(spawn);
const mockPending = vi.mocked(readActivePendingFromSessionFile);

const lastSpawnedChild = (): FakeChild => lastSpawnedChildOf(mockSpawn);
const waitForSpawn = (timeoutMs = 1000): Promise<void> => waitForSpawnOf(mockSpawn, timeoutMs);

/** 非 chatMode 层主 + fake timers + agent_end keep-alive 落位的公共前奏。 */
async function spawnAndReachKeepAlive(opts = makeOpts()): Promise<{
  child: FakeChild;
  finish: (code?: number) => Promise<Awaited<ReturnType<typeof runSpawn>>>;
}> {
  const record = makeRecord();
  const promise = runSpawn(record, "Task: keep-alive no-progress", opts, makeCtx());
  await waitForSpawn();
  const child = lastSpawnedChild();
  // fake timers 必须在 emit agent_end 之前启用（keep-alive timer 新建于 agent_end
  // 处理器内；不 fake setImmediate——stream flush 靠真实事件循环交付，见 MF-3 先例）。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  emitStdoutLine(child, sessionHeaderLine());
  emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
  await new Promise((r) => setImmediate(r));
  return {
    child,
    finish: (code = 143) => {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code);
      return promise as Promise<Awaited<ReturnType<typeof runSpawn>>>;
    },
  };
}

function sessionHeaderLine(): Record<string, unknown> {
  return { type: "session", id: "sess-ka", timestamp: "2026-09-01T00:00:00.000Z", cwd: "/tmp/test" };
}

describe("[T2-①] keep-alive 裸缺省无进展检测上界（P-T2 降级路径 B）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv(SPAWN_WATCHDOG_ENV, "");
    mockPending.mockReturnValue({ count: 1, recentUnregister: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("裸缺省：agent_end keep-alive 挂无进展 timer，连续静默 30min 触发 SIGTERM 处置", async () => {
    const { child, finish } = await spawnAndReachKeepAlive();

    // keep-alive 落位：进程保活
    expect(child.killed).toBe(false);

    // 静默 30min-1ms：未达阈值，不处置
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS - 1);
    expect(child.killed).toBe(false);

    // 连续静默达 30min：处置（SIGTERM，升级由 killChildWithEscalation 承接）
    await vi.advanceTimersByTimeAsync(1);
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGTERM");

    const result = await finish();
    expect(result.success).toBe(true); // 信号终止视为正常完成（既有语义，T2-③ 形态除外）
  });

  it("裸缺省：keep-alive 期间 stdout 活动刷新计时——持续输出的层主不被时长上限误杀", async () => {
    const { child, finish } = await spawnAndReachKeepAlive();
    expect(child.killed).toBe(false);

    // 静默 29min 后子进程产生一次输出（任意行）：静默计时被刷新
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS - 60_000);
    emitStdoutLine(child, { type: "turn_end" });
    await new Promise((r) => setImmediate(r));
    expect(child.killed).toBe(false);

    // 再静默 29min（相对上次活动 <30min）：若无刷新语义此刻已累计 58min 会被误杀
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS - 60_000);
    expect(child.killed).toBe(false);

    // 刷新后再静默满 30min：连续静默达阈值，处置
    await vi.advanceTimersByTimeAsync(60_000);
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGTERM");

    await finish();
  });

  it("显式 maxTurns：行为不变——无进展 timer 不挂，30min 静默点不处置，动态超时到期才 kill", async () => {
    const maxTurns = 20; // maxTurnsToWatchdogMs(20) = 100min
    const { child, finish } = await spawnAndReachKeepAlive(makeOpts({ maxTurns }));

    // 关键反证断言：裸缺省阈值（30min）处连续静默也不 kill——无进展 timer 未挂载
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS);
    expect(child.killed).toBe(false);

    // 既有 MF-4 动态超时行为不变：100min 到期才 kill
    await vi.advanceTimersByTimeAsync(maxTurnsToWatchdogMs(maxTurns) - KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS - 1);
    expect(child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGTERM");

    await finish();
  });

  it("显式 env 兑底：行为不变——按 env 绝对时限固定等待，不挂无进展 timer", async () => {
    vi.stubEnv(SPAWN_WATCHDOG_ENV, "600000"); // 10min（< 30min 静默阈值，反证无进展 timer 未挂）
    const { child, finish } = await spawnAndReachKeepAlive();

    await vi.advanceTimersByTimeAsync(600_000);
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGTERM");

    await finish();
  });

  it("keep-alive 结束（后代全部完成 → final kill）即撤无进展 timer，无残留误杀", async () => {
    // 先走 keep-alive（count>0）挂无进展 timer，再被唤醒重评估为 count=0 → final kill
    mockPending
      .mockReturnValueOnce({ count: 1, recentUnregister: false })
      .mockReturnValueOnce({ count: 0, recentUnregister: false });
    const record = makeRecord();
    const promise = runSpawn(record, "Task: keep-then-final", makeOpts(), makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    emitStdoutLine(child, sessionHeaderLine());
    // 第一次 agent_end：keep-alive（挂无进展 timer）
    emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
    await new Promise((r) => setImmediate(r));
    expect(child.killed).toBe(false);

    // 第二次 agent_end：后代已完成 → final kill（keep-alive 结束，无进展 timer 同撤）
    emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
    await new Promise((r) => setImmediate(r));
    expect(child.killed).toBe(true);

    // 反证 timer 已撤：advance 30min 不再有任何残留 kill 副作用（进程已 close 收尾）
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 143);
    const result = (await promise) as Awaited<ReturnType<typeof runSpawn>>;
    expect(result.success).toBe(true);
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS + 60_000);
    expect(child.killSignal).toBe("SIGTERM"); // 仅 final kill 一次，无二次信号
  });
});
