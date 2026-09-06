// src/execution/__tests__/session-runner-lifecycle-helpers.test.ts
//
// [S-17b / runSpawn 阶段拆分] 重构提取辅助函数的可观察行为锁定（生命周期/kill 决策域）。
//
// 背景：session-runner.ts 按执行阶段拆分后，以下新提取辅助函数残留分支无断言锁定：
//   - hasLiveActiveDescendant（keep-alive no-progress fire 惰性复核）的两个 continue
//     盲区分支：pending 项无 sessionId / sessionId 反查不到 session 文件——两者均
//     「不计入存活」→ 真静默处置（与 A1-2② 同向，但走的是不同 continue 边）；
//   - sweepDescendantsOnChildClose 的整体失败 catch：sweep 抛错不掩盖层主自身的
//     收尾结果（best-effort 可见 + runSpawn 照常 resolve）；
//   - registerSpawnedChildForRecord 的 close/error 双通道按句移除（M4 竞态守卫）；
//   - killRecordChildWithEscalation 同 record 换新 child（resume spawn 覆盖注册）时
//     先清旧升级 timer 防叠加——与 service-kill-escalation.test.ts 的「同 child
//     重复调用 no-op」互补，覆盖的是 1396-1397 的 clearTimeout 真路径。
//
// mock 布局与 keep-alive-no-progress.test.ts 一致（FakeChild + fs/alive-store/
// session-pending/temp-prompt mock + 共享 logger mock）。

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

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
  killRecordChildWithEscalation,
  registerSpawnedChildForRecord,
  runSpawn,
  SPAWN_WATCHDOG_ENV,
  spawnedChildren,
  _resetServiceKillStateForTest,
  getChildByRecord,
} from "../engine/engines/pi/session-runner.ts";
import { listActivePendingFromSessionFile, readActivePendingFromSessionFile } from "../session-pending.ts";
import { _resetLifecycleState } from "../lifecycle-manager.ts";
import {
  emitStdoutLine,
  FakeChild,
  lastSpawnedChild as lastSpawnedChildOf,
  makeCtx,
  makeOpts,
  makeRecord,
  waitForSpawn as waitForSpawnOf,
} from "./helpers/spawn-mock.ts";

const mockSpawn = vi.mocked(spawn);
const mockPending = vi.mocked(readActivePendingFromSessionFile);
const mockListPending = vi.mocked(listActivePendingFromSessionFile);
const lastSpawnedChild = (): FakeChild => lastSpawnedChildOf(mockSpawn);
const waitForSpawn = (timeoutMs = 1000): Promise<void> => waitForSpawnOf(mockSpawn, timeoutMs);

/** keep-alive 30min 无进展阈值（与源码常量一致，测试可读性用）。 */
const SIGKILL_ESCALATION_MS = 30_000;

/** FakeChild → 注册 API 的 ChildProcess 形状收窄（结构缺私有字段；记账/kill 只消费 once/kill 形状）。 */
const asChildProcess = (c: FakeChild): ChildProcess => c as unknown as ChildProcess;

function sessionHeaderLine(): Record<string, unknown> {
  return { type: "session", id: "sess-ka", timestamp: "2026-09-01T00:00:00.000Z", cwd: "/tmp/test" };
}

/** 非 chatMode 层主 + fake timers + agent_end keep-alive 落位的公共前奏。 */
async function spawnAndReachKeepAlive(): Promise<{
  child: FakeChild;
  finish: (code?: number) => Promise<Awaited<ReturnType<typeof runSpawn>>>;
}> {
  const record = makeRecord();
  const promise = runSpawn(record, "Task: keep-alive re-check", makeOpts(), makeCtx());
  await waitForSpawn();
  const child = lastSpawnedChild();
  // fake timers 必须在 emit agent_end 之前启用（keep-alive timer 新建于 agent_end 处理器内）
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

describe("[S-17b] hasLiveActiveDescendant：fire 复核的 T5 盲区 continue 边", () => {
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

  it("复核发现 pending 项缺 sessionId（marker 反查无门）→ 不计入存活，真静默处置", async () => {
    mockListPending.mockReturnValue({
      items: [{ id: "bg-nosess", sessionId: undefined, type: "session" }],
    });

    const { child, finish } = await spawnAndReachKeepAlive();
    expect(child.killed).toBe(false);

    // 连续静默 30min fire：盲区后代不豁免层主（归 T5 marker 机制兜底）
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS);
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGTERM");

    await finish();
  });

  it("复核发现 sessionId 反查不到 session 文件（未 flush / 非本树）→ 不计入存活，真静默处置", async () => {
    mockListPending.mockReturnValue({
      items: [{ id: "bg-lost", sessionId: "ka-missing-sess", type: "session" }],
    });
    // readdirSync 默认 mock 返回 [] → findSessionFileByHeaderId 反查失败

    const { child, finish } = await spawnAndReachKeepAlive();
    expect(child.killed).toBe(false);

    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS);
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGTERM");

    await finish();
  });
});

