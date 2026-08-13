// src/execution/__tests__/run-and-finalize-chatmode.test.ts
//
// runAndFinalize 的 chatMode idle 分流测试（M2-A）。
//
// mock session-runner.runSpawn（受控返回 success/failed result），走 SubagentService
// 真实的 runAndFinalize 分流逻辑，验证：
//   - chatMode + done   → doFinalizeRoundToIdle：record.status=idle、留内存、round+1
//   - chatMode + failed → MF-6：回退 idle（可恢复），不销毁（agent 可重试 message 或 close）
//   - 非 chatMode + done → doFinalizeRecord：record.status=done、archived（现有行为不变）
//
// 分流效果通过「最终可观察状态」验证（record.status + store.getMutable 是否在内存），
// 不依赖 spy 私有方法调用，更稳健。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock logger（doFinalizeRecord 的 manifest 写入降级路径用 logger.error）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({ getLogger: () => loggerMock }));

// mock session-runner：runSpawn 受控返回 result，killAllSpawnedChildren 空实现。
// 注意：必须在 import SubagentService 之前 mock（vi.mock 提升到顶部）。
vi.mock("../session-runner.ts", () => ({
  runSpawn: vi.fn(),
  killAllSpawnedChildren: vi.fn(),
}));

import { runSpawn } from "../session-runner.ts";
import type { SessionRunnerContext } from "../session-runner.ts";
import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo } from "../model-resolver.ts";
import { RecordStore, type StatusFilter } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import type {
  AgentResult,
  ExecutionRecord,
  ExecuteOptions,
} from "../types.ts";

const mockRunSpawn = vi.mocked(runSpawn);

// ── 最小合法 ModelInfo（resolveModel 未注入 registry 会抛错，故 stub；runSpawn 被 mock 不消费）──
const STUB_MODEL: ModelInfo = {
  id: "test-model",
  name: "Test",
  provider: "test",
  reasoning: false,
};

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chatmode-test-"));
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

function makeRecord(chatMode: boolean, id = "sa-test"): ExecutionRecord {
  return createRecord(id, {
    agent: "general-purpose",
    model: "test-model",
    mode: "background",
    task: "do something",
    slug: "test",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode,
  });
}

/** 暴露 runAndFinalize + store 的私有访问接口（测试专用 cast）。 */
interface ServiceInternals {
  store: RecordStore;
  runAndFinalize: (
    record: ExecutionRecord,
    opts: ExecuteOptions,
    ctx: SessionRunnerContext,
    identity: {
      agent: string;
      agentConfig: unknown;
      resolved: { model: ModelInfo; thinkingLevel: string | undefined };
    },
    signal: undefined,
    priority: number,
  ) => Promise<AgentResult>;
}

describe("runAndFinalize chatMode idle 分流 (M2-A)", () => {
  let agentDir: string;
  let modelService: ModelConfigService;
  let service: SubagentService;
  let internals: ServiceInternals;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    modelService = new ModelConfigService({ agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    internals = service as unknown as ServiceInternals;
    mockRunSpawn.mockReset();
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  /** 直接调私有 runAndFinalize（mock runSpawn 后走完整分流逻辑）。 */
  async function callRunAndFinalize(record: ExecutionRecord, success: boolean): Promise<void> {
    mockRunSpawn.mockResolvedValueOnce(makeResult(success));
    const opts: ExecuteOptions = { task: "do something", slug: "test" };
    const ctx: SessionRunnerContext = {
      cwd: agentDir,
      agentDir,
      skillDirs: [],
      mainCwd: agentDir,
    };
    const identity = {
      agent: "general-purpose",
      agentConfig: undefined,
      resolved: { model: STUB_MODEL, thinkingLevel: undefined },
    };
    await internals.runAndFinalize(record, opts, ctx, identity, undefined, 0);
  }

  it("chatMode + done → record idle，留内存，round 0→1", async () => {
    const record = makeRecord(true);
    internals.store.register(record);
    await callRunAndFinalize(record, true);

    expect(record.status).toBe("idle");
    expect(record.round).toBe(1);
    // record 留内存（未 archive）——idle 分流核心断言
    expect(internals.store.getMutable(record.id)).toBe(record);
  });

  it("chatMode + failed → MF-6：回退 idle（可恢复），不销毁对话（agent 可重试 message 或 close）", async () => {
    const record = makeRecord(true);
    internals.store.register(record);
    await callRunAndFinalize(record, false);

    // MF-6：chatMode 失败不终态销毁——record 回退 idle（留内存），agent 可重试 message 或 close。
    expect(record.status).toBe("idle");
    expect(internals.store.getMutable(record.id)).toBe(record); // 留内存（未 archive）
    // record.result 被 finalizeRoundToIdle 设值（MF-2：否则 notifier idle 恒 (empty)）。
    // makeResult(false) 返回 text:"err" + error:"boom"；text 非空 → record.result="err"。
    expect(record.result).toBeTruthy();
  });

  it("非 chatMode + done → record idle（SP-5: 一次性完成后保持活跃，等待 message 触发升级）", async () => {
    const record = makeRecord(false);
    internals.store.register(record);
    await callRunAndFinalize(record, true);

    // SP-5: one-shot 完成后 record 保持 idle（非终态归档），用户可通过 message 续聊。
    expect(record.status).toBe("idle");
    expect(internals.store.getMutable(record.id)).toBe(record); // 留内存
  });

  it("chatMode 第二轮 done → round 累加（1→2，续聊场景）", async () => {
    // 模拟 resume 续聊：第一轮已 idle（round=1），第二轮 runAndFinalize 再次 done
    const record = makeRecord(true);
    record.status = "idle"; // 第一轮已完成
    record.round = 1;
    internals.store.register(record);
    await callRunAndFinalize(record, true);

    // 注意：tryTransition 要求 status==="running" 才 CAS 成功。
    // idle record 的 runAndFinalize：tryTransition(idle→done) 返回 false（非 running），
    // 分流不执行，record 保持 idle。这是 M2-A 的预期边界——
    // idle 续聊（prompt 触发新 run）由 M2-B 处理，届时 record 会被重新设为 running。
    // 本用例锁定：idle record 直接进 runAndFinalize 不会误转态。
    expect(record.status).toBe("idle");
    expect(record.round).toBe(1);
    expect(mockRunSpawn).toHaveBeenCalled();
  });

  it("chatMode + done + closeAfterRound=true → finalizeRecord(done)（不进 idle，M2-B3）", async () => {
    // close 优雅关闭（force:false）：running 时置 closeAfterRound=true，
    // runAndFinalize done 分流终态化为 done（而非进 idle）。
    const record = makeRecord(true);
    record.status = "running";
    record.closeAfterRound = true;
    internals.store.register(record);
    await callRunAndFinalize(record, true);

    expect(record.status).toBe("closed");
    expect(record.closeAfterRound).toBeUndefined(); // 清标志
    // 终态化 → archive → 内存无（与 idle 分流「留内存」对比）
    expect(internals.store.getMutable(record.id)).toBeUndefined();
  });

  it("chatMode + done + 无 closeAfterRound → 进 idle（现有 M2-A 行为不变）", async () => {
    const record = makeRecord(true);
    record.status = "running";
    internals.store.register(record);
    await callRunAndFinalize(record, true);

    expect(record.status).toBe("idle");
    expect(record.round).toBe(1);
    expect(internals.store.getMutable(record.id)).toBe(record);
  });
});
