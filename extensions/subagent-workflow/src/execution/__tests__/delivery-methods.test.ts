// src/execution/__tests__/delivery-methods.test.ts
//
// resumeRound + deliverMessage 单元测试（M2-B1 投递基础设施）。
//
// mock session-runner（runSpawn 受控 + killAllSpawnedChildren 空实现 + getChildByRecord/spawnedChildren
// 真实 Map 语义），走 SubagentService 真实的 resumeRound/deliverMessage 逻辑：
//   - resumeRound：idle→running→detached kickOff runSpawn 收到 resume 参数；chatMode+done 回 idle/round+1；
//     非 idle / 无 sessionFile / 无 controller throw
//   - deliverMessage：按进程死活分流（热路径 prompt+streamingBehavior / 冷路径 resume）
//
// stdin-writer 不 mock（端到端验证 deliverMessage→sendPromptCommand→child.stdin 字节）。
// [review 修复] 已删除 deliverToRunning describe（busy follow_up/steer 投递）——随
// deliverToRunning 方法一并移除（无生产调用方，pendingMessages 消费确认制死机制）。

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

import { runSpawn, spawnedChildren, type SessionRunnerContext } from "../session-runner.ts";
import * as lifecycle from "../lifecycle-manager.ts";
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
  // v4 B-1：idle 折入 running。"等待续聊"态现为 status="running"（isIdle/isResumable 派生谓词区分）。
  record.status = "running";
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

  it("resumeRound(running) → kickOff runSpawn 收到 resume 参数；chatMode+done 回 running/round+1", async () => {
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

    // 等 detached 完成：chatMode+done→running（v4 B-1 idle 折入 running，M2-A 分流），round 累加
    await vi.waitFor(() => expect(record.status).toBe("running"));
    expect(record.round).toBe(beforeRound! + 1);
  });

  it("终态 closed record → throw 行动语言（MF-4，仅 running 可续聊），不触发 kickOff", () => {
    record.status = "closed";
    // MF-4：行动语言（spec §3.1），不暴露 resume/controller 内部词汇
    expect(() => service.resumeRound(record, "msg")).toThrow(/not ready for a new message/);
    expect(mockRunSpawn).not.toHaveBeenCalled();
  });

  it("record 无 sessionFile → throw 行动语言（MF-4 canonical session unavailable），不触发 kickOff", () => {
    record.sessionFile = undefined;
    expect(() => service.resumeRound(record, "msg")).toThrow(/session unavailable/);
    expect(mockRunSpawn).not.toHaveBeenCalled();
  });

  it("record 无 controller → throw 行动语言（MF-4），不触发 kickOff", () => {
    record.controller = undefined;
    expect(() => service.resumeRound(record, "msg")).toThrow(/not ready for a new message/);
    expect(mockRunSpawn).not.toHaveBeenCalled();
  });
});

// ============================================================
// deliverMessage（V2 决策 3 chatMode 统一投递：按进程死活分流）
// ============================================================

describe("deliverMessage (V2 决策 3 chatMode 统一投递)", () => {
  let agentDir: string;
  let service: SubagentService;
  let record: ExecutionRecord;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    const modelService = new ModelConfigService({ agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    record = makeIdleRecord(); // chatMode:true, idle, round=1
    // sessionFile：冷路径 resumeRound 需要（热路径不用，设了无害）
    record.sessionFile = path.join(agentDir, "fake-session.jsonl");
    spawnedChildren.clear();
    mockRunSpawn.mockReset();
    lifecycle._resetLifecycleState();
  });

  afterEach(() => {
    service.dispose();
    spawnedChildren.clear();
    lifecycle._resetLifecycleState();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("热路径 interrupt=false：进程活 → prompt streamingBehavior:followUp + status=running + pid 记录", () => {
    const child = makeStreamChild();
    Object.assign(child, { pid: 12345 });
    spawnedChildren.set(record.id, child);

    service.deliverMessage(record, "after you finish", false);

    const lines = readStdinLines(child);
    expect(lines).toHaveLength(1);
    // [验收 4] sendPromptCommand 收到的命令含 streamingBehavior 字段（followUp）
    expect(lines[0]).toMatchObject({ type: "prompt", message: "after you finish", streamingBehavior: "followUp" });
    expect(record.status).toBe("running");
    expect(record.pid).toBe(12345);
  });

  it("热路径 interrupt=true：进程活 → prompt streamingBehavior:steer", () => {
    const child = makeStreamChild();
    spawnedChildren.set(record.id, child);

    service.deliverMessage(record, "stop now", true);

    const lines = readStdinLines(child);
    expect(lines[0]).toMatchObject({ type: "prompt", message: "stop now", streamingBehavior: "steer" });
    expect(record.status).toBe("running");
  });

  it("热路径 disarm idle timer：arm 后 deliverMessage → timer 清除（防 turn 期间误杀）", () => {
    const child = makeStreamChild();
    spawnedChildren.set(record.id, child);
    // 先 arm idle timer（模拟 Step 4a agent_settled 后 armed）
    lifecycle.armIdleTimer(record.id, () => {}, 10000);
    expect(lifecycle.hasIdleTimer(record.id)).toBe(true);

    service.deliverMessage(record, "msg", false);

    // disarmIdleTimer 被调 → timer 清除（新 turn 不被 idle timer 误杀）
    expect(lifecycle.hasIdleTimer(record.id)).toBe(false);
  });

  it("冷路径：进程死（无 child）→ resumeRound spawn（runSpawn 收到 resume 参数）", async () => {
    mockRunSpawn.mockResolvedValueOnce(makeResult(true));
    // spawnedChildren 无该 record → getChildByRecord 返回 undefined → 冷路径

    service.deliverMessage(record, "resume msg", false);

    await vi.waitFor(() => expect(mockRunSpawn).toHaveBeenCalledTimes(1));
    const call = mockRunSpawn.mock.calls[0]!;
    expect(call[1]).toBe("resume msg");
    expect(call[4]).toEqual({
      sessionFile: record.sessionFile,
      model: record.model,
      thinkingLevel: record.thinkingLevel,
    });
  });

  it("冷路径 child.killed=true → 走 resume（判活用 !child.killed）", async () => {
    mockRunSpawn.mockResolvedValueOnce(makeResult(true));
    const child = makeStreamChild();
    Object.assign(child, { killed: true }); // 进程已 kill
    spawnedChildren.set(record.id, child);

    service.deliverMessage(record, "after kill", false);

    await vi.waitFor(() => expect(mockRunSpawn).toHaveBeenCalledTimes(1));
  });

  it("续聊后 agent_settled → onRoundSettled 设 running + round+1（v4 B-1 idle 折入 running，复用 Step 4a 链路）", () => {
    // buildSessionRunnerContext 是 private，类型断言访问（测试专用）
    const ctx = (service as unknown as { buildSessionRunnerContext(): SessionRunnerContext }).buildSessionRunnerContext();
    record.status = "running"; // 模拟 deliverMessage 热路径设的新 turn 状态
    const beforeRound = record.round;

    // 模拟 session-runner 在 agent_settled 时调本回调（Step 4a 接入点）
    ctx.onRoundSettled!(record);

    expect(record.status).toBe("running");
    expect(record.round).toBe(beforeRound! + 1);
  });
});
