// src/execution/__tests__/descendant-sweep-guards.test.ts
//
// [S-17c / T2-②] sweepDescendantsOfSession 守卫分支补充（与 descendant-sweep.test.ts
// 互补，不改动其既有用例）。
//
// 覆盖该文件未锁定的分支：
//   - register entry 缺 sessionId（TODO T5 marker fallback 锚点）→ skipped 留痕不杀；
//   - readProcessCmdline 两条失败边：ps 非零退出（status≠0/error）与 spawnSync 同步
//     抛错 → cmdline undefined → "cmdline probe failed" 保守跳过；
//   - killPidWithEscalation 的 SIGTERM 发送失败（EPERM 等权限/垂死窗口）→ debug
//     留痕不武装升级（30s 后无 SIGKILL）；
//   - SIGKILL 升级窗口内目标自行退出（ESRCH）→ 吞掉不崩（目标已达成）。
//
// 真实 fs（临时目录）+ mock spawnSync / process.kill / logger——同 descendant-sweep
// 布局，新增 logger mock 用于 SIGTERM 失败留痕断言。

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// 只 mock spawnSync（ps 探测受控）；spawn 等其余实现保留 actual（本文件不经 runSpawn）。
vi.mock("node:child_process", async () => {
  const actual = await import("node:child_process");
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

import { sweepDescendantsOfSession } from "../engine/engines/pi/session-runner.ts";
import { clearPendingCursors } from "../session-pending.ts";
import { writeAliveMarker } from "../alive-store.ts";

const mockSpawnSync = vi.mocked(spawnSync);

const ALIVE_PID = 424_242;

/** process.kill 受控：signal=0 探活与真实信号分别处置，信号调用记录到 kills。 */
const kills: Array<{ pid: number; signal: string | number }> = [];

function entryLine(customType: string, data: Record<string, unknown>): string {
  return `${JSON.stringify({
    type: "custom",
    customType,
    data,
    timestamp: "2026-09-01T00:00:00.000Z",
    id: `e-${Math.random().toString(36).slice(2)}`,
  })}\n`;
}

function registerData(fields: Record<string, unknown>): Record<string, unknown> {
  return { id: "bg-1", type: "session", name: "desc", status: "active", registeredAt: 1, ...fields };
}

/** ps -p <pid> -o command= 的完整 SpawnSyncReturns 形态（字段补齐省 as 链）。 */
function psResult(stdout: string, status = 0): ReturnType<typeof spawnSync> {
  return {
    pid: 0,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status,
    signal: null,
  } as ReturnType<typeof spawnSync>;
}

let sessionDir = "";

beforeEach(() => {
  vi.clearAllMocks();
  clearPendingCursors();
  kills.length = 0;
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "desc-sweep-guard-"));
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    if (signal === undefined || signal === 0) return true; // 探活恒真（目标在窗口内存活）
    kills.push({ pid, signal });
    return true;
  }) as typeof process.kill);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearPendingCursors();
  fs.rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 层主 + 一个带 .alive marker 的直接后代（标准单层树）。 */
function writeSingleLevelTree(): { rootFile: string; childFile: string } {
  const rootFile = path.join(sessionDir, "20260901T000000-000_root-sess.jsonl");
  const childFile = path.join(sessionDir, "20260901T000001-000_child-sess.jsonl");
  fs.writeFileSync(rootFile, entryLine("pending:register", registerData({ sessionId: "child-sess" })));
  fs.writeFileSync(childFile, "other entry line\n");
  writeAliveMarker(childFile, { pid: ALIVE_PID, id: "child-sess", startedAt: Date.now() });
  return { rootFile, childFile };
}

/** ps 探测默认桩：存活 pid 返回 pi rpc 形态。 */
function stubCmdlineByPid(): void {
  mockSpawnSync.mockImplementation((_cmd: string, args?: readonly string[]) => {
    const pid = Number(args?.[1]);
    return psResult(`node /usr/local/bin/pi --mode rpc --session-dir /tmp/sess-${pid}\n`);
  });
}

