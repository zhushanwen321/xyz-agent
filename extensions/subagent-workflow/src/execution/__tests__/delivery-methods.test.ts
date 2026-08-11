// src/execution/__tests__/delivery-methods.test.ts
//
// deliverToRunning + resumeRound 单元测试（M2-B1 投递基础设施）。
//
// mock session-runner（runSpawn 受控 + killAllSpawnedChildren 空实现 + getChildByRecord/spawnedChildren
// 真实 Map 语义），走 SubagentService 真实的 deliverToRunning/resumeRound 逻辑：
//   - deliverToRunning：busy 写 stdin（PassThrough child 验证字节）+ pendingMessages push；child 不存在 throw
//   - resumeRound：idle→running→detached kickOff runSpawn 收到 resume 参数；chatMode+done 回 idle/round+1；
//     非 idle / 无 sessionFile / 无 controller throw
//
// stdin-writer 不 mock（端到端验证 deliverToRunning→sendFollowUp/sendSteer→child.stdin 字节）。

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
// getChildByRecord/spawnedChildren 提供真实 Map 语义（deliverToRunning 注册 mock child 用）。
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
import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo } from "../model-resolver.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import type { AgentResult, ExecutionRecord } from "../types.ts";

const mockRunSpawn = vi.mocked(runSpawn);

const STUB_MODEL: ModelInfo = { id: "test-model", name: "Test", provider: "test", reasoning: false };

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delivery-test-"));
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

/** chatMode idle record（第一轮已完成，等待续聊）。sessionFile 由调用方覆盖为 agentDir 下路径。 */
function makeIdleRecord(id = "sa-chat"): ExecutionRecord {
  const record = createRecord(id, {
    agent: "general-purpose",
    model: "test/test-model",
    thinkingLevel: "low",
    mode: "background",
    task: "initial task",
    slug: "chat",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: true,
  });
  record.status = "idle";
  record.round = 1;
  record.controller = new AbortController();
  return record;
}

/** PassThrough child（可读出 stdin 字节验证 deliverToRunning 写入）。 */
function makeStreamChild(): ChildProcess {
  return { stdin: new PassThrough() } as unknown as ChildProcess;
}

function readStdinLines(child: ChildProcess): unknown[] {
  const stream = child.stdin as unknown as PassThrough;
  stream.pause();
  const text = stream.read()?.toString() ?? "";
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("deliverToRunning (M2-B1 busy 投递)", () => {
  let agentDir: string;
  let service: SubagentService;
  let record: ExecutionRecord;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    const modelService = new ModelConfigService({ agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    record = makeIdleRecord();
    record.status = "running"; // busy 投递前提
    spawnedChildren.clear();
  });

  afterEach(() => {
    service.dispose();
    spawnedChildren.clear();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("interrupt=false → 写 follow_up 到 stdin + push pendingMessages(interrupt:false)", () => {
    const child = makeStreamChild();
    spawnedChildren.set(record.id, child);

    service.deliverToRunning(record, "after you finish", false);

    const lines = readStdinLines(child);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: "follow_up", message: "after you finish" });
    expect(record.pendingMessages).toHaveLength(1);
    expect(record.pendingMessages![0]).toMatchObject({ text: "after you finish", interrupt: false });
    expect(record.pendingMessages![0]!.id).toEqual(expect.any(String));
    expect(record.pendingMessages![0]!.sentAt).toEqual(expect.any(Number));
  });

  it("interrupt=true → 写 steer 到 stdin + push pendingMessages(interrupt:true)", () => {
    const child = makeStreamChild();
    spawnedChildren.set(record.id, child);

    service.deliverToRunning(record, "stop now", true);

    const lines = readStdinLines(child);
    expect(lines[0]).toMatchObject({ type: "steer", message: "stop now" });
    expect(record.pendingMessages![0]).toMatchObject({ text: "stop now", interrupt: true });
  });

  it("child 不存在（进程已退）→ throw（M2-B2 补投机制处理竞态）+ 不写 pendingMessages", () => {
    expect(() => service.deliverToRunning(record, "msg", false)).toThrow(/no live process/);
    expect(record.pendingMessages).toBeUndefined();
  });

  it("多次投递累积 pendingMessages（FIFO 顺序保留）", () => {
    const child = makeStreamChild();
    spawnedChildren.set(record.id, child);
    service.deliverToRunning(record, "first", false);
    service.deliverToRunning(record, "second", true);

    expect(record.pendingMessages).toHaveLength(2);
    expect(record.pendingMessages![0]!.text).toBe("first");
    expect(record.pendingMessages![0]!.interrupt).toBe(false);
    expect(record.pendingMessages![1]!.text).toBe("second");
    expect(record.pendingMessages![1]!.interrupt).toBe(true);
  });
});

describe("resumeRound (M2-B1 idle 投递)", () => {
  let agentDir: string;
  let service: SubagentService;
  let record: ExecutionRecord;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    const modelService = new ModelConfigService({ agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    record = makeIdleRecord();
    // sessionFile 用 agentDir 下路径（finalizeRoundToIdle 写 .idle sidecar 不留 /tmp 垃圾）
    record.sessionFile = path.join(agentDir, "fake-session.jsonl");
    mockRunSpawn.mockReset();
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("idle → status=running → kickOff runSpawn 收到 resume 参数；chatMode+done 回 idle/round+1", async () => {
    mockRunSpawn.mockResolvedValueOnce(makeResult(true));
    const beforeRound = record.round;

    service.resumeRound(record, "next round msg");

    // 同步：status 已手动设回 running（M2-A 边界，绕过 tryTransition）
    expect(record.status).toBe("running");

    // detached：等 runSpawn 被调
    await vi.waitFor(() => expect(mockRunSpawn).toHaveBeenCalledTimes(1));
    const call = mockRunSpawn.mock.calls[0]!;
    // [record, task, opts, ctx, resume]
    expect(call[1]).toBe("next round msg");
    expect(call[4]).toEqual({
      sessionFile: record.sessionFile,
      model: record.model, // 防漂移（P-10）：从 record identity 读
      thinkingLevel: record.thinkingLevel,
    });
    expect((call[4] as { model: string }).model).toBe("test/test-model");

    // 等 detached 完成：chatMode+done→idle（M2-A 分流），round 累加
    await vi.waitFor(() => expect(record.status).toBe("idle"));
    expect(record.round).toBe(beforeRound! + 1);
  });

  it("非 idle record → throw（仅 idle 可 resume），不触发 kickOff", () => {
    record.status = "running";
    expect(() => service.resumeRound(record, "msg")).toThrow(/not idle/);
    expect(mockRunSpawn).not.toHaveBeenCalled();
  });

  it("record 无 sessionFile → throw（resume 需要续写的 session）", () => {
    record.sessionFile = undefined;
    expect(() => service.resumeRound(record, "msg")).toThrow(/no sessionFile/);
    expect(mockRunSpawn).not.toHaveBeenCalled();
  });

  it("record 无 controller → throw（防御性，chatMode record 创建时一定有）", () => {
    record.controller = undefined;
    expect(() => service.resumeRound(record, "msg")).toThrow(/no controller/);
    expect(mockRunSpawn).not.toHaveBeenCalled();
  });
});
