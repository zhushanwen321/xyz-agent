// src/execution/__tests__/subagent-service-message-close.test.ts
//
// M2-B3 service 层：getRecordForAction 归属守卫 + closeSubagent 行为分流 + closeChatIdle。
//
// 沿用 run-and-finalize-chatmode.test.ts 的 mock 模式（真实 SubagentService + mock runSpawn +
// ServiceInternals cast 暴露 store）。验证 M2-B3 新增的归属守卫与 close 行为分流。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock logger（doFinalizeRecord manifest 写入降级路径用）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({ getLogger: () => loggerMock }));

// mock session-runner（import 链需要 runSpawn/killAllSpawnedChildren/getChildByRecord 存在）
vi.mock("../session-runner.ts", () => ({
  runSpawn: vi.fn(),
  killAllSpawnedChildren: vi.fn(),
  getChildByRecord: vi.fn(() => undefined),
}));

import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import { RecordStore } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import type { ExecutionRecord } from "../types.ts";
import { getChildByRecord } from "../session-runner.ts";
import {
  armIdleTimer,
  disarmIdleTimer,
  hasIdleTimer,
  _resetLifecycleState,
} from "../lifecycle-manager.ts";

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "msg-close-svc-"));
}

function makePi(): PiLike & {
  appendEntry: ReturnType<typeof vi.fn>;
  events: { emit: ReturnType<typeof vi.fn> };
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return { appendEntry: vi.fn(), events: { emit: vi.fn() }, sendMessage: vi.fn() } as unknown as PiLike & {
    appendEntry: ReturnType<typeof vi.fn>;
    events: { emit: ReturnType<typeof vi.fn> };
    sendMessage: ReturnType<typeof vi.fn>;
  };
}

/** 构造 chatMode background record（带 controller，模拟真实 background record）。 */
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
  sessionRootId: string | null;
}

type MockPi = ReturnType<typeof makePi>;

function setup(): {
  agentDir: string;
  service: SubagentService;
  store: RecordStore;
  sessionRootId: string;
  pi: MockPi;
} {
  const agentDir = makeTmpAgentDir();
  const modelService = new ModelConfigService({ agentDir });
  const service = new SubagentService({ cwd: agentDir, modelService });
  // [C2] pi 提为外层引用（对照 real-chain :139-140 形态）——close 现状语义断言需读
  // pi.sendMessage.mock.calls（末条通知 content 指针行），内联构造不保留引用。
  const pi = makePi();
  service.initSession({ pi, sessionId: "root-session" });
  const internals = service as unknown as ServiceInternals;
  return { agentDir, service, store: internals.store, sessionRootId: internals.sessionRootId!, pi };
}

// ============================================================
// getRecordForAction 归属守卫（决策 3）
// ============================================================

