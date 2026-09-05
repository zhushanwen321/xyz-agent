// src/execution/__tests__/subagent-service-recovery-bounds.test.ts
//
// [u-svc / T2] 服务侧回收上界与 kill 收敛：
//   - T2④/LC-2：closeChatIdle / closeAfterRoundSettled / cancelBackground 三条裸 SIGTERM
//     收敛到 killRecordChildWithEscalation（spy 断言调用点与参数）；
//   - T2⑥/PS-1：disposeAllRecords 补三回收面（controller.abort + kill + disarm idle timer
//     + disarm settled watchdog）；
//   - T2③/LC-1 + D9：热路径投递 armMidRoundNoProgress（挂载点 D2 下沉后在编排层
//     deliverChatMessage 的 interact 返回点；挂载中段无进展检测 + 到期 onMidTimeout/
//     onSettleTimeout 处置：kill + 失败终态化 + error 含 'settled watchdog' 标记与恢复
//     指引；agent_end 交棒收尾段的接线在 session-runner stdout pump，两路径共用）；
//   - T2⑧/PS-3：非 EPIPE 热路径写失败 re-arm idle timer（进程不再裸奔；挂载位 D2
//     下沉后在 PiEngine.deliverPrompt 的非 EPIPE catch——编排层无法区分错误类别）。
//
// mock 形态沿用 subagent-service-message-close.test.ts（真实 SubagentService + ServiceInternals
// cast 暴露 store + mock session-runner/stdin-writer/logger）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// killRecordChildWithEscalation 换 spy（收敛调用点断言）；spawnedChildren 用真 Map
//（热路径投递判定 / EPIPE 兜底按值删除的消费者）；getChildByRecord 从同一 Map 查
//（mock 工厂与测试共享同一实例）。D2 后模块物理下沉 engines/pi/（mock 路径随迁）。
const { killChildSpy, spawnedMap, getChildByRecordMock } = vi.hoisted(() => {
  const map = new Map<string, unknown>();
  return {
    killChildSpy: vi.fn(),
    spawnedMap: map,
    getChildByRecordMock: vi.fn((recordId: string) => map.get(recordId)),
  };
});
vi.mock("../engine/engines/pi/session-runner.ts", () => ({
  runSpawn: vi.fn(),
  killAllSpawnedChildren: vi.fn(),
  getChildByRecord: getChildByRecordMock,
  registerSpawnedChildForRecord: vi.fn(),
  spawnedChildren: spawnedMap,
  killRecordChildWithEscalation: killChildSpy,
}));

// sendPromptCommand 换 spy（控制热路径写成功 / 抛非 EPIPE 错误）。
const { sendPromptCommandMock } = vi.hoisted(() => ({ sendPromptCommandMock: vi.fn() }));
vi.mock("../engine/engines/pi/stdin-writer.ts", () => ({
  sendPromptCommand: sendPromptCommandMock,
  clearEpipeFailure: vi.fn(),
  recordEpipeFailure: vi.fn(() => 1),
  resetAllEpipeFailures: vi.fn(),
  EPIPE_FAILURE_THRESHOLD: 3,
}));

import { FakeChild } from "./helpers/spawn-mock.ts";
import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { RecordStore } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import { armSettledWatchdog, hasSettledWatchdog, SETTLED_MID_ROUND_NO_PROGRESS_MS, _resetSettledWatchdogsForTest } from "../settled-watchdog.ts";
import { armIdleTimer, hasIdleTimer, _resetLifecycleState } from "../lifecycle-manager.ts";
import type { ExecutionRecord } from "../types.ts";

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "svc-recovery-bounds-"));
}

function makePi(): PiLike & {
  appendEntry: ReturnType<typeof vi.fn>;
  events: { emit: ReturnType<typeof vi.fn> };
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as PiLike & {
    appendEntry: ReturnType<typeof vi.fn>;
    events: { emit: ReturnType<typeof vi.fn> };
    sendMessage: ReturnType<typeof vi.fn>;
  };
}

