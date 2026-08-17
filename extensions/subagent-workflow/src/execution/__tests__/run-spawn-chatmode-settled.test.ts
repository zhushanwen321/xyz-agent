// src/execution/__tests__/run-spawn-chatmode-settled.test.ts
//
// [V2 模块 3] chatMode agent_settled 信号换挂单测（Step 3）。
//
// 验证 session-runner 的 V2 改动（5 处）：
//   ① chatMode record agent_end 不触发 SIGTERM（进程保活，等 agent_settled）
//   ② chatMode record agent_settled 触发 armIdleTimer（fake timer + 超时后 kill）
//   ③ chatMode agent_settled 调 ctx.onRoundSettled（挂载点，mock 断言被调）
//   ④ 非 chatMode agent_settled 不 armIdleTimer、不调 onRoundSettled
//
// mock 结构与 run-spawn-edges.test.ts 一致（FakeChild + session-pending 受控 count=0）。
// lifecycle-manager 用真实模块（hasIdleTimer / _resetLifecycleState 可观测 + 隔离）。

import { spawn } from "node:child_process";
import * as fs from "node:fs";

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

vi.mock("../alive-store.ts", () => ({
  writeAliveMarker: vi.fn(),
}));

// chatMode 测试不依赖后代判定（chatMode agent_end 早返回跳过 readActivePending），统一 count=0。
// 非 chatMode 用例 ④ 的 agent_end 走正常 kill 分支（count=0 → SIGTERM）。
vi.mock("../session-pending.ts", () => ({
  readActivePendingFromSessionFile: vi.fn(() => ({ count: 0 })),
}));

vi.mock("../temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { runSpawn } from "../session-runner.ts";
import type { SessionRunnerContext } from "../session-runner.ts";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  hasIdleTimer,
  _resetLifecycleState,
} from "../lifecycle-manager.ts";
import { createRecord } from "../execution-record.ts";
import type { ExecutionRecord } from "../types.ts";
import {
  emitStdoutLine,
  type FakeChild,
  lastSpawnedChild as lastSpawnedChildOf,
  makeCtx,
  makeOpts,
  makeRecord,
  sessionHeader,
  waitForSpawn as waitForSpawnOf,
} from "./helpers/spawn-mock.ts";

const mockSpawn = vi.mocked(spawn);

const lastSpawnedChild = (): FakeChild => lastSpawnedChildOf(mockSpawn);
const waitForSpawn = (timeoutMs = 1000): Promise<void> => waitForSpawnOf(mockSpawn, timeoutMs);

