// src/execution/__tests__/delivery-methods.test.ts
//
// 冷路径续轮 + chatMode 统一投递单元测试（M2-B1 投递基础设施）。
//
// [W3 改写] 投递链路协议化：deliverChatMessage → pi EnginePort（registry cli 形态
// port 的替身 registerFakePiEngine）interact(message)；冷路径 =
// engine_session_not_resumable → resumeColdRound → run chat + resume 锚点。
// 原 inproc stdin 字节断言（sendPromptCommand/streamingBehavior/EPIPE 写后死检测）
// 随 inproc pi 引擎目录 删除归 pi-subagent-cli 包内测试（chat-session.test.ts 同语义覆盖）。
//
// 本文件断言的编排语义（分流/守卫/状态迁移/在途守卫）与改线前逐点同构。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { clearEngines } from "../engine/registry.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import * as lifecycle from "../lifecycle-manager.ts";
import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { PiLike } from "../subagent-service.ts";
import { SubagentService } from "../subagent-service.ts";
import type { ExecutionRecord } from "../types.ts";

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delivery-test-"));
}

function makePi(): PiLike {
  return {
    appendEntry: vi.fn(() => {}),
    events: { emit: vi.fn(() => {}) },
    sendMessage: vi.fn(() => {}),
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

describe("冷路径续轮（M2-B1 idle 投递；engine_session_not_resumable → run chat + resume）", () => {
  let agentDir: string;
  let service: SubagentService;
  let record: ExecutionRecord;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    clearEngines();
    fake = registerFakePiEngine();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    record = makeIdleRecord();
    // sessionFile 用 agentDir 下路径（finalizeRoundToIdle 写 .idle sidecar 不留 /tmp 垃圾）
    record.sessionFile = path.join(agentDir, "fake-session.jsonl");
    // 冷路径替身：interact 返回 engine_session_not_resumable（引擎无活进程）
    fake.interactMessageResult = {
      ok: false,
      code: "engine_session_not_resumable",
      message: "no live process (cold path). Recovery: dispatch a new run with ctx chat resume.",
    };
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("冷路径续轮(running) → run chat 收到 resume 锚点；chatMode+done 回 running/round+1", async () => {
    const beforeRound = record.round;

    await service.chatActions.deliverChatMessage(record, "next round msg", false);

    // 冷路径守卫通过后：status 已手动设回 running（M2-A 边界，绕过 tryTransition）
    expect(record.status).toBe("running");

    // detached：等协议 run 被调（冷续 = chat.resume 锚点）
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    const run = fake.runs[0]!;
    expect(run.task.prompt).toBe("next round msg");
    expect(run.task.conversation).toBe(true);
    expect(run.ctx.chat).toEqual({
      recordId: record.id,
      resume: {
        sessionRef: { recordId: record.id, sessionFile: record.sessionFile },
        poolKey: "shared",
      },
    });

    // 模拟引擎首轮 agent_settled 应答（idle 帧先于应答帧）
    run.emitLifecycle({ phase: "idle", anchor: { sessionRef: { recordId: record.id, sessionFile: record.sessionFile }, poolKey: "shared" } });
    run.settle({ content: "round text" });

    // 等 detached 完成：chatMode+done→running（v4 B-1 idle 折入 running，M2-A 分流），round 累加
    await vi.waitFor(() => expect(record.round).toBe(beforeRound! + 1));
    expect(record.status).toBe("running");
  });

  it("终态 closed record → throw 行动语言（MF-4，仅 running 可续聊），不触发 interact", async () => {
    record.status = "closed";
    // MF-4：行动语言（spec §3.1），不暴露 resume/controller 内部词汇
    await expect(service.chatActions.deliverChatMessage(record, "msg", false)).rejects.toThrow(/not ready for a new message/);
    expect(fake.interacts.length).toBe(0);
  });

  it("record 无 sessionFile → 冷路径续轮 throw 行动语言（MF-4 canonical session unavailable），不触发 kickOff", async () => {
    record.sessionFile = undefined;
    await expect(service.chatActions.deliverChatMessage(record, "msg", false)).rejects.toThrow(/session unavailable/);
    expect(fake.runs.length).toBe(0);
  });

  it("record 无 controller → 冷路径续轮 throw 行动语言（MF-4），不触发 kickOff", async () => {
    record.controller = undefined;
    await expect(service.chatActions.deliverChatMessage(record, "msg", false)).rejects.toThrow(/not ready for a new message/);
    expect(fake.runs.length).toBe(0);
  });
});

// ============================================================
// deliverChatMessage（V2 决策 3 chatMode 统一投递：协议 interact message 分流）
// ============================================================

describe("deliverChatMessage (V2 决策 3 chatMode 统一投递；协议 interact)", () => {
  let agentDir: string;
  let service: SubagentService;
  let record: ExecutionRecord;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    clearEngines();
    fake = registerFakePiEngine();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    record = makeIdleRecord(); // chatMode:true, idle, round=1
    // sessionFile：冷路径续轮需要（热路径不用，设了无害）
    record.sessionFile = path.join(agentDir, "fake-session.jsonl");
    lifecycle._resetLifecycleState();
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    lifecycle._resetLifecycleState();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("热路径 interrupt=false：引擎受理 → interact(message, interrupt:false) + status=running + 执行态信号清除", async () => {
    record.result = "上一轮增量";
    record.resumable = true;

    await service.chatActions.deliverChatMessage(record, "after you finish", false);

    expect(fake.interacts.length).toBe(1);
    const call = fake.interacts[0]!;
    expect(call.action).toEqual({ kind: "message", payload: "after you finish", interrupt: false });
    expect(call.handle.data.sessionRef["recordId"]).toBe(record.id);
    // 受理成功：status 回 running + 上一轮执行态信号清除（§5.4 isStreaming 公式）
    expect(record.status).toBe("running");
    expect(record.result).toBeUndefined();
    expect(record.resumable).toBeUndefined();
  });

  it("热路径 interrupt=true：引擎受理 → interact(message, interrupt:true)（steer 抢占）", async () => {
    await service.chatActions.deliverChatMessage(record, "stop now", true);

    expect(fake.interacts[0]!.action).toEqual({ kind: "message", payload: "stop now", interrupt: true });
    expect(record.status).toBe("running");
  });

  it("冷路径：engine_session_not_resumable → 续轮 run chat + resume 锚点", async () => {
    fake.interactMessageResult = {
      ok: false,
      code: "engine_session_not_resumable",
      message: "no live process (cold path)",
    };

    await service.chatActions.deliverChatMessage(record, "resume msg", false);

    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    const run = fake.runs[0]!;
    expect(run.task.prompt).toBe("resume msg");
    expect(run.ctx.chat?.recordId).toBe(record.id);
    expect(run.ctx.chat?.resume?.sessionRef["sessionFile"]).toBe(record.sessionFile);
  });

  it("业务拒绝（EPIPE 兜底耗尽等）→ 原样 throw（错误文本逐字节保持），不进冷路径", async () => {
    fake.interactMessageResult = {
      ok: false,
      code: "engine_interact_failed",
      message: `EPIPE fallback exhausted for ${record.id}: 3 consecutive failures.`,
    };

    await expect(service.chatActions.deliverChatMessage(record, "msg", false)).rejects.toThrow(
      /EPIPE fallback exhausted/,
    );
    expect(fake.runs.length).toBe(0); // 不进冷路径
  });

  it("热路径 disarm idle timer：arm 后投递 → timer 清除（防 turn 期间误杀）", async () => {
    // 先 arm idle timer（模拟首轮 agent_settled 后 armed）
    lifecycle.armIdleTimer(record.id, () => {}, 10000);
    expect(lifecycle.hasIdleTimer(record.id)).toBe(true);

    await service.chatActions.deliverChatMessage(record, "msg", false);

    // disarmIdleTimer 被调 → timer 清除（新 turn 不被 idle timer 误杀）
    expect(lifecycle.hasIdleTimer(record.id)).toBe(false);
  });

  it("受理后挂中段守护（settled-watchdog mid-round armed）；settled 相位交棒收尾段", async () => {
    await service.chatActions.deliverChatMessage(record, "msg", false);

    const { hasSettledWatchdog, getSettledWatchdogPhase } = await import("../settled-watchdog.ts");
    expect(hasSettledWatchdog(record.id)).toBe(true);
    expect(getSettledWatchdogPhase(record.id)).toBe("mid-round");

    // 引擎 settled 相位（recordId 键）→ 中段让位收尾段（W4 noteRoundSettledFromProtocol）
    fake.emitRecordLifecycle(record.id, { phase: "settled" });
    expect(getSettledWatchdogPhase(record.id)).toBe("settled");
  });
});

// ============================================================
// 冷路径并发守卫（review round2 MF1：同 turn 批量两条 message 双冷路径双 spawn）
// ============================================================
// 复现链（reviewer 探针实证）：pi 对同一条 assistant message 的 tool calls 顺序执行，
// tool1 的投递在冷路径续轮返回即 resolve——早于协议 run 完成（pool.acquire await 等
// 异步点）；tool2 立即执行 → 引擎仍无活进程 → 再次冷路径。v4 两态收敛后续轮的
// `status !== "running"` 守卫对 idle-resumable record 恒放行 → 两次 kickOff →
// 两个 pi 子进程以 --session 同一 JSONL 双写 + 第一个进程脱离记账成孤儿。
describe("deliverChatMessage 冷路径并发守卫（review round2 MF1）", () => {
  let agentDir: string;
  let service: SubagentService;
  let record: ExecutionRecord;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    clearEngines();
    fake = registerFakePiEngine();
    fake.interactMessageResult = {
      ok: false,
      code: "engine_session_not_resumable",
      message: "no live process (cold path)",
    };
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    record = makeIdleRecord();
    record.sessionFile = path.join(agentDir, "fake-session.jsonl");
    lifecycle._resetLifecycleState();
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    lifecycle._resetLifecycleState();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("同 record 连续两条 message 冷路径 → 第二条 throw 行动语言，协议 run 仅 1 次", async () => {
    // 第一条：正常冷路径 resume（run 挂起不 resolve——模拟 pool.acquire 排队窗口）
    await expect(service.chatActions.deliverChatMessage(record, "first msg", false)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));

    // 第二条：run 仍在途（引擎侧仍无活进程）→ 再走冷路径。
    // 修复前：续轮守卫恒放行 → 第二次 kickOff → 2 个 run（双 spawn 双写 session）。
    // 修复后：in-flight 守卫 throw 行动语言（MF-4）。
    await expect(service.chatActions.deliverChatMessage(record, "second msg", false)).rejects.toThrow(
      /already starting a new round/,
    );
    expect(fake.runs.length).toBe(1);

    // 轮次完成 → 守卫清除 → 后续冷路径可再 resume（守卫不得永久死锁 record）
    fake.runs[0]!.settle({ content: "done" });
    await vi.waitFor(() =>
      expect((service as unknown as { resumesInFlight: Set<string> }).resumesInFlight.has(record.id)).toBe(false),
    );
    await expect(service.chatActions.deliverChatMessage(record, "third msg", false)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(fake.runs.length).toBe(2));
    expect(fake.runs[1]!.task.prompt).toBe("third msg");
  });

  it("守卫是 record 级：A 在途 resume 不拦截 B 的冷路径 message", async () => {
    const recordB = makeIdleRecord("sa-chat-b");
    recordB.sessionFile = path.join(agentDir, "fake-session-b.jsonl");

    await service.chatActions.deliverChatMessage(record, "A msg", false);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));

    // B 的冷路径不受 A 在途影响
    await expect(service.chatActions.deliverChatMessage(recordB, "B msg", false)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(fake.runs.length).toBe(2));
    expect(fake.runs[1]!.ctx.chat?.recordId).toBe(recordB.id);

    fake.runs[0]!.settle({ content: "A done" });
    fake.runs[1]!.settle({ content: "B done" });
    await vi.waitFor(() =>
      expect((service as unknown as { resumesInFlight: Set<string> }).resumesInFlight.has(recordB.id)).toBe(false),
    );
  });
});

