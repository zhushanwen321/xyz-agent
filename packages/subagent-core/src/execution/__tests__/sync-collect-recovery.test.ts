// src/execution/__tests__/sync-collect-recovery.test.ts
//
// U5 崩溃恢复钩子（E1）+ dispose 转换（E9）的真实文件通路测试（subagent-sync-collect
// 设计 §3.1.5）。
//
// 通路保真（U8 红线：禁 mock record 断言）：
//   种子 entry 经真实 RecordStore.reportSubagentRecord → toSubagentRecordEntry 序列化
//   → 真实 appendFileSync 落 tmpdir 主 session JSONL → 恢复侧真实 readFileSync 扫描
//   （scanLastRecordEntries → collectLastRecordEntries + rebuildEntryRecord 投影）。
//   断言全部打在「磁盘文件内容 + 真实投影产物」上，scan/投影/序列化三层零 mock。
//
// 场景：
//   1. 标记与终态五字段可见性：collectMode/batchFinalized/status/endedAt/closedReason/
//      result/error 经末条 entry 重建后全部可见（rebuildEntryRecord 投影白名单扩展）；
//   2. E1 补发：崩溃残留（全员终态 + 无标记）→ notifyBatch 单批补发（内容 = 末条终态
//      快照）+ 统一落标；async 成员 / 已标记成员（E9 排除）/ 异根成员均不入批；
//   3. E1 幂等窗口：账本同 hash 拒绝（accepted=false）也统一补标 → 标记落盘后二次
//      恢复零补发（收敛）；
//   4. E1 仍有 running：不补发，等自然终态；
//   5. E9 dispose：缓冲中已终态成员逐条转 async notify（放弃攒批）+ 落标；在跑成员
//      走现有退出路径（不通知）；
//   6. U4 deviation #8 接线：notifyBatch 收到 config 热读的 budget 参数。
//
// mock 手法对齐 collect-coordinator-service.test.ts：mock session-runner（不 spawn 真子
// 进程）+ logger；record-store / config 走真实实现（tmpdir 自建自删，红线）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock, runSpawnMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  runSpawnMock: vi.fn(async () => ({
    text: "ok",
    turns: 1,
    durationMs: 10,
    success: true,
    sessionId: "spawned",
    toolCalls: [],
  })),
}));
vi.mock("../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// mock session-runner：execute 链经 kickOffBackground → runAndFinalize → runSpawn。
// 路径从 __tests__ 解析必须命中真实模块（src/execution/session-runner.ts）——
// 相对路径错一层拦截就静默失效（U2 教训，见 collect-coordinator-service.test.ts）。
vi.mock("../session-runner.ts", () => ({
  runSpawn: runSpawnMock,
  killAllSpawnedChildren: vi.fn(),
  killRecordChildWithEscalation: vi.fn(),
  getChildByRecord: vi.fn(() => undefined),
  spawnedChildren: new Map(),
}));

import { SUBAGENT_RECORD_CUSTOM_TYPE } from "../record-entry.ts";
import { ManifestStore } from "../manifest-store.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelRegistryLike } from "../model-resolver.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "../path-encoding.ts";
import { RecordStore } from "../record-store.ts";
import type { SubagentRecord } from "../types.ts";
import { SubagentService } from "../subagent-service.ts";

/** 剥身份/relay env：身份 env 会让 service 误判自己是子进程（跳过恢复扫描），
 *  relay env 属 pi-invocation/relay-env 存量测试的敏感面（测试纪律：env 剥离）。 */
const ENV_KEYS_TO_STRIP = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_ROOT_CWD",
  "PI_SUBAGENT_FORK_DEPTH",
  "XYZ_SUBAGENT_RELAY_SOCKET",
  "XYZ_SUBAGENT_RELAY_NODE",
  "XYZ_SUBAGENT_RELAY_SCRIPT",
] as const;

const ROOT_SESSION = "root-session-crash";

