// src/execution/__tests__/descendant-sweep.test.ts
//
// [T2-② / P-T2b 主路径] 后代级联补杀 sweep + session-pending 差集清单导出。
//
// 设计：docs/design/subagent-core-unbounded-wait-audit.md §7.2 T2-②；P-T2b 裁决
//（probe/p-t2b-report.md）：pi SIGTERM 不级联孤儿后台后代（NO-CASCADE 三次稳定复现），
// 补杀为主路径。覆盖：
//   - listActivePendingFromSessionFile：register−unregister 差集、sessionId 提取、
//     与 count 口径共享增量游标（交错调用不错位）。
//   - sweepDescendantsOfSession：迭代展开至叶、pid 存活校验、cmdline（pi/--mode rpc）
//     防误杀校验、反查失败 skip（T5 marker fallback TODO 锚点）。
//   - looksLikePiRpcProcess：命中 / 拒绝形态矩阵。
//   - killPidWithEscalation：SIGTERM 后 30s 仍活升级 SIGKILL（fake timers）。
//
// 真实 fs（临时目录）+ mock process.kill / spawnSync——session-pending 增量游标与
// findSessionFileByHeaderId 的文件形态语义被真实执行。

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 只 mock spawnSync（ps 探测受控）；spawn 等其余实现保留 actual（本文件不经 runSpawn）。
vi.mock("node:child_process", async () => {
  const actual = await import("node:child_process");
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

import {
  looksLikePiRpcProcess,
  sweepDescendantsOfSession,
} from "../session-runner.ts";
import {
  clearPendingCursors,
  listActivePendingFromSessionFile,
  readActivePendingFromSessionFile,
} from "../session-pending.ts";
import { writeAliveMarker } from "../alive-store.ts";

const mockSpawnSync = vi.mocked(spawnSync);

const ALIVE_PID_CHILD = 424_242;
const ALIVE_PID_GRAND = 424_243;
const DEAD_PID = 999_999;

/** process.kill 受控：signal=0 探活（死 pid 抛 ESRCH），其余记录到 kills。 */
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

function registerData(id: string, sessionId: string): Record<string, unknown> {
  return { id, type: "session", name: `desc-${id}`, status: "active", registeredAt: 1, expiresAt: undefined, sessionId };
}

let sessionDir = "";

beforeEach(() => {
  clearPendingCursors();
  kills.length = 0;
  mockSpawnSync.mockReset();
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "desc-sweep-"));
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    if ((signal ?? 0) === 0) {
      if (pid === DEAD_PID) {
        const err = new Error("No such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }
    kills.push({ pid, signal: signal as string | number });
    return true;
  }) as typeof process.kill);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearPendingCursors();
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

/** 标准三层树：root（层主）→ child-sess → grand-sess（叶）。 */
function writeThreeLevelTree(): { rootFile: string; childFile: string; grandFile: string } {
  const rootFile = path.join(sessionDir, "20260901T000000-000_root-sess.jsonl");
  const childFile = path.join(sessionDir, "20260901T000001-000_child-sess.jsonl");
  const grandFile = path.join(sessionDir, "20260901T000002-000_grand-sess.jsonl");
  // 层主：注册了 child（未 unregister）
  fs.writeFileSync(rootFile, entryLine("pending:register", registerData("bg-1", "child-sess")));
  // child：注册了 grand（未 unregister）——sweep 须迭代至叶
  fs.writeFileSync(childFile, entryLine("pending:register", registerData("bg-2", "grand-sess")));
  // grand：叶，无 pending
  fs.writeFileSync(grandFile, "other entry line\n");
  // .alive sidecar：pid 线索来源
  writeAliveMarker(childFile, { pid: ALIVE_PID_CHILD, id: "child-sess", startedAt: Date.now() });
  writeAliveMarker(grandFile, { pid: ALIVE_PID_GRAND, id: "grand-sess", startedAt: Date.now() });
  return { rootFile, childFile, grandFile };
}

/** ps -p <pid> -o command= 的完整 SpawnSyncReturns 形态（测试桩用，字段补齐省 as 链）。 */
function psResult(stdout: string): ReturnType<typeof spawnSync> {
  return {
    pid: 0,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
  } as ReturnType<typeof spawnSync>;
}

/** ps 探测默认桩：全部存活 pid 返回 pi rpc 形态。 */
function stubCmdlineByPid(): void {
  mockSpawnSync.mockImplementation((_cmd: string, args: readonly string[]) => {
    const pid = Number(args[1]);
    return psResult(`node /usr/local/bin/pi --mode rpc --no-extensions --session-dir /tmp/sess-${pid}\n`);
  });
}

describe("[T2-②] listActivePendingFromSessionFile（差集清单）", () => {
  it("register−unregister 差集 + sessionId/type 提取", () => {
    const f = path.join(sessionDir, "a.jsonl");
    fs.writeFileSync(
      f,
      entryLine("pending:register", registerData("bg-1", "sess-1")) +
        entryLine("pending:register", registerData("bg-2", "sess-2")) +
        entryLine("pending:unregister", { id: "bg-1" }),
    );
    const r = listActivePendingFromSessionFile(f);
    expect(r.error).toBeUndefined();
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ id: "bg-2", sessionId: "sess-2", type: "session" });
  });

  it("count 与 list 交错调用共享增量游标（结果一致、不丢条目）", () => {
    const f = path.join(sessionDir, "b.jsonl");
    fs.writeFileSync(f, entryLine("pending:register", registerData("bg-1", "sess-1")));
    // 先 count（建立游标），后 append 再 list——增量读入新行
    const c1 = readActivePendingFromSessionFile(f);
    expect(c1.count).toBe(0); // 端口缺席时缺省 0（core notify-ports 默认实现）
    fs.appendFileSync(f, entryLine("pending:register", registerData("bg-2", "sess-2")));
    const r = listActivePendingFromSessionFile(f);
    expect(r.items.map((i) => i.id).sort()).toEqual(["bg-1", "bg-2"]);
  });

  it("sessionFile undefined / 不可读 → error 面空清单", () => {
    expect(listActivePendingFromSessionFile(undefined).error).toBeDefined();
    expect(listActivePendingFromSessionFile(path.join(sessionDir, "missing.jsonl")).error).toBeDefined();
  });
});

