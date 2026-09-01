// src/execution/__tests__/subagent-service-parent-guard.test.ts
//
// [v4 A-5 / P7] getRecordForAction 直接父校验单元测试。
//
// 背景：递归 subagent 场景下，孙级 record（parentRecordId = 某子进程的 self recordId）
// 的子进程句柄只存在于其直接父进程内存。SP-8 后全树 record 的 rootSessionId 贯穿真 ROOT，
// 旧实现 getRecordForAction 仅校验 rootSessionId → 主进程可凭 rootSessionId 通过 message 孙级，
// 但孙级 B 的子进程句柄只在 A 进程里 → 主进程走冷路径重新 spawn → 双写同一 session 文件（P7）。
//
// 修复：rootSessionId 校验之后增加直接父校验——record.parentRecordId 必须等于本进程
// execCtxBaseline.recordId（主进程 baseline=null → 只能操作根层 record）。
//
// 本测试 mock execCtxBaseline 三种身份（undefined=主进程 / sa-A=直接父 / sa-B=兄弟进程），
// 断言对 record B（parentRecordId=sa-A）及顶层 record 的操作权限矩阵。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock logger（import 链需要 getLogger 存在）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// mock session-runner（import 链需要 runSpawn/killAllSpawnedChildren/getChildByRecord 存在）
vi.mock("../session-runner.ts", () => ({
  runSpawn: vi.fn(),
  killAllSpawnedChildren: vi.fn(),
  getChildByRecord: vi.fn(() => undefined),
  registerSpawnedChildForRecord: vi.fn(),
  killRecordChildWithEscalation: vi.fn(),
  spawnedChildren: new Map(),
}));

import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import { RecordStore } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import type { ExecutionRecord } from "../types.ts";

type Baseline = { recordId: string | undefined; depth: number } | null;
const MAIN_PROCESS: Baseline = null;
const PARENT_A: Baseline = { recordId: "sa-A", depth: 1 };
const SIBLING_B: Baseline = { recordId: "sa-B", depth: 1 };

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "parent-guard-"));
}

function makePi(): PiLike {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as PiLike;
}

/** 暴露私有字段供测试注入身份。 */
interface ServiceInternals {
  store: RecordStore;
  sessionRootId: string | null;
  execCtxBaseline: { recordId: string | undefined; depth: number } | null;
}

/** 构造一个 chatMode idle record（message/close action 的典型目标态）。 */
function makeRecord(
  id: string,
  sessionRootId: string,
  overrides: Partial<ExecutionRecord> = {},
): ExecutionRecord {
  return createRecord(id, {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: "test",
    slug: "test",
    startedAt: 1000,
    rootSessionId: sessionRootId,
    chatMode: true,
    controller: new AbortController(),
    ...overrides,
  });
}

describe("[v4 A-5 / P7] getRecordForAction 直接父校验", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let sessionRootId: string;
  let internals: ServiceInternals;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    const modelService = new ModelConfigService({ agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    // initSession 建立 sessionRootId=sessionId（本 session 树的根）。execCtxBaseline 的
    // 真实值由 initSession 从 env 读取（见 recursive-visibility-baseline.test.ts），但本测试
    // 聚焦守卫逻辑，故每例直接注入身份（mock），不依赖进程 env（测试进程可能继承 subagent env）。
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    internals = service as unknown as ServiceInternals;
    store = internals.store;
    sessionRootId = internals.sessionRootId!;
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  // ---------- 身份 sa-A：直接父，放行孙级 B ----------

  it("身份=sa-A（直接父）→ 放行操作孙级 record B（parentRecordId=sa-A）", () => {
    const recordB = makeRecord("sa-B", sessionRootId, { parentRecordId: "sa-A", depth: 2, status: "idle" });
    store.register(recordB);
    internals.execCtxBaseline = PARENT_A;

    expect(service.getRecordForAction("sa-B")).toBe(recordB);
  });

  // ---------- 身份 undefined（主进程）：拒绝孙级，放行根层 ----------

  it("身份=undefined（主进程）拒绝孙级 record B，错误含 'direct parent' + 'parent=sa-A'", () => {
    const recordB = makeRecord("sa-B", sessionRootId, { parentRecordId: "sa-A", depth: 2, status: "idle" });
    store.register(recordB);
    internals.execCtxBaseline = MAIN_PROCESS;

    expect(() => service.getRecordForAction("sa-B")).toThrow(/direct parent/);
    expect(() => service.getRecordForAction("sa-B")).toThrow(/see \/subagents list, parent=sa-A/);
  });

  it("身份=undefined（主进程）放行顶层 record（parentRecordId=undefined 视为根层）", () => {
    const topRecord = makeRecord("sa-top", sessionRootId, { parentRecordId: undefined, depth: 0, status: "idle" });
    store.register(topRecord);
    internals.execCtxBaseline = MAIN_PROCESS;

    expect(service.getRecordForAction("sa-top")).toBe(topRecord);
  });

  // ---------- 身份 sa-B（兄弟进程）：拒绝孙级 ----------

  it("身份=sa-B（兄弟进程）拒绝孙级 record B（parentRecordId=sa-A ≠ baseline sa-B）", () => {
    const recordB = makeRecord("sa-B", sessionRootId, { parentRecordId: "sa-A", depth: 2, status: "idle" });
    store.register(recordB);
    internals.execCtxBaseline = SIBLING_B;

    expect(() => service.getRecordForAction("sa-B")).toThrow(/direct parent/);
    expect(() => service.getRecordForAction("sa-B")).toThrow(/see \/subagents list, parent=sa-A/);
  });

  // ---------- 身份缺省语义 + 更深递归 ----------

  it("子进程（baseline=sa-A）拒绝顶层 record（身份缺省视为根层，仅主进程可操作）", () => {
    const topRecord = makeRecord("sa-top", sessionRootId, { parentRecordId: undefined, depth: 0, status: "idle" });
    store.register(topRecord);
    internals.execCtxBaseline = PARENT_A;

    expect(() => service.getRecordForAction("sa-top")).toThrow(/direct parent/);
  });

  it("P7 场景：主进程拒绝曾孙 record C（parentRecordId=sa-B），错误含 baseline=root + parent=sa-B", () => {
    const recordC = makeRecord("sa-C", sessionRootId, { parentRecordId: "sa-B", depth: 3, status: "idle" });
    store.register(recordC);
    internals.execCtxBaseline = MAIN_PROCESS;

    const fn = () => service.getRecordForAction("sa-C");
    expect(fn).toThrow(/direct parent/);
    expect(fn).toThrow(/see \/subagents list, parent=sa-B/);
    expect(fn).toThrow(/baseline=\(root\)/);
  });

  it("rootSessionId 不匹配仍优先拒绝（直接父校验在 rootSessionId 校验之后，不绕过归属守卫）", () => {
    // 跨 session 树的 record：rootSessionId 不匹配 → 走首个 throw（not found or not owned）
    const foreignRecord = makeRecord("sa-foreign", "other-session", { parentRecordId: "sa-A", depth: 2, status: "idle" });
    store.register(foreignRecord);
    internals.execCtxBaseline = PARENT_A;

    expect(() => service.getRecordForAction("sa-foreign")).toThrow(/not found or not owned/);
  });
});
