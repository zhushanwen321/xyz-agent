// src/execution/__tests__/keep-alive-no-progress.test.ts
//
// [T2-① / P-T2 降级路径 B] keep-alive 裸缺省无进展检测上界。
//
// 设计：docs/design/subagent-core-unbounded-wait-audit.md §7.2 T2-① + impl-plan §5
// P-T2 裁决（probe/p-t2-report.md）：历史 89 样本 96.6% keep-alive 窗口 >30min、
// 长尾 95.5h 合法（parent-shutdown 收敛）——固定 30min 上限被数据否定，按设计降级
// 路径 B 落地为无进展检测语义：
//   - 裸缺省（无 maxTurns 无 env）：keep-alive 期间任何子进程 stdout 活动刷新计时，
//     连续静默达 KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS（30min）且 fire 时惰性复核无存活
//     后代（A1-2）才处置；
//   - 显式 maxTurns / env：行为不变（既有固定时长等待，不挂无进展 timer——opt-out
//     语义保留，A1-1：显式 maxTurns<=0 与 fail-fast 降级也不挂）。
//
// mock 布局与 run-spawn-edges.test.ts 一致（FakeChild + mock session-pending）。

import { spawn } from "node:child_process";
import * as fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// [A1-2③] Mock 共享 logger：复核失败的 warn 留痕可被断言（对齐 run-spawn-edges 模式）。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

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

import {
  KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS,
  maxTurnsToWatchdogMs,
  runSpawn,
  SPAWN_WATCHDOG_ENV,
} from "../engine/engines/pi/session-runner.ts";
import { listActivePendingFromSessionFile, readActivePendingFromSessionFile } from "../session-pending.ts";
import { isProcessAlive, readAliveMarker, writeAliveMarker } from "../alive-store.ts";
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
const mockListPending = vi.mocked(listActivePendingFromSessionFile);
const mockReadAliveMarker = vi.mocked(readAliveMarker);
const mockWriteAliveMarker = vi.mocked(writeAliveMarker);
const mockIsProcessAlive = vi.mocked(isProcessAlive);
const mockReaddirSync = vi.mocked(fs.readdirSync);

