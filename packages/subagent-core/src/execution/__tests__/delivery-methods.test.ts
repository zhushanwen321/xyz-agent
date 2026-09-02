// src/execution/__tests__/delivery-methods.test.ts
//
// 冷路径续轮 + chatMode 统一投递单元测试（M2-B1 投递基础设施；D2 单轨后口径）。
//
// mock session-runner（runSpawn 受控 + killAllSpawnedChildren 空实现 + getChildByRecord/spawnedChildren
// 真实 Map 语义），走 SubagentService.deliverChatMessage → PiEngine.deliverPrompt 真实逻辑：
//   - 冷路径（进程死）：续轮 resume spawn（runSpawn 收到 resume 参数）；chatMode+done 回 running/round+1；
//     终态 / 无 sessionFile / 无 controller throw 行动语言
//   - 热路径（进程活）：prompt + streamingBehavior（interrupt → steer/followUp）
//
// stdin-writer 不 mock（端到端验证 PiEngine.deliverPrompt→sendPromptCommand→child.stdin 字节）。
// [review 修复] 已删除 deliverToRunning describe（busy follow_up/steer 投递）——随
// deliverToRunning 方法一并移除（无生产调用方，pendingMessages 消费确认制死机制）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// [race-F5] 断言的消费方 stdin-writer（及 notifier/session-pending）的 logger 已切
// core facade——mock 目标跟随消费方实际 import 源，拦到同一 loggerMock。
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// mock session-runner：runSpawn 受控 + killAllSpawnedChildren 空实现；
// getChildByRecord/spawnedChildren 提供真实 Map 语义（deliverToRunning 注册 mock child 用）。
vi.mock("../engine/engines/pi/session-runner.ts", () => {
  const spawnedChildren = new Map<string, unknown>();
  return {
    runSpawn: vi.fn(),
    killAllSpawnedChildren: vi.fn(),
    spawnedChildren,
    getChildByRecord: (id: string): unknown => spawnedChildren.get(id),
  };
});

import { runSpawn, spawnedChildren, type SessionRunnerContext } from "../engine/engines/pi/session-runner.ts";
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
  // exitCode/signalCode：真 ChildProcess 未退出时均为 null（热路径投递 [race-F5]
  // 写后死进程检测读这两个字段，缺省 undefined 会被误判为已死触发 warn）。
  return { stdin: new PassThrough(), exitCode: null, signalCode: null } as unknown as ChildProcess;
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

