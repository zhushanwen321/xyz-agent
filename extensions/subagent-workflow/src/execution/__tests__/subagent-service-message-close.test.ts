// src/execution/__tests__/subagent-service-message-close.test.ts
//
// M2-B3 service 层：getRecordForAction 归属守卫 + closeSubagent 行为分流 + closeChatIdle。
//
// 沿用 run-and-finalize-chatmode.test.ts 的 mock 模式（真实 SubagentService + mock runSpawn +
// ServiceInternals cast 暴露 store）。验证 M2-B3 新增的归属守卫与 close 行为分流。

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

import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import { RecordStore } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import type { ExecutionRecord } from "../types.ts";

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "msg-close-svc-"));
}

function makePi(): PiLike {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as PiLike;
}

/** 构造 chatMode background record（带 controller，模拟真实 background record）。 */
function makeRecord(overrides: Partial<ExecutionRecord> & { id?: string } = {}): ExecutionRecord {
  const { id = "sa-test", ...rest } = overrides;
  const r = createRecord(id, {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: "test",
    slug: "test",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: true,
    controller: new AbortController(),
  });
  Object.assign(r, rest);
  return r;
}

interface ServiceInternals {
  store: RecordStore;
  sessionRootId: string | null;
}

function setup(): { agentDir: string; service: SubagentService; store: RecordStore; sessionRootId: string } {
  const agentDir = makeTmpAgentDir();
  const modelService = new ModelConfigService({ agentDir });
  const service = new SubagentService({ cwd: agentDir, modelService });
  service.initSession({ pi: makePi(), sessionId: "root-session" });
  const internals = service as unknown as ServiceInternals;
  return { agentDir, service, store: internals.store, sessionRootId: internals.sessionRootId! };
}

// ============================================================
// getRecordForAction 归属守卫（决策 3）
// ============================================================

describe("getRecordForAction 归属守卫（决策 3）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let sessionRootId: string;

  beforeEach(() => {
    ({ agentDir, service, store, sessionRootId } = setup());
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("正常（rootSessionId 匹配）→ 返回可变 record", () => {
    const record = makeRecord({ rootSessionId: sessionRootId });
    store.register(record);
    expect(service.getRecordForAction(record.id)).toBe(record);
  });

  it("不存在 → throw not found or not owned", () => {
    expect(() => service.getRecordForAction("sa-nonexistent")).toThrow(/not found or not owned/);
  });

  it("rootSessionId 不匹配 → throw not found or not owned（不区分 not found vs not owned，防信息泄露）", () => {
    const record = makeRecord({ id: "sa-other", rootSessionId: "other-session" });
    store.register(record);
    expect(() => service.getRecordForAction("sa-other")).toThrow(/not found or not owned/);
  });
});

// ============================================================
// closeSubagent 行为分流
// ============================================================

describe("closeSubagent 行为分流", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;

  beforeEach(() => {
    ({ agentDir, service, store } = setup());
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("running + force:false → 置 closeAfterRound=true（不立即终态，等轮完）", async () => {
    const record = makeRecord({ status: "running" });
    store.register(record);

    await service.closeSubagent(record, false);

    expect(record.closeAfterRound).toBe(true);
    expect(record.status).toBe("running"); // 仍 running
    expect(store.getMutable(record.id)).toBe(record); // 留内存
  });

  it("idle → closeChatIdle（done 终态化 + archive + .idle sidecar 删除）", async () => {
    const record = makeRecord({ status: "idle", round: 1 });
    record.sessionFile = path.join(agentDir, "test.jsonl");
    // 预写 .idle sidecar（模拟 idle record 的磁盘状态）
    fs.writeFileSync(`${record.sessionFile}.idle`, '{"id":"sa-test","sessionFile":"x","round":1}');
    expect(fs.existsSync(`${record.sessionFile}.idle`)).toBe(true);
    store.register(record);

    await service.closeSubagent(record, false);

    expect(record.status).toBe("done");
    expect(store.getMutable(record.id)).toBeUndefined(); // archived
    expect(fs.existsSync(`${record.sessionFile}.idle`)).toBe(false); // .idle 删除
  });

  it("running + force:true → cancelBackground（cancelled 终态化 + archive）", async () => {
    const record = makeRecord({ status: "running", sessionFile: path.join(agentDir, "run.jsonl") });
    store.register(record);

    await service.closeSubagent(record, true);

    expect(record.status).toBe("cancelled");
    expect(store.getMutable(record.id)).toBeUndefined(); // archived
  });

  it("终态（done）→ 幂等 no-op（不改状态、不 archive）", async () => {
    const record = makeRecord({ status: "done" });
    store.register(record);

    await service.closeSubagent(record, false);

    expect(record.status).toBe("done"); // 不变
  });
});