/** 种子 pi：appendEntry 真写主 session JSONL（每 entry 一行，pi 落盘形态）。 */
function makeWritingPi(mainFile: string) {
  return {
    appendEntry: vi.fn((customType: string, data: unknown) => {
      fs.appendFileSync(
        mainFile,
        `${JSON.stringify({
          type: "custom",
          id: `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          parentId: null,
          timestamp: new Date().toISOString(),
          customType,
          data,
        })}\n`,
        "utf-8",
      );
    }),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
    on: vi.fn(),
  };
}

/** 断言 pi：appendEntry 只记录不落盘（断言恢复侧写点用）。 */
function makeAssertPi() {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
    on: vi.fn(),
  };
}

type AssertPi = ReturnType<typeof makeAssertPi>;

interface NotifierSpy {
  notify: ReturnType<typeof vi.fn>;
  notifyBatch: ReturnType<typeof vi.fn>;
}

function spyNotifier(service: SubagentService): NotifierSpy {
  const original = (service as unknown as { notifier: object }).notifier;
  const spy: NotifierSpy = { notify: vi.fn(), notifyBatch: vi.fn(() => true) };
  (service as unknown as { notifier: unknown }).notifier = {
    ...original,
    notify: spy.notify,
    notifyBatch: spy.notifyBatch,
  };
  return spy;
}

/** 手写短轮询（真实 timers）——vi.waitFor 在 vitest 4.1.8 本包环境对 falsy callback
 *  立即 resolve 不轮询（见 collect-coordinator-service.test.ts 同款说明）。 */
async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`sync-collect-recovery: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 种子成员 record（真实 reportSubagentRecord 入参——序列化/落盘/扫描三层真实）。 */
function memberRecord(overrides: Partial<SubagentRecord> & { id: string }): SubagentRecord {
  return {
    agent: "/agents/worker.md",
    task: "seed task",
    slug: "seed",
    status: "running",
    mode: "background",
    startedAt: 1000,
    rootSessionId: ROOT_SESSION,
    parentRecordId: undefined,
    depth: 0,
    endedAt: undefined,
    turns: 0,
    totalTokens: 0,
    model: "prov/m1",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    result: undefined,
    error: undefined,
    sessionFile: undefined,
    chatMode: false,
    collectMode: "sync",
    ...overrides,
  };
}

describe("sync collect recovery (U5 E1/E9) — 真实文件通路", () => {
  let agentDir: string;
  let mainFile: string;

  beforeEach(() => {
    for (const k of ENV_KEYS_TO_STRIP) delete process.env[k];
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-sync-recovery-"));
    fs.mkdirSync(getSubagentSessionDir(agentDir, agentDir), { recursive: true });
    mainFile = path.join(agentDir, "main-session.jsonl");
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  /** 种子 store：真实 RecordStore + 写文件 pi（种子经真实 toSubagentRecordEntry 序列化）。 */
  function makeSeedStore(): RecordStore {
    return new RecordStore(
      getSubagentSessionDir(agentDir, agentDir),
      new ManifestStore(getSubagentRecordsDir(agentDir, agentDir)),
      makeWritingPi(mainFile),
    );
  }

  /** 恢复侧 service（断言 pi，不写文件）。 */
  function makeRecoveryService(pi: AssertPi): SubagentService {
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    const modelRegistry: ModelRegistryLike = {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    };
    modelService.initModel({
      sessionId: ROOT_SESSION,
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
      modelRegistry,
    });
    const service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi, sessionId: ROOT_SESSION, mainSessionFile: mainFile });
    return service;
  }

  /** 读回主文件每 id 末条 entry data（断言文件真实内容用）。 */
  function readMainFileLastEntries(): Map<string, Record<string, unknown>> {
    const lastById = new Map<string, Record<string, unknown>>();
    for (const line of fs.readFileSync(mainFile, "utf-8").split("\n")) {
      if (!line.includes(SUBAGENT_RECORD_CUSTOM_TYPE) || line.trim() === "") continue;
      const obj = JSON.parse(line) as { customType?: string; data?: { id?: string } };
      if (obj.customType === SUBAGENT_RECORD_CUSTOM_TYPE && typeof obj.data?.id === "string") {
        lastById.set(obj.data.id, obj.data as Record<string, unknown>);
      }
    }
    return lastById;
  }

  it("标记与终态五字段经真实落盘→扫描投影后可见（rebuildEntryRecord 白名单扩展）", () => {
    const store = makeSeedStore();
    // 成员 A：register（running+sync）→ 终态（closed + gc + result）两笔真实 entry
    store.reportSubagentRecord(memberRecord({ id: "sa-a" }));
    store.reportSubagentRecord(
      memberRecord({
        id: "sa-a",
        status: "closed",
        closedReason: "gc",
        endedAt: 2000,
        result: "done-A",
      }),
    );
    // 成员 B：failed 终态（error 字段）
    store.reportSubagentRecord(memberRecord({ id: "sa-b" }));
    store.reportSubagentRecord(
      memberRecord({ id: "sa-b", status: "closed", closedReason: "gc", endedAt: 3000, error: "boom" }),
    );
    // 成员 C：已落标（batchFinalized，E9/flush 后形态）
    store.reportSubagentRecord(
      memberRecord({ id: "sa-c", status: "closed", closedReason: "gc", endedAt: 4000, batchFinalized: true }),
    );
    // 成员 D：async（无 collectMode）终态
    store.reportSubagentRecord(
      memberRecord({ id: "sa-d", status: "closed", closedReason: "gc", endedAt: 5000, collectMode: undefined }),
    );

    // 恢复侧：真实 readFileSync 扫描 + 投影（零 mock；store 经测试后门访问，与
    // collect-coordinator-service.test.ts 访问 notifier 同款手法）
    const recovery = makeRecoveryService(makeAssertPi());
    const scanned = (recovery as unknown as { store: RecordStore }).store.scanLastRecordEntries(mainFile);
    const byId = new Map(scanned.map((r) => [r.id, r]));

    // 终态五字段 + 两标记字段全可见（末条 last-writer-wins）
    const a = byId.get("sa-a");
    expect(a).toBeDefined();
    expect(a!.status).toBe("closed");
    expect(a!.endedAt).toBe(2000);
    expect(a!.closedReason).toBe("gc");
    expect(a!.result).toBe("done-A");
    expect(a!.error).toBeUndefined();
    expect(a!.collectMode).toBe("sync");
    expect(a!.batchFinalized).toBeUndefined();

    const b = byId.get("sa-b");
    expect(b!.error).toBe("boom");
    expect(b!.result).toBeUndefined();

    expect(byId.get("sa-c")!.batchFinalized).toBe(true);
    expect(byId.get("sa-d")!.collectMode).toBeUndefined();
  });

  it("E1 补发：全员终态无标记 → notifyBatch 单批（末条终态快照）+ 统一落标；async/已标记/异根排除", () => {
    const store = makeSeedStore();
    store.reportSubagentRecord(memberRecord({ id: "sa-a" }));
    store.reportSubagentRecord(
      memberRecord({ id: "sa-a", status: "closed", closedReason: "gc", endedAt: 2000, result: "done-A" }),
    );
    store.reportSubagentRecord(memberRecord({ id: "sa-b" }));
    store.reportSubagentRecord(
      memberRecord({ id: "sa-b", status: "closed", closedReason: "gc", endedAt: 3000, error: "boom" }),
    );
    // 排除面 1：async 终态成员不入批
    store.reportSubagentRecord(
      memberRecord({ id: "sa-async", status: "closed", closedReason: "gc", endedAt: 4000, collectMode: undefined }),
    );
    // 排除面 2：已标记成员（E9 转换后重启形态）不入批
    store.reportSubagentRecord(
      memberRecord({ id: "sa-marked", status: "closed", closedReason: "gc", endedAt: 5000, batchFinalized: true }),
    );
    // 排除面 3：异根成员不入批
    store.reportSubagentRecord(
      memberRecord({ id: "sa-foreign", status: "closed", closedReason: "gc", endedAt: 6000, rootSessionId: "other-root" }),
    );

    const pi = makeAssertPi();
    const recovery = makeRecoveryService(pi);
    const spy = spyNotifier(recovery);
    recovery.recoverSyncCollectBatch();

    // 单批补发：只有 sa-a / sa-b 入批，内容 = 末条终态快照
    expect(spy.notifyBatch).toHaveBeenCalledTimes(1);
    const batch = spy.notifyBatch.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(batch.map((m) => m.id).sort()).toEqual(["sa-a", "sa-b"]);
    const a = batch.find((m) => m.id === "sa-a")!;
    expect(a.status).toBe("closed");
    expect(a.result).toBe("done-A");
    expect(a.closedReason).toBe("gc");
    const b = batch.find((m) => m.id === "sa-b")!;
    expect(b.error).toBe("boom");
    // 单条 notify 零调用（补发形态是批，不是逐条）
    expect(spy.notify).not.toHaveBeenCalled();

    // 统一落标：两成员各一笔 batchFinalized entry（appendEntry 直投影，含终态快照）
    const marks = pi.appendEntry.mock.calls
      .filter((c) => c[0] === SUBAGENT_RECORD_CUSTOM_TYPE)
      .map((c) => c[1] as Record<string, unknown>)
      .filter((d) => d.batchFinalized === true);
    expect(marks.map((m) => m.id).sort()).toEqual(["sa-a", "sa-b"]);
  });

  it("E1 幂等窗口：账本同 hash 拒绝（accepted=false）也统一补标 → 标记落盘后二次恢复零补发", () => {
    const store = makeSeedStore();
    store.reportSubagentRecord(memberRecord({ id: "sa-a" }));
    store.reportSubagentRecord(
      memberRecord({ id: "sa-a", status: "closed", closedReason: "gc", endedAt: 2000, result: "done-A" }),
    );

    // 第一次恢复：notifyBatch 返回 false（模拟「批闭合写账成功、落标前崩溃」后账本已在该批）
    const pi1 = makeAssertPi();
    const first = makeRecoveryService(pi1);
    const spy1 = spyNotifier(first);
    spy1.notifyBatch.mockReturnValue(false);
    first.recoverSyncCollectBatch();
    expect(spy1.notifyBatch).toHaveBeenCalledTimes(1);
    // 账本拒绝也算已投递 → 仍统一补标
    const marks1 = pi1.appendEntry.mock.calls
      .filter((c) => c[0] === SUBAGENT_RECORD_CUSTOM_TYPE)
      .map((c) => c[1] as Record<string, unknown>)
      .filter((d) => d.batchFinalized === true);
    expect(marks1.map((m) => m.id)).toEqual(["sa-a"]);

    // 标记真实落盘（写文件 pi 把补标 entry 追加进主文件——flush 后形态）
    const seedForMark = makeSeedStore();
    seedForMark.reportSubagentRecord(
      memberRecord({ id: "sa-a", status: "closed", closedReason: "gc", endedAt: 2000, result: "done-A", batchFinalized: true }),
    );

    // 第二次恢复：全员已标记 → 零补发零 notify（收敛，无振荡）
    const second = makeRecoveryService(makeAssertPi());
    const spy2 = spyNotifier(second);
    second.recoverSyncCollectBatch();
    expect(spy2.notifyBatch).not.toHaveBeenCalled();
    expect(spy2.notify).not.toHaveBeenCalled();
  });

  it("E1 仍有 running 成员：不补发不落标（等自然终态走正常流）", () => {
    const store = makeSeedStore();
    store.reportSubagentRecord(memberRecord({ id: "sa-a" }));
    store.reportSubagentRecord(
      memberRecord({ id: "sa-a", status: "closed", closedReason: "gc", endedAt: 2000, result: "done-A" }),
    );
    // 在跑成员：末条 running（子进程活到重启后的形态）
    store.reportSubagentRecord(memberRecord({ id: "sa-running" }));

    const pi = makeAssertPi();
    const recovery = makeRecoveryService(pi);
    const spy = spyNotifier(recovery);
    recovery.recoverSyncCollectBatch();

    expect(spy.notifyBatch).not.toHaveBeenCalled();
    expect(spy.notify).not.toHaveBeenCalled();
    expect(
      pi.appendEntry.mock.calls
        .filter((c) => c[0] === SUBAGENT_RECORD_CUSTOM_TYPE)
        .map((c) => c[1] as Record<string, unknown>)
        .some((d) => d.batchFinalized === true),
    ).toBe(false);
  });

  it("E9 dispose：缓冲终态成员逐条转 async notify + 落标；在跑成员走现有退出路径（不通知）", async () => {
    // 复用 execute 真链：成员 1 受控终态（入缓冲后批因成员 2 在跑不闭合），成员 2 悬置 running
    let resolve1!: (v: { text: string; turns: number; durationMs: number; success: boolean; sessionId: string; toolCalls: [] }) => void;
    runSpawnMock.mockImplementationOnce(() => new Promise((res) => { resolve1 = res; }));
    runSpawnMock.mockImplementationOnce(() => new Promise(() => { /* 悬置到 dispose */ }));
    const pi = makeAssertPi();
    const service = makeRecoveryService(pi);
    const spy = spyNotifier(service);
    const h1 = await service.execute({ task: "terminal one", slug: "one", collect: "sync" });
    await service.execute({ task: "running two", slug: "two", collect: "sync" });
    await until(() => runSpawnMock.mock.calls.length >= 2);

    // 成员 1 子文件就位（E9 落标 getFullRecord 冷路径数据源）
    const sessionsDir = getSubagentSessionDir(agentDir, agentDir);
    const ts = new Date(1000).toISOString();
    fs.writeFileSync(
      path.join(sessionsDir, `${h1.subagentId}.jsonl`),
      `${JSON.stringify({ type: "session", version: 3, id: `sess-${h1.subagentId}`, timestamp: ts, cwd: agentDir })}\n` +
        JSON.stringify({
          type: "custom", id: "id-1", parentId: null, timestamp: ts,
          customType: "subagent-identity",
          data: { id: h1.subagentId, agent: "/agents/worker.md", mode: "background", task: "terminal one", startedAt: 1000, rootSessionId: ROOT_SESSION, depth: 0 },
        }) + "\n" +
        JSON.stringify({
          type: "custom", id: "id-2", parentId: "id-1", timestamp: ts,
          customType: "subagent-record",
          data: {
            v: 1, id: h1.subagentId, agent: "/agents/worker.md", task: "terminal one", slug: "one",
            status: "closed", mode: "background", startedAt: 1000, rootSessionId: ROOT_SESSION,
            depth: 0, endedAt: 2000, turns: 1, totalTokens: 10, model: "prov/m1",
            eventLog: [], displayItems: [], result: "ok-terminal",
          },
        }) + "\n",
      "utf-8",
    );

    // 成员 1 终态：入缓冲，成员 2 在跑 → 批不闭合（零批投递）
    resolve1({ text: "ok-terminal", turns: 1, durationMs: 10, success: true, sessionId: "spawned", toolCalls: [] });
    await until(() => spy.notify.mock.calls.length + spy.notifyBatch.mock.calls.length > 0 || runSpawnMock.mock.calls.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 50)); // microtask 链排空
    expect(spy.notifyBatch).not.toHaveBeenCalled();

    // dispose（E9）：成员 1 逐条转 async 写账 + 落标；成员 2 不通知（现有退出路径）
    service.dispose();
    expect(spy.notify).toHaveBeenCalledTimes(1);
    expect(spy.notify.mock.calls[0]![0]).toMatchObject({ id: h1.subagentId, status: "closed" });
    expect(spy.notifyBatch).not.toHaveBeenCalled(); // 放弃攒批
    const marks = pi.appendEntry.mock.calls
      .filter((c) => c[0] === SUBAGENT_RECORD_CUSTOM_TYPE)
      .map((c) => c[1] as Record<string, unknown>)
      .filter((d) => d.batchFinalized === true);
    expect(marks.map((m) => m.id)).toEqual([h1.subagentId]);
    expect(marks[0]!.collectMode).toBe("sync");
    expect(marks[0]!.result).toBe("ok-terminal");
  });

  it("U4 deviation #8 接线：config collectSync 预算热读传入 notifyBatch budget 参数", () => {
    const store = makeSeedStore();
    store.reportSubagentRecord(memberRecord({ id: "sa-a" }));
    store.reportSubagentRecord(
      memberRecord({ id: "sa-a", status: "closed", closedReason: "gc", endedAt: 2000, result: "done-A" }),
    );
    // 写 config（collectSync 预算字段）+ reload —— 与 getCollectSyncDefault 同款访问链
    const configPath = path.join(agentDir, "subagents", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: 1, maxConcurrent: 6, collectSync: { default: "sync", perItemChars: 1234, totalChars: 5678 } }),
      "utf-8",
    );

    const pi = makeAssertPi();
    const recovery = makeRecoveryService(pi);
    const modelService = (recovery as unknown as { modelService: ModelConfigService }).modelService;
    modelService.reloadGlobalConfig();
    const spy = spyNotifier(recovery);
    recovery.recoverSyncCollectBatch();

    expect(spy.notifyBatch).toHaveBeenCalledTimes(1);
    expect(spy.notifyBatch.mock.calls[0]![1]).toEqual({ perItemChars: 1234, totalChars: 5678 });

    // 文件末条确为无标记终态（本用例的数据前提自检）
    const last = readMainFileLastEntries().get("sa-a");
    expect(last!.batchFinalized).toBeUndefined();
  });
});
