// src/execution/__tests__/chatmode-first-round-closure-spawn.test.ts
//
// [V2 决策 2] chatMode 首轮闭环——runSpawn resolve 时机（Step 4a 改动 1）。
//
// 改动 1：chatMode agent_settled 时提前 resolve runSpawn 的 exitCode promise（exit code 0），
// 让 runAndFinalize 拿到首轮 result，进程仍保活（idle timer armed）。非 chatMode 不变
//（agent_end kill → close resolve）。
//
// 本文件验证 resolve 时机（run-spawn-chatmode-settled.test.ts 验证 idle timer + 回调挂载点，
// 收尾靠 emit close 让 resolve——隐含 agent_settled 不 resolve；本文件显式断言 agent_settled
// 即 resolve，且进程未 close）。
//
// mock 结构与 run-spawn-chatmode-settled.test.ts 一致（FakeChild + session-pending count=0）。

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

vi.mock("../alive-store.ts", () => ({ writeAliveMarker: vi.fn() }));

// chatMode agent_end 早返回（continue），不读 session-pending；统一 count=0 防干扰。
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

import { runSpawn } from "../engine/engines/pi/session-runner.ts";
import type { SessionRunnerContext } from "../engine/engines/pi/session-runner.ts";
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

/** 用 race 探测 promise 是否在指定时间内 settle（resolve 或 reject）。 */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);
}

describe("[V2 决策 2] chatMode 首轮闭环：runSpawn resolve 时机（改动 1）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetLifecycleState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    _resetLifecycleState();
  });

  it("chatMode agent_settled → runSpawn 提前 resolve（不等 close），进程仍保活", async () => {
    const record = makeChatModeRecord("sa-first-resolve");
    const promise = runSpawn(record, "Task: first-round", makeOpts(), makeCtx());

    await waitForSpawn();
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeader());
    emitStdoutLine(child, { type: "agent_end", willRetry: false });
    // 让 stdout flush 处理 agent_end（chatMode 分支 continue，不 kill）
    await new Promise((r) => setTimeout(r, 10));
    emitStdoutLine(child, { type: "agent_settled" });

    // [改动 1 核心] agent_settled 后 runSpawn 立即 resolve（resolveRun(0)），不等 close。
    // 若改动 1 未生效，promise 会 hang 等 close，settlesWithin 返回 false。
    expect(await settlesWithin(promise, 500)).toBe(true);
    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("sess-abc");

    // 进程仍保活：agent_settled 只 resolve promise，未 kill、未 emit close。
    // idle timer（5min 真实 setTimeout）armed 但未到期。
    expect(child.killed).toBe(false);

    // 收尾：手动 close（模拟后续 idle timer 超时 kill / 外部终止）。
    // close handler 的 cleanup 仍执行（resolve(code) 是 no-op，Promise 已 resolve）。
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0);
  });

  it("非 chatMode runSpawn 仍在 close resolve（agent_settled 不触发 resolve）", async () => {
    // makeRecord 默认非 chatMode
    const record = makeRecord("sa-nonchat-resolve");
    const promise = runSpawn(record, "Task: nonchat", makeOpts(), makeCtx());

    await waitForSpawn();
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeader());
    emitStdoutLine(child, { type: "agent_end", willRetry: false });
    // 非 chatMode agent_end → count=0 → SIGTERM kill
    await new Promise((r) => setTimeout(r, 10));
    expect(child.killed).toBe(true);

    // agent_settled 在非 chatMode 下被忽略（handler 直接 return，不调 resolveRun）
    emitStdoutLine(child, { type: "agent_settled" });
    await new Promise((r) => setTimeout(r, 20));

    // [回归防护] agent_settled 不 resolve 非 chatMode runSpawn——promise 仍 pending（等 close）。
    expect(await settlesWithin(promise, 200)).toBe(false);

    // emit close 才 resolve（现有行为，改动 1 不影响非 chatMode）
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 143);
    const result = await promise;
    expect(result.success).toBe(true); // 信号终止（143 ≥ threshold）视为正常完成
  });
});
