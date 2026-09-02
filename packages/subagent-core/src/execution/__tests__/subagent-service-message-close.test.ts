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
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// mock session-runner（import 链需要 runSpawn/killAllSpawnedChildren/getChildByRecord 存在）
vi.mock("../engine/engines/pi/session-runner.ts", () => ({
  runSpawn: vi.fn(),
  killAllSpawnedChildren: vi.fn(),
  getChildByRecord: vi.fn(() => undefined),
}));

import { createRecord, updateFromEvent } from "../execution-record.ts";
import { createNotifyHost } from "../notify-host.ts";
import { ModelConfigService } from "../model-config-service.ts";
import { RecordStore } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import type { ExecutionRecord } from "../types.ts";
import { getChildByRecord } from "../engine/engines/pi/session-runner.ts";
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
    expect(service.chatActions.getRecordForAction(record.id)).toBe(record);
  });

  it("不存在 → throw not found or not owned", () => {
    expect(() => service.chatActions.getRecordForAction("sa-nonexistent")).toThrow(/not found or not owned/);
  });

  it("rootSessionId 不匹配 → throw not found or not owned（不区分 not found vs not owned，防信息泄露）", () => {
    const record = makeRecord({ id: "sa-other", rootSessionId: "other-session" });
    store.register(record);
    expect(() => service.chatActions.getRecordForAction("sa-other")).toThrow(/not found or not owned/);
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

    await service.chatActions.closeSubagent(record, false);

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

    await service.chatActions.closeSubagent(record, false);

    expect(record.status).toBe("closed");
    expect(store.getMutable(record.id)).toBeUndefined(); // archived
  });

  it("running + force:true → cancelBackground（closed+cancelled 终态化 + archive）", async () => {
    const record = makeRecord({ status: "running", sessionFile: path.join(agentDir, "run.jsonl") });
    store.register(record);

    await service.chatActions.closeSubagent(record, true);

    // v4 B-1：cancelled 折入 closed（closedReason='cancelled' 区分用户取消语义）
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("cancelled");
    expect(store.getMutable(record.id)).toBeUndefined(); // archived
  });

  it("终态（done）→ 幂等 no-op（不改状态、不 archive）", async () => {
    const record = makeRecord({ status: "closed" });
    store.register(record);

    await service.chatActions.closeSubagent(record, false);

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
      await service.chatActions.closeSubagent(record, false);
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

  it("[M5] Path B（无活进程、timer 未 armed）+ force:false → 立即终态化（同旧 isResumable 行为）+ 终态通知", async () => {
    const record = makeRecord({ status: "running", round: 1 });
    record.sessionFile = path.join(agentDir, "path-b.jsonl");
    store.register(record);

    await service.chatActions.closeSubagent(record, false);

    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("user-close");
    expect(store.getMutable(record.id)).toBeUndefined();
    // [C-1] close 终态通知（设计 D2 路径②）：chatMode close 后父 agent 收到终态通知——
    // 正文空串（doneResult.text 恒空）+ 轮次统计 + Full transcript 指针行
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const sent = pi.sendMessage.mock.calls[0]![0] as { content: string };
    expect(sent.content).toContain("completed after 1 round.");
    expect(sent.content).toContain(`\n\nFull transcript: ${record.sessionFile}`);
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
      await service.chatActions.closeSubagent(record, true);
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

	it("close 语义：轮次通知（含指针行）发出后 closeAfterRoundSettled 终态化 + 终态通知，两条都送达", async () => {
		// [C-1] 修复后语义：终态通知经 notifyClosed 显式发送（dedup 身份 = 裸 id，与轮次通知
		// 的 id:round key 区分）——close 后父 agent 收到「最后一轮轮次通知 + 终态通知」两条。
		const internals = service as unknown as { buildSessionRunnerContext(): { onRoundSettled?: (r: ExecutionRecord) => void } };
		const ctx = internals.buildSessionRunnerContext();
		const record = makeRecord({ id: "sa-c2-close", status: "running" });
		record.sessionFile = path.join(agentDir, "c2-close.jsonl");
		store.register(record);
		record.closeAfterRound = true; // busy 轮中 close(force:false) 置的标志
		armIdleTimer(record.id, () => {});
		try {
			ctx.onRoundSettled!(record);
			// closeAfterRoundSettled 是 async（finalizeRecord 链）——终态通知在链末尾的
			// notifyClosed，等它发出而不是只等 archive（archive 在链中段，先于通知）
			await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));
			await vi.waitFor(() => expect(store.getMutable(record.id)).toBeUndefined());
		} finally {
			disarmIdleTimer(record.id);
		}

		// 轮次通知 1 条 + 终态通知 1 条（dedup 不吞）
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
		// 第 1 条：轮次通知含 Full transcript 指针行（chatMode:true + sessionFile 有值 → 透传）
		const roundMsg = pi.sendMessage.mock.calls[0]![0] as { content: string };
		expect(roundMsg.content).toContain("finished a round");
		expect(roundMsg.content).toContain(`\n\nFull transcript: ${record.sessionFile}`);
		// 第 2 条：终态通知含轮次统计 + 指针行
		const closeMsg = pi.sendMessage.mock.calls[1]![0] as { content: string };
		expect(closeMsg.content).toContain("completed after 1 round.");
		expect(closeMsg.content).toContain(`\n\nFull transcript: ${record.sessionFile}`);
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
    // [D4-①] notifyComplete 已随通知簇搬至 notify-host——按轴直接构造（同 pi/store
    // 注入，行为与经 Service 的原路径等价；dedup 集为空与单次调用断言相容）
    createNotifyHost({ getPi: () => pi, listRunning: () => store.listRunning(), getIsIdle: () => undefined })
      .notifyComplete(record);

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

    createNotifyHost({ getPi: () => pi, listRunning: () => store.listRunning(), getIsIdle: () => undefined })
      .notifyComplete(record);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const msg = pi.sendMessage.mock.calls[0]![0] as {
      content: string;
      details?: { sessionFile?: string };
    };
    expect(msg.details?.sessionFile).toBe(path.join(agentDir, "c2-chat.jsonl"));
    expect(msg.content).toContain(`\n\nFull transcript: ${path.join(agentDir, "c2-chat.jsonl")}`);
  });
});