/** A1-2 复核用例的后代 pid（存/死两形态，对齐 descendant-sweep.test.ts 数值风格）。 */
const LIVE_DESCENDANT_PID = 424_242;
const DEAD_DESCENDANT_PID = 999_999;

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
    // 真实 ChildProcess 语义：被 SIGTERM 杀死 → 先 exit(null,'SIGTERM') 再 close。只发
    // close 不发 exit 时 killChain 升级窗口不结算（waitForExit 挂 exit 事件），下方
    // advance 30min+ 会越过 30s grace 误触发 SIGKILL 升级——补 exit 忠实模拟进程已死。
    child.signalCode = "SIGTERM";
    child.emit("exit", null, "SIGTERM");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 143);
    const result = (await promise) as Awaited<ReturnType<typeof runSpawn>>;
    expect(result.success).toBe(true);
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS + 60_000);
    expect(child.killSignal).toBe("SIGTERM"); // 仅 final kill 一次，无二次信号
  });

  // ── [A1-1] 挂载面收窄：只有裸缺省（maxTurns 未传且 env 未设）挂无进展 timer ──

  it("A1-1: 显式 maxTurns:0（显式不限时）→ 不挂无进展 timer，静默超阈值不处置", async () => {
    const { child, finish } = await spawnAndReachKeepAlive(makeOpts({ maxTurns: 0 }));
    expect(child.killed).toBe(false);

    // 无进展阈值（30min）处静默不 kill：timer 未挂（旧实现 keepAliveMs === undefined
    // 即挂 timer，30min 处会误 kill——本断言守护挂载面收窄）
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS);
    expect(child.killed).toBe(false);

    // 显式 opt-out 旧语义 = 等待后代不限时：远超阈值仍无任何 timer 处置
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS * 3);
    expect(child.killed).toBe(false);

    await finish();
  });

  it("A1-1: env 已设 + maxTurns:0（参数显式压过 env，U5）→ 同样不挂无进展 timer", async () => {
    vi.stubEnv(SPAWN_WATCHDOG_ENV, "600000"); // 10min
    const { child, finish } = await spawnAndReachKeepAlive(makeOpts({ maxTurns: 0 }));

    // 同时越过 env 时限（10min）与无进展阈值（30min）仍不 kill：显式 maxTurns<=0
    // 压过 env（U5），env 固定 watchdog 与无进展 timer 均未挂
    await vi.advanceTimersByTimeAsync(Math.max(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS, 600_000) + 60_000);
    expect(child.killed).toBe(false);

    await finish();
  });

  // ── [A1-2] fire 惰性复核：stdout 静默 ≠ 无进展，存活后代是刷新信号源的另一半 ──

  it("A1-2①: fire 复核有存活活跃后代 → 视为有进展重挂（30min 固定复核节奏），不处置层主", async () => {
    // 后代 pending 差集非空 + pid 存活（与 descendant sweep 同源判据）
    mockListPending.mockReturnValue({
      items: [{ id: "bg-1", sessionId: "ka-desc-sess", type: "session" }],
    });
    mockReaddirSync.mockReturnValue(["20260901T000000-000_ka-desc-sess.jsonl"]);
    mockReadAliveMarker.mockImplementation((f: unknown) =>
      String(f).endsWith("_ka-desc-sess.jsonl")
        ? { pid: LIVE_DESCENDANT_PID, id: "ka-desc-sess", startedAt: 0 }
        : undefined,
    );
    mockIsProcessAlive.mockImplementation((pid: number) => pid === LIVE_DESCENDANT_PID);

    const { child, finish } = await spawnAndReachKeepAlive();
    expect(child.killed).toBe(false);

    // [A1-2 补修] 清掉 agent_end 处置写点的心跳基线：只统计 fire 重挂分支随行的心跳
    mockWriteAliveMarker.mockClear();

    // 第 1 次连续静默 30min fire：复核发现存活后代 → 重挂不处置
    //（「直接后代跑 >30min、层主静默」的合法形态，P-T2 数据 85/89 parent-shutdown）
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS);
    expect(child.killed).toBe(false);

    // 第 2 个 30min 再 fire（固定复核节奏直到后代死光）：后代仍活 → 仍不处置
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS);
    expect(child.killed).toBe(false);

    // [A1-2 补修] 每次复核重挂随行一次心跳：合法化形态「层主静默 + 后代长跑数小时」
    // 期间层主无 agent_end（原心跳写点不再触达），重挂分支是唯一心跳源——缺失则
    // marker 超 1h 软超时判陈旧 → 透明重生放行双写 / 孤儿恢复误终态活 record
    expect(mockWriteAliveMarker).toHaveBeenCalledTimes(2);
    // 心跳写点 = 层主 sessionFile + 子进程 pid（marker 软超时基准刷新语义）
    expect(mockWriteAliveMarker).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ pid: child.pid }),
    );

    await finish();
  });

  it("A1-2②: fire 复核后代差集非空但 pid 全部已死 → 真静默，执行处置", async () => {
    mockListPending.mockReturnValue({
      items: [{ id: "bg-1", sessionId: "ka-dead-sess", type: "session" }],
    });
    mockReaddirSync.mockReturnValue(["20260901T000000-000_ka-dead-sess.jsonl"]);
    mockReadAliveMarker.mockImplementation((f: unknown) =>
      String(f).endsWith("_ka-dead-sess.jsonl")
        ? { pid: DEAD_DESCENDANT_PID, id: "ka-dead-sess", startedAt: 0 }
        : undefined,
    );
    mockIsProcessAlive.mockReturnValue(false); // 全部已死

    const { child, finish } = await spawnAndReachKeepAlive();

    // fire：差集非空但无任何存活 pid → 真静默 → 处置（SIGTERM + sweep 标志承接）
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS);
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGTERM");

    await finish();
  });

  it("A1-2③: fire 复核失败（sessionFile 读不出）→ 按无后代处置 + warn 留痕", async () => {
    mockListPending.mockReturnValue({
      items: [],
      error: "session file unreadable: ENOENT",
    });

    const { child, finish } = await spawnAndReachKeepAlive();

    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS);
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGTERM");
    // 复核失败 warn 留痕（与既有保守分支一致的可观测性）
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("re-check failed (treating as no live descendants)"),
    );

    await finish();
  });
});
