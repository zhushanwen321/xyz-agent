// src/execution/__tests__/dispose-manifest-recovery.test.ts
//
// [M1/M2/M3 Gate B 真机验收回归] 编排性/取消终态化的 manifest 反查索引 + 重启冷查分流：
//   - M1：disposeAllRecords（parent-shutdown 等）终态化补写 records/<id>.json——曾整体
//     缺席 → 重启后 list 不可见 + message「not found or not owned」（展示层∪动作链双失）。
//     含 sessionFile 锚点提升（engineHandle.sessionRef.sessionFile → record.sessionFile）。
//   - M1 自愈段：SIGKILL 打进 shutdown 窗口吞掉 fire-and-forget manifest 写时，
//     initSession 的可重连 entry（closed + closedReason ∈ RECONNECTABLE_FINAL_REASONS）
//     重物化 manifest。
//   - M1 负向：user-close/cancelled/gc 末条 entry 不被孤儿恢复/重物化（主动终态语义不放大）。
//   - M2：manifest 源快照 closedReason 投影 → endedMessageGuard 三分流正确
//     （user-close/cancelled → 主动关闭专属文案；parent-shutdown → reconnectable 文案）。
//     曾因 manifest 不携带 closedReason，user-close 误入「closedReason: unknown +
//     reconnectable/fork-from」分支；cancel（无 sessionFile 形态）则完全不可见报原始 not-found。
//
// mock 形态：真实 SubagentService + 真实 ManifestStore（tmp agentDir），重启 =
// 同 agentDir 二次构造 Service + initSession。fire-and-forget manifest 写用 vi.waitFor 等待。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import { toSubagentRecordEntry, SUBAGENT_RECORD_CUSTOM_TYPE } from "../record-entry.ts";
import { RecordStore } from "../record-store.ts";
import { getSubagentRecordsDir } from "../path-encoding.ts";
import { SubagentService, type PiLike } from "../subagent-service.ts";
import { endedMessageGuard } from "../subagent-actions-core.ts";
import type { ExecutionRecord, SubagentRecord } from "../types.ts";

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dispose-manifest-"));
}

function makePi(): PiLike {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as PiLike;
}

function makeRecord(overrides: Partial<ExecutionRecord> & { id?: string } = {}): ExecutionRecord {
  const { id = "sa-m1", ...rest } = overrides;
  const r = createRecord(id, {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: "gate b task",
    slug: "gate-b",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: false,
    controller: new AbortController(),
  });
  Object.assign(r, rest);
  return r;
}

interface ServiceInternals {
  store: RecordStore;
}

/** 同 agentDir 二次构造 + initSession = 重启冷查（新 RecordStore/fileCache/manifest 缓存）。 */
function makeServiceOn(agentDir: string, init?: { mainSessionFile?: string }): SubagentService {
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  const service = new SubagentService({ cwd: agentDir, modelService });
  service.initSession({ pi: makePi(), sessionId: "root-session", mainSessionFile: init?.mainSessionFile });
  return service;
}

/** 构造一条 closed 终态的 subagent-record entry 行（archive 写点的离线形态）。 */
function closedEntryLine(rec: Partial<SubagentRecord> & { id: string; closedReason: NonNullable<SubagentRecord["closedReason"]> }): string {
  const full: SubagentRecord = {
    id: rec.id,
    agent: rec.agent ?? "general-purpose",
    task: rec.task ?? "gate b task",
    slug: rec.slug ?? "gate-b",
    status: "closed",
    closedReason: rec.closedReason,
    mode: "background",
    startedAt: 1000,
    rootSessionId: "root-session",
    parentRecordId: undefined,
    depth: 0,
    endedAt: 2000,
    turns: 0,
    totalTokens: 0,
    model: "test/model",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    error: "closed due to parent-shutdown",
    sessionFile: rec.sessionFile,
  };
  return JSON.stringify({ type: "custom", customType: SUBAGENT_RECORD_CUSTOM_TYPE, data: toSubagentRecordEntry(full) });
}

