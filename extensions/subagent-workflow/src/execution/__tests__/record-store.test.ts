// src/__tests__/record-store.test.ts
//
// RecordStore 专属测试。
// 覆盖：
//   - archive 立即移除（终态 record 不留内存，读时从 session.jsonl 重建）
//   - collectRecords 合并内存(running) + 磁盘(session.jsonl 重建)
//   - collectRecords statusFilter（"running" vs "all"）
//   - cancelled tombstone override
//   - compareRecords 排序（status priority + startedAt desc）
//   - 重建缓存（notifyChange 失效）
//
// 用 tmpdir + 真实 .jsonl fixture（隔离真实文件系统，同 session-reconstructor.test.ts 模式）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeAliveMarker } from "../alive-store.ts";
import { createRecord } from "../execution-record.ts";
import { writeFinalized } from "../finalized-marker.ts";
import type { ManifestRecord } from "../manifest-store.ts";
import { ManifestStore } from "../manifest-store.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "../path-encoding.ts";
import type { StatusFilter } from "../record-store.ts";
import { RecordStore } from "../record-store.ts";
import { writeCancelledTombstone } from "../tombstone-store.ts";
import type { AliveMarker, ExecutionRecord } from "../types.ts";

/** 构造 ExecutionRecord（base 默认 running，over 覆盖任意字段）。 */
function makeRecord(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const base = createRecord("r1", {
    agent: "worker",
    model: "m",
    mode: "sync",
    task: "t",
    startedAt: 1000,
    rootSessionId: "sess-current",
  });
  return { ...base, ...over };
}

/**
 * 写一个最小合法的 session.jsonl（含 identity custom entry + 1 个 assistant message）。
 * 用于 collectRecords 磁盘源重建测试。
 */
function writeSessionJsonl(
  filePath: string,
  identity: { id: string; agent: string; mode: "sync" | "background"; task: string; startedAt: number; rootSessionId?: string; parentRecordId?: string; depth?: number; lastTs?: number },
  assistantText = "result text",
): void {
  const lastTs = identity.lastTs ?? identity.startedAt + 1000;
  const header = JSON.stringify({
    type: "session", version: 3, id: "sess-uuid", timestamp: new Date(identity.startedAt).toISOString(), cwd: "/tmp",
  });
  const identityData: Record<string, unknown> = {
    id: identity.id,
    agent: identity.agent,
    mode: identity.mode,
    task: identity.task,
    startedAt: identity.startedAt,
  };
  if (identity.rootSessionId !== undefined) identityData.rootSessionId = identity.rootSessionId;
  if (identity.parentRecordId !== undefined) identityData.parentRecordId = identity.parentRecordId;
  if (identity.depth !== undefined) identityData.depth = identity.depth;
  const identityEntry = JSON.stringify({
    type: "custom",
    id: "id-1",
    parentId: null,
    timestamp: new Date(identity.startedAt).toISOString(),
    customType: "subagent-identity",
    data: identityData,
  });
  const assistantMsg = JSON.stringify({
    type: "message",
    id: "msg-1",
    parentId: "id-1",
    timestamp: new Date(lastTs).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: assistantText }],
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0 } },
      stopReason: "stop",
      timestamp: lastTs,
    },
  });
  fs.writeFileSync(filePath, `${header}\n${identityEntry}\n${assistantMsg}\n`, "utf-8");
}

