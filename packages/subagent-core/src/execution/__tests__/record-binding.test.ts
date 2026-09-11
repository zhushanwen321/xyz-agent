// src/execution/__tests__/record-binding.test.ts
//
// [UF-1] 跨重启续聊绑定修复（U4 真机基线 S6 ❌）：record↔sessionFile 映射落盘与消费。
//
// 缺陷背景：engine-CLI 化后子 session 文件只含 {session, model_change,
// thinking_level_change, message} 条目族（无身份 entry），旧
// PI_SUBAGENT_SELF_RECORD_ID 注入链消失 → collectRecords/findLightById 失去
// id→file 工件 → 跨重启 message 一律「not found or not owned」（展示层 entry
// 扫描源可见 3 条 record、message 链全部 not-found 的双注册表不同源形态）。
//
// 修复面（本套件锁定）：
//   ① 写入：sessionFile 回填点（轮应答 / idle 帧锚点 / run 域 outcome）经
//      writeBindingForRecord 落 `<sessionFile>.record-binding`（best-effort，
//      写失败 warn 不阻断派发主路径）；
//   ② 消费：record-store scanFile 在 identity miss 时据绑定重建 light record
//      （模拟重启后空内存），findLightById/collectRecords 恢复 id→file 解析；
//   ③ 全链：getRecordForAction（coldLookupForAction）→ 绑定重建 → register →
//      deliverChatMessage 续聊发起（resume 锚点续写原文件）；
//   ④ 终态不冲突：.state 优先级高于绑定的 running 形态（buildRecord 既有分支
//      矩阵构造性保证）；终态后绑定保留（resurrect 回边删 .state 后绑定仍在，
//      再崩溃仍可恢复）——保留选项由此套件锁定；
//   ⑤ 绑定写失败（只读目录）不阻塞派发主路径。
//
// fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { clearEngines } from "../engine/registry.ts";
import { _resetCoreSpawnedChildrenMirrorForTest } from "../engine/host/spawned-children.ts";
import { createRecord } from "../execution-record.ts";
import { _resetLifecycleState } from "../lifecycle-manager.ts";
import { getSubagentSessionDir } from "../path-encoding.ts";
import { RecordStore } from "../record-store.ts";
import { _resetSettledWatchdogsForTest } from "../settled-watchdog.ts";
import {
  readRecordBinding,
  writeFinalizedState,
  writeRecordBinding,
  RECORD_BINDING_SIDECAR_EXT,
} from "../state-marker.ts";
import type { RecordBinding } from "../state-marker.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import type { ExecutionRecord } from "../types.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { ModelConfigService } from "../model-config-service.ts";

// 身份 env 清理（同 get-record-for-action-restart.test.ts：测试进程可能继承
// subagent env，污染 rootCwd 编码目录与 sessionRootId 基线）。
const IDENTITY_ENV_KEYS = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_ROOT_CWD",
  "PI_SUBAGENT_FORK_DEPTH",
] as const;

const STARTED_AT = 1_700_000_000_000;

/** engine-CLI 化子 session 文件 fixture：{session, message} 条目族，无身份 entry。 */
function writePlainChildSession(sessionsDir: string): string {
  const file = path.join(sessionsDir, "20260910T000000-000_sa-bind-1.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "sess-child",
      timestamp: new Date(STARTED_AT).toISOString(),
      cwd: "/tmp",
    }),
    JSON.stringify({
      type: "message",
      id: "msg-1",
      parentId: null,
      timestamp: new Date(STARTED_AT + 1000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first round done" }],
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        timestamp: STARTED_AT + 1000,
      },
    }),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
  return file;
}

/** 绑定 sidecar fixture（经真实写函数落盘）。 */
function writeBindingFixture(file: string, overrides: Partial<RecordBinding> = {}): void {
  writeRecordBinding(file, {
    v: 1,
    recordId: "sa-bind-1",
    rootSessionId: "root-session",
    parentRecordId: undefined,
    depth: 0,
    agent: "general-purpose",
    task: "binding task",
    slug: "bind-test",
    mode: "background",
    startedAt: STARTED_AT,
    chatMode: true,
    round: 1,
    model: "prov/model-1",
    thinkingLevel: undefined,
    worktree: false,
    ...overrides,
  });
}