function manifestPath(agentDir: string, id: string): string {
  return path.join(getSubagentRecordsDir(agentDir, agentDir), `${id}.json`);
}

async function flushAsyncWrites(): Promise<void> {
  // fire-and-forget manifest 写 = fs.promises 微任务/宏任务链；数轮 tick 留足 flush 窗。
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => { setTimeout(r, 5); });
  }
}

describe("[M1/M2 Gate B] 编排性终态化 manifest 反查索引 + 重启冷查分流", () => {
  let agentDir: string;
  let service: SubagentService;
  const extraServices: SubagentService[] = [];

  beforeEach(() => {
    // 身份/目录贯穿 env 净化（本包 vitest.setup 不覆盖；字面量同 subagent-service 模块私有常量，
    // 残留会让 recoverOrphansIfRootProcess 误判子进程跳过恢复、rootCwd 漂移出 tmp agentDir）。
    delete process.env.PI_SUBAGENT_SELF_RECORD_ID;
    delete process.env.PI_SUBAGENT_ROOT_CWD;
    delete process.env.PI_SUBAGENT_ROOT_SESSION_ID;
    agentDir = makeTmpAgentDir();
    service = makeServiceOn(agentDir);
  });

  afterEach(async () => {
    await flushAsyncWrites(); // 先等 fire-and-forget 写落盘，再拆 tmp 目录（防 ENOENT 竞态噪声）
    for (const s of extraServices.splice(0)) s.dispose();
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("M1: disposeAllRecords(parent-shutdown) 补写 manifest（status closed + closedReason 随写）", async () => {
    const record = makeRecord({ id: "sa-m1" });
    (service as unknown as ServiceInternals).store.register(record);

    const count = service.disposeAllRecords("parent-shutdown");
    expect(count).toBe(1);

    await vi.waitFor(() => expect(fs.existsSync(manifestPath(agentDir, "sa-m1"))).toBe(true));
    const manifest = JSON.parse(fs.readFileSync(manifestPath(agentDir, "sa-m1"), "utf-8")) as Record<string, unknown>;
    expect(manifest.status).toBe("closed");
    expect(manifest.closedReason).toBe("parent-shutdown");
    expect(manifest.rootSessionId).toBe("root-session");
    expect(manifest.agentName).toBe("general-purpose");
    expect(manifest.createdAt).toBe(1000);
  });

  it("M1: 在途 record 的 engineHandle.sessionRef.sessionFile 提升为终态锚点（entry+manifest 带真实路径）", async () => {
    const promoted = path.join(agentDir, "enc", "20260910T000000_sess-e1.jsonl");
    const record = makeRecord({
      id: "sa-promote",
      engineHandle: { sessionRef: { sessionId: "sess-e1", sessionFile: promoted }, poolKey: "shared" },
    });
    (service as unknown as ServiceInternals).store.register(record);

    service.disposeAllRecords("parent-shutdown");

    // record 本体提升（archive entry 投影随之携带）
    expect(record.sessionFile).toBe(promoted);
    // manifest 落真实锚点（重启 revive/fork-from 可直接定位子文件）
    await vi.waitFor(() => expect(fs.existsSync(manifestPath(agentDir, "sa-promote"))).toBe(true));
    const manifest = JSON.parse(fs.readFileSync(manifestPath(agentDir, "sa-promote"), "utf-8")) as Record<string, unknown>;
    expect(manifest.sessionFile).toBe(promoted);
    expect(manifest.closedReason).toBe("parent-shutdown");
  });

  it("M1+M2: 重启冷查 manifest 源可见，endedMessageGuard 走 parent-shutdown 可重连分流", async () => {
    const record = makeRecord({ id: "sa-m1" });
    (service as unknown as ServiceInternals).store.register(record);
    service.disposeAllRecords("parent-shutdown");
    await vi.waitFor(() => expect(fs.existsSync(manifestPath(agentDir, "sa-m1"))).toBe(true));
    service.dispose();

    // 重启：新 Service 实例（内存空、fileCache 空、manifest 缓存空）+ initSession
    const restarted = makeServiceOn(agentDir);
    extraServices.push(restarted);

    const snap = restarted.queries.lookupRecordAnyState("sa-m1");
    expect(snap).toBeDefined();
    expect(snap?.status).toBe("closed");
    expect(snap?.closedReason).toBe("parent-shutdown");

    const err = endedMessageGuard(restarted, "sa-m1", new Error("subagent not found or not owned: sa-m1"));
    expect(err.message).toContain("ended but reconnectable");
    expect(err.message).toContain("closedReason: parent-shutdown");
    expect(err.message).toContain("it was disconnected when the previous parent session exited");
    expect(err.message).not.toContain("deliberately closed by user");
  });

  it("M1 自愈: manifest 被 SIGKILL 竞态吞掉时，boot 从可重连 entry 重物化反查索引", async () => {
    // 离线形态：archive entry 已随 pi flush 落盘，但 dispose 的 manifest 写未及落盘
    //（无 records/<id>.json、无子文件、无绑定 sidecar——重物化的唯一恢复源是 entry）。
    const mainSessionFile = path.join(agentDir, "main-session.jsonl");
    fs.writeFileSync(
      mainSessionFile,
      `${closedEntryLine({ id: "sa-remat", closedReason: "parent-shutdown" })}\n`,
      "utf-8",
    );
    expect(fs.existsSync(manifestPath(agentDir, "sa-remat"))).toBe(false);

    const restarted = makeServiceOn(agentDir, { mainSessionFile });
    extraServices.push(restarted);

    await vi.waitFor(() => expect(fs.existsSync(manifestPath(agentDir, "sa-remat"))).toBe(true));
    const manifest = JSON.parse(fs.readFileSync(manifestPath(agentDir, "sa-remat"), "utf-8")) as Record<string, unknown>;
    expect(manifest.status).toBe("closed");
    expect(manifest.closedReason).toBe("parent-shutdown");
    expect(manifest.rootSessionId).toBe("root-session");
    // 动作链同步恢复：message 分流可查（不再 not found）
    const snap = restarted.queries.lookupRecordAnyState("sa-remat");
    expect(snap?.status).toBe("closed");
    expect(snap?.closedReason).toBe("parent-shutdown");
  });

  it("M1 负向: user-close/cancelled/gc 末条 entry 不被重物化、不被孤儿恢复改写", async () => {
    const mainSessionFile = path.join(agentDir, "main-session.jsonl");
    const lines = [
      closedEntryLine({ id: "sa-uc", closedReason: "user-close" }),
      closedEntryLine({ id: "sa-cc", closedReason: "cancelled" }),
      closedEntryLine({ id: "sa-gc", closedReason: "gc" }),
    ];
    fs.writeFileSync(mainSessionFile, `${lines.join("\n")}\n`, "utf-8");

    const restarted = makeServiceOn(agentDir, { mainSessionFile });
    extraServices.push(restarted);
    await flushAsyncWrites();

    // 三类主动/自洽终态均不重物化 manifest（可见性语义 = 「记录真没了/无需恢复」）
    expect(fs.existsSync(manifestPath(agentDir, "sa-uc"))).toBe(false);
    expect(fs.existsSync(manifestPath(agentDir, "sa-cc"))).toBe(false);
    expect(fs.existsSync(manifestPath(agentDir, "sa-gc"))).toBe(false);
    // 查询面不可见（保持现状语义），且孤儿恢复未追加任何 subagent-record entry（无改写）
    expect(restarted.queries.lookupRecordAnyState("sa-uc")).toBeUndefined();
    expect(restarted.queries.lookupRecordAnyState("sa-cc")).toBeUndefined();
    expect(restarted.queries.lookupRecordAnyState("sa-gc")).toBeUndefined();
  });

  it("M1 负向(store 侧): recoverEntryOnlyOrphans 对非 running 末条零 entry 追加", () => {
    // 与上一用例互补：直接钉 store 层候选守卫（isEntryOrphanCandidate 只认 running 末条），
    // 防未来放宽时把主动终态误回收（closed+parent-shutdown 交由 service 重物化段治理）。
    const sessionsDir = path.join(agentDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const mainSessionFile = path.join(agentDir, "main-session.jsonl");
    fs.writeFileSync(
      mainSessionFile,
      `${closedEntryLine({ id: "sa-uc2", closedReason: "user-close" })}\n`,
      "utf-8",
    );
    const appended: Array<{ customType: string; data: Record<string, unknown> }> = [];
    const store = new RecordStore(sessionsDir, undefined, {
      appendEntry: (customType: string, data: unknown) => {
        appended.push({ customType, data: data as Record<string, unknown> });
      },
    });
    store.recoverEntryOnlyOrphans(mainSessionFile, "root-session");
    expect(appended).toHaveLength(0);
    store.dispose();
  });

  it("M2: cancel 终态化补写 manifest——无 sessionFile 形态重启可见 + 主动关闭分流", async () => {
    const record = makeRecord({ id: "sa-cx" });
    (service as unknown as ServiceInternals).store.register(record);
    expect(service.cancel("sa-cx")).toBe(true);

    await vi.waitFor(() => expect(fs.existsSync(manifestPath(agentDir, "sa-cx"))).toBe(true));
    const manifest = JSON.parse(fs.readFileSync(manifestPath(agentDir, "sa-cx"), "utf-8")) as Record<string, unknown>;
    expect(manifest.status).toBe("closed");
    expect(manifest.closedReason).toBe("cancelled");
    service.dispose();

    const restarted = makeServiceOn(agentDir);
    extraServices.push(restarted);
    const snap = restarted.queries.lookupRecordAnyState("sa-cx");
    expect(snap?.status).toBe("closed");
    expect(snap?.closedReason).toBe("cancelled");

    // 曾报原始 not-found（Gate B sq-c）——现走「主动关闭」专属文案
    const err = endedMessageGuard(restarted, "sa-cx", new Error("subagent not found or not owned: sa-cx"));
    expect(err.message).toContain("deliberately closed by user (closedReason: cancelled)");
    expect(err.message).toContain("cannot be messaged or resumed");
    expect(err.message).not.toContain("fork-from");
  });

  it("M2: manifest 源 user-close 快照走「主动关闭」专属文案（读侧投影三分流收口）", async () => {
    // user-close 终态正常路径走 doFinalizeRecord（writeManifestBestEffort 携 closedReason，
    // 写侧由 finalize-record.test.ts 钉）；此处钉读侧：离线构造 user-close manifest，
    // 重启后 endedMessageGuard 不再误入 reconnectable/fork-from 分支（Gate B 实测错分流形态）。
    const restarted = makeServiceOn(agentDir);
    extraServices.push(restarted);
    fs.writeFileSync(
      manifestPath(agentDir, "sa-ucx"),
      JSON.stringify({
        id: "sa-ucx",
        rootSessionId: "root-session",
        agentName: "general-purpose",
        status: "closed",
        closedReason: "user-close",
        createdAt: 1000,
        completedAt: 2000,
        task: "gate b task",
        slug: "gate-b",
      }),
      "utf-8",
    );
    // manifest 缓存按 stat 戳读取，写入后直接查询即可（listAllSync 每次重 stat）
    const err = endedMessageGuard(restarted, "sa-ucx", new Error("subagent not found or not owned: sa-ucx"));
    expect(err.message).toContain("deliberately closed by user (closedReason: user-close)");
    expect(err.message).toContain("cannot be messaged or resumed");
    expect(err.message).not.toContain("ended but reconnectable");
  });
});
