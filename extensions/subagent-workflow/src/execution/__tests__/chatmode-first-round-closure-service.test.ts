// src/execution/__tests__/chatmode-first-round-closure-service.test.ts
//
// [V2 决策 2/3] chatMode 首轮闭环——onRoundSettled 注入 + runAndFinalize early return
// + double-notify 防护（Step 4a 改动 2/3）。
//
// 改动 2：buildSessionRunnerContext 注入 onRoundSettled 回调——设 record.status=idle +
//   round+=1 + notifyComplete（轻量 idle 化，不调 doFinalizeRoundToIdle）。
// 改动 3：runAndFinalize 检测 chatMode + status===idle（onRoundSettled 已设）→ early return，
//   不进现有 chatMode 分流（那是 close 后 done/failed/cancelled 终态化的）。
// double-notify 防护：onRoundSettled notify + kickOffBackground.then notify 同 id:round，
//   notifier dedup（id:round key，60s TTL）吞第二次——notifier.ts L122 是天然防线。
//
// mock 结构与 run-and-finalize-chatmode.test.ts 一致（mock session-runner + logger，
// 走真实 SubagentService 的 buildSessionRunnerContext / runAndFinalize 分流逻辑）。

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
vi.mock("../session-runner.ts", () => ({
  runSpawn: vi.fn(),
  killAllSpawnedChildren: vi.fn(),
}));

import { runSpawn } from "../session-runner.ts";
import type { SessionRunnerContext } from "../session-runner.ts";
import { BgNotifier, type BgNotifyRecord, type NotifierHost } from "../notifier.ts";
import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo } from "../model-resolver.ts";
import { RecordStore } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import type {
  AgentResult,
  ExecutionRecord,
  ExecuteOptions,
} from "../types.ts";

const mockRunSpawn = vi.mocked(runSpawn);

const STUB_MODEL: ModelInfo = {
  id: "test-model",
  name: "Test",
  provider: "test",
  reasoning: false,
};

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chatmode-closure-"));
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

/** 暴露 runAndFinalize / store / buildSessionRunnerContext / notifyComplete 私有访问。 */
interface ServiceInternals {
  store: RecordStore;
  buildSessionRunnerContext(): SessionRunnerContext;
  notifyComplete(record: ExecutionRecord): void;
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

describe("[V2 决策 2/3] chatMode 首轮闭环：onRoundSettled 注入 + early return（改动 2/3）", () => {
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

  // ── 改动 2：onRoundSettled 回调注入 ──────────────────────────────────

  it("buildSessionRunnerContext 注入 onRoundSettled：设 running(idle 折入) + round+=1 + notifyComplete", () => {
    const ctx = internals.buildSessionRunnerContext();
    expect(typeof ctx.onRoundSettled).toBe("function");

    const record = makeRecord(true); // chatMode, status=running, round=undefined
    const spy = vi.spyOn(internals, "notifyComplete");

    ctx.onRoundSettled!(record);

    // [改动 2] 轻量 idle 化（v4 B-1：idle 折入 running）：status=running（notify 守卫放行）+ round 0→1（dedup key 递增）
    expect(record.status).toBe("running");
    expect(record.round).toBe(1);
    // notifyComplete 被调 1 次，入参是当前 record（此时 running+isIdle，toNotifyRecord 守卫放行）
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(record);
  });

  it("onRoundSettled 连续两轮：round 累加（1→2，dedup key 区分每轮）", () => {
    const ctx = internals.buildSessionRunnerContext();
    const record = makeRecord(true);
    record.round = 1; // 第一轮已完成
    vi.spyOn(internals, "notifyComplete");

    ctx.onRoundSettled!(record);

    expect(record.status).toBe("running");
    expect(record.round).toBe(2); // 第二轮 round 累加
  });

  // ── 改动 3：runAndFinalize chatMode 首轮 early return ────────────────

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

  it("runAndFinalize chatMode 首轮（status=idle）early return：不进 finalize 分流，record 保持 idle", async () => {
    // 模拟 onRoundSettled 已执行后的状态：chatMode + status=idle + round=1
    const record = makeRecord(true);
    record.status = "idle";
    record.round = 1;
    internals.store.register(record);
    await callRunAndFinalize(record, true);

    // [改动 3] chatMode 首轮 early return：record 保持 idle（不转 done）、round 不变（不二次 +1）、
    // 未 archive（不进 finalizeRoundToIdle / finalizeRecord 的销毁路径）
    expect(record.status).toBe("idle");
    expect(record.round).toBe(1);
    expect(internals.store.getMutable(record.id)).toBe(record);
  });

  it("runAndFinalize chatMode 首轮 early return 不依赖 tryTransition：close 后 done 分流仍对 running record 生效", async () => {
    // 对照组：chatMode + status=running（未经 onRoundSettled，如旧路径或测试直调）→
    // tryTransition 成功 → 进现有 chatMode done 分流（finalizeRoundToIdle）。证明 early return
    // 守卫只挡 onRoundSettled 设的 idle，不误伤 running record 的正常分流。
    const record = makeRecord(true);
    record.status = "running";
    internals.store.register(record);
    await callRunAndFinalize(record, true);

    expect(record.status).toBe("running"); // finalizeRoundToIdle 设的（v4 B-1 idle 折入 running）
    expect(record.round).toBe(1); // finalizeRoundToIdle +1
    expect(internals.store.getMutable(record.id)).toBe(record);
  });

  // ── double-notify 防护：notifier dedup 是天然防线 ────────────────────

  it("chatMode 首轮 double-notify 防护：notifier dedup 同 id:round 60s 内吞第二次", () => {
    // 场景：onRoundSettled notify（改动 2）+ kickOffBackground.then notifyComplete（现有）
    // 两次 notify 同 id:round → notifier dedup key=`${id}:${round}` 60s 内吞第二次。
    // 这是 double-notify 的天然防线（notifier.ts L122），无需调用层额外守卫。
    const sent: Array<{ customType: string; content: string }> = [];
    const host: NotifierHost = {
      sendMessage: (m) => {
        sent.push(m);
      },
      hasRunningBackground: () => false, // 无 running → 立即 flush（不排队）
      isIdle: () => true, // 主 agent 空闲 → flush 立即发送（不退避）
    };
    const notifier = new BgNotifier(host);
    const rec: BgNotifyRecord = {
      id: "sa-dup",
      status: "idle",
      agent: "general-purpose",
      model: "test-model",
      result: "first-round-done",
      error: undefined,
      startedAt: 1000,
      endedAt: 1100,
      round: 1, // onRoundSettled 设的 round
    };

    notifier.notify(rec); // 第一次：onRoundSettled 那次 → flush 发送
    notifier.notify(rec); // 第二次：kickOffBackground.then 那次 → dedup 吞

    // 只发送 1 条（第二次被 dedup 吞，未进 pending / 未 flush）
    expect(sent).toHaveLength(1);
    expect(sent[0]!.customType).toBe("subagent-bg-notify");
  });
});