// ============================================================
// A. state-marker 绑定读写单元
// ============================================================

describe("[UF-1] record 绑定 sidecar 读写（state-marker）", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-binding-unit-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("原子写落盘 + 读回 roundtrip（载荷含 recordId/rootSessionId/chatMode/round/startedAt）；无 tmp 残留", () => {
    const sessionFile = path.join(dir, "child.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    writeBindingFixture(sessionFile);

    const target = `${sessionFile}${RECORD_BINDING_SIDECAR_EXT}`;
    expect(fs.existsSync(target)).toBe(true);
    // 原子写收口：tmp 中间产物不残留
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);

    const binding = readRecordBinding(sessionFile);
    expect(binding).toMatchObject({
      v: 1,
      recordId: "sa-bind-1",
      rootSessionId: "root-session",
      chatMode: true,
      round: 1,
      startedAt: STARTED_AT,
      agent: "general-purpose",
      task: "binding task",
      mode: "background",
      worktree: false,
    });
  });

  it("损坏载荷拒绝重建：JSON 残缺 / 关键身份域缺失 / 版本不识别 / 文件缺失 → undefined", () => {
    const sessionFile = path.join(dir, "child.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    expect(readRecordBinding(sessionFile)).toBeUndefined(); // 文件缺失

    fs.writeFileSync(`${sessionFile}${RECORD_BINDING_SIDECAR_EXT}`, "{not json", "utf-8");
    expect(readRecordBinding(sessionFile)).toBeUndefined(); // JSON 损坏

    fs.writeFileSync(
      `${sessionFile}${RECORD_BINDING_SIDECAR_EXT}`,
      JSON.stringify({ v: 1, agent: "a", task: "t", mode: "background", startedAt: 1 }),
      "utf-8",
    );
    expect(readRecordBinding(sessionFile)).toBeUndefined(); // recordId 缺失

    fs.writeFileSync(
      `${sessionFile}${RECORD_BINDING_SIDECAR_EXT}`,
      JSON.stringify({ v: 2, recordId: "sa-x", agent: "a", task: "t", mode: "background", startedAt: 1 }),
      "utf-8",
    );
    expect(readRecordBinding(sessionFile)).toBeUndefined(); // 版本不识别
  });

  it("写失败只 warn 不抛（只读目录）", () => {
    const roDir = path.join(dir, "ro");
    fs.mkdirSync(roDir, { recursive: true });
    fs.chmodSync(roDir, 0o555);
    try {
      expect(() => writeBindingFixture(path.join(roDir, "child.jsonl"))).not.toThrow();
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining("record binding write failed"),
        expect.objectContaining({ detail: expect.objectContaining({ sessionFile: path.join(roDir, "child.jsonl") }) }),
      );
    } finally {
      fs.chmodSync(roDir, 0o755);
    }
  });
});

// ============================================================
// B. record-store 消费面（模拟重启后空内存）
// ============================================================

