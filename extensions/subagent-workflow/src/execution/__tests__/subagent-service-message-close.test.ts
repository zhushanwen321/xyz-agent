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
import { getChildByRecord } from "../session-runner.ts";

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

  it("running + force:false + 有活进程 → 置 closeAfterRound=true（不立即终态，等轮完）", async () => {
    // v4 B-1：closeSubagent running 分支按 isResumable 区分——有活进程（isResumable=false）
    // 走 closeAfterRound；无活进程（isResumable=true）走 closeChatIdle。本用例 mock 活进程。
    vi.mocked(getChildByRecord).mockReturnValueOnce({ killed: false } as never);
    const record = makeRecord({ status: "running" });
    store.register(record);

    await service.closeSubagent(record, false);

    expect(record.closeAfterRound).toBe(true);
    expect(record.status).toBe("running"); // 仍 running
    expect(store.getMutable(record.id)).toBe(record); // 留内存
  });

  it("running + 无活进程（旧 idle）→ closeChatIdle（closed 终态化 + archive）", async () => {
    // v4 B-1：旧 idle 折入 running。running + force:false + isResumable=true（getChildByRecord
    // 默认 mock 返回 undefined = 无活进程）→ closeChatIdle 立即终态化。
    const record = makeRecord({ status: "running", round: 1 });
    record.sessionFile = path.join(agentDir, "test.jsonl");
    store.register(record);

    await service.closeSubagent(record, false);

    expect(record.status).toBe("closed");
    expect(store.getMutable(record.id)).toBeUndefined(); // archived
  });

  it("running + force:true → cancelBackground（closed+cancelled 终态化 + archive）", async () => {
    const record = makeRecord({ status: "running", sessionFile: path.join(agentDir, "run.jsonl") });
    store.register(record);

    await service.closeSubagent(record, true);

    // v4 B-1：cancelled 折入 closed（closedReason='cancelled' 区分用户取消语义）
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("cancelled");
    expect(store.getMutable(record.id)).toBeUndefined(); // archived
  });

  it("终态（done）→ 幂等 no-op（不改状态、不 archive）", async () => {
    const record = makeRecord({ status: "closed" });
    store.register(record);

    await service.closeSubagent(record, false);

    expect(record.status).toBe("closed"); // 不变
  });
});