describe("[T2-②] sweepDescendantsOfSession（迭代补杀）", () => {
  it("层主→后代→孙迭代展开至叶，双校验通过者逐个 SIGTERM", () => {
    const { rootFile } = writeThreeLevelTree();
    stubCmdlineByPid();

    const r = sweepDescendantsOfSession(rootFile, sessionDir, "keep-alive watchdog");
    expect(r.killed.sort()).toEqual([ALIVE_PID_CHILD, ALIVE_PID_GRAND].sort());
    expect(r.skipped).toHaveLength(0);
    const sigterms = kills.filter((k) => k.signal === "SIGTERM").map((k) => k.pid);
    expect(sigterms.sort()).toEqual([ALIVE_PID_CHILD, ALIVE_PID_GRAND].sort());
  });

  it("SIGTERM 后 30s 仍存活 → 升级 SIGKILL（fake timers）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { rootFile } = writeThreeLevelTree();
    stubCmdlineByPid();

    sweepDescendantsOfSession(rootFile, sessionDir, "test-escalation");
    expect(kills.filter((k) => k.signal === "SIGKILL")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);
    const sigkills = kills.filter((k) => k.signal === "SIGKILL").map((k) => k.pid);
    expect(sigkills.sort()).toEqual([ALIVE_PID_CHILD, ALIVE_PID_GRAND].sort());
  });

  it("cmdline 非 pi --mode rpc → pid 复用守卫拦截，不杀（但迭代继续展开其后代）", () => {
    const { rootFile, childFile, grandFile } = writeThreeLevelTree();
    // 伪造无关进程占住 child 的 pid；grand 正常
    mockSpawnSync.mockImplementation((_cmd: string, args: readonly string[]) => {
      const pid = Number(args[1]);
      return psResult(
        pid === ALIVE_PID_CHILD ? "vim notes.txt\n" : "pi --mode rpc\n",
      );
    });
    void childFile;
    void grandFile;

    const r = sweepDescendantsOfSession(rootFile, sessionDir, "test-guard");
    expect(r.killed).toEqual([ALIVE_PID_GRAND]); // child 被拦，grand 不受影响
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toMatchObject({ sessionId: "child-sess", pid: ALIVE_PID_CHILD });
    expect(r.skipped[0].reason).toContain("pid reuse guard");
    expect(kills.map((k) => k.pid)).toEqual([ALIVE_PID_GRAND]);
  });

  it("存活校验不过（pid 已死）→ skip 不杀", () => {
    const { rootFile, childFile } = writeThreeLevelTree();
    // child 的 marker 指向死 pid
    writeAliveMarker(childFile, { pid: DEAD_PID, id: "child-sess", startedAt: Date.now() });
    stubCmdlineByPid();

    const r = sweepDescendantsOfSession(rootFile, sessionDir, "test-dead");
    expect(r.killed).toEqual([ALIVE_PID_GRAND]);
    expect(r.skipped[0]).toMatchObject({ pid: DEAD_PID, reason: expect.stringContaining("not alive") });
  });

  it("sessionId 反查失败 / 无 alive marker → skip 留 T5 锚点原因，不中断其余分支", () => {
    const rootFile = path.join(sessionDir, "20260901T000010-000_root2.jsonl");
    const childFile = path.join(sessionDir, "20260901T000011-000_naked-sess.jsonl");
    // 两条 register：missing-sess 反查不到；naked-sess 有文件但无 .alive marker
    fs.writeFileSync(
      rootFile,
      entryLine("pending:register", registerData("bg-m", "missing-sess")) +
        entryLine("pending:register", { id: "bg-n", type: "session", name: "naked", status: "active", registeredAt: 1, expiresAt: undefined, sessionId: "naked-sess" }),
    );
    fs.writeFileSync(childFile, "");

    const r = sweepDescendantsOfSession(rootFile, sessionDir, "test-skip");
    expect(r.killed).toHaveLength(0);
    expect(r.skipped).toHaveLength(2);
    const reasons = r.skipped.map((s) => s.reason).join(" | ");
    expect(reasons).toContain("not found in sessionDir");
    expect(reasons).toContain("pending T5");
    expect(reasons).toContain("no alive marker");
  });

  it("rootSessionFile undefined → 空 result（无层主快照不扫）", () => {
    stubCmdlineByPid();
    const r = sweepDescendantsOfSession(undefined, sessionDir, "test-empty");
    expect(r.killed).toHaveLength(0);
    expect(r.skipped).toHaveLength(0);
    expect(kills).toHaveLength(0);
  });
});

describe("[T2-②] looksLikePiRpcProcess（pid 复用防误杀校验）", () => {
  it.each([
    ["pi --mode rpc --no-extensions --session-dir /tmp/x", true],
    ["node /usr/local/bin/pi --mode rpc --session-dir /tmp/x", true],
    ["/opt/pi/bin/pi --mode=rpc", true],
    ["pi.js --mode rpc", true],
  ])("命中 pi rpc 形态: %s", (cmdline, expected) => {
    expect(looksLikePiRpcProcess(cmdline)).toBe(expected);
  });

  it.each([
    ["vim notes.txt"],
    ["nginx: master process"],
    ["tail -f /dev/null"],
    ["node server.js --mode rpc"], // 有 --mode rpc 但命令不是 pi
    ["pi --mode json"], // pi 但非 rpc
    ["api --mode rpc"], // 含 "pi" 子串但非 pi 词形
  ])("拒绝无关形态: %s", (cmdline) => {
    expect(looksLikePiRpcProcess(cmdline)).toBe(false);
  });
});
