// src/execution/__tests__/session-runner-heartbeat-idle-fallback.test.ts
//
// [u-svc / T5② + T4②] session-runner 侧两措施（真实模块）：
//   - T5②/PS-7a：keep-alive 期 agent_end 心跳——覆盖写 .alive marker 刷新软超时基准
//    （P-T5 探针裁决写盘开销可忽略，主路径落地）；
//   - T4②/PS-4：agent_settled 的 armIdleTimer fail-fast 降级语义修正——「挂
//     DEFAULT_IDLE_TIMEOUT_MS + warn」而非旧「不挂」（保住通知放行门 + 进程回收两个
//     不变量，兜底可见）。
//
// mock 结构与 keep-alive-no-progress.test.ts / run-spawn-chatmode-settled.test.ts 一致
//（FakeChild + 受控 session-pending；lifecycle-manager partial mock：armIdleTimer 可注入
// fail-fast，其余导出（hasIdleTimer/_resetLifecycleState/DEFAULT）为真实实现）。

import { spawn } from "node:child_process";
import * as fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

const { writeAliveMarkerMock, readAliveMarkerMock, armIdleTimerMock } = vi.hoisted(() => ({
  writeAliveMarkerMock: vi.fn(),
  readAliveMarkerMock: vi.fn<() => undefined>(() => undefined),
  armIdleTimerMock: vi.fn(),
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
  writeAliveMarker: writeAliveMarkerMock,
  readAliveMarker: readAliveMarkerMock,
  isProcessAlive: vi.fn(() => false),
  ALIVE_SOFT_TIMEOUT_MS: 3_600_000,
}));

// keep-alive 心跳用例：count=1（有活跃后代 → keep-alive 分支）。
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

vi.mock("../lifecycle-manager.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lifecycle-manager.ts")>();
  return { ...actual, armIdleTimer: armIdleTimerMock };
});

import { DEFAULT_IDLE_TIMEOUT_MS, hasIdleTimer, _resetLifecycleState } from "../lifecycle-manager.ts";
import { runSpawn } from "../engine/engines/pi/session-runner.ts";
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

const flushPump = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 20));
};

describe("T5② alive marker heartbeat on keep-alive agent_end", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeAliveMarkerMock.mockClear();
    readAliveMarkerMock.mockReturnValue(undefined);
    _resetLifecycleState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    _resetLifecycleState();
  });

  it("rewrites the alive marker each keep-alive agent_end (soft-timeout base refreshed)", async () => {
    const record = makeRecord("sa-heartbeat");
    // 预设 sessionFile（跳过 lazy get_state 回补；不 emit header——RPC mode 无 header，
    // emit 会经 deriveSessionFilePath 覆盖预设路径）
    record.sessionFile = "/tmp/fake-heartbeat-session.jsonl";
    const promise = runSpawn(record, "Task: heartbeat", makeOpts(), makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();

    // 第一次 keep-alive agent_end → 心跳（保 pid/id、刷新 startedAt）
    emitStdoutLine(child, { type: "agent_end", willRetry: false });
    await flushPump();
    expect(writeAliveMarkerMock).toHaveBeenCalledTimes(1);
    expect(writeAliveMarkerMock).toHaveBeenCalledWith(
      "/tmp/fake-heartbeat-session.jsonl",
      expect.objectContaining({ pid: child.pid, id: record.id, startedAt: expect.any(Number) }),
    );

    // 第二次 agent_end（后代仍在）→ 再次心跳（软超时基准持续推新）
    emitStdoutLine(child, { type: "agent_end", willRetry: false });
    await flushPump();
    expect(writeAliveMarkerMock).toHaveBeenCalledTimes(2);

    child.stdout.end();
    child.stderr.end();
    child.emit("close", 143);
    await promise;
  });

  it("keeps the existing marker id when refreshing (readAliveMarker hit)", async () => {
    readAliveMarkerMock.mockReturnValue({ pid: 1, id: "sess-orig-id", startedAt: 1 } as never);
    const record = makeRecord("sa-heartbeat-id");
    record.sessionFile = "/tmp/fake-heartbeat-session-2.jsonl";
    const promise = runSpawn(record, "Task: heartbeat id", makeOpts(), makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();

    emitStdoutLine(child, { type: "agent_end", willRetry: false });
    await flushPump();
    expect(writeAliveMarkerMock).toHaveBeenLastCalledWith(
      "/tmp/fake-heartbeat-session-2.jsonl",
      expect.objectContaining({ id: "sess-orig-id" }),
    );

    child.stdout.end();
    child.stderr.end();
    child.emit("close", 143);
    await promise;
  });
});

describe("T4② armIdleTimer fail-fast falls back to DEFAULT + warn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetLifecycleState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    _resetLifecycleState();
  });

  it("agent_settled with failing armIdleTimer still arms the timer at DEFAULT duration with a warning", async () => {
    // 首次调用（record.idleTimeoutMs 通道）注入 fail-fast，后续转发真实实现
    const actual = await vi.importActual<typeof import("../lifecycle-manager.ts")>("../lifecycle-manager.ts");
    armIdleTimerMock.mockImplementationOnce(() => {
      throw new Error("idleTimeoutMs = 3000000000 exceeds the Node setTimeout limit");
    });
    armIdleTimerMock.mockImplementation(
      (recordId: string, onTimeout: () => void, timeoutMs?: number) =>
        actual.armIdleTimer(recordId, onTimeout, timeoutMs),
    );

    const record = makeRecord("sa-settled-fallback");
    record.chatMode = true;
    record.idleTimeoutMs = 600_000;
    const promise = runSpawn(record, "Task: settled fallback", makeOpts(), makeCtx());
    await waitForSpawn();
    const child = lastSpawnedChild();

    emitStdoutLine(child, { type: "agent_settled" });
    await flushPump();

    // 两次 arm：第一次（非法/失败通道）+ 降级（DEFAULT）
    expect(armIdleTimerMock).toHaveBeenCalledTimes(2);
    expect(armIdleTimerMock).toHaveBeenLastCalledWith(record.id, expect.any(Function), DEFAULT_IDLE_TIMEOUT_MS);
    // 不变量保住：timer 确实 armed（通知放行门 + 进程回收有效）
    expect(hasIdleTimer(record.id)).toBe(true);
    // 降级可见
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("fell back to DEFAULT_IDLE_TIMEOUT_MS"),
    );

    child.stdout.end();
    child.stderr.end();
    child.emit("close", 143);
    await promise;
  });
});