/** 构造 chatMode record（spawn-mock.makeRecord 默认非 chatMode，此处显式开启）。 */
function makeChatModeRecord(id = "sa-chat"): ExecutionRecord {
  return createRecord(id, {
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
}

describe("[V2 模块 3] chatMode agent_settled 信号换挂", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // lifecycle-manager 是模块级单例（idleTimers Map 跨用例共享），每用例前清空防泄漏。
    _resetLifecycleState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    _resetLifecycleState();
  });

  it("① chatMode agent_end → 不触发 SIGTERM（进程保活，等 agent_settled）", async () => {
    const record = makeChatModeRecord("sa-chat-end");
    const promise = runSpawn(record, "Task: chatmode-end", makeOpts(), makeCtx());

    await waitForSpawn();
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeader());
    emitStdoutLine(child, { type: "agent_end", willRetry: false });
    // 让事件 pump 处理 agent_end（stream flush 异步）
    await new Promise((r) => setTimeout(r, 20));

    // [V2 决策 1] chatMode agent_end 不 kill——进程不因轮次死，等 agent_settled。
    expect(child.killed).toBe(false);
    // agent_end 不 arm idle timer（arm 点是 agent_settled，不是 agent_end）
    expect(hasIdleTimer(record.id)).toBe(false);

    // 收尾：手动 close 让 runSpawn resolve（模拟后续 idle timer 超时 kill / 外部终止）
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 143);
    const result = await promise;
    expect(result.success).toBe(true);
  });

  it("② chatMode agent_settled → armIdleTimer，idle 超时后 SIGTERM kill", async () => {
    const record = makeChatModeRecord("sa-chat-settled");
    const promise = runSpawn(record, "Task: chatmode-settled", makeOpts(), makeCtx());

    await waitForSpawn();
    const child = lastSpawnedChild();

    // 必须在 emit agent_settled 前启用 fake timers——armIdleTimer 内 setTimeout 在 agent_settled
    // 处理器里新建，新建时已是 fake timer 才可 advance。不 fake setImmediate：stream flush 靠
    // 真实事件循环。对齐 run-spawn-edges MF-3/MF-4 模式。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      emitStdoutLine(child, sessionHeader());
      emitStdoutLine(child, { type: "agent_end", willRetry: false });
      await new Promise((r) => setImmediate(r));
      emitStdoutLine(child, { type: "agent_settled" });
      await new Promise((r) => setImmediate(r));

      // agent_settled → arm idle timer（DEFAULT_IDLE_TIMEOUT_MS = 5min）
      expect(hasIdleTimer(record.id)).toBe(true);
      // 进程仍存活（idle timer 未到期）
      expect(child.killed).toBe(false);

      // 未到 idle timeout（5min - 1ms）：不 kill
      await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS - 1);
      expect(child.killed).toBe(false);

      // idle timeout 到期：onTimeout → child.kill("SIGTERM")（复用现有 kill 路径）
      await vi.advanceTimersByTimeAsync(1);
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");
      // timer 触发后从 Map 移除（armIdleTimer 内 setTimeout 回调 idleTimers.delete）
      expect(hasIdleTimer(record.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    // 收尾：close 让 runSpawn resolve
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 143);
    const result = await promise;
    expect(result.success).toBe(true);
  });

  it("③ chatMode agent_settled → 调 ctx.onRoundSettled（Step 3 挂载点，回调被调 1 次）", async () => {
    const record = makeChatModeRecord("sa-chat-cb");
    const onRoundSettled = vi.fn();
    const ctx: SessionRunnerContext = makeCtx({ onRoundSettled });
    const promise = runSpawn(record, "Task: chatmode-cb", makeOpts(), ctx);

    await waitForSpawn();
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeader());
    emitStdoutLine(child, { type: "agent_end", willRetry: false });
    await new Promise((r) => setTimeout(r, 10));
    emitStdoutLine(child, { type: "agent_settled" });
    await new Promise((r) => setTimeout(r, 10));

    // agent_settled → onRoundSettled 被调，入参是当前 record
    expect(onRoundSettled).toHaveBeenCalledTimes(1);
    expect(onRoundSettled).toHaveBeenCalledWith(record);

    // 收尾：手动 close（idle timer 仍 armed，由 afterEach _resetLifecycleState 清理）
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 143);
    const result = await promise;
    expect(result.success).toBe(true);
  });

  it("④ 非 chatMode agent_settled → 不 armIdleTimer、不调 onRoundSettled", async () => {
    // makeRecord 默认非 chatMode（createRecord 未传 chatMode）
    const record = makeRecord("sa-nonchat-settled");
    const onRoundSettled = vi.fn();
    const ctx: SessionRunnerContext = makeCtx({ onRoundSettled });
    const promise = runSpawn(record, "Task: nonchat-settled", makeOpts(), ctx);

    await waitForSpawn();
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeader());
    // 直接 emit agent_settled（非 chatMode：handler 应忽略，不 arm、不调回调）
    emitStdoutLine(child, { type: "agent_settled" });
    await new Promise((r) => setTimeout(r, 20));

    expect(hasIdleTimer(record.id)).toBe(false);
    expect(onRoundSettled).not.toHaveBeenCalled();

    // 收尾：emit agent_end 走正常 kill 分支（count=0 → SIGTERM）→ close resolve
    emitStdoutLine(child, { type: "agent_end", willRetry: false });
    await new Promise((r) => setTimeout(r, 10));
    expect(child.killed).toBe(true); // 非 chatMode agent_end → kill（现有行为，V2 不动）

    child.stdout.end();
    child.stderr.end();
    child.emit("close", 143);
    const result = await promise;
    expect(result.success).toBe(true);
  });
});