// ============================================================
// [C-4] chatMode 轮次增量（onRoundSettled 写点）+ close 终态通知
// ============================================================

describe("[C-4] onRoundSettled 轮次增量 + [C-1] close 终态通知", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: MockPi;

  beforeEach(() => {
    vi.mocked(getChildByRecord).mockReset();
    // 默认无活进程：hasRunningBackground=false → notify 立即 flush，sendMessage 同步可断言
    vi.mocked(getChildByRecord).mockReturnValue(undefined);
    ({ agentDir, service, store, pi } = setup());
  });

  afterEach(() => {
    service.dispose();
    _resetLifecycleState();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  /** 真实回调链（与生产一致：agent_settled → onRoundSettled），turns 经 updateFromEvent 累积。 */
  function settleRound(record: ExecutionRecord): void {
    (service as unknown as {
      buildSessionRunnerContext(): { onRoundSettled?: (r: ExecutionRecord) => void };
    }).buildSessionRunnerContext().onRoundSettled!(record);
  }

  it("空增量轮：通知正文占位 (no output this round)，不含上一轮文本（D5，onRoundSettled 写点）", () => {
    const record = makeRecord({ id: "sa-empty-round", status: "running" });
    record.sessionFile = path.join(agentDir, "empty-round.jsonl");
    store.register(record);
    armIdleTimer(record.id, () => {});
    try {
      // 第 1 轮：有真实回复
      updateFromEvent(record, { type: "text_delta", delta: "ROUND-ONE-REPLY" });
      updateFromEvent(record, { type: "turn_end" });
      settleRound(record);

      // 第 2 轮：零新事件（纯空转/工具轮形态）→ 空增量
      settleRound(record);
    } finally {
      disarmIdleTimer(record.id);
    }

    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    const round1 = pi.sendMessage.mock.calls[0]![0] as { content: string };
    expect(round1.content).toContain("ROUND-ONE-REPLY");
    // D5 核心：空增量轮占位，不沿用旧 result（= 上一轮增量 → 父 agent 误读为原样重复回复）
    const round2 = pi.sendMessage.mock.calls[1]![0] as { content: string };
    expect(round2.content).toContain("(no output this round)");
    expect(round2.content).not.toContain("ROUND-ONE-REPLY");
  });

  it("多轮增量：第 2 条通知只含第 2 轮文本、不含第 1 轮（D1/G1，roundBaseTurnIndex 推进）", () => {
    const record = makeRecord({ id: "sa-multi-round", status: "running" });
    record.sessionFile = path.join(agentDir, "multi-round.jsonl");
    store.register(record);
    armIdleTimer(record.id, () => {});
    try {
      // 第 1 轮
      updateFromEvent(record, { type: "text_delta", delta: "ALPHA-ROUND-ONE" });
      updateFromEvent(record, { type: "turn_end" });
      settleRound(record);

      // 第 2 轮：turn_end 已闭合前轮 turn → text_delta 开新 turn
      updateFromEvent(record, { type: "text_delta", delta: "BETA-ROUND-TWO" });
      updateFromEvent(record, { type: "turn_end" });
      settleRound(record);
    } finally {
      disarmIdleTimer(record.id);
    }

    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    const round1 = pi.sendMessage.mock.calls[0]![0] as { content: string };
    expect(round1.content).toContain("ALPHA-ROUND-ONE");
    expect(round1.content).not.toContain("BETA-ROUND-TWO");
    const round2 = pi.sendMessage.mock.calls[1]![0] as { content: string };
    expect(round2.content).toContain("BETA-ROUND-TWO");
    expect(round2.content).not.toContain("ALPHA-ROUND-ONE");
    // base 推进写点：第 2 轮后边界 = 2 个 turn（第 3 轮增量将从新 turn 起）
    expect(record.roundBaseTurnIndex).toBe(2);
  });

  it("[C-1] idle close（closeChatIdle）后父侧收到终态通知：正文空串 + Full transcript 指针行，轮次通知与终态通知都送达（dedup 不吞）", async () => {
    const record = makeRecord({ id: "sa-idle-close", status: "running" });
    record.sessionFile = path.join(agentDir, "idle-close.jsonl");
    store.register(record);
    armIdleTimer(record.id, () => {}); // Path A：轮次完成、进程保活等待续聊
    try {
      updateFromEvent(record, { type: "text_delta", delta: "LAST-ROUND-INCREMENT" });
      updateFromEvent(record, { type: "turn_end" });
      settleRound(record); // 第 1 条：轮次通知
      await service.chatActions.closeSubagent(record, false); // idle close（D2 路径②）
    } finally {
      disarmIdleTimer(record.id);
    }

    // dedup 不吞：轮次通知（key=id:1）+ 终态通知（key=裸 id）两条都送达
    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    const roundMsg = pi.sendMessage.mock.calls[0]![0] as { content: string };
    expect(roundMsg.content).toContain("finished a round");
    expect(roundMsg.content).toContain("LAST-ROUND-INCREMENT");
    // 终态通知：正文空串占位（不含上一轮增量，D2 路径②）+ 轮次统计 + 指针行
    const closeMsg = pi.sendMessage.mock.calls[1]![0] as { content: string };
    expect(closeMsg.content).toContain("completed after 1 round.");
    expect(closeMsg.content).toContain(`\n\nFull transcript: ${record.sessionFile}`);
    expect(closeMsg.content).not.toContain("LAST-ROUND-INCREMENT");
  });

  it("[C-1] 路径①（closeAfterRoundSettled）：轮次通知与终态通知两条都送达，终态携带本轮增量 + 轮次统计 + 指针行", async () => {
    const record = makeRecord({ id: "sa-path-one", status: "running" });
    record.sessionFile = path.join(agentDir, "path-one.jsonl");
    store.register(record);
    record.closeAfterRound = true; // busy 轮中 close(force:false) 置的标志
    armIdleTimer(record.id, () => {});
    try {
      updateFromEvent(record, { type: "text_delta", delta: "PATH-ONE-ROUND-REPLY" });
      updateFromEvent(record, { type: "turn_end" });
      settleRound(record); // 轮次通知 + 消费标志 → closeAfterRoundSettled 终态化
      // 终态通知在 async finalize 链末尾的 notifyClosed——直接等它发出
      await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(store.getMutable(record.id)).toBeUndefined());
    } finally {
      disarmIdleTimer(record.id);
    }

    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    const roundMsg = pi.sendMessage.mock.calls[0]![0] as { content: string };
    expect(roundMsg.content).toContain("finished a round");
    expect(roundMsg.content).toContain("PATH-ONE-ROUND-REPLY");
    // 路径①终态：合成 result 沿用 record.result（= 本轮增量，D2 路径①）+ 统计 + 指针
    const closeMsg = pi.sendMessage.mock.calls[1]![0] as { content: string };
    expect(closeMsg.content).toContain("completed after 1 round.");
    expect(closeMsg.content).toContain("PATH-ONE-ROUND-REPLY");
    expect(closeMsg.content).toContain(`\n\nFull transcript: ${record.sessionFile}`);
  });

  it("[G4] 对照：one-shot（chatMode:false）close → 不发终态通知（现状行为字节不变）", async () => {
    const record = makeRecord({ id: "sa-oneshot-close", status: "running", chatMode: false });
    record.sessionFile = path.join(agentDir, "oneshot-close.jsonl");
    store.register(record);

    await service.chatActions.closeSubagent(record, false); // resumable → closeChatIdle → notifyClosed 拒绝

    expect(record.status).toBe("closed");
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("[W16 P-1 回归] close 终态 subagent-record entry 的 result == 轮终真实值（closeChatIdle 不抹空）", async () => {
    // 完整生命周期：register（entry: running）→ 轮终（record.result = 轮终真实值）→
    // idle close（archive 落 close 终态 entry——D4 重建源）。
    // 缺陷形态（verifier W16 实测复现）：closeChatIdle 合成 text:"" 经 completeRecord
    // 覆盖 record.result → close entry 的 result=''（轮终 'ok' 被抹空），W18 消费后
    // 重开 session result 回退空串。修复：doneResult.text 沿用 record.result。
    const record = makeRecord({ id: "sa-close-entry-result", status: "running" });
    record.sessionFile = path.join(agentDir, "close-entry-result.jsonl");
    store.register(record);
    armIdleTimer(record.id, () => {});
    try {
      updateFromEvent(record, { type: "text_delta", delta: "ok" });
      updateFromEvent(record, { type: "turn_end" });
      settleRound(record); // 轮终：onRoundSettled 写 record.result = "ok"
      expect(record.result).toBe("ok"); // 前提锚点：轮终真实值在位
      await service.chatActions.closeSubagent(record, false); // idle close → completeRecord + archive
    } finally {
      disarmIdleTimer(record.id);
    }

    // appendEntry 序列中的 subagent-record 快照：register（running）→ close（closed）。
    const snapshots = pi.appendEntry.mock.calls
      .filter(([type]) => type === "subagent-record")
      .map(([, data]) => data as { status: string; result?: string });
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    const closeEntry = snapshots[snapshots.length - 1]!;
    expect(closeEntry.status).toBe("closed");
    // 修复断言：close 终态 entry 保持轮终真实值（缺陷形态为 ''）
    expect(closeEntry.result).toBe("ok");
  });
});
