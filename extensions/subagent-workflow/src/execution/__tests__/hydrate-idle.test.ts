// src/execution/__tests__/hydrate-idle.test.ts
//
// M3 G4 跨重启水合（P-6）+ toNotifyRecord idle 守卫。
//
// 验证场景 C（会话重启后恢复）：主 agent 重启后，内存 idle record 丢失，
// getRecordForAction 从磁盘 .idle sidecar 水合 idle record，message 续聊可用。
//
// 沿用 subagent-service-message-close.test.ts 的 mock 模式（真实 SubagentService +
// mock runSpawn + ServiceInternals cast 暴露 private 方法）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock logger（doFinalizeRecord manifest 写入降级路径用）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({ getLogger: () => loggerMock }));

// mock session-runner（import 链需要 runSpawn/killAllSpawnedChildren/getChildByRecord 存在）
vi.mock("../session-runner.ts", () => ({
  runSpawn: vi.fn(),
  killAllSpawnedChildren: vi.fn(),
  getChildByRecord: vi.fn(() => undefined),
}));

import { runSpawn } from "../session-runner.ts";
import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { BgNotifyRecord } from "../notifier.ts";
import { writeIdleMarker } from "../idle-marker.ts";
import { getSubagentSessionDir } from "../path-encoding.ts";
import { RecordStore } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import type { AgentResult, ExecutionRecord } from "../types.ts";

const mockRunSpawn = vi.mocked(runSpawn);

/**
 * env 隔离：父进程(pi)可能注入 PI_SUBAGENT_* env，污染 SubagentService.initSession 的
 * sessionRootId（→ env UUID 而非 init.sessionId）与 rootCwd（→ sessionsDir 编码 key 偏移）。
 * 水合测试需 sessionRootId="root-session" + sessionsDir=getSubagentSessionDir(agentDir, agentDir)
 * 可控，beforeEach save+delete、afterEach 恢复，保证本地(在 pi 内跑 vitest)与 CI 一致。
 */
const ENV_KEYS = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_ROOT_CWD",
  "PI_SUBAGENT_FORK_DEPTH",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hydrate-idle-"));
}

function makePi(): PiLike {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as PiLike;
}

function makeResult(success: boolean): AgentResult {
  return {
    text: success ? "done" : "err",
    turns: 1,
    durationMs: 100,
    success,
    error: success ? undefined : "boom",
    sessionId: "sess-1",
    toolCalls: [],
  };
}

/** 构造 chatMode background record（base running，over 覆盖）。 */
function makeRecord(overrides: Partial<ExecutionRecord> & { id?: string } = {}): ExecutionRecord {
  const { id = "sa-test", ...rest } = overrides;
  const r = createRecord(id, {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: "chat task",
    slug: "chat",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: true,
    controller: new AbortController(),
  });
  Object.assign(r, rest);
  return r;
}

/**
 * 写一个 idle record 的完整磁盘状态（session.jsonl + .idle sidecar，无 .alive）。
 * 模拟跨重启后磁盘上残留的对话模式 record：进程已回收（无 .alive），record 留 idle。
 */
function writeIdleSessionOnDisk(
  agentDir: string,
  id: string,
  rootSessionId: string,
  round: number,
): string {
  // sessionsDir 与 SubagentService 构造一致（rootCwd = cwd = agentDir，根进程）
  const sessionsDir = getSubagentSessionDir(agentDir, agentDir);
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, `${id}.jsonl`);

  const startedAt = 1000;
  const header = JSON.stringify({
    type: "session", version: 3, id: "sess-uuid",
    timestamp: new Date(startedAt).toISOString(), cwd: agentDir,
  });
  const identityEntry = JSON.stringify({
    type: "custom", id: "id-1", parentId: null,
    timestamp: new Date(startedAt).toISOString(),
    customType: "subagent-identity",
    data: {
      id, agent: "general-purpose", mode: "background",
      task: "chat task", slug: "chat", startedAt, rootSessionId, chatMode: true,
    },
  });
  const assistantMsg = JSON.stringify({
    type: "message", id: "msg-1", parentId: "id-1",
    timestamp: new Date(startedAt + 1000).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "round reply" }],
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
      stopReason: "stop",
      timestamp: startedAt + 1000,
    },
  });
  fs.writeFileSync(file, `${header}\n${identityEntry}\n${assistantMsg}\n`, "utf-8");
  writeIdleMarker(file, { id, sessionFile: file, rootSessionId, round });
  return file;
}

/** 暴露 store + toNotifyRecord 的私有访问接口（测试专用 cast）。 */
interface ServiceInternals {
  store: RecordStore;
  toNotifyRecord: (record: ExecutionRecord) => BgNotifyRecord | undefined;
}

