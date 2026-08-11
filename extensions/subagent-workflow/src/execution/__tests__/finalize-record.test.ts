// doFinalizeRecord — manifest status 透传测试（M3: 4 态方案）。
//
// 验证 finalize-record.ts 的 status 映射：done→completed, failed→failed, cancelled→cancelled
// （cancelled 不再归并 failed）。crashed 不进 finalize 入参（TS 签名锁定 done/failed/cancelled）。
//
// 测试策略：record 不带 sessionFile/worktreeHandle,跳过 Step 0 (collectPatch) 和 Step 3
// (finalized/tombstone/aliveMarker/worktree cleanup) 的文件操作,聚焦 Step 4 writeManifest
// 的 status 产出。FinalizeDeps 用 stub 注入（manifestStore 为真实实例,指向 tmpDir）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock 共享 logger，让 logger.error 可被 spy（源码已从 console.error 改为 logger.error）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
  getLogger: () => loggerMock,
}));

import { doFinalizeRecord, doFinalizeRoundToIdle } from "../finalize-record.ts";
import { readIdleMarker } from "../idle-marker.ts";
import { ManifestStore } from "../manifest-store.ts";
import type { AgentResult, ExecutionRecord } from "../types.ts";

function makeMinimalRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "finalize-test",
    agent: "worker",
    model: "test/model",
    thinkingLevel: undefined,
    mode: "background",
    task: "test",
    slug: "test",
    startedAt: 1000,
    rootSessionId: "session-main",
    parentRecordId: undefined,
    depth: 0,
    status: "running",
    turns: [],
    turnCount: 0,
    totalTokens: 0,
    lastError: undefined,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    agentResult: undefined,
    sessionFile: undefined,
    controller: undefined,
    ...overrides,
  } as ExecutionRecord;
}

function makeMinimalResult(): AgentResult {
  return {
    text: "done",
    turns: 1,
    durationMs: 100,
    success: true,
    sessionId: "sess-1",
    toolCalls: [],
  };
}