describe("[UF-1] record-store 据绑定 sidecar 重建（跨重启空内存场景）", () => {
  let agentDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-binding-store-"));
    sessionsDir = getSubagentSessionDir(agentDir, agentDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    // maxRetries：扫描尾 fire-and-forget sessions-index 写可能与删除并发
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("collectRecords：无 identity 子文件 + 绑定 → 重建 running light（id/rootSessionId/chatMode/round/sessionFile）", () => {
    const file = writePlainChildSession(sessionsDir);
    writeBindingFixture(file);
    const store = new RecordStore(sessionsDir);

    const records = store.collectRecords(10, "all", undefined);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.id).toBe("sa-bind-1");
    expect(rec.status).toBe("running"); // v4 B-1 跨重启可续聊语义（无 .state → 分支 4）
    expect(rec.rootSessionId).toBe("root-session");
    expect(rec.chatMode).toBe(true);
    expect(rec.round).toBe(1);
    expect(rec.sessionFile).toBe(file);
    expect(rec.agent).toBe("general-purpose");
    expect(rec.task).toBe("binding task");
  });

  it("findLightById：冷启动空索引先 miss → collectRecords 全扫填充 → 索引命中（coldLookup 步骤 1 链）", () => {
    const file = writePlainChildSession(sessionsDir);
    writeBindingFixture(file);
    const store = new RecordStore(sessionsDir);

    // 重启后 idToFile 未热：直查 miss
    expect(store.findLightById("sa-bind-1")).toBeUndefined();
    // 全扫兜底命中并填充 idToFile 索引
    expect(store.collectRecords(10, "all", undefined).map((r) => r.id)).toContain("sa-bind-1");
    // 索引回暖：后续直查命中（把跨重启每条 message 一次全扫降为 O(1)）
    const light = store.findLightById("sa-bind-1");
    expect(light?.id).toBe("sa-bind-1");
    expect(light?.sessionFile).toBe(file);
    expect(light?.status).toBe("running");
  });

  it("rootSessionId 过滤仍生效：异树过滤排除绑定 record（session 隔离不因绑定旁路）", () => {
    const file = writePlainChildSession(sessionsDir);
    writeBindingFixture(file);
    const store = new RecordStore(sessionsDir);

    expect(store.collectRecords(10, "all", "other-root")).toHaveLength(0);
    expect(store.collectRecords(10, "all", "root-session")).toHaveLength(1);
  });

  it("终态优先级：绑定 + .state(finalized) → closed/gc（.state 胜过绑定的 running 形态）；绑定保留在盘", () => {
    const file = writePlainChildSession(sessionsDir);
    writeBindingFixture(file);
    writeFinalizedState(file, "gc");
    const store = new RecordStore(sessionsDir);

    const records = store.collectRecords(10, "all", undefined);
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("closed");
    expect(records[0]!.closedReason).toBe("gc");
    // 保留选项锁定：终态后绑定不删——resurrect 回边删 .state 后绑定仍在，再崩溃仍可恢复
    expect(fs.existsSync(`${file}${RECORD_BINDING_SIDECAR_EXT}`)).toBe(true);
  });

  it("负缓存打破：先仅子文件（无绑定）扫描为空 → 绑定后到落盘 → 再次扫描命中", () => {
    const file = writePlainChildSession(sessionsDir);
    const store = new RecordStore(sessionsDir);
    expect(store.collectRecords(10, "all", undefined)).toHaveLength(0); // 无身份无绑定 → 负缓存

    writeBindingFixture(file); // run 应答回填点后到：绑定戳变化
    const records = store.collectRecords(10, "all", undefined);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe("sa-bind-1");
  });

  it("无 identity 无绑定 → 不重建（负缓存语义保持，不误建幽灵 record）", () => {
    writePlainChildSession(sessionsDir);
    const store = new RecordStore(sessionsDir);
    expect(store.collectRecords(10, "all", undefined)).toHaveLength(0);
    expect(store.findLightById("sa-bind-1")).toBeUndefined();
  });
});

// ============================================================
// C. SubagentService 集成（写入点 + 跨重启全链）
// ============================================================

function makePi(): PiLike {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as PiLike;
}

interface ServiceInternals {
  store: RecordStore;
}

/** chatMode 续聊 record（首轮已完成、等待续聊；sessionFile 预置在指定目录）。 */
function makeChatRecord(id: string, sessionFile: string): ExecutionRecord {
  const record = createRecord(id, {
    agent: "general-purpose",
    model: "prov/model-1",
    thinkingLevel: "low",
    mode: "background",
    task: "initial task",
    slug: "cont",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: true,
    controller: new AbortController(),
  });
  record.status = "running";
  record.round = 1;
  record.sessionFile = sessionFile;
  fs.writeFileSync(sessionFile, "{}\n", "utf-8");
  return record;
}

