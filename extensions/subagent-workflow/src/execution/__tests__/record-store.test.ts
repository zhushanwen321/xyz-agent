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
import { completeRecord, createRecord, tryTransition } from "../execution-record.ts";
import { writeFinalized } from "../finalized-marker.ts";
import type { ManifestRecord } from "../manifest-store.ts";
import { ManifestStore } from "../manifest-store.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "../path-encoding.ts";
import { SUBAGENT_RECORD_CUSTOM_TYPE } from "../record-entry.ts";
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
  identity: { id: string; agent: string; mode: "sync" | "background"; task: string; startedAt: number; rootSessionId?: string; parentRecordId?: string; depth?: number; lastTs?: number; chatMode?: boolean },
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
  if (identity.chatMode !== undefined) identityData.chatMode = identity.chatMode;
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
  let rootDir: string;
  let tmpDir: string;

  beforeEach(() => {
    // [DS3] 两层布局：tmpDir 深一层（对齐生产 <enc> 段结构），sessions-index.json 落
    // dirname(tmpDir)=rootDir 内随 afterEach 清理（含 MF-3/S-20 的嵌套 <enc> 段索引）。
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-test-"));
    tmpDir = path.join(rootDir, "sessions");
    fs.mkdirSync(tmpDir);
  });
  afterEach(() => {
    // maxRetries：fire-and-forget 的 sessions-index 写可能与删除并发（ENOTEMPTY 竞态）
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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

    it("磁盘 session.jsonl 重建的 record 出现在结果中（无 sidecar → running, SP-2 跨重启可恢复）", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      // 无 sidecar → 四分支兜底 running（v4 B-1：旧 idle 折入 running，SP-2 跨重启可恢复）
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === "bg-1");
      expect(found).toBeDefined();
      expect(found?.status).toBe("running");
      expect(found?.agent).toBe("worker");
      // [perf] 列表是 light（头部 identity，详情字段缺省）——turns/tokens/result 走 getFullRecord 懒加载
      expect(found?.turns).toBe(0);
      expect(found?.result).toBeUndefined();
      const full = store.getFullRecord("bg-1");
      expect(full?.turns).toBe(1);
      expect(full?.totalTokens).toBe(30);
      expect(full?.result).toBe("result text");
      expect(full?.status).toBe("running"); // 状态矩阵在全量路径同样套用
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

    it("statusFilter='running' 含内存 + 磁盘跨重启 running（v4 B-1：旧 idle 折入 running）", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "run-1", mode: "background", startedAt: 1000 }));
      const filter: StatusFilter = "running";
      const ids = store.collectRecords(100, filter).map((r) => r.id);
      // 内存 run-1 + 磁盘跨重启 bg-1 都是 running（旧 idle 折入）；startedAt desc → bg-1(5000) 先
      expect(ids).toEqual(["bg-1", "run-1"]);
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
    it("有 .cancelled sidecar → status override 为 closed + closedReason=cancelled", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      writeCancelledTombstone(sessionFile, {
        id: "bg-1", status: "cancelled", agent: "worker", startedAt: 5000, endedAt: 6000,
      });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === "bg-1");
      // v4 B-1：cancelled 折入 closed，closedReason='cancelled' 保留用户取消语义
      expect(found?.status).toBe("closed");
      expect(found?.closedReason).toBe("cancelled");
      expect(found?.error).toBe("cancelled by user");
    });
  });

  // ============================================================
  // compareRecords 排序稳定性（内存 running record）
  // ============================================================
  describe("compareRecords 排序", () => {
    it("status priority（running < closed）", () => {
      const store = new RecordStore(tmpDir);
      // 内存 running record
      const running = makeRecord({ id: "run-1", mode: "background", startedAt: 3000, status: "running" });
      store.register(running);
      // 磁盘 closed record（.finalized sidecar → closed，v4 B-1 统一终态）
      const doneFile = path.join(tmpDir, "a.jsonl");
      writeSessionJsonl(doneFile, {
        id: "done-1", agent: "w", mode: "background", task: "t", startedAt: 5000,
      });
      writeFinalized(doneFile);
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids[0]).toBe("run-1"); // running(0) 排在 closed(3) 前
    });

    it("同 status 时 startedAt desc（新→旧）", () => {
      const store = new RecordStore(tmpDir);
      writeSessionJsonl(path.join(tmpDir, "old.jsonl"), {
        id: "old", agent: "w", mode: "background", task: "t", startedAt: 1000,
      });
      writeSessionJsonl(path.join(tmpDir, "new.jsonl"), {
        id: "new", agent: "w", mode: "background", task: "t", startedAt: 9000,
      });
      // 两个都是 running（磁盘重建，无 sidecar → SP-2 兜底 running，旧 idle 折入），按 startedAt desc
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids).toEqual(["new", "old"]);
    });
  });

  // ============================================================
  // running 态 record（M2-A chatMode 续聊；v4 B-1：旧 idle 折入 running）
  // ============================================================
  describe("running 态 record（旧 idle 折入，等待续聊）", () => {
    it("getMutable 能查到 running record（不筛 status，running record 留内存不 archive）", () => {
      const store = new RecordStore(tmpDir);
      const r = makeRecord({ id: "idle-1", status: "running" });
      store.register(r);
      // running record 不 archive → getMutable 仍可查（续聊定位依赖此）
      expect(store.getMutable("idle-1")).toBe(r);
    });

    it("running record 经 collectRecords(statusFilter=all) 可见", () => {
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "idle-2", status: "running" }));
      const ids = store.collectRecords(100, "all").map((r) => r.id);
      expect(ids).toContain("idle-2");
    });

    it("running record 经 collectRecords(statusFilter=running) 可见（v4 B-1：旧 idle 折入 running）", () => {
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "idle-3", status: "running" }));
      const ids = store.collectRecords(100, "running").map((r) => r.id);
      expect(ids).toContain("idle-3");
    });
  });


  // ============================================================
  // 重建缓存
  // ============================================================
  describe("重建缓存", () => {
    it("新 session.jsonl 无需内存事件即立即可见（[perf] stat 校验取代 notifyChange 整体失效）", () => {
      const store = new RecordStore(tmpDir);
      // 首次 collect：空目录
      expect(store.collectRecords(100)).toHaveLength(0);
      // 写新 session.jsonl（模拟外部进程/子进程写入——不经本进程任何内存事件）
      writeSessionJsonl(path.join(tmpDir, "new.jsonl"), {
        id: "bg-1", agent: "w", mode: "background", task: "t", startedAt: 1000,
      });
      // [perf] 旧实现：reconCache 建立后只能靠 register/archive 触发 notifyChange 失效，
      // 否则永远 stale（外部进程写入的文件对本进程不可见）。新实现：每次 collectRecords
      // 都 readdir + stat 校验，新文件立即可见（同时修复跨进程可见性）。
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
    it(".cancelled sidecar → closed + closedReason=cancelled", () => {
      const sessionFile = writeBaseSession();
      writeCancelledTombstone(sessionFile, {
        id: SESSION_ID, status: "cancelled", agent: "worker", startedAt: STARTED_AT, endedAt: 6000,
      });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      // v4 B-1：cancelled 折入 closed（closedReason='cancelled' 区分用户取消）
      expect(found?.status).toBe("closed");
      expect(found?.closedReason).toBe("cancelled");
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

    // ── 分支 3→4: .alive + 死 pid → running（SP-2：跨重启可恢复）──
    it(".alive + 死 pid → running（SP-2 跨重启可恢复）", () => {
      const sessionFile = writeBaseSession();
      const marker: AliveMarker = { pid: 9999999, id: SESSION_ID, startedAt: STARTED_AT };
      writeAliveMarker(sessionFile, marker);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("running");
      expect(found?.externalInstance).toBeUndefined();
    });

    // ── 分支 4: 都无 sidecar → running（SP-2：跨重启可恢复）──
    it("无任何 sidecar → running（SP-2 跨重启可恢复）", () => {
      writeBaseSession();
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("running");
    });

    // ── 分支 4: >24h 软超时 → running（SP-2：跨重启可恢复，无视探活）──
    it(">24h 软超时 → running（SP-2，即使 pid 存活）", () => {
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
      expect(found?.status).toBe("running");
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
      // v4 B-1：.cancelled 优先级不变，但 status 折入 closed（closedReason='cancelled'）
      expect(found?.status).toBe("closed");
      expect(found?.closedReason).toBe("cancelled");
    });

    // ── 回归：旧 .cancelled 单分支行为不变 ──
    it("旧 .cancelled 单分支行为不变（回归，status 折入 closed）", () => {
      const sessionFile = writeBaseSession();
      writeCancelledTombstone(sessionFile, {
        id: SESSION_ID, status: "cancelled", agent: "worker", startedAt: STARTED_AT, endedAt: 7000,
      });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("closed");
      expect(found?.closedReason).toBe("cancelled");
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
    it(".finalized → light endedAt 用 mtime 近似，全量 endedAt 为最后 entry 时间戳", () => {
      const sessionFile = path.join(tmpDir, "fin.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "w", mode: "background", task: "t",
        startedAt: 5000, lastTs: 9000, rootSessionId: "sess-A",
      });
      writeFinalized(sessionFile);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-A").find((r) => r.id === "bg-1");
      // [perf] light 分支 2：endedAt 用 jsonl mtime 近似（finalize 后文件不再变化，
      // 与最后 entry ts 差 <1s）——不是 entry ts 9000，也不是随墙钟无限增长的 now 基准。
      expect(found?.endedAt).toBeDefined();
      expect(found?.endedAt).toBeGreaterThan(5000);
      // 全量（getFullRecord）：精确用最后 entry 时间戳（非 now）。
      expect(store.getFullRecord("bg-1")?.endedAt).toBe(9000);
    });

    it("无 sidecar（running, SP-2）→ endedAt 保持 undefined（非终态）", () => {
      const sessionFile = path.join(tmpDir, "crash.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "w", mode: "background", task: "t",
        startedAt: 5000, lastTs: 9000, rootSessionId: "sess-A",
      });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-A").find((r) => r.id === "bg-1");
      expect(found?.status).toBe("running");
      // SP-2: running 是非终态（旧 idle 折入），endedAt 保持 undefined（待续聊）
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
  // SP-2: reconstructAll 兜底分支输出 running（非 crashed；v4 两态后旧 idle 折入 running）
  // ============================================================
  describe("SP-2: reconstructAll 兜底 running（跨重启恢复）", () => {
    // TC-1: 兜底分支输出 running（非 crashed）
    it("TC-1: 无 sidecar + 死 pid → reconstructAll 输出 running（可冷路径 resume）", () => {
      const sessionFile = path.join(tmpDir, "sp2-tc1.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "sa-sp2-1", agent: "worker", mode: "background", task: "cross-restart task",
        startedAt: 1000, rootSessionId: "sess-sp2",
      });
      // 无任何 sidecar marker → 分支 4 兜底
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-sp2").find((r) => r.id === "sa-sp2-1");
      expect(found).toBeDefined();
      expect(found?.status).toBe("running");
      // SP-2: running 是非终态（旧 idle 折入），endedAt 保持 undefined
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

    // TC-2b: .cancelled marker → closed+cancelled（分支 1 不回归）
    it("TC-2b: .cancelled marker → closed+cancelled reason（分支 1 不回归）", () => {
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
      expect(found?.status).toBe("closed");
      expect(found?.closedReason).toBe("cancelled");
    });
  });

  // ============================================================
  // 孤儿终态恢复（residual-fixes）：分支 4 兜底 record 的判定与落盘
  // ============================================================
  describe("recoverOrphanRecords 孤儿终态恢复", () => {
    /** 带真实磁盘 fixture + appendEntry 捕获的 store。 */
    function makeRecoveryStore(): { store: RecordStore; appended: Array<{ customType: string; data: Record<string, unknown> }> } {
      const appended: Array<{ customType: string; data: Record<string, unknown> }> = [];
      const store = new RecordStore(tmpDir, undefined, {
        appendEntry: (customType: string, data: unknown) => {
          appended.push({ customType, data: data as Record<string, unknown> });
        },
      } as never);
      return { store, appended };
    }

    it("末行完整 → closed 终态 entry + .finalized sidecar（防重锚）", () => {
      const sessionFile = path.join(tmpDir, "orphan-done.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "sa-orphan-1", agent: "worker", mode: "background", task: "orphan done",
        startedAt: 1000, rootSessionId: "sess-orphan",
      });
      const { store, appended } = makeRecoveryStore();
      store.recoverOrphanRecords("sess-orphan");

      const entry = appended.find((c) => c.data.id === "sa-orphan-1");
      expect(entry?.customType).toBe("subagent-record");
      expect(entry?.data.status).toBe("closed");
      expect(entry?.data.closedReason).toBe("gc");
      expect(entry?.data.endedAt).toEqual(expect.any(Number));
      expect(entry?.data.error).toBeUndefined();
      expect(fs.existsSync(`${sessionFile}.finalized`)).toBe(true);
      // 防重：sidecar 使下次重建走分支 2（closed），不再进判定
      const again = [...appended];
      store.recoverOrphanRecords("sess-orphan");
      expect(appended.length).toBe(again.length);
      const found = store.collectRecords(100, "all", "sess-orphan").find((r) => r.id === "sa-orphan-1");
      expect(found?.status).toBe("closed");
    });

    it("末行截断 → closed + error（保守方向）", () => {
      const sessionFile = path.join(tmpDir, "orphan-truncated.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "sa-orphan-2", agent: "worker", mode: "background", task: "orphan truncated",
        startedAt: 2000, rootSessionId: "sess-orphan",
      });
      // 制造截断：append 半行 JSON（无换行结尾）
      fs.appendFileSync(sessionFile, '{"type":"message","id":"msg-2","pare', "utf-8");
      const { store, appended } = makeRecoveryStore();
      store.recoverOrphanRecords("sess-orphan");

      const entry = appended.find((c) => c.data.id === "sa-orphan-2");
      expect(entry?.data.status).toBe("closed");
      expect(entry?.data.error).toContain("truncated");
      expect(fs.existsSync(`${sessionFile}.finalized`)).toBe(true);
    });

    it("chatMode 孤儿 → 不终态化，落 resumable entry（可续聊产品语义）", () => {
      const sessionFile = path.join(tmpDir, "orphan-chat.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "sa-orphan-3", agent: "worker", mode: "background", task: "orphan chat",
        startedAt: 3000, rootSessionId: "sess-orphan", chatMode: true,
      });
      const { store, appended } = makeRecoveryStore();
      store.recoverOrphanRecords("sess-orphan");

      const entry = appended.find((c) => c.data.id === "sa-orphan-3");
      expect(entry?.data.status).toBe("running");
      expect(entry?.data.resumable).toBe(true);
      expect(entry?.data.chatMode).toBe(true);
      // chat 分流不写终态 sidecar
      expect(fs.existsSync(`${sessionFile}.finalized`)).toBe(false);
      // orphanJudged 缓存：同 store 重复调用不重复 append
      const count = appended.length;
      store.recoverOrphanRecords("sess-orphan");
      expect(appended.length).toBe(count);
    });

    it("非分支 4 record（closed / 活进程）不进判定", () => {
      const closedFile = path.join(tmpDir, "orphan-closed.jsonl");
      writeSessionJsonl(closedFile, {
        id: "sa-orphan-4", agent: "worker", mode: "background", task: "already closed",
        startedAt: 4000, rootSessionId: "sess-orphan",
      });
      writeFinalized(closedFile);
      const { store, appended } = makeRecoveryStore();
      store.recoverOrphanRecords("sess-orphan");
      expect(appended.find((c) => c.data.id === "sa-orphan-4")).toBeUndefined();
    });
  });

  // ============================================================
  // W16 [D4]：subagent-record 自描述 appendEntry 上报（状态迁移点）
  // ============================================================
  describe("W16 subagent-record 自描述 appendEntry 上报", () => {
    /** appendEntry 捕获（RecordStorePi 最小实现）。 */
    interface AppendedCall {
      customType: string;
      data: unknown;
    }

    /** 构造带 appendEntry 捕获的 store（pi 注入通道，对齐生产 setPi 后形态）。 */
    function makeStoreWithPi(): { store: RecordStore; appended: AppendedCall[] } {
      const appended: AppendedCall[] = [];
      const store = new RecordStore(tmpDir, undefined, {
        appendEntry: (customType: string, data: unknown) => {
          appended.push({ customType, data });
        },
      });
      return { store, appended };
    }

    /** unknown → 对象的运行时 guard（taste/no-unsafe-cast：断言前先收窄）。 */
    function asEntryData(d: unknown): Record<string, unknown> {
      if (typeof d !== "object" || d === null) throw new Error("entry data is not an object");
      return d as Record<string, unknown>;
    }

    it("register：append subagent-record entry，data = v1 + SubagentRecord 完整快照 schema", () => {
      const { store, appended } = makeStoreWithPi();
      store.register(makeRecord());

      expect(appended).toHaveLength(1);
      // 写点字面量与 record-entry.ts 常量等值（钉住双源一致性）
      expect(appended[0]?.customType).toBe(SUBAGENT_RECORD_CUSTOM_TYPE);
      const data = asEntryData(appended[0]?.data);
      // schema 完整性：27 字段（v + SubagentRecord 持久化字段全集，无缺无余；
      // residual-fixes 增 chatMode/resumable 执行态细分判据）
      expect(Object.keys(data).sort()).toEqual([
        "agent", "chatMode", "closedReason", "depth", "displayItems", "endedAt", "error", "eventLog",
        "id", "mode", "model", "parentRecordId", "patchFile", "result", "resumable", "rootSessionId",
        "round", "sessionFile", "slug", "startedAt", "status", "task", "thinkingLevel",
        "totalTokens", "turns", "v", "worktree",
      ]);
      expect(data).toMatchObject({
        v: 1,
        id: "r1",
        agent: "worker",
        task: "t",
        status: "running",
        mode: "sync",
        startedAt: 1000,
        rootSessionId: "sess-current",
        turns: 0,
        totalTokens: 0,
        model: "m",
        eventLog: [],
        displayItems: [],
      });
    });

    it("archive：append 终态完整快照（result/endedAt/closedReason）；one-shot 生命周期共 2 次 append", () => {
      const { store, appended } = makeStoreWithPi();
      const r = makeRecord();
      store.register(r);
      // 模拟正常终态路径：tryTransition CAS → completeRecord 冻结 → archive（D-017 时序）
      tryTransition(r, "closed", "gc");
      completeRecord(r, { text: "task done", turns: 1, durationMs: 500, success: true, sessionId: "r1", toolCalls: [] }, "closed", "gc");
      store.archive(r);

      // 探针基线（单测级）：one-shot 生命周期 = register + archive = 2 次 append
      expect(appended).toHaveLength(2);
      const data = asEntryData(appended[1]?.data);
      expect(data).toMatchObject({
        v: 1,
        id: "r1",
        status: "closed",
        closedReason: "gc",
        result: "task done",
        endedAt: expect.any(Number) as number,
      });
    });

    it("reportRecordTransition：类外恢复写点上报（chatMode 续轮 round 携带）", () => {
      const { store, appended } = makeStoreWithPi();
      const r = makeRecord({ chatMode: true, round: 1 });
      store.reportRecordTransition(r);

      expect(appended).toHaveLength(1);
      expect(appended[0]?.customType).toBe(SUBAGENT_RECORD_CUSTOM_TYPE);
      expect(asEntryData(appended[0]?.data)).toMatchObject({
        v: 1,
        id: "r1",
        status: "running",
        round: 1,
      });
    });

    it("pi 未注入（session_start 前）：三写点均安全降级不抛错", () => {
      const store = new RecordStore(tmpDir);
      const r = makeRecord();
      expect(() => store.register(r)).not.toThrow();
      expect(() => store.archive(r)).not.toThrow();
      expect(() => store.reportRecordTransition(r)).not.toThrow();
    });
  });
});
