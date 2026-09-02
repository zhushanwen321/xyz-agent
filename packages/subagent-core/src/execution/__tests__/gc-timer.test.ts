// src/execution/__tests__/gc-timer.test.ts
//
// [M8] idle record GC 定时器测试（subagent-service.ts startGcTimer，L485-507）。
//
// 背景：GC 定时器（1h interval 扫描 + isResumable && idleSince 30 天 TTL + store.archive）
// 此前零测试覆盖——所有相关测试把 startGcTimer mock 成 no-op（index-session-start /
// crash-recovery / stream-sink-guard / session-start-reaper / index-session-start-identity）。
// 误判 isResumable/idleSince 会把可续聊 record 从内存错误归档（用户数据路径），
// 或永不触发（内存驻留失效）——两个方向都无回归拦截。
//
// 本文件用真实 SubagentService + 真实 startGcTimer（不 mock GC 逻辑本身），仅 mock
// session-runner（import 链依赖 + isResumable 的 hasLiveProcessHandle 查询点）与 logger。
// timer 全部 vi.useFakeTimers，不真实等待。

import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// mock session-runner：runSpawn/killAllSpawnedChildren 占位（import 链需要），
// getChildByRecord 默认返回 undefined（无活进程 → isResumable=true），用例内按需覆盖。
vi.mock("../session-runner.ts", () => ({
  runSpawn: vi.fn(),
  killAllSpawnedChildren: vi.fn(),
  getChildByRecord: vi.fn(() => undefined),
  registerSpawnedChildForRecord: vi.fn(),
  killRecordChildWithEscalation: vi.fn(),
  spawnedChildren: new Map(),
}));

import { getChildByRecord } from "../session-runner.ts";
import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import { RecordStore } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { ExecutionRecord } from "../types.ts";

const mockGetChildByRecord = vi.mocked(getChildByRecord);

/** 与 startGcTimer 内部常量一致（1h 扫描 / 30 天 TTL）。 */
const GC_INTERVAL_MS = 60 * 60 * 1000;
const IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** initSession 注入的最小 pi duck-type（同 subagent-service PiLike 形状，结构匹配即可）。 */
interface PiStub {
  appendEntry(customType: string, data?: unknown): void;
  events: { emit(channel: string, data: unknown): void };
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

function makePi(): PiStub {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
}

/** 构造 running + 无活进程 + 指定 idleSince 的 record（GC 扫描的目标态）。
 *  listAllActive 只返回 status==="running"（createRecord 初始即 running）。 */
function makeIdleRecord(id: string, idleSince: number): ExecutionRecord {
  const record = createRecord(id, {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: "test",
    slug: "test",
    startedAt: idleSince,
    rootSessionId: "root-session",
    chatMode: true,
    controller: new AbortController(),
  });
  record.idleSince = idleSince;
  return record;
}

/** 暴露私有字段供测试读取 store。 */
interface ServiceInternals {
  store: RecordStore;
}

describe("[M8] idle record GC 定时器（startGcTimer）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;

  beforeEach(() => {
    vi.useFakeTimers();
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-timer-"));
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    store = (service as unknown as ServiceInternals).store;
    mockGetChildByRecord.mockReset();
    // 默认无活进程（isResumable=true）——Path B：进程已回收、可冷路径 resume 的等待续聊态
    mockGetChildByRecord.mockImplementation(() => undefined);
    loggerMock.warn.mockClear();
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("TTL 边界：超 1ms 归档、差 1ms 不归档（同一轮扫描）", () => {
    // idleSince 相对 interval 首次触发时刻（fake clock + 1h）构造：
    //   over  = fireAt - TTL - 1 → 扫描时 age = TTL + 1 > TTL → archive
    //   under = fireAt - TTL + 1 → 扫描时 age = TTL - 1 ≤ TTL → 留内存
    const fireAt = Date.now() + GC_INTERVAL_MS;
    store.register(makeIdleRecord("sa-over", fireAt - IDLE_TTL_MS - 1));
    store.register(makeIdleRecord("sa-under", fireAt - IDLE_TTL_MS + 1));

    service.startGcTimer();
    vi.advanceTimersByTime(GC_INTERVAL_MS);

    expect(store.getMutable("sa-over")).toBeUndefined(); // archive 从内存移除
    expect(store.getMutable("sa-under")).toBeDefined(); // 未超 TTL 留内存
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("GC: archiving idle record sa-over"),
    );
  });

  it("有活进程的 record 不归档（isResumable=false，即使 idleSince 超 TTL）", () => {
    const fireAt = Date.now() + GC_INTERVAL_MS;
    // Path A：进程保活等待续聊（idle timer armed、child 未 kill）——归档会让活进程失管
    store.register(makeIdleRecord("sa-live", fireAt - IDLE_TTL_MS - 1));
    mockGetChildByRecord.mockImplementation(
      (id: string): ChildProcess | undefined =>
        id === "sa-live" ? ({ killed: false } as unknown as ChildProcess) : undefined,
    );

    service.startGcTimer();
    vi.advanceTimersByTime(GC_INTERVAL_MS);

    expect(store.getMutable("sa-live")).toBeDefined(); // 有活进程 → 不归档
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("每小时重复扫描：上一轮差 1ms 的 record 下一轮超龄被归档", () => {
    const fireAt = Date.now() + GC_INTERVAL_MS;
    store.register(makeIdleRecord("sa-late", fireAt - IDLE_TTL_MS + 1));

    service.startGcTimer();
    vi.advanceTimersByTime(GC_INTERVAL_MS);
    expect(store.getMutable("sa-late")).toBeDefined(); // 第一轮：age = TTL - 1，未到

    vi.advanceTimersByTime(GC_INTERVAL_MS); // 第二轮：age = TTL + 1h - 1 > TTL
    expect(store.getMutable("sa-late")).toBeUndefined();
  });

  it("startGcTimer 幂等：重复调用不产生第二个 interval", () => {
    const fireAt = Date.now() + GC_INTERVAL_MS;
    store.register(makeIdleRecord("sa-over", fireAt - IDLE_TTL_MS - 1));

    service.startGcTimer();
    service.startGcTimer(); // 已有 timer 直接 return（防重复 interval）
    vi.advanceTimersByTime(GC_INTERVAL_MS);

    // 同一 record 一轮只扫一次（重复 interval 会对同一 record 产生第二条 GC warn）
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  it("dispose 后 interval 停止：超 TTL record 不再被归档", () => {
    service.startGcTimer();
    vi.advanceTimersByTime(GC_INTERVAL_MS); // 第一轮正常触发
    service.dispose(); // stopGcTimer + disposeAllRecords

    // dispose 后塞入超 TTL record，interval 已停 → 无论推进多久都不归档
    store.register(makeIdleRecord("sa-after-dispose", Date.now() - IDLE_TTL_MS - 1));
    vi.advanceTimersByTime(GC_INTERVAL_MS * 10);

    expect(store.getMutable("sa-after-dispose")).toBeDefined();
  });
});
