// src/execution/__tests__/run-and-finalize-anchoring.test.ts
//
// runAndFinalize 特征锚定基线（第二批复杂度债务 U04：锚定测试先行）。
//
// 既有 run-and-finalize-chatmode.test.ts 覆盖 settle 阶段的 chatMode × closeAfterRound
// 分流；本文件补直接分支缺口，重构前后行为逐字节对照（错误文案 / 终态写盘 / 事件顺序）：
//   G1  pooled acquire 成功 → acquire → runSpawn → release 调用次序 + 轮次回退事件(running)
//   G2  排队 acquire 被中止（signal.aborted）→ finalizeAborted（"cancelled by user"）
//   G3  acquire 非中止失败 → finalizeFailed 合成 "aborted" 文案（原始错误被吞——现状怪癖锚定）
//   G4  非 chatMode + runSpawn 抛错 → finalizeFailed：closed/gc + archive + manifest 落盘
//   G5  chatMode + runSpawn 抛错 → MF-6 回退：record.result="round did not complete: <msg>"
//   G6  chatMode + 抛错 + CAS 输（record 已 closed）→ 不回退、不 archive、原样返回合成 result
//   G7  chatMode + idle timer armed → early return：settle 不执行（round/closeAfterRound 不动）
//   G8  settle 阶段 CAS 输（record 已 closed）→ 跳过收尾、closeAfterRound 不消费
//   G9  非 chatMode + 失败 result → else 分支：closed/gc + archive + manifest 落盘 + endedAt
//   G10 运行中 abort → closedReason="cancelled" 终态化，result 原样返回（不改写为 cancelled 形态）
//
// harness 与 run-and-finalize-chatmode.test.ts 同形态：mock session-runner.runSpawn，
// 走 SubagentService 真实 runAndFinalize 分流逻辑，断言「最终可观察状态」。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock logger（doFinalizeRecord 的 manifest 写入降级路径用 logger.error）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// mock session-runner：runSpawn 受控返回 result / 抛错，killAllSpawnedChildren 空实现。
// 注意：必须在 import SubagentService 之前 mock（vi.mock 提升到顶部）。
vi.mock("../engine/engines/pi/session-runner.ts", () => ({
  runSpawn: vi.fn(),
  killAllSpawnedChildren: vi.fn(),
  getChildByRecord: vi.fn(() => undefined),
  registerSpawnedChildForRecord: vi.fn(),
  killRecordChildWithEscalation: vi.fn(),
  spawnedChildren: new Map(),
}));

import { runSpawn } from "../engine/engines/pi/session-runner.ts";
import type { SessionRunnerContext } from "../engine/engines/pi/session-runner.ts";
import { armIdleTimer, disarmIdleTimer } from "../lifecycle-manager.ts";
import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo } from "../model-resolver.ts";
import { getSubagentRecordsDir } from "../path-encoding.ts";
import { RecordStore } from "../record-store.ts";
import type { ConcurrencyPool } from "../concurrency-pool.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import type {
  AgentResult,
  ExecutionRecord,
  ExecuteOptions,
} from "../types.ts";

const mockRunSpawn = vi.mocked(runSpawn);

// ── 最小合法 ModelInfo（resolveModel 未注入 registry 会抛错，故 stub；runSpawn 被 mock 不消费）──
const STUB_MODEL: ModelInfo = {
  id: "test-model",
  name: "Test",
  provider: "test",
  reasoning: false,
};

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "raf-anchor-test-"));
}