describe("[S-17b] sweepDescendantsOnChildClose：sweep 整体失败不掩盖层主收尾", () => {
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

  it("no-progress 处置后 close 收尾时 sweep 抛错 → best-effort error 留痕，runSpawn 照常 resolve 成功", async () => {
    // 第一次 list 调用（fire 惰性复核）：无存活后代 → 处置
    // 第二次 list 调用（close 后 sweep 采集）：整体抛错 → sweepDescendantsOnChildClose catch
    mockListPending
      .mockReturnValueOnce({ items: [] })
      .mockImplementation(() => {
        throw new Error("pending scan exploded");
      });

    const { child, finish } = await spawnAndReachKeepAlive();
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS);
    expect(child.killed).toBe(true);

    const result = await finish();
    // 层主自身收尾结果不被 sweep 失败掩盖（信号终止视为正常完成，既有语义）
    expect(result.success).toBe(true);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining("descendant sweep (keep-alive watchdog) failed"),
      expect.objectContaining({ detail: "pending scan exploded" }),
    );
  });
});

describe("[S-17b] registerSpawnedChildForRecord：close/error 双通道按句移除", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnedChildren.clear();
  });

  afterEach(() => {
    spawnedChildren.clear();
  });

  it("注册后 child 异步 'error'（spawn 失败）→ 移出 spawnedChildren（dispose 兜底不再 kill 它）", () => {
    const child = new FakeChild();
    registerSpawnedChildForRecord("rec-reg-error", asChildProcess(child));
    expect(getChildByRecord("rec-reg-error")).toBe(child);

    child.emit("error", new Error("spawn ENOENT"));
    expect(getChildByRecord("rec-reg-error")).toBeUndefined();
  });

  it("注册后 child 'close'（正常退出）→ 同样移出（close/error 两监听同构）", () => {
    const child = new FakeChild();
    registerSpawnedChildForRecord("rec-reg-close", asChildProcess(child));
    expect(getChildByRecord("rec-reg-close")).toBe(child);

    child.emit("close", 0);
    expect(getChildByRecord("rec-reg-close")).toBeUndefined();
  });
});

describe("[S-17b] killRecordChildWithEscalation：同 record 换新 child 的升级 timer 防叠加", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    _resetServiceKillStateForTest();
    spawnedChildren.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetServiceKillStateForTest();
    spawnedChildren.clear();
  });

  it("resume spawn 覆盖注册后重复 kill → 旧 child 的升级 timer 被清，30s 后仅新 child 收到 SIGKILL", async () => {
    const oldChild = new FakeChild();
    spawnedChildren.set("rec-resume-kill", asChildProcess(oldChild));
    killRecordChildWithEscalation("rec-resume-kill", "closeChatIdle#1");
    expect(oldChild.killSignal).toBe("SIGTERM");

    // resume：同 record 换新 child（Map 条目被覆盖，旧 child 句柄仍在旧 timer 闭包里）
    const newChild = new FakeChild();
    spawnedChildren.set("rec-resume-kill", asChildProcess(newChild));
    killRecordChildWithEscalation("rec-resume-kill", "closeChatIdle#2");
    expect(newChild.killSignal).toBe("SIGTERM");

    await vi.advanceTimersByTimeAsync(SIGKILL_ESCALATION_MS);

    // 只有新 child 的升级 timer 存活：旧 timer 已被 clearTimeout，不产生第二次 SIGKILL
    expect(newChild.killSignal).toBe("SIGKILL");
    expect(oldChild.killSignal).toBe("SIGTERM");
  });
});
