// src/execution/__tests__/session-runner-epipe.test.ts
//
// [v4 A-1] session-runner 异步 stdin 'error' listener 测试。
//
// 背景：writeStdinLine 的 try/catch 只覆盖同步 write 抛错；子进程退出后内核回写 EPIPE
// 以异步 stream 'error' event 到达，若无 listener 会让 Node 抛 unhandled 'error' 崩主进程（P1）。
// runSpawn 在 spawn 后、首次 stdin 写入前注册 child.stdin.on('error') handler，合并
// 同步/异步 EPIPE 计数（共用 stdin-writer 的 recordEpipeFailure）。
//
// 验收：① listener 存在 ② error 触发后 spawnedChildren 不含该 recordId
//      ③ recordEpipeFailure 计数累加（同步/异步合并）

import { spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const { FakeChild } = await import("./helpers/spawn-mock.ts");
  return {
    spawn: vi.fn(() => new FakeChild()),
    // buildEnvBlock 的 git branch 调用（execFile 异步）：默认 err-first 兜底 → catch → branch=""
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
  readActivePendingFromSessionFile: vi.fn(() => ({ count: 0 })),
  prunePendingCursor: vi.fn(),
}));

vi.mock("../engine/engines/pi/temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import {
  EPIPE_FAILURE_THRESHOLD,
  recordEpipeFailure,
  resetAllEpipeFailures,
} from "../engine/engines/pi/stdin-writer.ts";
import { runSpawn, spawnedChildren } from "../engine/engines/pi/session-runner.ts";
import { _resetLifecycleState } from "../lifecycle-manager.ts";
import {
  FakeChild,
  lastSpawnedChild as lastSpawnedChildOf,
  makeCtx,
  makeOpts,
  makeRecord,
  waitForSpawn as waitForSpawnOf,
} from "./helpers/spawn-mock.ts";

const mockSpawn = vi.mocked(spawn);
const lastSpawnedChild = (): FakeChild => lastSpawnedChildOf(mockSpawn);
const waitForSpawn = (timeoutMs = 1000): Promise<void> => waitForSpawnOf(mockSpawn, timeoutMs);

/** 构造 EPIPE errno 错误（模拟子进程退出后内核回写 EPIPE）。 */
function epipeError(message = "write after end"): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = "EPIPE";
  return err;
}

/** 手动 emit close 让 runSpawn 的 exitCode promise resolve（非 chatMode 默认 close resolve）。 */
function settleRunSpawn(child: FakeChild): void {
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0);
}

describe("[v4 A-1] session-runner 异步 stdin 'error' listener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetLifecycleState();
    resetAllEpipeFailures();
    spawnedChildren.clear();
  });

  afterEach(() => {
    _resetLifecycleState();
    resetAllEpipeFailures();
    spawnedChildren.clear();
  });

  it("① spawn 后注册 child.stdin 'error' listener", async () => {
    const record = makeRecord("sa-listener");
    const promise = runSpawn(record, "Task: listener-exists", makeOpts(), makeCtx());

    await waitForSpawn();
    const child = lastSpawnedChild();

    // listener 已注册——无 listener 时异步 EPIPE 会崩主进程（这是 A-1 修复的 P1）
    expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);

    settleRunSpawn(child);
    await promise;
  });

  it("②③ async stdin 'error' → 移出 spawnedChildren + recordEpipeFailure 计数递增", async () => {
    const record = makeRecord("sa-async-epipe");
    const promise = runSpawn(record, "Task: async-epipe", makeOpts(), makeCtx());

    await waitForSpawn();
    const child = lastSpawnedChild();

    // runSpawn 已把 child 注册进 spawnedChildren
    expect(spawnedChildren.has(record.id)).toBe(true);

    // 发一次异步 stdin 'error'（count 0→1，未达阈值，handler 只 warn 不 throw）
    child.stdin.emit("error", epipeError());

    // ② spawnedChildren 已移除该 recordId（标记 dead）
    expect(spawnedChildren.has(record.id)).toBe(false);

    // ③ 计数累加：handler 调 recordEpipeFailure 设为 1；此处再调一次应返回 2
    //    （若 handler 未运行，counter 仍为 0，本次调用只会返回 1）
    expect(recordEpipeFailure(record.id)).toBe(2);

    settleRunSpawn(child);
    await promise;
  });

  it("③ 同步预置计数 + 异步 stdin 'error' 合并计数（handler 不 throw，防 listener 内 throw 崩进程）", async () => {
    const record = makeRecord("sa-threshold");
    const promise = runSpawn(record, "Task: threshold", makeOpts(), makeCtx());

    await waitForSpawn();
    const child = lastSpawnedChild();

    // 预置 count=1（模拟 deliverMessage 同步路径已计 1 次失败——证明共用同一计数器）
    expect(recordEpipeFailure(record.id)).toBe(1);

    // [v4 A-1 裁决] async handler 内不 throw（stream 'error' listener 内 throw 会经 emit
    // 传播为 uncaughtException 崩主进程，违背 A-1 防崩）——达阈值 throw 留同步路径。
    // emit 不抛错：
    expect(() => child.stdin.emit("error", epipeError())).not.toThrow();

    // handler 调 recordEpipeFailure → count=2（达阈值但 async 不 throw）；此处再调返回 3
    expect(recordEpipeFailure(record.id)).toBe(3);
    expect(EPIPE_FAILURE_THRESHOLD).toBe(2);

    // handler 已移出 spawnedChildren（标记 dead，下次 deliverMessage 检测走冷路径）
    expect(spawnedChildren.has(record.id)).toBe(false);

    settleRunSpawn(child);
    await promise;
  });
});
