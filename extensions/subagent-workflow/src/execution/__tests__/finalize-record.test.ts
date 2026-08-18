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
      store: { archive: vi.fn(), reportRecordTransition: vi.fn() } as never,
      modelService: {} as never,
      pi: { appendEntry: vi.fn() },
      emitUnregister: vi.fn(),
    };
  }

  it("status=closed + cancelled reason → manifest 写 closed（v4 B-1：cancelled 折入 closed）", async () => {
    const record = makeMinimalRecord({ id: "rec-cancelled" });
    await doFinalizeRecord(makeDeps(), record, makeMinimalResult(), "closed", "cancelled");

    const manifest = await manifestStore.readManifest("rec-cancelled");
    expect(manifest).not.toBeNull();
    // 关键断言：v4 B-1 manifest status 恒写 closed（cancelled 区分靠 tombstone sidecar）
    expect(manifest?.status).toBe("closed");
  });

  it("status=closed + user-close → manifest 写 closed", async () => {
    const record = makeMinimalRecord({ id: "rec-done" });
    await doFinalizeRecord(makeDeps(), record, makeMinimalResult(), "closed", "user-close");

    const manifest = await manifestStore.readManifest("rec-done");
    expect(manifest?.status).toBe("closed");
  });

  it("status=closed + gc → manifest 写 closed", async () => {
    const record = makeMinimalRecord({ id: "rec-failed" });
    await doFinalizeRecord(makeDeps(), record, makeMinimalResult(), "closed", "gc");

    const manifest = await manifestStore.readManifest("rec-failed");
    expect(manifest?.status).toBe("closed");
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
      doFinalizeRecord(deps, record, makeMinimalResult(), "closed"),
    ).resolves.toBeUndefined();

    // ── 核心 claim 2：Step 3 cleanup 先执行 —— finalized marker 真实写入 ──
    expect(fs.existsSync(`${sessionFile}.finalized`)).toBe(true);

    // ── 核心 claim 3：Step 3 aliveMarker 被移除（预写的 .alive 不再存在）──
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);

    // ── 核心 claim 4：pending-notifications 注销仍触发（emitUnregister）──
    expect(deps.emitUnregister).toHaveBeenCalledWith("rec-cleanup-first", "closed");

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
      store: { archive: vi.fn(), reportRecordTransition: vi.fn() } as never,
      modelService: {} as never,
      pi: { appendEntry: vi.fn() } as never,
      emitUnregister: vi.fn(),
    };
  }

  it("record 带 sessionFile → 删 .alive + record.status=running + round 0→1", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    // 预写 .alive marker（验证 doFinalizeRoundToIdle 删除它——进程已回收）
    fs.writeFileSync(
      `${sessionFile}.alive`,
      `${JSON.stringify({ pid: 99999, id: "rec-idle", startedAt: 1000 })}\n`,
      "utf-8",
    );
    const record = makeMinimalRecord({ id: "rec-idle", sessionFile, chatMode: true, round: 0 });
    // tryTransition 已把 status 设为 done，模拟 runAndFinalize 调用前的状态
    record.status = "closed";

    await doFinalizeRoundToIdle(makeDeps(), record, makeMinimalResult());

    // 状态机（v4 B-1：旧 idle 折入 running，finalizeRoundToIdle 设 running）
    expect(record.status).toBe("running");
    expect(record.round).toBe(1);
    // .alive marker 被删（进程已 SIGTERM 回收）
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);
  });

  it("W16: 轮终上报 reportRecordTransition（record-store 类外恢复写点迁移落 entry）", async () => {
    const deps = makeDeps();
    const record = makeMinimalRecord({ id: "rec-report", chatMode: true, round: 2 });
    record.status = "closed";
    await doFinalizeRoundToIdle(deps, record, makeMinimalResult());
    expect(deps.store.reportRecordTransition).toHaveBeenCalledTimes(1);
    // 上报发生在 round 推进之后（entry 携带新轮计数，重建源不滞后）
    expect(record.round).toBe(3);
    expect(record.status).toBe("running");
  });

  it("record.round 已为 N → round 变 N+1", async () => {
    const record = makeMinimalRecord({ id: "rec-round", round: 3 });
    record.status = "closed";
    await doFinalizeRoundToIdle(makeDeps(), record, makeMinimalResult());
    expect(record.round).toBe(4);
    expect(record.status).toBe("running");
  });

  it("不调 store.archive（record 留内存，getMutable 仍可查）", async () => {
    const deps = makeDeps();
    const record = makeMinimalRecord({ id: "rec-noarchive" });
    record.status = "closed";
    await doFinalizeRoundToIdle(deps, record, makeMinimalResult());
    expect(deps.store.archive).not.toHaveBeenCalled();
  });

  it("不 cleanup worktree（即使 record 带 worktreeHandle——保留对话模式工作目录）", async () => {
    const deps = makeDeps();
    const record = makeMinimalRecord({
      id: "rec-noworktree",
      worktreeHandle: { path: "/tmp/x", branch: "b", baseCommit: "c", mainCwd: "/tmp" } as never,
    });
    record.status = "closed";
    await doFinalizeRoundToIdle(deps, record, makeMinimalResult());
    expect(deps.worktreeManager.cleanup).not.toHaveBeenCalled();
  });

  it("emitUnregister 被调（status=running，进程已死从 pending 活跃差集移除）", async () => {
    const deps = makeDeps();
    const record = makeMinimalRecord({ id: "rec-emit" });
    record.status = "closed";
    await doFinalizeRoundToIdle(deps, record, makeMinimalResult());
    expect(deps.emitUnregister).toHaveBeenCalledWith("rec-emit", "running");
  });

  it("不调 completeRecord：record 不冻结（endedAt / agentResult 仍 undefined）", async () => {
    const record = makeMinimalRecord({ id: "rec-nofreeze" });
    record.status = "closed";
    await doFinalizeRoundToIdle(makeDeps(), record, makeMinimalResult());
    expect(record.endedAt).toBeUndefined();
    expect(record.agentResult).toBeUndefined();
  });

  it("不写 manifest（idle 非终态，manifest 是终态诊断辅助）", async () => {
    const record = makeMinimalRecord({ id: "rec-nomanifest" });
    record.status = "closed";
    await doFinalizeRoundToIdle(makeDeps(), record, makeMinimalResult());
    const manifest = await manifestStore.readManifest("rec-nomanifest");
    expect(manifest).toBeNull();
  });

  it("MF-2: record.result 设为 result.text（否则 notifier idle 回复恒为 (empty)，G1/G2 不成立）", async () => {
    const record = makeMinimalRecord({ id: "rec-result" });
    record.status = "closed";
    const result = makeMinimalResult();
    result.text = "review done, found 3 issues";
    await doFinalizeRoundToIdle(makeDeps(), record, result);
    // MF-2：record.result 被 result.text 填充，notifier idle 分支读取后携带回复正文
    expect(record.result).toBe("review done, found 3 issues");
  });

  it("MF-2 兑底：失败轮次 result.text 为空时用 result.error 填 record.result（MF-6 回退 idle 路径）", async () => {
    const record = makeMinimalRecord({ id: "rec-result-err" });
    record.status = "closed";
    const result = makeMinimalResult();
    result.text = "";
    result.success = false;
    result.error = "spawn timeout";
    await doFinalizeRoundToIdle(makeDeps(), record, result);
    // 失败轮次的 notify 需可读：result.text 空 → 兑底用 error
    expect(record.result).toBe("round did not complete: spawn timeout");
  });

  it("C1TC10: chatMode 空增量轮占位——record.result 固定 (no output this round)，不含上一轮文本（D5）", async () => {
    const record = makeMinimalRecord({ id: "rec-increment-empty", chatMode: true });
    record.status = "closed";
    // 预置上一轮通知文本（模拟增量语义前的 record.result 残留）
    record.result = "PREV-ROUND-TEXT";
    const result = makeMinimalResult();
    result.text = "";
    result.success = true;
    result.error = undefined;
    await doFinalizeRoundToIdle(makeDeps(), record, result);
    // 空增量轮通知不含上一轮文本：沿用旧值会让父 agent 误读为原样重复回复（D5 判定）
    expect(record.result).toBe("(no output this round)");
    expect(record.result).not.toContain("PREV-ROUND-TEXT");
  });

  it("C1TC11: 非 chatMode 空文本沿用旧值——one-shot 空文本完成 record.result 保持 undefined（G2/G4）", async () => {
    const record = makeMinimalRecord({ id: "rec-oneshot-empty", chatMode: false });
    record.status = "closed";
    // one-shot 成功空文本完成路径（collectResult getFullText 返回 ""、success=true）：
    // result 前值 undefined
    record.result = undefined;
    const result = makeMinimalResult();
    result.text = "";
    result.success = true;
    result.error = undefined;
    await doFinalizeRoundToIdle(makeDeps(), record, result);
    // 非 chatMode 侧维持现状（第三分支 record.chatMode ? 占位 : record.result）
    expect(record.result).toBeUndefined();
    // notifier buildLlmContent 的 record.result ?? "(empty)" 确定性链保 G4：
    // 通知文案逐字节产出 "completed. Result:\n(empty)"，不漂移为 "(no output this round)"
    expect(record.result ?? "(empty)").toBe("(empty)");
  });
});
