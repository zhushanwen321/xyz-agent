// src/execution/__tests__/run-spawn-stdout-callback-throw.test.ts
//
// [F-R2] stdout data 同步回调链内 fail-fast throw 不逃逸（不升级为 uncaughtException 崩宿主）。
//
// 背景：session-runner 的两处 timer 安全校验调用位于 child.stdout.on("data") 同步回调链内：
//   ① agent_end keep-alive 分支的 resolveSpawnWatchdogMs（→ assertSafeTimerDelay fail-fast）
//   ② chatMode agent_settled 分支的 armIdleTimer（→ assertSafeTimerDelay fail-fast）
// 旧实现任一处 throw 都会逃出事件回调 = Node uncaughtException 崩宿主进程。
// 修复：调用点包 try/catch 降级（不挂 timer），错误经 bestEffort("error") 可见。
//
// mock 结构与 run-spawn-chatmode-settled.test.ts 一致（FakeChild + lifecycle-manager 真实模块）。
// logger 整体 mock（loggerMock spy）断言错误可见——「fail-fast 语义保留（错误可见、行为明确）
// 但不升级为进程崩溃」。
import { spawn } from "node:child_process";
import * as fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// logger mock：bestEffort / session-runner 共享同一 loggerMock（断言错误可见性）。
// vi.hoisted：vi.mock 工厂被提升到顶层 const 之前执行，loggerMock 必须经 vi.hoisted 创建。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

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
  // [T5②] keep-alive 心跳刷新读取现有 marker id（缺失兜底 record.id）
  readAliveMarker: vi.fn(() => undefined),
  isProcessAlive: vi.fn(() => false),
}));

// 场景 ① 依赖 keep-alive 分支命中：count=1（有活跃后代 → 不 kill → 重挂 watchdog）
vi.mock("../session-pending.ts", () => ({
  readActivePendingFromSessionFile: vi.fn(() => ({ count: 1 })),
}));

vi.mock("../temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { runSpawn, SPAWN_WATCHDOG_ENV } from "../session-runner.ts";
import type { SessionRunnerContext } from "../session-runner.ts";
import { hasIdleTimer, _resetLifecycleState } from "../lifecycle-manager.ts";
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

/** 构造 chatMode record（idleTimeoutMs 设为超出 setTimeout 安全域的值 → assertSafeTimerDelay throw）。 */
function makeChatModeRecord(id = "sa-f2-idle"): ExecutionRecord {
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
    // > 2^31-1：Node setTimeout 溢出域，assertSafeTimerDelay fail-fast
    idleTimeoutMs: Number.MAX_SAFE_INTEGER,
  });
}

describe("[F-R2] stdout 回调链内 fail-fast throw 不逃逸", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetLifecycleState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetLifecycleState();
  });

  it("① agent_end keep-alive 分支 resolveSpawnWatchdogMs throw → 降级不 re-arm，run 正常收尾，error 可见", async () => {
    const record = makeRecord();
    const promise = runSpawn(record, "Task: keepalive", makeOpts(), makeCtx());

    await waitForSpawn();
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeader("sess-fr2a"));
    // 初始 watchdog 解析在 spawn 后同步块内已完成（env 未设 → 不挂）。
    // 此刻设非法 env：agent_end keep-alive 分支再读 env → assertSafeTimerDelay throw。
    process.env[SPAWN_WATCHDOG_ENV] = String(Number.MAX_SAFE_INTEGER);
    try {
      emitStdoutLine(child, { type: "agent_end", willRetry: false });
      // 给 stream flush 留一个 tick（对齐 chatmode 测试模式）：throw 若逃逸回调，
      // vitest 会以 unhandled error 判本测试失败——能走到断言即「未崩宿主」。
      await new Promise((r) => setTimeout(r, 20));

      // 降级语义：不 re-arm（无 timer 可直接观察的是——子进程未被 kill、run 未被中断）
      expect(child.killed).toBe(false);

      // 错误可见（fail-fast 语义保留）：bestEffort("error") 经 logger.error 落日志
      expect(loggerMock.error).toHaveBeenCalledWith(
        expect.stringContaining("resolveSpawnWatchdogMs"),
        expect.objectContaining({ detail: expect.stringContaining("exceeds the Node setTimeout limit") }),
      );

      // 收尾：run 正常完成（未被回调异常打断）
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0);
      const result = await promise;
      expect(result.success).toBe(true);
    } finally {
      delete process.env[SPAWN_WATCHDOG_ENV];
    }
  });

  it("② chatMode agent_settled armIdleTimer throw → 降级挂 DEFAULT idle timer + warn，onRoundSettled 照常、提前 resolve", async () => {
    const record = makeChatModeRecord("sa-f2-idle");
    const onRoundSettled = vi.fn();
    const ctx: Partial<SessionRunnerContext> = { onRoundSettled };
    const promise = runSpawn(record, "Task: idle", makeOpts(), makeCtx(ctx as SessionRunnerContext));

    await waitForSpawn();
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeader("sess-fr2b"));
    emitStdoutLine(child, { type: "agent_settled" });
    await new Promise((r) => setTimeout(r, 20));

    // [T4② / PS-4] 降级语义修正：旧「不挂」（丢通知放行门 + 进程回收）改为
    // 「挂 DEFAULT_IDLE_TIMEOUT_MS + warn」——防御性兜底保住两个不变量且可见
    expect(hasIdleTimer(record.id)).toBe(true);
    expect(child.killed).toBe(false);

    // catch 后续语句照常执行：本轮完成通知不因 GC timer 故障丢失
    expect(onRoundSettled).toHaveBeenCalledTimes(1);

    // 错误可见（原失败留痕）+ 降级动作可见（T4②）
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining("armIdleTimer"),
      expect.objectContaining({ detail: expect.stringContaining("exceeds the Node setTimeout limit") }),
    );
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("fell back to DEFAULT_IDLE_TIMEOUT_MS"),
    );

    // 收尾：chatMode 首轮 agent_settled 已 resolveRun(0)，close 后 runSpawn 正常返回
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0);
    const result = await promise;
    expect(result.success).toBe(true);
  });
});
