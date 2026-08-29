// src/execution/__tests__/one-shot-upgrade.test.ts
//
// SP-5 one-shot upgrade：非 chatMode active record 收到 message 时自动升级 chatMode。
//
// 场景：one-shot subagent（conversation=false）完成首轮后 record 仍在内存（running/idle），
// LLM 调 message 续聊 → messageHandler 检测非 chatMode + active → 置 chatMode=true（upgrade）→
// 走 deliverMessage 统一路径（热路径或冷路径 resume）。
//
// mock 策略：真实 SubagentService + mock runSpawn（受控），getChildByRecord/spawnedChildren
// 提供真实 Map 语义（deliverMessage 热路径需要 child 存在）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock logger
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// mock session-runner：runSpawn 受控 + killAllSpawnedChildren 空实现；
// getChildByRecord/spawnedChildren 提供真实 Map 语义。
vi.mock("../session-runner.ts", () => {
  const spawnedChildren = new Map<string, unknown>();
  return {
    runSpawn: vi.fn(),
    killAllSpawnedChildren: vi.fn(),
    spawnedChildren,
    getChildByRecord: (id: string): unknown => spawnedChildren.get(id),
  };
});

import { runSpawn, spawnedChildren } from "../session-runner.ts";
import type { SessionRunnerContext } from "../session-runner.ts";
import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo } from "../model-resolver.ts";
import { RecordStore } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import type { AgentResult, ExecutionRecord } from "../types.ts";
import { messageHandler } from "../../interface/subagent-actions.ts";

const mockRunSpawn = vi.mocked(runSpawn);

const STUB_MODEL: ModelInfo = { id: "test-model", name: "Test", provider: "test", reasoning: false };

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-test-"));
}

function makePi(): PiLike & {
  appendEntry: ReturnType<typeof vi.fn>;
  events: { emit: ReturnType<typeof vi.fn> };
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return { appendEntry: vi.fn(), events: { emit: vi.fn() }, sendMessage: vi.fn() };
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

interface ServiceInternals {
  store: RecordStore;
  sessionRootId: string | null;
}

/** 非 chatMode background record（one-shot 模式）。 */
function makeOneShotRecord(
  sessionRootId: string,
  status: "running" = "running",
  id = "sa-oneshot",
): ExecutionRecord {
  const record = createRecord(id, {
    agent: "general-purpose",
    model: "test/test-model",
    thinkingLevel: "low",
    mode: "background",
    task: "one-shot task",
    slug: "oneshot",
    startedAt: 1000,
    rootSessionId: sessionRootId,
    // chatMode 不传 = undefined = 非 chatMode（one-shot）
  });
  record.status = status;
  record.controller = new AbortController();
  // v4 B-1：one-shot 完成后 record 为 running（idle 折入 running）+ isResumable（无活进程）。
  // sessionFile 总设（resumeRound 冷路径校验需要，热路径无害）。
  record.sessionFile = "/tmp/fake-session.jsonl";
  record.round = 1;
  return record;
}

// ============================================================
// SP-5 one-shot upgrade
// ============================================================

describe("SP-5 one-shot upgrade（message → chatMode + 冷 resume）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let sessionRootId: string;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    const modelService = new ModelConfigService({ agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    const internals = service as unknown as ServiceInternals;
    store = internals.store;
    sessionRootId = internals.sessionRootId!;
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  // TC-1: one-shot done 后 message 触发 upgrade（chatMode=true）
  // 场景：one-shot running record → message → chatMode 被置 true → deliverMessage 热路径（child 存在）
  it("TC-1: one-shot running record 收到 message → chatMode 升级为 true", async () => {
    const record = makeOneShotRecord(sessionRootId, "running");
    store.register(record);

    // 注册 mock child 让 deliverMessage 走热路径
    const mockChild = { killed: false, pid: 12345, stdin: { write: vi.fn(() => true) } };
    spawnedChildren.set(record.id, mockChild as unknown);

    // 验证升级前 chatMode 为 falsy
    expect(record.chatMode).toBeFalsy();

    await messageHandler(service, { subagentId: record.id, text: "follow-up" });

    // 验证 chatMode 被升级
    expect(record.chatMode).toBe(true);
    // 验证 record 仍为 running（deliverMessage 热路径设 running）
    expect(record.status).toBe("running");
    // 验证 record 在内存中（非终态，未被 archive）
    expect(store.getMutable(record.id)).toBeDefined();

    // 清理
    spawnedChildren.delete(record.id);
  });

  // TC-2: upgrade 后走冷路径 resume
  // 场景：one-shot idle record（进程已死）→ message → chatMode=true → deliverMessage 冷路径 → resumeRound
  it("TC-2: one-shot idle record 收到 message → chatMode 升级 + 冷路径 resume", async () => {
    // one-shot 完成态 record（running + isResumable）需要 sessionFile（resumeRound 冷路径校验）
    fs.writeFileSync("/tmp/fake-session.jsonl", "");
    const record = makeOneShotRecord(sessionRootId);
    store.register(record);

    // mock runSpawn 返回成功（resume 后的 spawn）
    mockRunSpawn.mockImplementation(async (_ctx: SessionRunnerContext) => {
      return makeResult(true);
    });

    expect(record.chatMode).toBeFalsy();

    await messageHandler(service, { subagentId: record.id, text: "resume message" });

    // 验证 chatMode 被升级
    expect(record.chatMode).toBe(true);
    // 验证走了 resumeRound → runSpawn（冷路径）
    expect(mockRunSpawn).toHaveBeenCalled();
    // record 被 resumeRound 设为 running，runAndFinalize 完成后保持 running（v4 B-1 idle 折入 running）
    // 关键是 record 不在终态
    expect(record.status).not.toBe("closed");
  });

  // TC-3: upgrade 后 record 可续聊（非终态）
  // 场景：验证升级后的 record 不会被 finalize 为终态，仍可接受后续 message
  it("TC-3: upgrade 后 record 可续聊（非终态，仍在内存）", async () => {
    const record = makeOneShotRecord(sessionRootId);
    store.register(record);

    // runSpawn 返回成功
    mockRunSpawn.mockImplementation(async () => makeResult(true));

    await messageHandler(service, { subagentId: record.id, text: "first resume" });

    // chatMode 已升级
    expect(record.chatMode).toBe(true);

    // 关键验证：record 仍在内存（getMutable 返回非 undefined）——未被 archive 到终态
    const mutable = store.getMutable(record.id);
    expect(mutable).toBeDefined();
    expect(mutable!.chatMode).toBe(true);

    // 验证 status 不是终态（closed 是终态；running 是非终态，v4 B-1 idle 折入 running）
    expect(record.status).toBe("running");
  });
});
