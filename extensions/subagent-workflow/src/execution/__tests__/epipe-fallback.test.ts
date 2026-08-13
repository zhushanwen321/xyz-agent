// src/execution/__tests__/epipe-fallback.test.ts
//
// deliverMessage EPIPE 兜底集成测试——热路径 stdin 写入 EPIPE 时自动转冷路径 resume + 消息重放。
//
// 场景覆盖：
//   1. 首次 EPIPE → 自动转冷路径 resumeRound（runSpawn 收到 resume 参数 + 原消息）
//   2. 连续 2 次 EPIPE → throw 含恢复指引（防无限循环）
//   3. 热路径成功写入后清零 EPIPE 计数（正常路径不受影响）

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({ getLogger: () => loggerMock }));

// mock session-runner：runSpawn 受控 + killAllSpawnedChildren 空实现；
// getChildByRecord/spawnedChildren 提供真实 Map 语义。
vi.mock("../session-runner.ts", () => {
  const spawnedChildren = new Map<string, unknown>();
  return {
    runSpawn: vi.fn(),
    killAllSpawnedChildren: vi.fn(),
    spawnedChildren,
    getChildByRecord: (id: string): unknown => spawnedChildren.get(id),
  };
});

import { runSpawn, spawnedChildren } from "../session-runner.ts";
import * as lifecycle from "../lifecycle-manager.ts";
import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo } from "../model-resolver.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import type { AgentResult, ExecutionRecord } from "../types.ts";

const mockRunSpawn = vi.mocked(runSpawn);

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "epipe-test-"));
}

function makePi(): PiLike & {
  appendEntry: ReturnType<typeof vi.fn>;
  events: { emit: ReturnType<typeof vi.fn> };
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return { appendEntry: vi.fn(), events: { emit: vi.fn() }, sendMessage: vi.fn() };
}

function makeResult(success: boolean): AgentResult {
  return {
    text: success ? "done" : "err",
    turns: 1,
    durationMs: 100,
    success,
    error: success ? undefined : "boom",
    sessionId: "sess-1",
    toolCalls: [],
  };
}

/** chatMode idle record（第一轮已完成，等待续聊）。 */
function makeIdleRecord(id = "sa-epipe"): ExecutionRecord {
  const record = createRecord(id, {
    agent: "general-purpose",
    model: "test/test-model",
    thinkingLevel: "low",
    mode: "background",
    task: "initial task",
    slug: "epipe-chat",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: true,
  });
  record.status = "idle";
  record.round = 1;
  record.controller = new AbortController();
  return record;
}

/**
 * 构造 EPIPE child：stdin.write 抛 {code:'EPIPE'}，模拟子进程已退出但 close 事件尚未到达的窗口。
 */
function makeEpipeChild(): ChildProcess {
  const fakeStdin = {
    write: vi.fn(() => {
      const err = Object.assign(new Error("write after end"), { code: "EPIPE" });
      throw err;
    }),
    destroyed: false,
  } as unknown as PassThrough;
  return { stdin: fakeStdin, pid: 99999 } as unknown as ChildProcess;
}

/**
 * 构造正常 child：PassThrough stdin（可正常写入）。
 */
function makeNormalChild(): ChildProcess {
  return { stdin: new PassThrough(), pid: 88888 } as unknown as ChildProcess;
}

// ============================================================
// deliverMessage EPIPE 兜底
// ============================================================

