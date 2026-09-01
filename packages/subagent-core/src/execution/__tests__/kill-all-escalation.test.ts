// src/execution/__tests__/kill-all-escalation.test.ts
//
// [T2-⑤ / LC-2] killAllSpawnedChildren 的跳过条件收敛：「killed 且已确认死亡才跳过」。
//
// 设计：docs/design/subagent-core-unbounded-wait-audit.md §7.2 T2-⑤。旧实现按
// child.killed 跳过——killed=true 只表示「发过 kill 请求」≠「已死」，SIGTERM 被无视
// 的进程（卡死在不可中断 native 调用）会脱离最后一次回收窗口泄漏。新规则：
//   - 已确认死亡（exitCode/signalCode 任一非 null）→ 跳过；
//   - killed 但未确认死亡 → 补 escalation 检查：直接 SIGKILL（dispose 是最后兜底，
//     没有 30s 升级窗口可等）；
//   - 未 killed 且未确认死亡 → 发调用方指定 signal（既有行为）。

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
vi.mock("../session-pending.ts", () => ({
  readActivePendingFromSessionFile: vi.fn(() => ({ count: 0, recentUnregister: false })),
  prunePendingCursor: vi.fn(),
  listActivePendingFromSessionFile: vi.fn(() => ({ items: [] })),
}));
vi.mock("../temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { killAllSpawnedChildren, runSpawn, spawnedChildren } from "../session-runner.ts";
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
const lastSpawnedChild = (): FakeChild => lastSpawnedChildOf(mockSpawn);
const waitForSpawn = (timeoutMs = 1000): Promise<void> => waitForSpawnOf(mockSpawn, timeoutMs);

describe("[T2-⑤ / LC-2] killAllSpawnedChildren 跳过条件收敛", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    killAllSpawnedChildren(); // 清可能残留的 Map 条目（前序用例/文件）
    spawnedChildren.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("killed 但未 close（SIGTERM 发过、进程未确认死亡）→ 不跳过，补 SIGKILL 升级", async () => {
    const record = makeRecord("esc-1");
    const promise = runSpawn(record, "Task: esc", makeOpts(), makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();

    // 模拟 SIGTERM 已发但进程仍在（LC-2 缺陷形态：killed=发过请求≠已死）
    child.killed = true;
    child.killSignal = "SIGTERM";
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    const n = killAllSpawnedChildren();
    expect(n).toBe(1);
    // 补 escalation：dispose 是最后兜底，直接 SIGKILL（不再赌 SIGTERM 生效）
    expect(child.killSignal).toBe("SIGKILL");

    // 收尾：emit close 让 runSpawn resolve
    emitStdoutLine(child, { type: "session", id: "s", timestamp: "t", cwd: "/tmp" });
    child.stdout.end();
    child.emit("close", 137);
    const result = await promise;
    expect(result.success).toBe(true);
  });

  it("killed 且已确认死亡（signalCode 非 null）→ 跳过", async () => {
    const record = makeRecord("esc-2");
    const promise = runSpawn(record, "Task: dead-skip", makeOpts(), makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();

    // SIGTERM 已发（经 child.kill 记录信号）且进程已确认死亡（内核回收完成、
    // close 事件尚未回调的窗口）
    child.kill("SIGTERM");
    child.signalCode = "SIGTERM";

    const n = killAllSpawnedChildren();
    expect(n).toBe(0); // 跳过，不重复发信号
    expect(child.killSignal).toBe("SIGTERM"); // 保持原信号（未被改写为 SIGKILL）

    child.stdout.end();
    child.emit("close", 143);
    await promise;
  });

  it("未 killed 且未确认死亡 → 发调用方 signal（既有行为不变）", async () => {
    const record = makeRecord("esc-3");
    const promise = runSpawn(record, "Task: alive", makeOpts(), makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();
    expect(child.killed).toBe(false);

    const n = killAllSpawnedChildren("SIGTERM");
    expect(n).toBe(1);
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGTERM");

    child.stdout.end();
    child.emit("close", 143);
    await promise;
  });

  it("未 killed 但已确认死亡（自然退出、close 未到）→ 跳过不补信号", async () => {
    const record = makeRecord("esc-4");
    const promise = runSpawn(record, "Task: natural", makeOpts(), makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();
    child.exitCode = 0; // 自然退出

    const n = killAllSpawnedChildren();
    expect(n).toBe(0);
    expect(child.killed).toBe(false);

    child.stdout.end();
    child.emit("close", 0);
    await promise;
  });

  it("混合形态：各分支独立判定（killed-not-dead 升级 / alive 首杀 / dead 跳过）", async () => {
    const mk = async (id: string): Promise<{ child: FakeChild; promise: Promise<unknown> }> => {
      const promise = runSpawn(makeRecord(id), `Task: ${id}`, makeOpts(), makeCtx());
      await waitForSpawn();
      return { child: lastSpawnedChild(), promise };
    };

    const a = await mk("mix-a");
    a.child.killed = true; // killed-not-dead → SIGKILL
    const b = await mk("mix-b"); // alive → SIGTERM
    const c = await mk("mix-c");
    c.child.signalCode = "SIGKILL"; // dead → skip

    const n = killAllSpawnedChildren();
    expect(n).toBe(2);
    expect(a.child.killSignal).toBe("SIGKILL");
    expect(b.child.killSignal).toBe("SIGTERM");
    expect(c.child.killSignal).toBeUndefined();

    for (const { child, promise } of [a, b, c]) {
      child.stdout.end();
      child.emit("close", 143);
      await promise;
    }
  });
});