describe("doFinalizeRecord — manifest status 透传 (M3 4 态)", () => {
  let tmpDir: string;
  let manifestStore: ManifestStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-test-"));
    manifestStore = new ManifestStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 构造最小 FinalizeDeps：record 无 sessionFile/worktreeHandle,跳过 Step 0/3 文件操作。 */
  function makeDeps() {
    return {
      manifestStore,
      worktreeManager: {} as never,
      store: { archive: vi.fn() } as never,
      modelService: {} as never,
      pi: { appendEntry: vi.fn() },
      clearThrottle: vi.fn(),
      emitUnregister: vi.fn(),
    };
  }

  it("status=cancelled → manifest 写 cancelled（不再归并 failed）", async () => {
    const record = makeMinimalRecord({ id: "rec-cancelled" });
    await doFinalizeRecord(makeDeps(), record, makeMinimalResult(), "cancelled");

    const manifest = await manifestStore.readManifest("rec-cancelled");
    expect(manifest).not.toBeNull();
    // 关键断言：cancelled 直接透传,不是 "failed"
    expect(manifest?.status).toBe("cancelled");
  });

  it("status=done → manifest 写 completed", async () => {
    const record = makeMinimalRecord({ id: "rec-done" });
    await doFinalizeRecord(makeDeps(), record, makeMinimalResult(), "done");

    const manifest = await manifestStore.readManifest("rec-done");
    expect(manifest?.status).toBe("completed");
  });

  it("status=failed → manifest 写 failed", async () => {
    const record = makeMinimalRecord({ id: "rec-failed" });
    await doFinalizeRecord(makeDeps(), record, makeMinimalResult(), "failed");

    const manifest = await manifestStore.readManifest("rec-failed");
    expect(manifest?.status).toBe("failed");
  });

  it("manifest write 抛错时 cleanup-first 顺序仍执行（Step 3 before Step 4 throw）", async () => {
    // record 带 sessionFile 让 Step 3 finalized/aliveMarker 走真实路径；
    // 不设 worktreeHandle → Step 0 (collectPatch) 和 Step 3 worktree cleanup 都跳过。
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const record = makeMinimalRecord({ id: "rec-cleanup-first", sessionFile });

    // 预写 .alive marker（让 removeAliveMarker 真实生效；不预写因 ENOENT 静默也 OK，
    // 但预写后用 fs.existsSync 验证更直观）。
    fs.writeFileSync(
      `${sessionFile}.alive`,
      `${JSON.stringify({ pid: 99999, id: "rec-cleanup-first", startedAt: 1000 })}\n`,
      "utf-8",
    );

    // mock writeManifest 抛错（模拟 disk full）。在 mock 内捕获「writeManifest 被调用时
    // finalized marker 是否已存在」——这是 cleanup-first 顺序的关键断言：若有人把
    // manifest write 前移到 cleanup 之前，本标志会是 false（[Critical #1] 反例）。
    const finalizedBeforeManifestWrite = { value: false };
    vi.spyOn(manifestStore, "writeManifest").mockImplementation(async () => {
      finalizedBeforeManifestWrite.value = fs.existsSync(`${sessionFile}.finalized`);
      throw new Error("disk full");
    });
    loggerMock.error.mockClear();

    const deps = makeDeps();

    // ── 核心 claim 1：不抛错（cleanup-first → manifest write 失败不 throw）──
    await expect(
      doFinalizeRecord(deps, record, makeMinimalResult(), "done"),
    ).resolves.toBeUndefined();

    // ── 核心 claim 2：Step 3 cleanup 先执行 —— finalized marker 真实写入 ──
    expect(fs.existsSync(`${sessionFile}.finalized`)).toBe(true);

    // ── 核心 claim 3：Step 3 aliveMarker 被移除（预写的 .alive 不再存在）──
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);

    // ── 核心 claim 4：pending-notifications 注销仍触发（emitUnregister）──
    expect(deps.emitUnregister).toHaveBeenCalledWith("rec-cleanup-first", "done");

    // ── 核心 claim 5：manifest 写失败被 logger.error 记录（含 record id + error）──
    expect(loggerMock.error).toHaveBeenCalledWith(expect.stringContaining("manifest 写入失败"));
    const errMsg = loggerMock.error.mock.calls[0]?.[0];
    expect(errMsg).toContain("rec-cleanup-first");
    expect(errMsg).toContain("disk full");

    // ── 核心 claim 6：pi.appendEntry 记录 "subagent:manifest-write-failed" 事件 ──
    expect(deps.pi.appendEntry).toHaveBeenCalledWith(
      "subagent:manifest-write-failed",
      expect.objectContaining({ id: "rec-cleanup-first", error: "disk full" }),
    );

    // ── 核心 claim 7：manifest 实际未写入（writeManifest 抛错被吞咽）──
    expect(await manifestStore.readManifest("rec-cleanup-first")).toBeNull();

    // ── 核心 claim 8：[Critical #1] cleanup 在 manifest 写之前 —— 顺序锁定 ──
    // 若有人把 manifest write 前移到 cleanup 之前，本标志会是 false（mock 捕获时刻
    // .finalized 尚未被 Step 3 写入），保护 Critical #1 时序不变量。
    expect(finalizedBeforeManifestWrite.value).toBe(true);

    // 清理 mock 调用记录防污染
    loggerMock.error.mockClear();
  });
});

// ============================================================
// doFinalizeRoundToIdle — chatMode 轮次完成进 idle（M2-A）
// ============================================================