describe("[UF-1] SubagentService 集成：回填点绑定落盘 + 跨重启 message 链", () => {
  let agentDir: string;
  let sessionsDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let fake: FakePiEnginePort;
  let readOnlyDir: string | undefined;

  beforeEach(() => {
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-binding-svc-"));
    sessionsDir = getSubagentSessionDir(agentDir, agentDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
    clearEngines();
    fake = registerFakePiEngine();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    store = (service as unknown as ServiceInternals).store;
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    // 只读目录先恢复权限再删（⑤用例的绑定写失败面）
    if (readOnlyDir !== undefined) {
      fs.chmodSync(readOnlyDir, 0o755);
      readOnlyDir = undefined;
    }
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
  });

  it("① chat 轮 run 应答回填点触发绑定落盘：载荷 = recordId/rootSessionId/chatMode/round 快照", async () => {
    const sessionFile = path.join(agentDir, "sa-bind-live-session.jsonl");
    const record = makeChatRecord("sa-bind-live", sessionFile);
    store.register(record);

    await service.chatActions.deliverChatMessage(record, "second round");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.settle({ content: "second round reply", sessionFile });

    // 轮应答（= L2797 回填点）后绑定在盘，身份域与 record 对齐
    await vi.waitFor(() => expect(fs.existsSync(`${sessionFile}${RECORD_BINDING_SIDECAR_EXT}`)).toBe(true));
    const binding = readRecordBinding(sessionFile);
    expect(binding).toMatchObject({
      v: 1,
      recordId: "sa-bind-live",
      rootSessionId: "root-session",
      chatMode: true,
      // 绑定写点在轮终 round+1 之前——写点时点快照（round 滞后一拍为已登记语义）
      round: 1,
      agent: "general-purpose",
      model: "prov/model-1",
    });
    // 轮正常收口（绑定写不影响派发主路径）
    await vi.waitFor(() => expect(record.round).toBe(2));
    expect(record.status).toBe("running");
  });

  it("⑤ 绑定写失败（只读目录）不阻塞派发主路径：轮正常 settle，仅 warn", async () => {
    readOnlyDir = path.join(agentDir, "ro-binding");
    fs.mkdirSync(readOnlyDir, { recursive: true });
    const sessionFile = path.join(readOnlyDir, "sa-bind-ro-session.jsonl");
    const record = makeChatRecord("sa-bind-ro", sessionFile); // makeChatRecord 内部落 sessionFile（此刻目录仍可写）
    fs.chmodSync(readOnlyDir, 0o555); // 轮应答（绑定写点）前锁只读——写失败面就位
    store.register(record);

    await service.chatActions.deliverChatMessage(record, "round on read-only dir");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.settle({ content: "reply", sessionFile });

    // 主路径不受影响：回填推进 + 轮终收口照常
    await vi.waitFor(() => expect(record.round).toBe(2));
    expect(record.sessionFile).toBe(sessionFile);
    // 记账面如实留痕：绑定缺失 + warn
    expect(fs.existsSync(`${sessionFile}${RECORD_BINDING_SIDECAR_EXT}`)).toBe(false);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("record binding write failed"),
      expect.anything(),
    );
  });

  it("③ 跨重启全链：绑定 fixture → getRecordForAction 重建 register → deliverChatMessage 续写原文件", async () => {
    const file = writePlainChildSession(sessionsDir);
    writeBindingFixture(file, { recordId: "sa-bind-1", rootSessionId: "root-session" });

    // 重启形态：内存空，冷查链（findLightById miss → collectRecords 绑定重建）命中
    const record = service.chatActions.getRecordForAction("sa-bind-1");
    expect(record.chatMode).toBe(true);
    expect(record.sessionFile).toBe(file);
    expect(record.rootSessionId).toBe("root-session");
    expect(record.status).toBe("running");
    expect(store.getMutable("sa-bind-1")).toBe(record); // register 生效

    // 可 message：续聊 run 以原 sessionFile 为 resume 锚点（续写原文件）。
    // chat 会话形态参数挂在 RunContext（协议 run.params.chat 的承载位），非 task。
    await service.chatActions.deliverChatMessage(record, "resume after restart");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    const chatParams = fake.runs[0]!.ctx.resume;
    expect(chatParams?.resume?.sessionRef["sessionFile"]).toBe(file);
    expect(chatParams?.recordId).toBe("sa-bind-1");
  });

  it("④ service 面终态不冲突：绑定 + .state(closed) → getRecordForAction 仍拒（终态单向语义保持）", () => {
    const file = writePlainChildSession(sessionsDir);
    writeBindingFixture(file);
    writeFinalizedState(file, "gc");

    expect(() => service.chatActions.getRecordForAction("sa-bind-1")).toThrow(/not found or not owned/);
    expect(store.getMutable("sa-bind-1")).toBeUndefined(); // 绑定不越权复活终态 record
  });
});