// ============================================================
// 跨重启水合 idle record（G4 场景 C，P-6 探针）
// ============================================================
describe("跨重启水合 idle record（G4 场景 C，P-6）", () => {
  let agentDir: string;
  let modelService: ModelConfigService;
  let service: SubagentService;

  beforeEach(() => {
    // env 隔离（见文件顶部 ENV_KEYS 说明）
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    agentDir = makeTmpAgentDir();
    modelService = new ModelConfigService({ agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    mockRunSpawn.mockReset();
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    }
  });

  it("dispose + new service + initSession → getRecordForAction(id) 水合返回 idle record", () => {
    // 1. 模拟 service1 生命周期内产生的 idle record 落盘
    writeIdleSessionOnDisk(agentDir, "sa-hydrate", "root-session", 1);

    // 2. 模拟重启：dispose（内存清空）+ new service + initSession（新进程）
    service.dispose();
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });

    // 3. 跨重启 getRecordForAction → 走 hydrateIdleRecord（内存未命中 → 扫磁盘）
    const record = service.getRecordForAction("sa-hydrate");
    expect(record.status).toBe("idle");
    expect(record.sessionFile).toBeDefined();
    expect(record.round).toBe(1);
    expect(record.rootSessionId).toBe("root-session");
    expect(record.chatMode).toBe(true);
    expect(record.controller).toBeInstanceOf(AbortController); // 跨重启新建

    // 4. 水合后 register 进内存（后续 getRecordForAction 不再扫磁盘）
    const internals = service as unknown as ServiceInternals;
    expect(internals.store.getMutable("sa-hydrate")).toBe(record);
  });

  it("rootSessionId 不匹配 → throw not found or not owned（归属守卫跨重启生效）", () => {
    // 写一个属于 other-session 的 idle record
    writeIdleSessionOnDisk(agentDir, "sa-other", "different-session", 1);

    service.dispose();
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });

    // 水合扫到磁盘 record（id 匹配 + idle），但归属校验失败 → throw
    expect(() => service.getRecordForAction("sa-other")).toThrow(/not found or not owned/);
  });

  it("水合后 resumeRound 不 throw（controller 新建、sessionFile 有值、status idle）", () => {
    writeIdleSessionOnDisk(agentDir, "sa-resume", "root-session", 1);

    service.dispose();
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    mockRunSpawn.mockResolvedValueOnce(makeResult(true));

    const record = service.getRecordForAction("sa-resume");

    // resumeRound 同步段：校验 idle/sessionFile/controller → 设 running → kickOffBackground（detached）
    expect(() => service.resumeRound(record, "next message")).not.toThrow();
    expect(record.status).toBe("running"); // resumeRound 手动设回 running
  });

  it("内存已有 idle record 时 getRecordForAction 不扫磁盘（同进程直接命中）", () => {
    // 同进程内 idle record 已在内存（M2-A 不 archive），getRecordForAction 直接命中
    const record = makeRecord({ id: "sa-inmem", status: "idle", round: 1 });
    const internals = service as unknown as ServiceInternals;
    internals.store.register(record);

    // 不写磁盘（验证内存命中，非水合）
    const got = service.getRecordForAction("sa-inmem");
    expect(got).toBe(record); // 同一引用（内存命中，非水合新建）
  });
});

// ============================================================
// toNotifyRecord 守卫（M3：idle 放行 + round 透传，G1 决策 9）
// ============================================================
describe("toNotifyRecord 守卫（M3：idle 放行 + round 透传）", () => {
  let agentDir: string;
  let service: SubagentService;
  let internals: ServiceInternals;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    const modelService = new ModelConfigService({ agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    internals = service as unknown as ServiceInternals;
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("idle record → 返回 BgNotifyRecord（status=idle，round 透传）", () => {
    const record = makeRecord({ id: "sa-idle", status: "idle", round: 2, result: "round reply" });
    const result = internals.toNotifyRecord(record);
    expect(result).toBeDefined();
    expect(result!.status).toBe("idle");
    expect(result!.round).toBe(2); // round 透传给 notifier dedup key
    expect(result!.result).toBe("round reply");
  });

  it("done record → 返回 BgNotifyRecord（status=done，现有行为不变）", () => {
    const record = makeRecord({ id: "sa-done", status: "done", round: 0, result: "done" });
    const result = internals.toNotifyRecord(record);
    expect(result).toBeDefined();
    expect(result!.status).toBe("done");
  });

  it("running record → undefined（守卫拦截非终态/非 idle）", () => {
    const record = makeRecord({ id: "sa-running", status: "running" });
    expect(internals.toNotifyRecord(record)).toBeUndefined();
  });

  it("crashed record → undefined（守卫拦截）", () => {
    const record = makeRecord({ id: "sa-crashed", status: "crashed" });
    expect(internals.toNotifyRecord(record)).toBeUndefined();
  });
});