describe("[S-17c] sweep 守卫：pending 项缺 sessionId（T5 marker fallback 锚点）", () => {
  it("register entry 无 sessionId → skipped 留痕（reason 指向 T5 兜底），不杀任何进程", () => {
    stubCmdlineByPid();
    const rootFile = path.join(sessionDir, "20260901T000000-000_root2.jsonl");
    fs.writeFileSync(rootFile, entryLine("pending:register", registerData({ sessionId: undefined })));

    const r = sweepDescendantsOfSession(rootFile, sessionDir, "test-nosessid");

    expect(r.killed).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    // sessionId 字段回退为 pending 操作 id（诊断线索），reason 说明 marker 兜底锚点
    expect(r.skipped[0]).toMatchObject({
      sessionId: "bg-1",
      reason: expect.stringContaining("no sessionId (marker-based fallback pending T5)"),
    });
    expect(kills).toHaveLength(0);
  });
});

describe("[S-17c] sweep 守卫：readProcessCmdline 失败边（保守跳过不动手）", () => {
  it.each([
    [
      "ps 非零退出（进程刚死，ps -p 无此进程）",
      () =>
        mockSpawnSync.mockImplementation(() => psResult("", 1)),
    ],
    [
      "spawnSync 同步抛错（ps 不可用）",
      () =>
        mockSpawnSync.mockImplementation(() => {
          throw new Error("ps binary missing");
        }),
    ],
  ])("%s → cmdline probe failed，跳过不杀", (_label, setupProbe) => {
    const { rootFile } = writeSingleLevelTree();
    setupProbe();

    const r = sweepDescendantsOfSession(rootFile, sessionDir, "test-ps-fail");

    // [防误杀] 探测失败 = 无法证明是 pi rpc 形态 → 一律不动手
    expect(r.killed).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toMatchObject({
      pid: ALIVE_PID,
      reason: expect.stringContaining("cmdline probe failed (ps unavailable)"),
    });
    expect(kills).toHaveLength(0);
  });
});

describe("[S-17c] killPidWithEscalation：SIGTERM/ SIGKILL 失败边", () => {
  it("SIGTERM 发送即失败（权限/垂死窗口 EPERM）→ debug 留痕不武装升级，30s 后无 SIGKILL", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stubCmdlineByPid();
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === undefined || signal === 0) return true;
      if (signal === "SIGTERM") {
        const err = new Error("operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      kills.push({ pid, signal });
      return true;
    }) as typeof process.kill);

    const { rootFile } = writeSingleLevelTree();
    const r = sweepDescendantsOfSession(rootFile, sessionDir, "test-sigterm-fail");

    // killed 列表记录的是处置意图；实际 SIGTERM 未送达（失败留痕，best-effort continue）
    expect(r.killed).toEqual([ALIVE_PID]);
    expect(loggerMock.debug).toHaveBeenCalledWith(
      expect.stringContaining(`SIGTERM to pid ${ALIVE_PID} failed (best-effort continue)`),
    );

    // 无升级 timer：SIGTERM 失败后直接 return，越过 30s 窗口也不补发 SIGKILL
    await vi.advanceTimersByTimeAsync(30_000);
    expect(kills).toHaveLength(0);
  });

  it("SIGKILL 升级窗口内目标自行退出（ESRCH）→ 吞掉不崩，SIGTERM 已达即目标达成", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stubCmdlineByPid();
    // 探活恒真（fire 时窗口内仍活）；SIGTERM 送达成功；SIGKILL 时进程已退出（ESRCH）
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === undefined || signal === 0) return true;
      if (signal === "SIGKILL") {
        const err = new Error("No such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      kills.push({ pid, signal });
      return true;
    }) as typeof process.kill);

    const { rootFile } = writeSingleLevelTree();
    const r = sweepDescendantsOfSession(rootFile, sessionDir, "test-sigkill-esrch");

    expect(r.killed).toEqual([ALIVE_PID]);
    expect(kills).toEqual([{ pid: ALIVE_PID, signal: "SIGTERM" }]);

    // 升级 fire：ESRCH 是预期终态（进程在窗口内自行退出），吞掉不崩不重试
    await vi.advanceTimersByTimeAsync(30_000);
    expect(kills).toEqual([{ pid: ALIVE_PID, signal: "SIGTERM" }]);
    expect(loggerMock.debug).not.toHaveBeenCalledWith(
      expect.stringContaining("SIGTERM to pid"),
    );
  });
});
