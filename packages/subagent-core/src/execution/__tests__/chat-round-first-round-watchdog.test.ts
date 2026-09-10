// src/execution/__tests__/chat-round-first-round-watchdog.test.ts
//
// [F-2 修复] 首轮/冷续轮 settled-watchdog arm 重接 + [F-5 修复] chat 轮路由终态化注销。
//
// 背景：armMidRoundNoProgress 此前唯一调用点在 deliverChatMessage（热路径续聊轮）；
// kickOffChatRound（spawn 首轮 + 冷续 resume 轮）内无任何 arm——被删的 inproc
// stdout-pump 是首轮唯一中段守护，协议化后引擎侧 spawn-runner 仅 turn 计数无墙钟，
// 首轮 wedged（LC-1 场景①：无事件行输出）无任何熔断。修复 = run 派发前补 arm
//（refresh 源 = runId 键 ctx.onEvent 事件行 + ctx.onRoundLifecycle settled 交棒——
// 引擎侧 spawn-runner 对 text_delta 同时走 onEvent 与 onDelta，刷新面与热路径等效）。
//
// [F-5] chat 轮路由（chatRoundRoutes）此前仅 cancelBackground 注销；finalize 链终态化
// （closeChatIdle / closeAfterRoundSettled / finalizeRecord）不注销 → 路由闭包持
// record/stream/守护引用泄漏。修复 = doFinalizeRecord 的 onFinalized 钩子单一汇聚点。
//
// 替身形态与 subagent-service-recovery-bounds.test.ts 同源（fake-engine-port 协议 seam）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

const { killChildSpy } = vi.hoisted(() => ({ killChildSpy: vi.fn() }));
vi.mock("../engine/host/spawned-children.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/host/spawned-children.ts")>();
  return { ...actual, killRecordChildWithEscalation: killChildSpy };
});

import { clearEngines } from "../engine/registry.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../model-resolver.ts";
import type { RecordStore } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import {
  getSettledWatchdogPhase,
  hasSettledWatchdog,
  SETTLED_MID_ROUND_NO_PROGRESS_MS,
  SETTLED_WATCHDOG_TIMEOUT_MS,
  _resetSettledWatchdogsForTest,
} from "../settled-watchdog.ts";
import { _resetLifecycleState } from "../lifecycle-manager.ts";
import { _resetCoreSpawnedChildrenMirrorForTest } from "../engine/host/spawned-children.ts";
import type { ExecutionRecord } from "../types.ts";

function makePi(): PiLike {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as PiLike;
}

interface ServiceInternals {
  store: RecordStore;
}

const CTX_MODEL: ModelInfo = { id: "m", name: "M", provider: "p", reasoning: false };

function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

function setup(): { agentDir: string; service: SubagentService; store: RecordStore; pi: PiLike; fake: FakePiEnginePort } {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-round-watchdog-"));
  clearEngines();
  const fake = registerFakePiEngine();
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({ modelRegistry: makeEmptyRegistry(), sessionId: "root-session", ctxModel: CTX_MODEL });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = makePi();
  service.initSession({ pi, sessionId: "root-session" });
  const store = (service as unknown as ServiceInternals).store;
  return { agentDir, service, store, pi, fake };
}

/** 模拟 kickOffChatRound 的路由注册面（Service map + fake 引擎两端同挂）。 */
function registerRoute(service: SubagentService, fake: FakePiEnginePort, recordId: string): void {
  const unregister = fake.registerChatRoundRoute(recordId, {
    onStreamDelta: () => {},
    onRoundLifecycle: () => {},
  });
  (
    service as unknown as { chatRoundRoutes: Map<string, () => void> }
  ).chatRoundRoutes.set(recordId, unregister);
}

function makeChatRecord(id: string): ExecutionRecord {
  return createRecord(id, {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: "test",
    slug: "test",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: true,
    controller: new AbortController(),
  });
}