describe("deliverMessage EPIPE 兜底（热路径 stdin EPIPE → 冷路径 resume）", () => {
  let agentDir: string;
  let service: SubagentService;
  let record: ExecutionRecord;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    const modelService = new ModelConfigService({ agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    record = makeIdleRecord();
    record.sessionFile = path.join(agentDir, "fake-session.jsonl");
    spawnedChildren.clear();
    mockRunSpawn.mockReset();
    lifecycle._resetLifecycleState();
    loggerMock.warn.mockClear();
  });

  afterEach(() => {
    service.dispose();
    spawnedChildren.clear();
    lifecycle._resetLifecycleState();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("首次 EPIPE → 自动转冷路径 resumeRound + 原消息重放", async () => {
    mockRunSpawn.mockResolvedValueOnce(makeResult(true));
    // 注册 EPIPE child（热路径会命中但 stdin.write 抛 EPIPE）
    spawnedChildren.set(record.id, makeEpipeChild());

    // deliverMessage 不 throw（首次 EPIPE 走 resume 兜底）
    await expect(service.deliverMessage(record, "msg after epipe", false)).resolves.toBeUndefined();

    // spawnedChildren 中的死进程条目已清理（EPIPE catch 块 delete）
    expect(spawnedChildren.has(record.id)).toBe(false);

    // resumeRound 被触发（冷路径），runSpawn 收到 resume 参数 + 原消息
    await vi.waitFor(() => expect(mockRunSpawn).toHaveBeenCalledTimes(1));
    const call = mockRunSpawn.mock.calls[0]!;
    expect(call[1]).toBe("msg after epipe");
    expect(call[4]).toEqual({
      sessionFile: record.sessionFile,
      model: record.model,
      thinkingLevel: record.thinkingLevel,
    });

    // warn 日志包含 EPIPE 关键词
    expect(loggerMock.warn).toHaveBeenCalled();
    const warnCalls = loggerMock.warn.mock.calls;
    const epipeWarn = warnCalls.find((c: unknown[]) =>
      typeof c[0] === "string" && c[0].includes("EPIPE"),
    );
    expect(epipeWarn).toBeDefined();
  });

  it("连续 2 次 EPIPE → throw 含恢复指引（防无限循环）", async () => {
    mockRunSpawn.mockResolvedValue(makeResult(true));
    // 注册 EPIPE child
    spawnedChildren.set(record.id, makeEpipeChild());

    // 第 1 次：EPIPE → resume（不 throw）
    await service.deliverMessage(record, "first epipe", false);
    await vi.waitFor(() => expect(mockRunSpawn).toHaveBeenCalledTimes(1));

    // resume 完成后 record 回 idle（mock runSpawn done → finalizeRoundToIdle）
    await vi.waitFor(() => expect(record.status).toBe("idle"));

    // 第 2 次：再次注入 EPIPE child + EPIPE
    spawnedChildren.set(record.id, makeEpipeChild());

    // 第 2 次 EPIPE → throw 含恢复指引（连续 2 次触发 exhaustion）
    // 注意：第二 EPIPE 时 count 已为 2，catch 块立即 throw（不经过 resumeRound）。
    let thrown: unknown;
    try {
      await service.deliverMessage(record, "second epipe", false);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("EPIPE fallback exhausted");
    expect((thrown as Error).message).toContain("2 consecutive EPIPE");
    expect((thrown as Error).message).toContain("action:'close'");
    expect((thrown as Error).message).toContain("action:'start'");
  });

  it("热路径成功写入后清零 EPIPE 计数（正常路径不受 EPIPE 计数影响）", async () => {
    mockRunSpawn.mockResolvedValue(makeResult(true));

    // 第 1 轮：EPIPE → resume
    spawnedChildren.set(record.id, makeEpipeChild());
    await service.deliverMessage(record, "epipe msg", false);
    await vi.waitFor(() => expect(mockRunSpawn).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(record.status).toBe("idle"));

    // 第 2 轮：正常 child，成功写入（清零 EPIPE 计数）
    spawnedChildren.set(record.id, makeNormalChild());
    await service.deliverMessage(record, "normal msg", true);
    // 不 throw，status=running（热路径成功）
    expect(record.status).toBe("running");

    // 第 3 轮：再次 EPIPE → 但因为第 2 轮清零了计数，这次是首次 EPIPE（不 throw）
    // 需要先让 record 回 idle
    record.status = "idle";
    spawnedChildren.set(record.id, makeEpipeChild());
    await expect(service.deliverMessage(record, "after reset", false)).resolves.toBeUndefined();
  });
});