// ============================================================
// 本轮 settle（协议形态：run 应答 = 首轮 agent_settled）
// ============================================================

describe("settleChatRoundFromResponse（W3：协议形态的本轮结算）", () => {
  let agentDir: string;
  let service: SubagentService;
  let record: ExecutionRecord;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    record = makeIdleRecord();
    record.sessionFile = path.join(agentDir, "fake-session.jsonl");
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("应答到达 → round+1 + result=本轮内容 + 通知回注（W2 契约：outcome = 本轮内容）", () => {
    const notifyRouted: string[] = [];
    const coord = (service as unknown as { collectCoordinator: { route(r: ExecutionRecord): void } }).collectCoordinator;
    const original = coord.route.bind(coord);
    Object.assign(coord, { route: (r: ExecutionRecord) => { notifyRouted.push(r.id); original(r); } });

    const settle = (service as unknown as {
      settleChatRoundFromResponse(record: ExecutionRecord, outcome: { content: string }): void;
    }).settleChatRoundFromResponse.bind(service);
    settle(record, { content: "本轮回复文本" });

    expect(record.round).toBe(2);
    expect(record.result).toBe("本轮回复文本");
    expect(notifyRouted).toEqual([record.id]);
  });

  it("closeAfterRound 挂起 → 轮终兑现终态化（closed + user-close）", async () => {
    record.closeAfterRound = true;
    const settle = (service as unknown as {
      settleChatRoundFromResponse(record: ExecutionRecord, outcome: { content: string }): void;
    }).settleChatRoundFromResponse.bind(service);
    settle(record, { content: "final" });

    await vi.waitFor(() => expect(record.status).toBe("closed"));
    expect(record.closeAfterRound).toBeUndefined();
  });
});
