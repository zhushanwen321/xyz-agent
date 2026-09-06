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
vi.mock("../engine/engines/pi/session-runner.ts", () => ({
  runSpawn: vi.fn(),
  killAllSpawnedChildren: vi.fn(),
  getChildByRecord: vi.fn(() => undefined),
  registerSpawnedChildForRecord: vi.fn(),
  killRecordChildWithEscalation: vi.fn(),
  spawnedChildren: new Map(),
}));

// [D8] idle-gc 归档时释放引擎池引用（releasePoolRef 经 getEngineDataDir 解析
// dataDir）——测试钉到模块级 holder（vi.mock factory 闭包只能引用模块级变量），
// beforeEach 刷新为当前 tmp agentDir，防触碰真实数据目录。
let gcDataDirHolder = "";
vi.mock("../engine/common/data-dir.ts", () => ({
  getEngineDataDir: () => gcDataDirHolder,
}));

import { acquirePool } from "../engine/common/pool-manager.ts";
import { getChildByRecord } from "../engine/engines/pi/session-runner.ts";
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
    gcDataDirHolder = agentDir;
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

  it("[D8] 归档超 TTL record 时释放引擎池引用：journal 跟随删除、refs 移除、归零删池原生状态", () => {
    // 建池（engine 缺省投影 'pi' + poolKey 'shared'——与 runEngineTask 回填形态一致）
    const poolDir = acquirePool(agentDir, "pi", "shared", "sa-pool-1");
    fs.mkdirSync(path.join(poolDir, "native-state"), { recursive: true });
    fs.writeFileSync(path.join(poolDir, "native-state", "db.sqlite"), "x");
    fs.writeFileSync(path.join(poolDir, "journal-sa-pool-1.jsonl"), "{}\n");
    fs.writeFileSync(path.join(poolDir, "journal-sa-pool-2.jsonl"), "{}\n"); // 他人 journal（refs 无条目）

    const fireAt = Date.now() + GC_INTERVAL_MS;
    const record = makeIdleRecord("sa-pool-1", fireAt - IDLE_TTL_MS - 1);
    record.engineHandle = { sessionRef: {}, poolKey: "shared" };
    store.register(record);

    service.startGcTimer();
    vi.advanceTimersByTime(GC_INTERVAL_MS);

    expect(store.getMutable("sa-pool-1")).toBeUndefined(); // 已归档
    // release 语义：自己的 journal 删、他人 journal 保留、归零删原生状态、目录保留（剩 journal）
    expect(fs.existsSync(path.join(poolDir, "journal-sa-pool-1.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(poolDir, "journal-sa-pool-2.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(poolDir, "native-state"))).toBe(false);
    expect(fs.existsSync(poolDir)).toBe(true);
    // refs 归零后随池清理（无残留幻影引用）
    const refsPath = path.join(poolDir, "refs.json");
    if (fs.existsSync(refsPath)) {
      expect(Object.keys((JSON.parse(fs.readFileSync(refsPath, "utf8")) as { refs: object }).refs)).toEqual([]);
    }
  });

  it("[D8] 无 engineHandle 的 record 归档不触碰引擎池（存量 record 零影响）", () => {
    const poolDir = acquirePool(agentDir, "pi", "shared", "sa-plain");
    fs.writeFileSync(path.join(poolDir, "journal-sa-plain.jsonl"), "{}\n");

    const fireAt = Date.now() + GC_INTERVAL_MS;
    store.register(makeIdleRecord("sa-plain", fireAt - IDLE_TTL_MS - 1)); // 无 engineHandle

    service.startGcTimer();
    vi.advanceTimersByTime(GC_INTERVAL_MS);

    expect(store.getMutable("sa-plain")).toBeUndefined(); // 正常归档
    expect(fs.existsSync(path.join(poolDir, "journal-sa-plain.jsonl"))).toBe(true); // 池/journal 不动
  });
});