describe("getRecordForAction 归属守卫（决策 3）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let sessionRootId: string;

  beforeEach(() => {
    ({ agentDir, service, store, sessionRootId } = setup());
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("正常（rootSessionId 匹配）→ 返回可变 record", () => {
    const record = makeRecord({ rootSessionId: sessionRootId });
    store.register(record);
    expect(service.getRecordForAction(record.id)).toBe(record);
  });

  it("不存在 → throw not found or not owned", () => {
    expect(() => service.getRecordForAction("sa-nonexistent")).toThrow(/not found or not owned/);
  });

  it("rootSessionId 不匹配 → throw not found or not owned（不区分 not found vs not owned，防信息泄露）", () => {
    const record = makeRecord({ id: "sa-other", rootSessionId: "other-session" });
    store.register(record);
    expect(() => service.getRecordForAction("sa-other")).toThrow(/not found or not owned/);
  });
});

// ============================================================
// closeSubagent 行为分流
// ============================================================

describe("closeSubagent 行为分流", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: MockPi;

  beforeEach(() => {
    ({ agentDir, service, store, pi } = setup());
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("running + force:false + 有活进程 → 置 closeAfterRound=true（不立即终态，等轮完）", async () => {
    // v4 B-1：closeSubagent running 分支按 isResumable 区分——有活进程（isResumable=false）
    // 走 closeAfterRound；无活进程（isResumable=true）走 closeChatIdle。本用例 mock 活进程。
    vi.mocked(getChildByRecord).mockReturnValueOnce({ killed: false } as never);
    const record = makeRecord({ status: "running" });
    store.register(record);

    await service.closeSubagent(record, false);

    expect(record.closeAfterRound).toBe(true);
    expect(record.status).toBe("running"); // 仍 running
    expect(store.getMutable(record.id)).toBe(record); // 留内存
  });

  it("running + 无活进程（旧 idle）→ closeChatIdle（closed 终态化 + archive）", async () => {
    // v4 B-1：旧 idle 折入 running。running + force:false + isResumable=true（getChildByRecord
    // 默认 mock 返回 undefined = 无活进程）→ closeChatIdle 立即终态化。
    const record = makeRecord({ status: "running", round: 1 });
    record.sessionFile = path.join(agentDir, "test.jsonl");
    store.register(record);

    await service.closeSubagent(record, false);

    expect(record.status).toBe("closed");
    expect(store.getMutable(record.id)).toBeUndefined(); // archived
  });

  it("running + force:true → cancelBackground（closed+cancelled 终态化 + archive）", async () => {
    const record = makeRecord({ status: "running", sessionFile: path.join(agentDir, "run.jsonl") });
    store.register(record);

    await service.closeSubagent(record, true);

    // v4 B-1：cancelled 折入 closed（closedReason='cancelled' 区分用户取消语义）
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("cancelled");
    expect(store.getMutable(record.id)).toBeUndefined(); // archived
  });

  it("终态（done）→ 幂等 no-op（不改状态、不 archive）", async () => {
    const record = makeRecord({ status: "closed" });
    store.register(record);

    await service.closeSubagent(record, false);

    expect(record.status).toBe("closed"); // 不变
  });

  // ── [M5] Path A（isIdle timer armed + 保活进程）立即终态化 ─────────────

  it("[M5] Path A（timer armed + 活进程）+ force:false → 立即终态化（closed+user-close + kill 进程 + disarm timer），不置 closeAfterRound", async () => {
    // 旧代码 Path A 走 else 置 closeAfterRound，但 chatMode 轮完成恒经 agent_settled →
    // onRoundSettled → runAndFinalize early return（isIdle 恒 true），标志无人消费，
    // tool 却返回 {closed:true}（谎报）。
    const killFn = vi.fn(() => true);
    const child = { killed: false, kill: killFn } as unknown as ChildProcess;
    vi.mocked(getChildByRecord).mockReturnValueOnce(child);
    const record = makeRecord({ status: "running", round: 1 });
    record.sessionFile = path.join(agentDir, "path-a.jsonl");
    store.register(record);
    armIdleTimer(record.id, () => {}); // Path A：轮次完成、进程保活等待续聊
    expect(hasIdleTimer(record.id)).toBe(true);

    try {
      await service.closeSubagent(record, false);
    } finally {
      disarmIdleTimer(record.id); // 断言失败路径的兜底清理
    }

    expect(record.closeAfterRound).toBeUndefined(); // 不置标志
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("user-close");
    expect(store.getMutable(record.id)).toBeUndefined(); // archived
    expect(killFn).toHaveBeenCalledWith("SIGTERM"); // 保活进程回收
    expect(hasIdleTimer(record.id)).toBe(false); // timer disarmed
  });

  it("[M5] Path B（无活进程、timer 未 armed）+ force:false → 立即终态化（同旧 isResumable 行为）", async () => {
    const record = makeRecord({ status: "running", round: 1 });
    record.sessionFile = path.join(agentDir, "path-b.jsonl");
    store.register(record);

    await service.closeSubagent(record, false);

    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("user-close");
    expect(store.getMutable(record.id)).toBeUndefined();
    // [C2TC2] close 后无新增通知的 unit 级断言（closeChatIdle 只终态化，终态通知发送点
    // 不存在）——与 Path A 消费点用例（closeAfterRoundSettled）补齐两路径 unit 覆盖
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  // ── [M6] cancelBackground 显式 kill（chatMode 热路径轮中 cancel）────────

  it("[M6] running + force:true + 活进程（热路径轮中）→ cancelBackground 显式 SIGTERM + disarm idle timer", async () => {
    // chatMode 首轮 agent_settled 后 runSpawn 提前 resolveRun(0) 返回，
    // abort→kill listener 已被 removeEventListener——热路径轮中 cancel 只能靠显式 kill。
    const killFn = vi.fn(() => true);
    const child = { killed: false, kill: killFn } as unknown as ChildProcess;
    vi.mocked(getChildByRecord).mockReturnValueOnce(child);
    const record = makeRecord({ status: "running", sessionFile: path.join(agentDir, "hot.jsonl") });
    record.controller = new AbortController();
    store.register(record);
    armIdleTimer(record.id, () => {}); // Path A 等待续聊态（cancel 时必须 disarm）
    expect(hasIdleTimer(record.id)).toBe(true);

    try {
      await service.closeSubagent(record, true);
    } finally {
      disarmIdleTimer(record.id); // 断言失败路径的兜底清理
    }

    expect(killFn).toHaveBeenCalledWith("SIGTERM"); // 子进程收到 kill
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("cancelled");
    expect(hasIdleTimer(record.id)).toBe(false); // timer disarmed
    expect(store.getMutable(record.id)).toBeUndefined(); // archived
  });
});

// ============================================================
// [M5] closeAfterRound 消费点：onRoundSettled（chatMode 热路径轮完成）
// ============================================================

describe("[M5] closeAfterRound 消费点挂 onRoundSettled（chatMode 轮完成终态化）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;

  beforeEach(() => {
    vi.mocked(getChildByRecord).mockReset();
    vi.mocked(getChildByRecord).mockReturnValue(undefined);
    ({ agentDir, service, store } = setup());
  });

  afterEach(() => {
    service.dispose();
    _resetLifecycleState();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("热路径轮完成（onRoundSettled）+ closeAfterRound=true → 消费标志终态化（closed+user-close + archive）", async () => {
    // 热路径轮不经 runAndFinalize（deliverMessage 直接 sendPromptCommand），旧消费点
    // （runAndFinalize CAS 分支）不可达——唯一可达的收尾点是 onRoundSettled。
    const killFn = vi.fn(() => true);
    const child = { killed: false, kill: killFn } as unknown as ChildProcess;
    // mockReturnValue（非 Once）：notifyComplete → hasRunningBackground → hasLiveProcessHandle
    // 也会读 getChildByRecord，Once mock 会被提前消费掉。
    vi.mocked(getChildByRecord).mockReturnValue(child);
    const internals = service as unknown as { buildSessionRunnerContext(): { onRoundSettled?: (r: ExecutionRecord) => void } };
    const ctx = internals.buildSessionRunnerContext();
    expect(typeof ctx.onRoundSettled).toBe("function");

    const record = makeRecord({ id: "sa-m5", status: "running" });
    record.sessionFile = path.join(agentDir, "m5.jsonl");
    store.register(record);
    record.closeAfterRound = true; // busy 轮中 close(force:false) 置的标志
    armIdleTimer(record.id, () => {}); // session-runner 在 onRoundSettled 前已 arm（时序还原）
    try {
      ctx.onRoundSettled!(record);
      // closeAfterRoundSettled 是 async（finalizeRecord 内 manifest 写入）——等微任务收尾完成
      await vi.waitFor(() => expect(store.getMutable(record.id)).toBeUndefined());
    } finally {
      disarmIdleTimer(record.id);
    }

    expect(record.closeAfterRound).toBeUndefined(); // 标志已消费
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("user-close");
    expect(killFn).toHaveBeenCalledWith("SIGTERM"); // 保活进程回收
    expect(hasIdleTimer(record.id)).toBe(false);
  });

  it("onRoundSettled 无 closeAfterRound → 不终态化（record 保持 running-resumable，轮完成通知照常）", async () => {
    const internals = service as unknown as { buildSessionRunnerContext(): { onRoundSettled?: (r: ExecutionRecord) => void } };
    const ctx = internals.buildSessionRunnerContext();
    const record = makeRecord({ id: "sa-m5-keep", status: "running" });
    store.register(record);
    armIdleTimer(record.id, () => {});
    try {
      ctx.onRoundSettled!(record);
    } finally {
      disarmIdleTimer(record.id);
    }

    expect(record.status).toBe("running"); // 不终态化
    expect(record.round).toBe(1); // round 累加照常
    expect(store.getMutable(record.id)).toBe(record); // 留内存
  });
});

// ============================================================
// [C2 wave2] close 现状语义 + sessionFile 条件透传
// ============================================================

describe("[C2] close 现状语义 + sessionFile 条件透传", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: MockPi;

  beforeEach(() => {
    vi.mocked(getChildByRecord).mockReset();
    // 默认无活进程（Path B / isResumable 形态）；hasRunningBackground 亦读此 mock
    vi.mocked(getChildByRecord).mockReturnValue(undefined);
    ({ agentDir, service, store, pi } = setup());
  });

  afterEach(() => {
    service.dispose();
    _resetLifecycleState();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("close 现状语义：轮次通知（含指针行）发出后 closeAfterRoundSettled 终态化，无新增 sendMessage，末条通知含指针行", async () => {
    // 现状机制：终态通知发送点不存在（上报 feature 层，本 slice 不新增）——close 只终态化
    // record，不再发通知。指针断言在 C2T1/C2T2 合入前必 red（无指针行），合入后 green。
    const internals = service as unknown as { buildSessionRunnerContext(): { onRoundSettled?: (r: ExecutionRecord) => void } };
    const ctx = internals.buildSessionRunnerContext();
    const record = makeRecord({ id: "sa-c2-close", status: "running" });
    record.sessionFile = path.join(agentDir, "c2-close.jsonl");
    store.register(record);
    record.closeAfterRound = true; // busy 轮中 close(force:false) 置的标志
    armIdleTimer(record.id, () => {});
    try {
      ctx.onRoundSettled!(record);
      await vi.waitFor(() => expect(store.getMutable(record.id)).toBeUndefined());
    } finally {
      disarmIdleTimer(record.id);
    }

    // close 后 sendMessage 总数不变（轮次通知 1 条后无新增）
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    // 末条轮次通知含 Full transcript 指针行（chatMode:true + sessionFile 有值 → 透传）
    const sent = pi.sendMessage.mock.calls[0]![0] as { content: string };
    expect(sent.content).toContain(`\n\nFull transcript: ${record.sessionFile}`);
  });

  it("one-shot 条件透传（R4 必选）：chatMode:false + sessionFile 有值 → 通知不透传 sessionFile、content 无指针行", () => {
    // 锁死 toNotifyRecord 的 chatMode 条件（C2C2 契约）——漏加条件时 notifier 单测不红
    //（notifier 层只见最终字段），此用例走真实 SubagentService + toNotifyRecord 路径必红。
    // 同时服务 C2TC6 结构级断言。
    const record = makeRecord({ id: "sa-c2-oneshot", status: "running", chatMode: false, result: "done" });
    record.sessionFile = path.join(agentDir, "c2-oneshot.jsonl");
    store.register(record);

    // running + 无活进程（getChildByRecord mock undefined）→ isResumable 放行 →
    // 非 chatMode 映射 closed 通知，立即 flush（无其他 running background）
    const svc = service as unknown as { notifyComplete(r: ExecutionRecord): void };
    svc.notifyComplete(record);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const msg = pi.sendMessage.mock.calls[0]![0] as {
      content: string;
      details?: { sessionFile?: string };
    };
    // 结构级：one-shot 通知的 BgNotifyRecord 不含 sessionFile
    expect(msg.details?.sessionFile).toBeUndefined();
    // 语义级：正文无指针行，且与改造前逐字节一致（G4）
    expect(msg.content).not.toContain("Full transcript");
    expect(msg.content).toBe('Subagent "general-purpose" (sa-c2-oneshot) completed. Result:\ndone');
  });

  it("chatMode:true 对照透传：isResumable 放行的轮次通知携带 sessionFile + 指针行（漏加 chatMode 条件时本用例红）", () => {
    const record = makeRecord({ id: "sa-c2-chat", status: "running", result: "round reply" });
    record.sessionFile = path.join(agentDir, "c2-chat.jsonl");
    store.register(record);

    const svc = service as unknown as { notifyComplete(r: ExecutionRecord): void };
    svc.notifyComplete(record);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const msg = pi.sendMessage.mock.calls[0]![0] as {
      content: string;
      details?: { sessionFile?: string };
    };
    expect(msg.details?.sessionFile).toBe(path.join(agentDir, "c2-chat.jsonl"));
    expect(msg.content).toContain(`\n\nFull transcript: ${path.join(agentDir, "c2-chat.jsonl")}`);
  });
});