function makeRecord(overrides: Partial<ExecutionRecord> & { id?: string } = {}): ExecutionRecord {
  const { id = "sa-test", ...rest } = overrides;
  const r = createRecord(id, {
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
  Object.assign(r, rest);
  return r;
}

interface ServiceInternals {
  store: RecordStore;
}

type MockPi = ReturnType<typeof makePi>;

function setup(): { agentDir: string; service: SubagentService; store: RecordStore; pi: MockPi } {
  const agentDir = makeTmpAgentDir();
  const modelService = new ModelConfigService({ agentDir });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = makePi();
  service.initSession({ pi, sessionId: "root-session" });
  const store = (service as unknown as ServiceInternals).store;
  return { agentDir, service, store, pi };
}

/** bracket 调 private 方法（ServiceInternals cast 先例的扩展形态）。 */
function privateFn<K extends string>(service: SubagentService, key: K): (...args: never[]) => unknown {
  return (service as unknown as Record<string, (...args: never[]) => unknown>)[key];
}

/**
 * message 投递入口（D2 后形态：编排层私有 deliverChatMessage → PiEngine.interactRecord
 * → deliverPrompt；旧直调形态 deliverMessage 已随协议知识下沉删除）。
 */
async function deliverChat(
  service: SubagentService,
  record: ExecutionRecord,
  text: string,
  interrupt: boolean,
): Promise<void> {
  return (
    privateFn(service, "deliverChatMessage") as (
      this: SubagentService,
      r: ExecutionRecord,
      t: string,
      i: boolean,
    ) => Promise<void>
  ).call(service, record, text, interrupt);
}

describe("T2④ service-side kill convergence", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: MockPi;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    sendPromptCommandMock.mockReset();
    ({ agentDir, service, store, pi } = setup());
  });

  afterEach(() => {
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    spawnedMap.clear();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("cancelBackground (via cancel) routes through killRecordChildWithEscalation", async () => {
    const record = makeRecord({ id: "sa-cancel" });
    store.register(record);
    spawnedMap.set(record.id, new FakeChild());
    const ok = service.cancel(record.id);
    expect(ok).toBe(true);
    expect(killChildSpy).toHaveBeenCalledWith(record.id, "cancelBackground");
  });

  it("closeChatIdle (via closeSubagent force:false on idle) routes through killRecordChildWithEscalation and disarms timers", async () => {
    const record = makeRecord({ id: "sa-close-idle" });
    store.register(record);
    spawnedMap.set(record.id, new FakeChild());
    armIdleTimer(record.id, () => {}); // Path A：idle timer armed（进程保活）
    armSettledWatchdog(record.id, () => {});
    await service.closeSubagent(record, false);
    expect(killChildSpy).toHaveBeenCalledWith(record.id, "closeChatIdle");
    expect(hasIdleTimer(record.id)).toBe(false);
    expect(hasSettledWatchdog(record.id)).toBe(false);
  });

  it("closeAfterRoundSettled routes through killRecordChildWithEscalation", async () => {
    const record = makeRecord({ id: "sa-close-round" });
    await (
      privateFn(service, "closeAfterRoundSettled") as (this: SubagentService, r: ExecutionRecord) => Promise<void>
    ).call(service, record);
    expect(killChildSpy).toHaveBeenCalledWith(record.id, "closeAfterRoundSettled");
  });

  it("disposeAllRecords applies all recovery surfaces: abort + escalation kill + disarm idle/settled timers", () => {
    const running = makeRecord({ id: "sa-dispose-run" });
    const idle = makeRecord({ id: "sa-dispose-idle" });
    store.register(running);
    store.register(idle);
    spawnedMap.set(running.id, new FakeChild());
    armIdleTimer(idle.id, () => {});
    armSettledWatchdog(idle.id, () => {});

    const count = service.disposeAllRecords("parent-new");

    expect(count).toBe(2);
    // 回收面 i：controller.abort
    expect(running.controller?.signal.aborted).toBe(true);
    expect(idle.controller?.signal.aborted).toBe(true);
    // 回收面 ii：kill 收敛到 escalation 入口
    expect(killChildSpy).toHaveBeenCalledWith(running.id, "disposeAllRecords (parent-new)");
    expect(killChildSpy).toHaveBeenCalledWith(idle.id, "disposeAllRecords (parent-new)");
    // 回收面 iii：idle timer + settled watchdog 双 disarm
    expect(hasIdleTimer(idle.id)).toBe(false);
    expect(hasSettledWatchdog(idle.id)).toBe(false);
    // record 终态化
    expect(running.status).toBe("closed");
    expect(idle.status).toBe("closed");
    expect(running.closedReason).toBe("parent-new");
  });
});

describe("T2③ hot-path settled watchdog", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: MockPi;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    // 模拟真 kill 的语义面（置 killed 标记）：isResumable 判定（无活进程）与失败通知
    // 放行依赖它——真实 kill 后 close 事件把句柄移出 spawnedChildren，语义相同。
    killChildSpy.mockImplementation((recordId: string) => {
      const c = spawnedMap.get(recordId) as FakeChild | undefined;
      if (c) c.killed = true;
    });
    sendPromptCommandMock.mockReset();
    sendPromptCommandMock.mockImplementation(() => {});
    ({ agentDir, service, store, pi } = setup());
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    spawnedMap.clear();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("arms the settled watchdog after a successful hot-path prompt", async () => {
    const record = makeRecord({ id: "sa-hot-arm" });
    store.register(record);
    spawnedMap.set(record.id, new FakeChild());
    await deliverChat(service, record, "hello", false);
    expect(sendPromptCommandMock).toHaveBeenCalledTimes(1);
    expect(hasSettledWatchdog(record.id)).toBe(true);
  });

  it("onMidTimeout: kills the child, fails the round, error carries 'settled watchdog' marker and recovery hint", async () => {
    // fake timers 必须先于 arm 生效（useFakeTimers 不接管已存在的真实 timer）
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const record = makeRecord({ id: "sa-hot-timeout" });
    store.register(record);
    spawnedMap.set(record.id, new FakeChild());
    await deliverChat(service, record, "hello", false);
    expect(hasSettledWatchdog(record.id)).toBe(true);

    // [D9 两段式] 热路径 prompt 发出后挂中段：静默满中段窗长触发（本测试 mock 了
    // session-runner，无 stdout pump 驱动事件刷新/交棒，中段静默形态直达）
    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS + 1);

    // kill 收敛入口被触发（onTimeout 第一步）
    expect(killChildSpy).toHaveBeenCalledWith(record.id, "settled watchdog (hot path)");
    // watchdog 到期自清（armedTimers 先删条目再执行回调）
    expect(hasSettledWatchdog(record.id)).toBe(false);
    // 该轮失败终态化（chatMode → MF-6 回退 resumable）+ 失败通知
    expect(record.resumable).toBe(true);
    expect(record.status).toBe("running");
    expect(record.result).toContain("settled watchdog");
    expect(record.result).toContain("Recovery");
    expect(record.result).toContain("action:'list'");
    // 失败通知送达（内核直发路径）
    expect(pi.sendMessage).toHaveBeenCalled();
    const notifyContent = (pi.sendMessage.mock.calls[0]?.[0] as { content?: string } | undefined)?.content ?? "";
    expect(notifyContent).toContain("settled watchdog");
  });
});