describe("doFinalizeRoundToIdle — chatMode 轮次完成进 idle (M2-A)", () => {
  let tmpDir: string;
  let manifestStore: ManifestStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-idle-test-"));
    manifestStore = new ManifestStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 构造 FinalizeDeps：worktreeManager.cleanup / store.archive 为 vi.fn 以断言「不调」。 */
  function makeDeps() {
    return {
      manifestStore,
      worktreeManager: { cleanup: vi.fn(), collectPatch: vi.fn() } as never,
      store: { archive: vi.fn() } as never,
      modelService: {} as never,
      pi: { appendEntry: vi.fn() } as never,
      clearThrottle: vi.fn(),
      emitUnregister: vi.fn(),
    };
  }

  it("record 带 sessionFile → 写 .idle sidecar + 删 .alive + record.status=idle + round 0→1", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    // 预写 .alive marker（验证 doFinalizeRoundToIdle 删除它——进程已回收）
    fs.writeFileSync(
      `${sessionFile}.alive`,
      `${JSON.stringify({ pid: 99999, id: "rec-idle", startedAt: 1000 })}\n`,
      "utf-8",
    );
    const record = makeMinimalRecord({ id: "rec-idle", sessionFile, chatMode: true, round: 0 });
    // tryTransition 已把 status 设为 done，模拟 runAndFinalize 调用前的状态
    record.status = "done";

    await doFinalizeRoundToIdle(makeDeps(), record, makeMinimalResult());

    // 状态机
    expect(record.status).toBe("idle");
    expect(record.round).toBe(1);
    // .idle sidecar 写入且字段正确
    expect(fs.existsSync(`${sessionFile}.idle`)).toBe(true);
    const marker = readIdleMarker(sessionFile);
    expect(marker?.id).toBe("rec-idle");
    expect(marker?.sessionFile).toBe(sessionFile);
    expect(marker?.round).toBe(1);
    expect(marker?.rootSessionId).toBe("session-main");
    // .alive marker 被删（进程已 SIGTERM 回收）
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);
  });

  it("record.round 已为 N → round 变 N+1", async () => {
    const record = makeMinimalRecord({ id: "rec-round", round: 3 });
    record.status = "done";
    await doFinalizeRoundToIdle(makeDeps(), record, makeMinimalResult());
    expect(record.round).toBe(4);
    expect(record.status).toBe("idle");
  });

  it("不调 store.archive（record 留内存，getMutable 仍可查）", async () => {
    const deps = makeDeps();
    const record = makeMinimalRecord({ id: "rec-noarchive" });
    record.status = "done";
    await doFinalizeRoundToIdle(deps, record, makeMinimalResult());
    expect(deps.store.archive).not.toHaveBeenCalled();
  });

  it("不 cleanup worktree（即使 record 带 worktreeHandle——保留对话模式工作目录）", async () => {
    const deps = makeDeps();
    const record = makeMinimalRecord({
      id: "rec-noworktree",
      worktreeHandle: { path: "/tmp/x", branch: "b", baseCommit: "c", mainCwd: "/tmp" } as never,
    });
    record.status = "done";
    await doFinalizeRoundToIdle(deps, record, makeMinimalResult());
    expect(deps.worktreeManager.cleanup).not.toHaveBeenCalled();
  });

  it("emitUnregister 被调（status=idle，进程已死从 pending 活跃差集移除）", async () => {
    const deps = makeDeps();
    const record = makeMinimalRecord({ id: "rec-emit" });
    record.status = "done";
    await doFinalizeRoundToIdle(deps, record, makeMinimalResult());
    expect(deps.emitUnregister).toHaveBeenCalledWith("rec-emit", "idle");
  });

  it("clearThrottle 被调（防 trailing onUpdate）", async () => {
    const deps = makeDeps();
    const record = makeMinimalRecord({ id: "rec-throttle" });
    record.status = "done";
    await doFinalizeRoundToIdle(deps, record, makeMinimalResult());
    expect(deps.clearThrottle).toHaveBeenCalledWith("rec-throttle");
  });

  it("不调 completeRecord：record 不冻结（endedAt / agentResult 仍 undefined）", async () => {
    const record = makeMinimalRecord({ id: "rec-nofreeze" });
    record.status = "done";
    await doFinalizeRoundToIdle(makeDeps(), record, makeMinimalResult());
    expect(record.endedAt).toBeUndefined();
    expect(record.agentResult).toBeUndefined();
  });

  it("不写 manifest（idle 非终态，manifest 是终态诊断辅助）", async () => {
    const record = makeMinimalRecord({ id: "rec-nomanifest" });
    record.status = "done";
    await doFinalizeRoundToIdle(makeDeps(), record, makeMinimalResult());
    const manifest = await manifestStore.readManifest("rec-nomanifest");
    expect(manifest).toBeNull();
  });
});