function makePi(): PiLike & {
  appendEntry: ReturnType<typeof vi.fn<(customType: string, data?: unknown) => void>>;
  events: { emit: ReturnType<typeof vi.fn<(channel: string, data: unknown) => void>> };
  sendMessage: ReturnType<typeof vi.fn<(message: Parameters<PiLike["sendMessage"]>[0], options?: Parameters<PiLike["sendMessage"]>[1]) => void>>;
} {
  return {
    appendEntry: vi.fn((customType: string, data?: unknown) => {}),
    events: { emit: vi.fn((channel: string, data: unknown) => {}) },
    sendMessage: vi.fn(() => {}),
  };
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

function makeRecord(chatMode: boolean, id: string): ExecutionRecord {
  return createRecord(id, {
    agent: "general-purpose",
    model: "test-model",
    mode: "background",
    task: "do something",
    slug: "test",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode,
  });
}

/** 暴露 runAndFinalize + store + pool 的私有访问接口（测试专用 cast）。 */
interface ServiceInternals {
  store: RecordStore;
  pool: ConcurrencyPool;
  runAndFinalize: (
    record: ExecutionRecord,
    opts: ExecuteOptions,
    ctx: SessionRunnerContext,
    identity: {
      agent: string;
      agentConfig: unknown;
      resolved: { model: ModelInfo; thinkingLevel: string | undefined };
    },
    signal: AbortSignal | undefined,
    priority: number,
  ) => Promise<AgentResult>;
}

describe("runAndFinalize 特征锚定基线（U04 重构前后行为对照）", () => {
  let agentDir: string;
  let modelService: ModelConfigService;
  let service: SubagentService;
  let internals: ServiceInternals;
  let pi: ReturnType<typeof makePi>;
  let armedTimerRecordIds: string[];

  beforeEach(() => {
    // rootCwd 推导基线：PI_SUBAGENT_ROOT_CWD 若被宿主 env 污染会改写 recordsDir 编码段，
    // manifest 落盘断言（G4/G9）依赖「rootCwd = init.cwd」的未设基线。
    delete process.env.PI_SUBAGENT_ROOT_CWD;
    agentDir = makeTmpAgentDir();
    modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    pi = makePi();
    service.initSession({ pi, sessionId: "root-session" });
    internals = service as unknown as ServiceInternals;
    armedTimerRecordIds = [];
    mockRunSpawn.mockReset();
  });

  afterEach(() => {
    for (const id of armedTimerRecordIds) disarmIdleTimer(id);
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 直接调私有 runAndFinalize（mock runSpawn 后走完整分流逻辑）。 */
  async function callRunAndFinalize(
    record: ExecutionRecord,
    mockImpl: () => void,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    mockImpl();
    const opts: ExecuteOptions = { task: "do something", slug: "test" };
    const ctx: SessionRunnerContext = {
      cwd: agentDir,
      agentDir,
      skillDirs: [],
      mainCwd: agentDir,
      sessionRootId: "s-root",
      rootCwd: agentDir,
    };
    const identity = {
      agent: "general-purpose",
      agentConfig: undefined,
      resolved: { model: STUB_MODEL, thinkingLevel: undefined },
    };
    return internals.runAndFinalize(record, opts, ctx, identity, signal, 0);
  }

  function manifestPath(recordId: string): string {
    return path.join(getSubagentRecordsDir(agentDir, agentDir), `${recordId}.json`);
  }

  it("G1: pooled acquire 成功 → acquire → runSpawn → release 次序锚定 + 轮次回退事件(running)", async () => {
    const record = makeRecord(false, "sa-anchor-g1");
    internals.store.register(record);
    const pool = internals.pool;
    const acquireSpy = vi.spyOn(pool, "acquire");
    const releaseSpy = vi.spyOn(pool, "release");

    const result = await callRunAndFinalize(record, () => mockRunSpawn.mockResolvedValueOnce(makeResult(true)));

    expect(result.text).toBe("done");
    // 事件顺序：acquire 先于 runSpawn，release（finally 收口）最后。
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(mockRunSpawn).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    const order = acquireSpy.mock.invocationCallOrder[0];
    const spawnOrder = mockRunSpawn.mock.invocationCallOrder[0];
    const releaseOrder = releaseSpy.mock.invocationCallOrder[0];
    expect(order).toBeLessThan(spawnOrder);
    expect(spawnOrder).toBeLessThan(releaseOrder);
    // one-shot 成功无 closeAfterRound → finalizeRoundToIdle：留内存 + 进程死注销事件(running)。
    expect(record.status).toBe("running");
    expect(internals.store.getMutable(record.id)).toBe(record);
    expect(pi.events.emit).toHaveBeenCalledWith("pending:unregister", { id: record.id, reason: "running" });
  });

  it("G2: 排队 acquire 被中止（signal.aborted）→ finalizeAborted：'cancelled by user' + closed/cancelled + archive", async () => {
    const record = makeRecord(false, "sa-anchor-g2");
    internals.store.register(record);
    const releaseSpy = vi.spyOn(internals.pool, "release");
    const controller = new AbortController();
    controller.abort(); // pre-aborted：signal.aborted = true
    // 真实 ConcurrencyPool.acquire 对 pre-aborted signal 并不保证 reject——
    // 显式 mock 排队中止（acquire reject + signal.aborted）以触发 catch 的 S1 分支。
    vi.spyOn(internals.pool, "acquire").mockRejectedValueOnce(new Error("AbortError: queued acquire aborted"));

    const result = await callRunAndFinalize(record, () => mockRunSpawn.mockResolvedValueOnce(makeResult(true)), controller.signal);

    // 错误路径文案逐字节：S1 对齐已运行被 abort 的 cancel 语义。
    expect(result.error).toBe("cancelled by user");
    expect(result.success).toBe(false);
    // 终态：closed + cancelled + archive（写盘收尾走完），runSpawn 未触达。
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("cancelled");
    expect(record.endedAt).toBeDefined();
    expect(internals.store.getMutable(record.id)).toBeUndefined();
    expect(mockRunSpawn).not.toHaveBeenCalled();
    // acquire 失败早退（try/finally 之前）→ 池槽不归还（acquired=false 语义）。
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(pi.events.emit).toHaveBeenCalledWith("pending:unregister", { id: record.id, reason: "closed" });
  });

  it("G3: acquire 非中止失败 → finalizeFailed 合成 'aborted' 文案（原始错误被吞——现状怪癖锚定）", async () => {
    const record = makeRecord(false, "sa-anchor-g3");
    internals.store.register(record);
    const releaseSpy = vi.spyOn(internals.pool, "release");
    vi.spyOn(internals.pool, "acquire").mockRejectedValueOnce(new Error("pool exploded"));

    const result = await callRunAndFinalize(record, () => mockRunSpawn.mockResolvedValueOnce(makeResult(true)));

    // 现状：catch 吞掉原始错误，统一合成 new Error("aborted") → toErrorMessage = "aborted"。
    // "pool exploded" 不透传——重构必须保持该文案（行为逐字节不变）。
    expect(result.error).toBe("aborted");
    expect(result.success).toBe(false);
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("gc");
    expect(internals.store.getMutable(record.id)).toBeUndefined();
    expect(mockRunSpawn).not.toHaveBeenCalled();
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it("G4: 非 chatMode + runSpawn 抛错 → finalizeFailed：error 透传 + closed/gc + archive + manifest 落盘", async () => {
    const record = makeRecord(false, "sa-anchor-g4");
    internals.store.register(record);

    const result = await callRunAndFinalize(record, () => mockRunSpawn.mockRejectedValueOnce(new Error("spawn exploded")));

    // 错误文案：toErrorMessage(Error) → .message 逐字节透传。
    expect(result.error).toBe("spawn exploded");
    expect(result.success).toBe(false);
    // 终态写盘：closed + gc + archive + manifest json 落盘。
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("gc");
    expect(record.endedAt).toBeDefined();
    expect(internals.store.getMutable(record.id)).toBeUndefined();
    expect(fs.existsSync(manifestPath(record.id))).toBe(true);
    expect(pi.events.emit).toHaveBeenCalledWith("pending:unregister", { id: record.id, reason: "closed" });
  });

  it("G5: chatMode + runSpawn 抛错 → MF-6 回退：'round did not complete: <msg>' + running + round+1 + 留内存", async () => {
    const record = makeRecord(true, "sa-anchor-g5");
    internals.store.register(record);

    const result = await callRunAndFinalize(record, () => mockRunSpawn.mockRejectedValueOnce(new Error("spawn creation failed")));

    // 合成 failed result 错误文案透传（swallow，不 re-throw）。
    expect(result.error).toBe("spawn creation failed");
    // MF-6：不销毁对话——finalizeRoundToIdle 回退 running-resumable（留内存可重试 message/close）。
    expect(record.status).toBe("running");
    expect(record.closedReason).toBeUndefined(); // [S10] 不残留 gc
    expect(record.round).toBe(1);
    expect(internals.store.getMutable(record.id)).toBe(record);
    // MF-2 写点：失败轮 error 优先 → record.result 固定前缀文案（notify 正文逐字节）。
    expect(record.result).toBe("round did not complete: spawn creation failed");
    // 事件：进程死注销 reason=running（非 closed——record 留内存非终态）。
    expect(pi.events.emit).toHaveBeenCalledWith("pending:unregister", { id: record.id, reason: "running" });
  });

  it("G6: chatMode + 抛错 + CAS 输（record 已 closed）→ 不回退不 archive，原样返回合成 result", async () => {
    const record = makeRecord(true, "sa-anchor-g6");
    record.status = "closed"; // cancel/收尾抢先：tryTransition(closed, gc) 必败
    internals.store.register(record);

    const result = await callRunAndFinalize(record, () => mockRunSpawn.mockRejectedValueOnce(new Error("spawn creation failed")));

    expect(result.error).toBe("spawn creation failed");
    // CAS 输：无任何收尾副作用——状态/轮次不动、留内存、无注销事件。
    expect(record.status).toBe("closed");
    expect(record.round).toBe(0);
    expect(internals.store.getMutable(record.id)).toBe(record);
    expect(pi.events.emit).not.toHaveBeenCalled();
  });

  it("G7: chatMode + idle timer armed → early return：settle 不执行（round/closeAfterRound 不动）", async () => {
    const record = makeRecord(true, "sa-anchor-g7");
    record.status = "running";
    record.round = 1;
    internals.store.register(record);
    // V2 决策 2/3 形态：onRoundSettled 已 arm idle timer（agent_settled 提前闭环）。
    armIdleTimer(record.id, () => {}, 60_000);
    armedTimerRecordIds.push(record.id);

    const result = await callRunAndFinalize(record, () => mockRunSpawn.mockResolvedValueOnce(makeResult(true)));

    // early return：原样返回 runSpawn result，settle 阶段未执行。
    expect(result.text).toBe("done");
    expect(record.status).toBe("running");
    expect(record.round).toBe(1); // 未 +1（round+1 归 onRoundSettled，非本函数）
    expect(record.closeAfterRound).toBeUndefined();
    expect(internals.store.getMutable(record.id)).toBe(record);
    expect(pi.events.emit).not.toHaveBeenCalled();
  });

  it("G8: settle 阶段 CAS 输（record 已 closed）→ 跳过收尾、closeAfterRound 不消费", async () => {
    const record = makeRecord(false, "sa-anchor-g8");
    record.status = "closed"; // cancel 抢先（A2-1 形态）
    record.closeAfterRound = true;
    internals.store.register(record);

    const result = await callRunAndFinalize(record, () => mockRunSpawn.mockResolvedValueOnce(makeResult(true)));

    // 原样返回（不改写为 cancelled 形态）；收尾全跳过。
    expect(result.text).toBe("done");
    expect(result.success).toBe(true);
    expect(record.status).toBe("closed");
    expect(record.closeAfterRound).toBe(true); // 标志不被本路径消费
    expect(record.endedAt).toBeUndefined();
    expect(internals.store.getMutable(record.id)).toBe(record);
    expect(pi.events.emit).not.toHaveBeenCalled();
  });

  it("G9: 非 chatMode + 失败 result → else 分支：closed/gc + archive + manifest 落盘 + endedAt", async () => {
    const record = makeRecord(false, "sa-anchor-g9");
    internals.store.register(record);

    const result = await callRunAndFinalize(record, () => mockRunSpawn.mockResolvedValueOnce(makeResult(false)));

    // 失败 result 原样返回（错误文案不经本函数改写）。
    expect(result.success).toBe(false);
    expect(result.error).toBe("boom");
    // 非 chatMode 失败 = 一次性销毁（archive + manifest 落盘）。
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("gc");
    expect(record.endedAt).toBeDefined();
    expect(internals.store.getMutable(record.id)).toBeUndefined();
    expect(fs.existsSync(manifestPath(record.id))).toBe(true);
    expect(pi.events.emit).toHaveBeenCalledWith("pending:unregister", { id: record.id, reason: "closed" });
  });

  it("G10: 运行中 abort → closedReason='cancelled' 终态化，result 原样返回（不改写）", async () => {
    const record = makeRecord(false, "sa-anchor-g10");
    internals.store.register(record);
    const controller = new AbortController();
    // acquire（signal 未中止 → 放行）后、runSpawn resolve 前中止。
    mockRunSpawn.mockImplementationOnce(async () => {
      await new Promise((r) => { setTimeout(r, 15); });
      return makeResult(true);
    });
    setTimeout(() => controller.abort(), 5);

    const result = await callRunAndFinalize(record, () => {}, controller.signal);

    // result 原样返回（success true 不被改写为 cancelled 形态——现状锚定）。
    expect(result.success).toBe(true);
    expect(result.text).toBe("done");
    // 终态：closed + cancelled（abort 折入 closed）+ archive。
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("cancelled");
    expect(record.endedAt).toBeDefined();
    expect(internals.store.getMutable(record.id)).toBeUndefined();
    expect(pi.events.emit).toHaveBeenCalledWith("pending:unregister", { id: record.id, reason: "closed" });
  });
});