describe("T2⑧ non-EPIPE hot-path failure re-arms idle timer", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    ({ agentDir, service, store } = setup());
  });

  afterEach(() => {
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    spawnedMap.clear();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("re-arms the idle timer (default duration) and rethrows on non-EPIPE write failure", async () => {
    const record = makeRecord({ id: "sa-nonpipe" });
    store.register(record);
    spawnedMap.set(record.id, new FakeChild());
    sendPromptCommandMock.mockImplementation(() => {
      throw new Error("write after end: ERR_STREAM_DESTROYED");
    });

    await expect(deliverChat(service, record, "hello", false)).rejects.toThrow(/ERR_STREAM_DESTROYED/);

    // 防泄漏前提恢复：入口 disarm 过的 idle timer 被 re-arm（进程不再裸奔）
    expect(hasIdleTimer(record.id)).toBe(true);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("idle timer re-armed"),
      expect.objectContaining({ detail: expect.stringContaining("ERR_STREAM_DESTROYED") }),
    );
  });

  it("falls back to DEFAULT idle duration (visible) when record.idleTimeoutMs is invalid", async () => {
    const record = makeRecord({ id: "sa-nonpipe-bad" });
    // 直接注入非法值模拟「入口校验前已存在的 record」/ 回归形态：re-arm 首选值非法 →
    // 降级挂 DEFAULT（防御性兜底可见，不静默不挂）
    record.idleTimeoutMs = 3_000_000_000;
    store.register(record);
    spawnedMap.set(record.id, new FakeChild());
    sendPromptCommandMock.mockImplementation(() => {
      throw new Error("ERR_STREAM_DESTROYED");
    });

    await expect(deliverChat(service, record, "hello", false)).rejects.toThrow(/ERR_STREAM_DESTROYED/);
    expect(hasIdleTimer(record.id)).toBe(true);
  });
});