describe("RecordStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ============================================================
  // archive 立即移除
  // ============================================================
  describe("archive 立即移除", () => {
    it("archive 后 record 立即从内存移除（不再 linger）", () => {
      const store = new RecordStore(tmpDir);
      const r = makeRecord({ id: "sync-1", mode: "sync", status: "closed" });
      store.register(r);
      expect(store.getMutable("sync-1")).toBeDefined();
      store.archive(r);
      expect(store.getMutable("sync-1")).toBeUndefined();
    });

    it("background record 同样立即移除（不再 FIFO）", () => {
      const store = new RecordStore(tmpDir);
      const r = makeRecord({ id: "bg-1", mode: "background", status: "closed" });
      store.register(r);
      store.archive(r);
      expect(store.getMutable("bg-1")).toBeUndefined();
    });
  });

  // ============================================================
  // collectRecords：内存(running) + 磁盘(重建) 合并
  // ============================================================
  describe("collectRecords 合并", () => {
    it("内存 running record 出现在结果中", () => {
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "run-1", mode: "background", startedAt: 1000 }));
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids).toContain("run-1");
    });

    it("磁盘 session.jsonl 重建的终态 record 出现在结果中（无 sidecar → idle, SP-2）", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      // 无 sidecar → 四分支兜底 idle（SP-2：跨重启可恢复）
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === "bg-1");
      expect(found).toBeDefined();
      expect(found?.status).toBe("idle");
      expect(found?.agent).toBe("worker");
      expect(found?.turns).toBe(1);
      expect(found?.totalTokens).toBe(30);
      expect(found?.result).toBe("result text");
    });

    it("磁盘 session.jsonl + .finalized sidecar → done", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-b.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-2", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      writeFinalized(sessionFile);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === "bg-2");
      expect(found).toBeDefined();
      expect(found?.status).toBe("closed");
    });

    it("statusFilter='running' 只返回 running（磁盘终态被滤掉）", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "run-1", mode: "background", startedAt: 1000 }));
      const filter: StatusFilter = "running";
      const ids = store.collectRecords(100, filter).map((r) => r.id);
      expect(ids).toEqual(["run-1"]); // 只有内存 running，磁盘 idle（SP-2）被滤
    });

    it("statusFilter='all'（默认）返回内存 + 磁盘", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "run-1", mode: "background", startedAt: 1000 }));
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids).toContain("run-1");
      expect(ids).toContain("bg-1");
    });

    it("内存 running 优先于磁盘同 id（内存覆盖）", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "dup-1", agent: "worker", mode: "background", task: "from disk", startedAt: 5000,
      });
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "dup-1", mode: "background", status: "running", startedAt: 5000 }));
      const found = store.collectRecords(100).find((r) => r.id === "dup-1");
      expect(found?.status).toBe("running"); // 内存 running 覆盖磁盘 idle（SP-2）
    });

    it("[MF-3/S-20] 跨进程组合：子进程（worktree）写入 enc(ROOT) 的深层 record 被 ROOT store 重建，同 rootSessionId 全树可见、他树被排除", () => {
      // MF-3 修复后：worktree 子进程把其子 record 的 session 文件写到统一 enc(ROOT cwd) 段，
      // ROOT 进程的 store 扫同一目录重建（旧实现子进程写到 enc(checkout) 段，此处为空）。
      const rootCwd = "/Users/x/root-proj";
      const sessionsDir = getSubagentSessionDir(tmpDir, rootCwd);
      const recordsDir = getSubagentRecordsDir(tmpDir, rootCwd);

      // 父 record A（ROOT 自己 spawn，parentRecordId 缺省=顶层）+ 孙 record C（B 子进程写入，
      // 同 rootSessionId、parentRecordId=A、depth=2）+ 他树 record X（rootSessionId 不同）
      fs.mkdirSync(sessionsDir, { recursive: true });
      writeSessionJsonl(path.join(sessionsDir, "2026-01-01-uuid-a.jsonl"), {
        id: "sa-A", agent: "worker", mode: "background", task: "level1", startedAt: 1000, rootSessionId: "root-main",
      });
      writeSessionJsonl(path.join(sessionsDir, "2026-01-01-uuid-c.jsonl"), {
        id: "sa-C", agent: "worker", mode: "background", task: "level3", startedAt: 3000,
        rootSessionId: "root-main", parentRecordId: "sa-A", depth: 2,
      });
      writeSessionJsonl(path.join(sessionsDir, "2026-01-01-uuid-x.jsonl"), {
        id: "sa-X", agent: "worker", mode: "background", task: "other root", startedAt: 4000, rootSessionId: "root-other",
      });

      // ROOT 进程的 store：sessionsDir/recordsDir 与子进程写盘目录同段（getSubagentSessionDir 同源）
      const store = new RecordStore(sessionsDir, new ManifestStore(recordsDir), undefined);
      const recs = store.collectRecords(10, "all", "root-main");
      const ids = recs.map((r) => r.id);

      // 全树可见：A（顶层）与 C（深度 2，跨进程写入）都在列表，身份字段正确
      expect(ids).toContain("sa-A");
      expect(ids).toContain("sa-C");
      const c = recs.find((r) => r.id === "sa-C");
      expect(c?.parentRecordId).toBe("sa-A");
      expect(c?.depth).toBe(2);
      // 他树 record 被 rootSessionFilter 排除（隔离不破坏）
      expect(ids).not.toContain("sa-X");
    });
  });

  // ============================================================
  // cancelled tombstone override
  // ============================================================
  describe("cancelled tombstone", () => {
    it("有 .cancelled sidecar → status override 为 cancelled", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      writeCancelledTombstone(sessionFile, {
        id: "bg-1", status: "cancelled", agent: "worker", startedAt: 5000, endedAt: 6000,
      });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === "bg-1");
      expect(found?.status).toBe("cancelled");
      expect(found?.error).toBe("cancelled by user");
    });
  });

  // ============================================================
  // compareRecords 排序稳定性（内存 running record）
  // ============================================================
  describe("compareRecords 排序", () => {
    it("status priority（running < idle）", () => {
      const store = new RecordStore(tmpDir);
      // 内存 running record vs 磁盘无 sidecar → idle（SP-2）
      const running = makeRecord({ id: "run-1", mode: "background", startedAt: 3000, status: "running" });
      store.register(running);
      // 磁盘 idle record（无 sidecar → 四分支兜底 idle）
      writeSessionJsonl(path.join(tmpDir, "a.jsonl"), {
        id: "done-1", agent: "w", mode: "background", task: "t", startedAt: 5000,
      });
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids[0]).toBe("run-1"); // running 排前
    });

    it("同 status 时 startedAt desc（新→旧）", () => {
      const store = new RecordStore(tmpDir);
      writeSessionJsonl(path.join(tmpDir, "old.jsonl"), {
        id: "old", agent: "w", mode: "background", task: "t", startedAt: 1000,
      });
      writeSessionJsonl(path.join(tmpDir, "new.jsonl"), {
        id: "new", agent: "w", mode: "background", task: "t", startedAt: 9000,
      });
      // 两个都是 idle（磁盘重建，无 sidecar → SP-2 兜底 idle），按 startedAt desc
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids).toEqual(["new", "old"]);
    });
  });

  // ============================================================
  // idle 态 record（M2-A：chatMode 轮次完成进 idle）
  // ============================================================
  describe("idle 态 record (M2-A)", () => {
    it("getMutable 能查到 idle record（不筛 status，idle record 留内存不 archive）", () => {
      const store = new RecordStore(tmpDir);
      const r = makeRecord({ id: "idle-1", status: "idle" });
      store.register(r);
      // idle record 不 archive → getMutable 仍可查（续聊定位依赖此）
      expect(store.getMutable("idle-1")).toBe(r);
    });

    it("STATUS_PRIORITY 含 idle：idle 排在 closed 之前（waiting 语义）", () => {
      const store = new RecordStore(tmpDir);
      // 两个内存 record，startedAt 相同 → 纯按 STATUS_PRIORITY 排序
      store.register(makeRecord({ id: "closed-1", status: "closed", startedAt: 5000 }));
      store.register(makeRecord({ id: "idle-1", status: "idle", startedAt: 5000 }));
      const ids = store.collectRecords(100).map((r) => r.id);
      // STATUS_PRIORITY: running=0 < idle=2 < closed=3
      expect(ids).toEqual(["idle-1", "closed-1"]);
    });

    it("idle record 经 collectRecords(statusFilter=all) 可见", () => {
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "idle-2", status: "idle" }));
      const ids = store.collectRecords(100, "all").map((r) => r.id);
      expect(ids).toContain("idle-2");
    });

    it("idle record 经 collectRecords(statusFilter=running) 不可见（idle ≠ running）", () => {
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "idle-3", status: "idle" }));
      const ids = store.collectRecords(100, "running").map((r) => r.id);
      expect(ids).not.toContain("idle-3");
    });
  });


  // ============================================================
  // 重建缓存
  // ============================================================
  describe("重建缓存", () => {
    it("notifyChange 后缓存失效（新 session.jsonl 可见）", () => {
      const store = new RecordStore(tmpDir);
      // 首次 collect：空目录
      expect(store.collectRecords(100)).toHaveLength(0);
      // 写新 session.jsonl
      writeSessionJsonl(path.join(tmpDir, "new.jsonl"), {
        id: "bg-1", agent: "w", mode: "background", task: "t", startedAt: 1000,
      });
      // 缓存仍命中旧结果（notifyChange 未触发）
      expect(store.collectRecords(100)).toHaveLength(0);
      // register 触发 notifyChange → 缓存失效
      store.register(makeRecord({ id: "trigger", mode: "sync", startedAt: 2000 }));
      store.archive(makeRecord({ id: "trigger", mode: "sync", startedAt: 2000 }));
      // 现在 bg-1 可见
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids).toContain("bg-1");
    });
  });

  // ============================================================
  // dispose / revive
  // ============================================================
  describe("dispose / revive", () => {
    it("dispose 后 notifyChange 不再触发 listener", () => {
      const store = new RecordStore(tmpDir);
      let count = 0;
      store.onChange(() => { count++; });
      store.register(makeRecord({ id: "r1", startedAt: 1000 }));
      expect(count).toBe(1);
      store.dispose();
      store.register(makeRecord({ id: "r2", startedAt: 2000 }));
      expect(count).toBe(1); // dispose 后不再通知
    });
  });

  // ============================================================
  // 四分支 sidecar 矩阵（D-006 + D-021）
  // ============================================================
  describe("四分支 sidecar 矩阵", () => {
    const SESSION_ID = "bg-1";
    const STARTED_AT = 1000;

    function writeBaseSession(): string {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-sidecar.jsonl");
      writeSessionJsonl(sessionFile, {
        id: SESSION_ID, agent: "worker", mode: "background", task: "do it", startedAt: STARTED_AT,
      });
      return sessionFile;
    }

    // ── 分支 1: .cancelled ──
    it(".cancelled sidecar → cancelled", () => {
      const sessionFile = writeBaseSession();
      writeCancelledTombstone(sessionFile, {
        id: SESSION_ID, status: "cancelled", agent: "worker", startedAt: STARTED_AT, endedAt: 6000,
      });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("cancelled");
      expect(found?.error).toBe("cancelled by user");
      expect(found?.endedAt).toBe(6000);
    });

    // ── 分支 2: .finalized done ──
    it(".finalized sidecar + stopReason=stop → done", () => {
      const sessionFile = writeBaseSession();
      writeFinalized(sessionFile);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("closed");
    });

    // ── 分支 2: .finalized failed ──
    it(".finalized sidecar + stopReason=error → failed", () => {
      // 写一个 stopReason=error 的 session.jsonl
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-fail.jsonl");
      const header = JSON.stringify({
        type: "session", version: 3, id: "sess-uuid", timestamp: new Date(STARTED_AT).toISOString(), cwd: "/tmp",
      });
      const identityEntry = JSON.stringify({
        type: "custom", id: "id-1", parentId: null, timestamp: new Date(STARTED_AT).toISOString(),
        customType: "subagent-identity",
        data: { id: SESSION_ID, agent: "worker", mode: "background", task: "do it", startedAt: STARTED_AT },
      });
      const assistantMsg = JSON.stringify({
        type: "message", id: "msg-1", parentId: "id-1",
        timestamp: new Date(STARTED_AT + 1000).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "error output" }],
          usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0 } },
          stopReason: "error",
          errorMessage: "something went wrong",
          timestamp: STARTED_AT + 1000,
        },
      });
      fs.writeFileSync(sessionFile, `${header}\n${identityEntry}\n${assistantMsg}\n`, "utf-8");

      writeFinalized(sessionFile);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("closed");
    });

    // ── 分支 3: .alive + 活 pid → running + externalInstance ──
    it(".alive + 存活 pid → running + externalInstance=true", () => {
      const sessionFile = writeBaseSession();
      const recentStartedAt = Date.now() - 1000; // 1 秒前，确保未超 24h
      const marker: AliveMarker = { pid: process.pid, id: SESSION_ID, startedAt: recentStartedAt };
      writeAliveMarker(sessionFile, marker);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("running");
      expect(found?.externalInstance).toEqual(marker);
    });

    // ── 分支 3→4: .alive + 死 pid → idle（SP-2：跨重启可恢复）──
    it(".alive + 死 pid → idle（SP-2 跨重启可恢复）", () => {
      const sessionFile = writeBaseSession();
      const marker: AliveMarker = { pid: 9999999, id: SESSION_ID, startedAt: STARTED_AT };
      writeAliveMarker(sessionFile, marker);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("idle");
      expect(found?.externalInstance).toBeUndefined();
    });

    // ── 分支 4: 都无 sidecar → idle（SP-2：跨重启可恢复）──
    it("无任何 sidecar → idle（SP-2 跨重启可恢复）", () => {
      writeBaseSession();
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("idle");
    });

    // ── 分支 4: >24h 软超时 → idle（SP-2：跨重启可恢复，无视探活）──
    it(">24h 软超时 → idle（SP-2，即使 pid 存活）", () => {
      const sessionFile = writeBaseSession();
      // startedAt 设为 25 小时前
      const oldStartedAt = Date.now() - 25 * 60 * 60 * 1000;
      const marker: AliveMarker = { pid: process.pid, id: SESSION_ID, startedAt: oldStartedAt };
      writeAliveMarker(sessionFile, marker);

      // 重写 session.jsonl 使 startedAt 匹配
      fs.unlinkSync(sessionFile);
      writeSessionJsonl(sessionFile, {
        id: SESSION_ID, agent: "worker", mode: "background", task: "do it", startedAt: oldStartedAt,
      });

      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("idle");
      expect(found?.externalInstance).toBeUndefined();
    });

    // ── 回归：.cancelled 优先于 .finalized ──
    it(".cancelled 优先于 .finalized（即使两者共存）", () => {
      const sessionFile = writeBaseSession();
      writeFinalized(sessionFile);
      writeCancelledTombstone(sessionFile, {
        id: SESSION_ID, status: "cancelled", agent: "worker", startedAt: STARTED_AT, endedAt: 6000,
      });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("cancelled");
    });

    // ── 回归：旧 .cancelled 单分支行为不变 ──
    it("旧 .cancelled 单分支行为不变（回归）", () => {
      const sessionFile = writeBaseSession();
      writeCancelledTombstone(sessionFile, {
        id: SESSION_ID, status: "cancelled", agent: "worker", startedAt: STARTED_AT, endedAt: 7000,
      });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("cancelled");
      expect(found?.error).toBe("cancelled by user");
      expect(found?.endedAt).toBe(7000);
    });
  });

  // ============================================================
  // session 隔离（问题 1 修复）
  // ============================================================
  describe("session 隔离（rootSessionId 过滤）", () => {
    it("磁盘源：只返回 rootSessionId 匹配的 record", () => {
      writeSessionJsonl(path.join(tmpDir, "mine.jsonl"), {
        id: "mine", agent: "w", mode: "background", task: "t", startedAt: 1000, rootSessionId: "sess-A",
      });
      writeSessionJsonl(path.join(tmpDir, "other.jsonl"), {
        id: "other", agent: "w", mode: "background", task: "t", startedAt: 2000, rootSessionId: "sess-B",
      });
      const store = new RecordStore(tmpDir);
      const ids = store.collectRecords(100, "all", "sess-A").map((r) => r.id);
      expect(ids).toEqual(["mine"]); // other 属于 sess-B，被隔离
    });

    it("磁盘源：rootSessionId 缺失（旧文件）被排除（无法判定归属）", () => {
      writeSessionJsonl(path.join(tmpDir, "legacy.jsonl"), {
        id: "legacy", agent: "w", mode: "background", task: "t", startedAt: 1000, // 无 rootSessionId
      });
      const store = new RecordStore(tmpDir);
      const ids = store.collectRecords(100, "all", "sess-A").map((r) => r.id);
      expect(ids).toEqual([]); // 旧文件被排除
    });

    it("磁盘源：不传 filter（undefined）不过滤（向后兼容）", () => {
      writeSessionJsonl(path.join(tmpDir, "legacy.jsonl"), {
        id: "legacy", agent: "w", mode: "background", task: "t", startedAt: 1000,
      });
      writeSessionJsonl(path.join(tmpDir, "tagged.jsonl"), {
        id: "tagged", agent: "w", mode: "background", task: "t", startedAt: 2000, rootSessionId: "sess-A",
      });
      const store = new RecordStore(tmpDir);
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids.sort()).toEqual(["legacy", "tagged"]); // 全返回，不过滤
    });

    it("内存源：只返回 rootSessionId 匹配的 running record", () => {
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "mine", startedAt: 1000, rootSessionId: "sess-A" }));
      store.register(makeRecord({ id: "other", startedAt: 2000, rootSessionId: "sess-B" }));
      const ids = store.collectRecords(100, "all", "sess-A").map((r) => r.id);
      expect(ids).toEqual(["mine"]);
    });

    it("内存+磁盘混合：同时按 session 过滤", () => {
      writeSessionJsonl(path.join(tmpDir, "disk-A.jsonl"), {
        id: "disk-A", agent: "w", mode: "background", task: "t", startedAt: 1000, rootSessionId: "sess-A",
      });
      writeSessionJsonl(path.join(tmpDir, "disk-B.jsonl"), {
        id: "disk-B", agent: "w", mode: "background", task: "t", startedAt: 2000, rootSessionId: "sess-B",
      });
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "mem-A", startedAt: 3000, rootSessionId: "sess-A" }));
      store.register(makeRecord({ id: "mem-B", startedAt: 4000, rootSessionId: "sess-B" }));
      const ids = store.collectRecords(100, "all", "sess-A").map((r) => r.id).sort();
      expect(ids).toEqual(["disk-A", "mem-A"]);
    });

    it("重建缓存：不同 filter 共享缓存，不交叉污染", () => {
      writeSessionJsonl(path.join(tmpDir, "a.jsonl"), {
        id: "a", agent: "w", mode: "background", task: "t", startedAt: 1000, rootSessionId: "sess-A",
      });
      writeSessionJsonl(path.join(tmpDir, "b.jsonl"), {
        id: "b", agent: "w", mode: "background", task: "t", startedAt: 2000, rootSessionId: "sess-B",
      });
      const store = new RecordStore(tmpDir);
      // 先查 sess-A（建缓存）
      expect(store.collectRecords(100, "all", "sess-A").map((r) => r.id)).toEqual(["a"]);
      // 再查 sess-B（复用缓存基底，过滤不交叉）
      expect(store.collectRecords(100, "all", "sess-B").map((r) => r.id)).toEqual(["b"]);
      // 不带 filter（复用缓存，全量）
      expect(store.collectRecords(100).map((r) => r.id).sort()).toEqual(["a", "b"]);
    });
  });

  // ============================================================
  // endedAt 重建（问题 2 修复：终态耗时不再随墙钟增长）
  // ============================================================
  describe("endedAt 重建（耗时不再无限增长）", () => {
    it(".finalized → endedAt 为最后 entry 时间戳（非 now）", () => {
      const sessionFile = path.join(tmpDir, "fin.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "w", mode: "background", task: "t",
        startedAt: 5000, lastTs: 9000, rootSessionId: "sess-A",
      });
      writeFinalized(sessionFile);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-A").find((r) => r.id === "bg-1");
      expect(found?.endedAt).toBe(9000); // 不是 Date.now()
    });

    it("无 sidecar（idle, SP-2）→ endedAt 保持 undefined（非终态）", () => {
      const sessionFile = path.join(tmpDir, "crash.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "w", mode: "background", task: "t",
        startedAt: 5000, lastTs: 9000, rootSessionId: "sess-A",
      });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-A").find((r) => r.id === "bg-1");
      expect(found?.status).toBe("idle");
      // SP-2: idle 是非终态，endedAt 保持 undefined（待续聊）
      expect(found?.endedAt).toBeUndefined();
    });

    it(".alive running → endedAt 保持 undefined（running 耗时继续增长是正确的）", () => {
      const sessionFile = path.join(tmpDir, "alive.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "w", mode: "background", task: "t",
        startedAt: Date.now() - 1000, lastTs: Date.now(), rootSessionId: "sess-A",
      });
      writeAliveMarker(sessionFile, { pid: process.pid, id: "bg-1", startedAt: Date.now() - 1000 });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-A").find((r) => r.id === "bg-1");
      expect(found?.status).toBe("running");
      expect(found?.endedAt).toBeUndefined();
    });
  });

  // ============================================================
  // [BL-M1] 修复：损坏 manifest 上报 pi.appendEntry（用户可见）
  // collectRecords 跳过 mapManifestStatus 返回 null 的 manifest 时，除 console.warn
  // 外还需调 pi.appendEntry("subagent:manifest-invalid-status", ...) 让用户能在 session
  // 内复盘事故——避免磁盘陈旧/损坏 manifest 被静默吞掉。
  // ============================================================
  describe("manifest status 越界（损坏 manifest）", () => {
    /** 构造一个 status 越界的 manifest mock。
     *  ManifestRecord.status union 是 4 态，运行时却可能收到陈旧 "error" / 意外 "crashed"
     * 等越界值——isValidManifest 当前挡掉了大部分，但 manifestStore.listAllSync 与
     *  mapManifestStatus 之间仍有防御层（[BL-M1] 修复记录）。本测试用 unknown-cast 模拟
     *  一个越过 ManifestRecord 静态类型的对象，验证 collectRecords 反应正确。 */
    function brokenManifest(): ManifestRecord {
      // eslint-disable-next-line taste/no-unsafe-cast -- intentional: cast status 越界值模拟磁盘损坏 manifest（测试目的本身）
      return {
        id: "broken-1",
        rootSessionId: "sess-current",
        agentName: "worker",
        status: "crashed", // 越界值（union 不含 "crashed"，SP-1 后 valid statuses = running/closed/cancelled）
        createdAt: 1000,
      } as unknown as ManifestRecord;
    }

    /** Mock ManifestStore 让测试不依赖 fs 路径 + isValidManifest 守卫。
     *  source/target 类型不兼容是 intentional（ManifestStore 有多个方法，测试仅需 listAllSync），
     *  `as unknown as ManifestStore` 是 vitest mock 标准 pattern。*/
    function makeManifestStoreMock(manifests: ManifestRecord[]): ManifestStore {
      // eslint-disable-next-line taste/no-unsafe-cast -- intentional: ManifestStore 有多个方法，测试仅需 listAllSync
      return {
        // 复制 manifests 防调用方意外 mutate 共享数组；vi.fn 每次调用返回独立数组
        listAllSync: vi.fn(() => [...manifests]),
      } as unknown as ManifestStore;
    }

    it("collectRecords 跳过越界 status 时调用 pi.appendEntry('subagent:manifest-invalid-status', ...)", () => {
      const pi = { appendEntry: vi.fn() };
      // Mock ManifestStore：listAllSync 返回损坏 manifest，绕开真实 fs 路径与 isValidManifest 守卫。
      const manifestStore = makeManifestStoreMock([brokenManifest()]);
      const store = new RecordStore(tmpDir, manifestStore, pi);

      const result = store.collectRecords(100);

      // 损坏 manifest 不出现在结果中（status 越界被跳过，不降级为 failed——避免误告警）
      expect(result.find((r) => r.id === "broken-1")).toBeUndefined();
      // appendEntry 被调用，customType + data 字段正确
      expect(pi.appendEntry).toHaveBeenCalledTimes(1);
      expect(pi.appendEntry).toHaveBeenCalledWith("subagent:manifest-invalid-status", {
        id: "broken-1",
        status: "crashed",
        rootSessionId: "sess-current",
        agentName: "worker",
      });
    });

    it("pi 为 null/undefined 时不抛错（向后兼容：不注入 pi 的旧调用路径）", () => {
      const manifestStore = makeManifestStoreMock([brokenManifest()]);
      // 不传 pi（undefined）—— 模拟 SubagentService 构造期 session_start 未触发的场景。
      const store = new RecordStore(tmpDir, manifestStore);
      expect(() => store.collectRecords(100)).not.toThrow();
      // 损坏 manifest 仍被跳过（不降级）
      const result = store.collectRecords(100);
      expect(result.find((r) => r.id === "broken-1")).toBeUndefined();
    });

    it("setPi() 后 appendEntry 切换到新 pi（覆盖初始 undefined）", () => {
      const pi1 = { appendEntry: vi.fn() };
      const pi2 = { appendEntry: vi.fn() };
      const manifestStore = makeManifestStoreMock([brokenManifest()]);
      const store = new RecordStore(tmpDir, manifestStore, pi1);
      store.setPi(pi2);

      store.collectRecords(100);

      // 切换后只调 pi2（pi1 不再被调用）
      expect(pi1.appendEntry).not.toHaveBeenCalled();
      expect(pi2.appendEntry).toHaveBeenCalledTimes(1);
      expect(pi2.appendEntry).toHaveBeenCalledWith(
        "subagent:manifest-invalid-status",
        expect.objectContaining({ id: "broken-1" }),
      );
    });
  });

  // ============================================================
  // SP-2: reconstructAll 兜底分支输出 idle（非 crashed）
  // ============================================================
  describe("SP-2: reconstructAll 兜底 idle（跨重启恢复）", () => {
    // TC-1: 兜底分支输出 idle（非 crashed）
    it("TC-1: 无 sidecar + 死 pid → reconstructAll 输出 idle（可冷路径 resume）", () => {
      const sessionFile = path.join(tmpDir, "sp2-tc1.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "sa-sp2-1", agent: "worker", mode: "background", task: "cross-restart task",
        startedAt: 1000, rootSessionId: "sess-sp2",
      });
      // 无任何 sidecar marker → 分支 4 兜底
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-sp2").find((r) => r.id === "sa-sp2-1");
      expect(found).toBeDefined();
      expect(found?.status).toBe("idle");
      // SP-2: idle 是非终态，endedAt 保持 undefined
      expect(found?.endedAt).toBeUndefined();
    });

    // TC-2: 有 .finalized marker 的 record 仍归档为 done（不回归）
    it("TC-2: .finalized marker → done（分支 1/2 不回归）", () => {
      const sessionFile = path.join(tmpDir, "sp2-tc2.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "sa-sp2-2", agent: "worker", mode: "background", task: "finalized task",
        startedAt: 2000, rootSessionId: "sess-sp2",
      });
      writeFinalized(sessionFile);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-sp2").find((r) => r.id === "sa-sp2-2");
      expect(found).toBeDefined();
      // 分支 2 仍归档为 done，不受 SP-2 影响
      expect(found?.status).toBe("closed");
      expect(found?.endedAt).toBeDefined();
    });

    // TC-2b: .cancelled marker → cancelled（分支 1 不回归）
    it("TC-2b: .cancelled marker → cancelled（分支 1 不回归）", () => {
      const sessionFile = path.join(tmpDir, "sp2-tc2b.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "sa-sp2-2b", agent: "worker", mode: "background", task: "cancelled task",
        startedAt: 3000, rootSessionId: "sess-sp2",
      });
      writeCancelledTombstone(sessionFile, {
        id: "sa-sp2-2b", status: "cancelled", agent: "worker", startedAt: 3000, endedAt: 4000,
      });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-sp2").find((r) => r.id === "sa-sp2-2b");
      expect(found).toBeDefined();
      expect(found?.status).toBe("cancelled");
    });
  });
});