describe("[F-2] 首轮/冷续轮 settled-watchdog arm（kickOffChatRound run 派发点）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: PiLike;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    ({ agentDir, service, store, pi, fake } = setup());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    vi.useRealTimers();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("首轮 run 派发后中段守护 armed（修复前首轮无任何守护）", async () => {
    const handle = await service.execute({ task: "first round", slug: "t", ctxModel: CTX_MODEL, conversation: true });
    expect(fake.runs).toHaveLength(1);
    expect(hasSettledWatchdog(handle.subagentId)).toBe(true);
    expect(getSettledWatchdogPhase(handle.subagentId)).toBe("mid-round");
  });

  it("冷续轮进行中无产出 → 中段守护按既有超时语义触发：kill + 引擎 cancel + 回退 idle-resumable（fake timers）", async () => {
    // fake timers 必须先于 arm 生效（useFakeTimers 不接管已存在的真实 timer）
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const record = makeChatRecord("sa-first");
    record.sessionFile = path.join(agentDir, "prior-session.jsonl");
    fs.writeFileSync(record.sessionFile, "{}\n", "utf-8");
    store.register(record);
    await (
      service as unknown as { resumeColdRound: (r: ExecutionRecord, t: string) => void }
    ).resumeColdRound(record, "cold resume text");
    expect(fake.runs).toHaveLength(1); // 冷续轮 run 已派发
    expect(hasSettledWatchdog(record.id)).toBe(true);

    // 冷续轮全程静默（无协议事件行）满中段窗长
    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS + 1);

    expect(killChildSpy).toHaveBeenCalledWith(record.id, "settled watchdog (hot path)");
    expect(hasSettledWatchdog(record.id)).toBe(false); // 到期自清
    // chatMode MF-6：回退 idle-resumable（不销毁对话）
    expect(record.resumable).toBe(true);
    expect(record.status).toBe("running");
    expect(record.result).toContain("settled watchdog");
    expect(record.result).toContain("Recovery");
    // 引擎侧终止意图（协议 interact cancel）
    const cancel = fake.interacts.find((c) => c.action.kind === "cancel");
    expect(cancel).toBeDefined();
    void pi;
  });

  it("中段事件行（text_delta 经 onEvent）刷新静默计时：半窗 + 刷新 + 半窗不触发，再满窗才触发", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const handle = await service.execute({ task: "streaming round", slug: "t", ctxModel: CTX_MODEL, conversation: true });
    const run = fake.runs[0]!;

    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS / 2);
    // 首轮 runId 键协议事件行到达（text_delta——引擎侧同时走 onEvent 通道）
    run.emitEvent({ type: "text_delta", delta: "chunk" });
    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS / 2 + 1);
    expect(hasSettledWatchdog(handle.subagentId)).toBe(true); // 刷新后未到期
    expect(killChildSpy).not.toHaveBeenCalled();

    // 刷新后再满整个静默窗才触发
    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS + 1);
    expect(killChildSpy).toHaveBeenCalledWith(handle.subagentId, "settled watchdog (hot path)");
  });

  it("首轮 settled 相位交棒：中段窗内相位到达 → 切收尾段（中段窗不再触发，收尾段硬顶触发）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const handle = await service.execute({ task: "stuck after settle", slug: "t", ctxModel: CTX_MODEL, conversation: true });
    const run = fake.runs[0]!;

    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS / 2);
    // 首轮 runId 键 roundLifecycle settled 相位（W3 报告称已接——本用例核实链路生效）
    run.emitLifecycle({ phase: "settled", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
    expect(getSettledWatchdogPhase(handle.subagentId)).toBe("settled"); // 已交棒收尾段

    // 中段不再计时（交棒清掉，不继承——30min 静默判据对收尾段失效）；收尾段未满（<600s）不触发
    await vi.advanceTimersByTimeAsync(SETTLED_WATCHDOG_TIMEOUT_MS - 1);
    expect(killChildSpy).not.toHaveBeenCalled();
    expect(hasSettledWatchdog(handle.subagentId)).toBe(true); // 收尾段仍在计时

    // 收尾段硬顶（600s 默认）到期触发
    await vi.advanceTimersByTimeAsync(2);
    expect(killChildSpy).toHaveBeenCalledWith(handle.subagentId, "settled watchdog (hot path)");
  });
});

describe("[F-5] chat 轮路由终态化注销（doFinalizeRecord onFinalized 汇聚点）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    ({ agentDir, service, store, fake } = setup());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("closeChatIdle 终态化路径注销 chat 轮路由（修复前仅 cancelBackground 注销 → 泄漏）", async () => {
    const record = makeChatRecord("sa-route-leak");
    store.register(record);
    // 模拟首轮已注册的 recordId 键路由（kickOffChatRound 注册面：Service map + fake 引擎两端）
    registerRoute(service, fake, record.id);
    // Path A：idle timer armed（进程保活等待续聊）→ closeSubagent(false) 走 closeChatIdle
    const { armIdleTimer } = (await import("../lifecycle-manager.ts")) as typeof import("../lifecycle-manager.ts");
    armIdleTimer(record.id, () => {}, 60_000);

    await service.chatActions.closeSubagent(record, false);

    expect(fake.chatRouteUnregisters).toContain(record.id);
  });

  it("closeAfterRoundSettled（优雅关闭消费）路径注销 chat 轮路由", async () => {
    const record = makeChatRecord("sa-route-close-round");
    store.register(record);
    registerRoute(service, fake, record.id);
    record.closeAfterRound = true;

    await (
      service as unknown as { closeAfterRoundSettled: (r: ExecutionRecord) => Promise<void> }
    ).closeAfterRoundSettled(record);

    expect(fake.chatRouteUnregisters).toContain(record.id);
    expect(record.status).toBe("closed");
  });
});