describe("冷路径续轮（M2-B1 idle 投递；D2 后经 deliverChatMessage 无活进程到达）", () => {
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

  it("冷路径续轮(running) → kickOff runSpawn 收到 resume 参数；chatMode+done 回 running/round+1", async () => {
    mockRunSpawn.mockResolvedValueOnce(makeResult(true));
    const beforeRound = record.round;

    await service.deliverChatMessage(record, "next round msg", false);

    // 冷路径守卫通过后：status 已手动设回 running（M2-A 边界，绕过 tryTransition）
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

  it("终态 closed record → throw 行动语言（MF-4，仅 running 可续聊），不触发 kickOff", async () => {
    record.status = "closed";
    // MF-4：行动语言（spec §3.1），不暴露 resume/controller 内部词汇
    await expect(service.deliverChatMessage(record, "msg", false)).rejects.toThrow(/not ready for a new message/);
    expect(mockRunSpawn).not.toHaveBeenCalled();
  });

  it("record 无 sessionFile → throw 行动语言（MF-4 canonical session unavailable），不触发 kickOff", async () => {
    record.sessionFile = undefined;
    await expect(service.deliverChatMessage(record, "msg", false)).rejects.toThrow(/session unavailable/);
    expect(mockRunSpawn).not.toHaveBeenCalled();
  });

  it("record 无 controller → throw 行动语言（MF-4），不触发 kickOff", async () => {
    record.controller = undefined;
    await expect(service.deliverChatMessage(record, "msg", false)).rejects.toThrow(/not ready for a new message/);
    expect(mockRunSpawn).not.toHaveBeenCalled();
  });
});

// ============================================================
// deliverChatMessage（V2 决策 3 chatMode 统一投递：按进程死活分流；D2 后经 engine.interactRecord）
// ============================================================

describe("deliverChatMessage (V2 决策 3 chatMode 统一投递)", () => {
  let agentDir: string;
  let service: SubagentService;
  let record: ExecutionRecord;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    const modelService = new ModelConfigService({ agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    record = makeIdleRecord(); // chatMode:true, idle, round=1
    // sessionFile：冷路径续轮需要（热路径不用，设了无害）
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

  it("热路径 interrupt=false：进程活 → prompt streamingBehavior:followUp + status=running + pid 记录", async () => {
    const child = makeStreamChild();
    Object.assign(child, { pid: 12345 });
    spawnedChildren.set(record.id, child);

    await service.deliverChatMessage(record, "after you finish", false);

    const lines = readStdinLines(child);
    expect(lines).toHaveLength(1);
    // [验收 4] sendPromptCommand 收到的命令含 streamingBehavior 字段（followUp）
    expect(lines[0]).toMatchObject({ type: "prompt", message: "after you finish", streamingBehavior: "followUp" });
    expect(record.status).toBe("running");
    expect(record.pid).toBe(12345);
  });

  it("热路径 interrupt=true：进程活 → prompt streamingBehavior:steer", async () => {
    const child = makeStreamChild();
    spawnedChildren.set(record.id, child);

    await service.deliverChatMessage(record, "stop now", true);

    const lines = readStdinLines(child);
    expect(lines[0]).toMatchObject({ type: "prompt", message: "stop now", streamingBehavior: "steer" });
    expect(record.status).toBe("running");
  });

  // [race-F5] 写后死进程检测：热路径 write 同步成功（数据进内核缓冲）但子进程在读取前
  // 已死（gate/idle kill 竞速）→ 消息将随缓冲静默丢弃。修复：写后检查 exitCode/signalCode，
  // 已死则 warn 留证（含 runId 与消息类型），不抛错不重试（终态已由 kill 路径保证）。
  it("[race-F5] 热路径写后子进程已死 → logger.warn 被记录（含 runId 与消息类型），不抛错", async () => {
    const child = makeStreamChild();
    // 模拟 gate/idle kill 竞速：写 stdin 成功但子进程已死（SIGTERM 终止形态）
    Object.assign(child, { signalCode: "SIGTERM" });
    spawnedChildren.set(record.id, child);

    await expect(service.deliverChatMessage(record, "lost msg", true)).resolves.toBeUndefined();

    // 写入照常发生（热路径语义不变，不做二次分发）
    const lines = readStdinLines(child);
    expect(lines[0]).toMatchObject({ type: "prompt", message: "lost msg", streamingBehavior: "steer" });
    // warn 留证：含 runId（record.id）与消息类型（steer）
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining(`child ${record.id} died around stdin write`),
      expect.objectContaining({ msgType: "steer", signalCode: "SIGTERM" }),
    );
  });

  it("[race-F5] 活进程正常投递不触发死进程 warn（守卫不误报）", async () => {
    // loggerMock 是模块级共享 mock：清历史调用后再断言（防前一用例的 warn 干扰）
    loggerMock.warn.mockClear();
    const child = makeStreamChild();
    spawnedChildren.set(record.id, child);

    await service.deliverChatMessage(record, "normal", false);

    expect(loggerMock.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("died around stdin write"),
      expect.anything(),
    );
  });

  it("热路径 disarm idle timer：arm 后投递 → timer 清除（防 turn 期间误杀）", async () => {
    const child = makeStreamChild();
    spawnedChildren.set(record.id, child);
    // 先 arm idle timer（模拟 Step 4a agent_settled 后 armed）
    lifecycle.armIdleTimer(record.id, () => {}, 10000);
    expect(lifecycle.hasIdleTimer(record.id)).toBe(true);

    await service.deliverChatMessage(record, "msg", false);

    // disarmIdleTimer 被调 → timer 清除（新 turn 不被 idle timer 误杀）
    expect(lifecycle.hasIdleTimer(record.id)).toBe(false);
  });

  it("冷路径：进程死（无 child）→ 续轮 resume spawn（runSpawn 收到 resume 参数）", async () => {
    mockRunSpawn.mockResolvedValueOnce(makeResult(true));
    // spawnedChildren 无该 record → getChildByRecord 返回 undefined → 冷路径

    await service.deliverChatMessage(record, "resume msg", false);

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

    await service.deliverChatMessage(record, "after kill", false);

    await vi.waitFor(() => expect(mockRunSpawn).toHaveBeenCalledTimes(1));
  });

  it("续聊后 agent_settled → onRoundSettled 设 running + round+1（v4 B-1 idle 折入 running，复用 Step 4a 链路）", () => {
    // buildSessionRunnerContext 是 private，类型断言访问（测试专用）
    const ctx = (service as unknown as { buildSessionRunnerContext(): SessionRunnerContext }).buildSessionRunnerContext();
    record.status = "running"; // 模拟热路径投递设的新 turn 状态
    const beforeRound = record.round;

    // 模拟 session-runner 在 agent_settled 时调本回调（Step 4a 接入点）
    ctx.onRoundSettled!(record);

    expect(record.status).toBe("running");
    expect(record.round).toBe(beforeRound! + 1);
  });
});

// ============================================================
// 冷路径并发守卫（review round2 MF1：同 turn 批量两条 message 双冷路径双 spawn）
// ============================================================
// 复现链（reviewer 探针实证）：pi 对同一条 assistant message 的 tool calls 顺序执行
// （subagent tool sequential），tool1 的投递在冷路径续轮返回即
// resolve——早于 runSpawn 完成 spawn 注册（session-runner spawnedChildren.set 前有
// pool.acquire await / writePromptToTempFile 等多个异步点）；tool2 立即执行 →
// getChildByRecord 仍 undefined → 再次冷路径。v4 两态收敛后续轮的
// `status !== "running"` 守卫对 idle-resumable record 恒放行（idle 本来就是 running）、
// `status = "running"` 是幂等写 → 两次 kickOff → runSpawn 被调 2 次 → 两个 pi 子进程
// 以 --session 同一 JSONL 双写 + 第一个进程脱离 kill 记账成孤儿。
describe("deliverChatMessage 冷路径并发守卫（review round2 MF1）", () => {
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
  });

  afterEach(() => {
    service.dispose();
    spawnedChildren.clear();
    lifecycle._resetLifecycleState();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("同 record 连续两条 message 冷路径 → 第二条 throw 行动语言，runSpawn 仅 1 次", async () => {
    // runSpawn 挂起不 resolve：模拟真实 spawn 异步窗口（pool.acquire 排队 + tempFile + spawn），
    // 此窗口内 spawnedChildren 尚未注册 → 第二条 message 必再走冷路径。
    let releaseFirst!: (r: AgentResult) => void;
    mockRunSpawn.mockImplementationOnce(
      () => new Promise<AgentResult>((res) => { releaseFirst = res; }),
    );

    // 第一条：正常冷路径 resume
    await expect(service.deliverChatMessage(record, "first msg", false)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(mockRunSpawn).toHaveBeenCalledTimes(1));

    // 第二条：spawn 仍在途（getChildByRecord undefined）→ 再走冷路径。
    // 修复前：续轮守卫恒放行 → 第二次 kickOff → runSpawn 2 次（双 spawn 双写 session）。
    // 修复后：in-flight 守卫 throw 行动语言（MF-4）。
    await expect(service.deliverChatMessage(record, "second msg", false)).rejects.toThrow(
      /already starting a new round/,
    );
    expect(mockRunSpawn).toHaveBeenCalledTimes(1);

    // 轮次完成 → 守卫清除 → 后续冷路径可再 resume（守卫不得永久死锁 record）
    releaseFirst(makeResult(true));
    await vi.waitFor(() =>
      expect((service as unknown as { resumesInFlight: Set<string> }).resumesInFlight.has(record.id)).toBe(false),
    );
    mockRunSpawn.mockResolvedValueOnce(makeResult(true));
    await expect(service.deliverChatMessage(record, "third msg", false)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(mockRunSpawn).toHaveBeenCalledTimes(2));
    expect(mockRunSpawn.mock.calls[1]![1]).toBe("third msg");
  });

  it("守卫是 record 级：A 在途 resume 不拦截 B 的冷路径 message", async () => {
    const recordB = makeIdleRecord("sa-chat-b");
    recordB.sessionFile = path.join(agentDir, "fake-session-b.jsonl");
    let releaseA!: (r: AgentResult) => void;
    mockRunSpawn.mockImplementation(
      () => new Promise<AgentResult>((res) => { releaseA = res; }),
    );

    await service.deliverChatMessage(record, "A msg", false);
    await vi.waitFor(() => expect(mockRunSpawn).toHaveBeenCalledTimes(1));

    // B 的冷路径不受 A 在途影响
    await expect(service.deliverChatMessage(recordB, "B msg", false)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(mockRunSpawn).toHaveBeenCalledTimes(2));
    expect(mockRunSpawn.mock.calls[1]![0]).toBe(recordB);

    releaseA(makeResult(true));
  });

  it("冷路径续轮在途时 EPIPE 兜底重入同样被守卫拦截（不持锁路径，review round2 MF1）", async () => {
    // D2 后续轮本体是编排层私有，不持锁的重入形态只剩 EPIPE 兜底（PiEngine.deliverPrompt
    // catch 分支直调续轮）——此处经热路径 EPIPE 复现：活 child 的 stdin 已销毁 → 写入
    // EPIPE → 兜底转冷路径。首条消息已占在途守卫时，第二条的 EPIPE 兜底被拒。
    let release!: (r: AgentResult) => void;
    mockRunSpawn.mockImplementationOnce(() => new Promise<AgentResult>((res) => { release = res; }));
    // 第一条：冷路径（无 child）→ 续轮在途
    await expect(service.deliverChatMessage(record, "first", false)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(mockRunSpawn).toHaveBeenCalledTimes(1));

    // 第二条：EPIPE 兜底（child 活但 stdin 断）→ 兜底转冷路径 → 在途守卫 throw 行动语言
    const epipe = new Error("write EPIPE") as NodeJS.ErrnoException;
    epipe.code = "EPIPE"; // writeStdinLine 的 R3 判据：err.code === 'EPIPE' 才转 throw
    const child = { stdin: { destroyed: false, write: () => { throw epipe; } }, exitCode: null, signalCode: null, killed: false } as unknown as ChildProcess;
    spawnedChildren.set(record.id, child);
    await expect(service.deliverChatMessage(record, "second", false)).rejects.toThrow(/already starting a new round/);
    expect(mockRunSpawn).toHaveBeenCalledTimes(1);

    release(makeResult(true));
  });
});
