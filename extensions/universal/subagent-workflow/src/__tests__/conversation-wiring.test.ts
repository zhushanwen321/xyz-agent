// src/__tests__/conversation-wiring.test.ts
//
// [M9] conversation:true → record.chatMode 接线穿透测试。
//
// 背景：「持续对话」特性的 LLM 入口接线（subagent-tool params → startHandler 透传 →
// execute → createRecordForMode 的 `chatMode: opts.conversation === true` +
// `idleTimeoutMs: opts.idleTimeoutMs`，subagent-service.ts L1234-1235）此前无任何测试——
// 全部 chatMode 测试手工构造 chatMode:true record，startHandler 测试不传 conversation。
// 若参数名漂移或透传丢失（subagent-actions.ts L206-207），1970 个用例仍全绿。
//
// 两层验证：
//   1. 接线层：真实 SubagentService.execute（mock runSpawn pending 阻断 detached 收尾）
//      → 断言内存 record.chatMode === true / idleTimeoutMs 生效；缺省对照 chatMode === false
//   2. 透传层：startHandler + mock service → 断言 execute 收到 conversation/idleTimeoutMs 原值

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock( "@zhushanwen/subagent-core/core/logger.ts", () => ({ getLogger: () => loggerMock }));

// mock session-runner：runSpawn 返回永不 resolve 的 promise（阻断 runAndFinalize 收尾，
// record 停在 running，execute 返回后立即可断言 createRecordForMode 的接线产物）。
vi.mock( "@zhushanwen/subagent-core/execution/engine/engines/pi/session-runner.ts", () => ({
  runSpawn: vi.fn(() => new Promise(() => {})),
  killAllSpawnedChildren: vi.fn(),
  getChildByRecord: vi.fn(() => undefined),
  spawnedChildren: new Map(),
}));

import { runSpawn } from "@zhushanwen/subagent-core/execution/engine/engines/pi/session-runner.ts";
import { startHandler } from "../interface/subagent-actions.ts";
import { ModelConfigService } from "@zhushanwen/subagent-core";
import type { ModelInfo, ModelRegistryLike } from "@zhushanwen/subagent-core/execution/model-resolver.ts";
import { RecordStore } from "@zhushanwen/subagent-core";
import { SubagentService } from "@zhushanwen/subagent-core";
import type { ExecutionHandle, SubagentToolDetails } from "@zhushanwen/subagent-core/execution/types.ts";

const mockRunSpawn = vi.mocked(runSpawn);

const STUB_MODEL: ModelInfo = { id: "test-model", name: "Test", provider: "test", reasoning: false };

/** 最小合法 registry（initModel fail-fast 需要；resolveModel 第三层直接透传 ctxModel）。 */
function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

/** initSession 注入的最小 pi duck-type（同 subagent-service PiLike 形状，结构匹配即可）。 */
interface PiStub {
  appendEntry(customType: string, data?: unknown): void;
  events: { emit(channel: string, data: unknown): void };
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

function makePi(): PiStub {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
}

/** 暴露私有 store 的接口（测试专用 cast）。 */
interface ServiceInternals {
  store: RecordStore;
}

// ============================================================
// 1. 接线层：execute({conversation, idleTimeoutMs}) → record 字段
// ============================================================

describe("[M9] conversation:true 接线：execute → createRecordForMode", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-wiring-"));
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    modelService.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "root-session",
      ctxModel: STUB_MODEL,
    });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    store = (service as unknown as ServiceInternals).store;
    mockRunSpawn.mockClear();
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("conversation:true + idleTimeoutMs:12345 → record.chatMode===true、idleTimeoutMs 生效", async () => {
    const handle = await service.execute({
      task: "keep chatting with me",
      slug: "conv-test",
      conversation: true,
      idleTimeoutMs: 12345,
    });

    const record = store.getMutable(handle.subagentId);
    expect(record).toBeDefined();
    expect(record!.chatMode).toBe(true);
    expect(record!.idleTimeoutMs).toBe(12345);
    expect(record!.status).toBe("running");
    // execute 走到 kickOffChatRound（runSpawn 已被调用）——完整接线而非 early return
    expect(mockRunSpawn).toHaveBeenCalledTimes(1);
  });

  it("conversation 缺省 → record.chatMode===false、idleTimeoutMs undefined（一次性模式不误升级）", async () => {
    const handle = await service.execute({
      task: "one shot task",
      slug: "oneshot-test",
    });

    const record = store.getMutable(handle.subagentId);
    expect(record).toBeDefined();
    expect(record!.chatMode).toBe(false);
    expect(record!.idleTimeoutMs).toBeUndefined();
  });
});

// ============================================================
// 2. 透传层：startHandler(service, {conversation, idleTimeoutMs}) → service.execute
// ============================================================

function makeHandle(subagentId: string): ExecutionHandle {
  const details: SubagentToolDetails = {
    status: "running",
    mode: "background",
    agent: "worker",
    model: "test/model",
    thinkingLevel: undefined,
    slug: "conv-test",
    turns: 0,
    totalTokens: 0,
    elapsedSeconds: 0,
    eventLog: [],
    displayItems: [],
    result: undefined,
  };
  return { mode: "background", subagentId, sessionFile: undefined, details };
}

function makeService(): SubagentService & { execute: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn(async () => makeHandle("sa-conv-1")),
    findRecord: vi.fn(() => undefined),
    cancel: vi.fn(() => false),
    collectRecords: vi.fn(() => []),
    getFullRecord: vi.fn(() => undefined),
  } as unknown as SubagentService & { execute: ReturnType<typeof vi.fn> };
}

describe("[M9] startHandler 透传：conversation/idleTimeoutMs → execute 入参", () => {
  it("conversation:true + idleTimeoutMs:12345 原值透传给 service.execute", async () => {
    const svc = makeService();
    const result = await startHandler(
      svc,
      { task: "chat task", slug: "conv-pass", conversation: true, idleTimeoutMs: 12345 },
      undefined,
    );

    expect(svc.execute).toHaveBeenCalledTimes(1);
    expect(svc.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "chat task",
        slug: "conv-pass",
        conversation: true,
        idleTimeoutMs: 12345,
      }),
    );
    // bg 响应回执（LLM 可见）：detached + running
    expect(result.kind).toBe("bg");
    expect(result.subagentId).toBe("sa-conv-1");
    expect(result.response.status).toBe("running");
  });

  it("conversation 缺省 → execute 入参 conversation===undefined（不误置 true）", async () => {
    const svc = makeService();
    await startHandler(svc, { task: "plain task", slug: "plain-pass" }, undefined);

    expect(svc.execute).toHaveBeenCalledWith(
      expect.objectContaining({ conversation: undefined, idleTimeoutMs: undefined }),
    );
  });
});
