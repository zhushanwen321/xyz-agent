// src/execution/__tests__/helpers/session-runner-mocks.ts
//
// session-runner 系测试（keep-alive-no-progress / recursive-visibility-env 等）的
// 测试文件侧装配：vi.mocked 取回 + spawn/keep-alive 前奏 + 子进程收尾。
//
// 与 spawn-mock.ts 的分工（依赖约束，勿混淆）：
//   - spawn-mock.ts 会被各 vi.mock 工厂 `await import()`（求值时机 = 被 mock 模块首次
//     请求），故它禁止值依赖 session-runner / alive-store / session-pending——否则形成
//     「mock 工厂 → helper → session-runner → node:child_process（mock 求值中）」循环。
//     mock 模块工厂 + FakeChild + 纯 fixture 都在 spawn-mock.ts。
//   - 本文件只被测试文件顶层静态 import（vi.mock 已 hoist 注册完毕、mock 工厂已可安全
//     执行），故可值依赖 session-runner / alive-store / session-pending 做 vi.mocked 取回
//     与 runSpawn 前奏封装。

import { spawn } from "node:child_process";
import * as fs from "node:fs";

import { afterEach, beforeEach, vi } from "vitest";

import { runSpawn, SPAWN_WATCHDOG_ENV } from "../../engine/engines/pi/session-runner.ts";
import {
  listActivePendingFromSessionFile,
  readActivePendingFromSessionFile,
} from "../../session-pending.ts";
import { isProcessAlive, readAliveMarker, writeAliveMarker } from "../../alive-store.ts";
import {
  emitStdoutLine,
  lastSpawnedChild,
  makeCtx,
  makeOpts,
  makeRecord,
  waitForSpawn,
  type FakeChild,
} from "./spawn-mock.ts";

/** keep-alive 用例的 session header 行（stdout 首行）。 */
function sessionHeaderLine(): Record<string, unknown> {
  return { type: "session", id: "sess-ka", timestamp: "2026-09-01T00:00:00.000Z", cwd: "/tmp/test" };
}

/** vi.mocked 取回超集（各测试文件按需解构；与各 vi.mock 工厂返回同一 mock 实例）。 */
export function takeSessionRunnerMocks() {
  return {
    mockSpawn: vi.mocked(spawn),
    mockExistsSync: vi.mocked(fs.existsSync),
    mockReaddirSync: vi.mocked(fs.readdirSync as (path: fs.PathLike) => string[]),
    mockPending: vi.mocked(readActivePendingFromSessionFile),
    mockListPending: vi.mocked(listActivePendingFromSessionFile),
    mockReadAliveMarker: vi.mocked(readAliveMarker),
    mockWriteAliveMarker: vi.mocked(writeAliveMarker),
    mockIsProcessAlive: vi.mocked(isProcessAlive),
  };
}

/**
 * 非 chatMode 层主 + fake timers + agent_end keep-alive 落位的公共前奏。
 *
 * 返回 promise（runSpawn 原始 promise，供手动 exit/close 收尾的用例）与 finish
 * （标准 close 收尾）两种取用形态。
 */
export async function spawnAndReachKeepAlive(
  opts = makeOpts(),
  task = "Task: keep-alive no-progress",
): Promise<{
  child: FakeChild;
  promise: Promise<Awaited<ReturnType<typeof runSpawn>>>;
  finish: (code?: number) => Promise<Awaited<ReturnType<typeof runSpawn>>>;
}> {
  const record = makeRecord();
  const promise = runSpawn(record, task, opts, makeCtx());
  await waitForSpawn(vi.mocked(spawn));
  const child = lastSpawnedChild(vi.mocked(spawn));
  // fake timers 必须在 emit agent_end 之前启用（keep-alive timer 新建于 agent_end
  // 处理器内；不 fake setImmediate——stream flush 靠真实事件循环交付，见 MF-3 先例）。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  emitStdoutLine(child, sessionHeaderLine());
  emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
  await new Promise((r) => setImmediate(r));
  return {
    child,
    promise,
    finish: (code = 143) => {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code);
      return promise as Promise<Awaited<ReturnType<typeof runSpawn>>>;
    },
  };
}

/** 让最近 spawn 的 FakeChild 发 close(0) 并等 runSpawn 收尾（env 注入用例的标准收尾装配）。 */
export async function closeLastChildAndAwait<T>(promise: Promise<T>): Promise<T> {
  const child = lastSpawnedChild(vi.mocked(spawn));
  child.emit("close", 0);
  return promise;
}

/** keep-alive 系测试的统一 hooks：清 mock + stub 空 watchdog env + 统一恢复（在 describe 内调用）。 */
export function keepAliveTestHooks(
  mockPending: ReturnType<typeof takeSessionRunnerMocks>["mockPending"],
): void {
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
}
