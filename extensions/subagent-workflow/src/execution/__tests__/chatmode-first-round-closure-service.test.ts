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
// [M3] getChildByRecord 返回活进程假句柄：让 piAdapter.hasRunningBackground 的判定只能靠
// 「!hasIdleTimer 排除等待续聊 record」通过（还原生产 Path A：轮次完成、进程保活）。
vi.mock("../session-runner.ts", () => ({
  runSpawn: vi.fn(),
  killAllSpawnedChildren: vi.fn(),
  getChildByRecord: vi.fn(() => ({ killed: false, kill: () => true })),
}));

import { runSpawn } from "../session-runner.ts";
import type { SessionRunnerContext } from "../session-runner.ts";
import { armIdleTimer, disarmIdleTimer } from "../lifecycle-manager.ts";
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

  // ── double-notify 防护 + [M3] 轮次完成通知立即送达 ───────────────────

  it("[M3] chatMode 轮次完成通知立即送达（不挂 60s 合并窗口）+ 同 id:round dedup 吞第二次", () => {
    // 生产场景：chatMode 轮次完成（agent_settled arm idle timer → onRoundSettled →
    // notifyComplete），record 留 store、status=running、进程保活（Path A）。
    // 旧 piAdapter.hasRunningBackground 按 mode==="background" 计数 → 对该 record 恒 true
    // → notify 恒挂 60s 合并窗口，主 agent 的续聊回复固定延迟 60s（G1 失效）。
    // 修复后排除 isIdle（timer armed）record → 立即 flush。
    //
    // 走真实 SubagentService.notifyComplete → BgNotifier → piAdapter（真实 host adapter），
    // 不再手搓 NotifierHost mock 绕过生产行为（旧用例 `hasRunningBackground: () => false`
    // 是对生产行为的 mock 绕过）。
    const pi = makePi();
    service.initSession({ pi, sessionId: "root-session" }); // 换上带 spy 的 pi
    const record = makeRecord(true);
    record.status = "running";
    record.round = 1;
    record.result = "first-round-done";
    internals.store.register(record);
    armIdleTimer(record.id, () => {}); // 模拟 agent_settled：轮次完成、等待续聊（Path A）
    try {
      internals.notifyComplete(record);

      // [M3] 立即 flush——同步断言 sendMessage 已发出（旧实现此处挂 60s timer，0 次调用）
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      const sentMsg = pi.sendMessage.mock.calls[0]![0] as { customType: string; content: string };
      expect(sentMsg.customType).toBe("subagent-bg-notify");
      expect(sentMsg.content).toContain("finished a round");
      expect(sentMsg.content).toContain("first-round-done");

      // double-notify 防护（原用例语义保留）：onRoundSettled notify + kickOffBackground.then
      // notifyComplete 同 id:round → notifier dedup key=`${id}:${round}` 60s 内吞第二次。
      internals.notifyComplete(record);
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      disarmIdleTimer(record.id);
    }

    // 对照：真在跑的 background 工作（活进程 + 无 timer）仍计入合并窗口——closed 通知
    // 挂 60s 不立即发送（合并窗口语义对真正的并发完成保留）。
    const busy = makeRecord(false, "sa-busy");
    busy.status = "running";
    internals.store.register(busy); // 活进程（mock 恒返回）+ 无 timer = busy，计入
    const done = makeRecord(false, "sa-done");
    done.status = "closed"; // 终态 notify（toNotifyRecord 放行 closed）
    try {
      internals.notifyComplete(done);
      expect(pi.sendMessage).toHaveBeenCalledTimes(1); // 未新增——busy 挂起合并窗口
    } finally {
      // busy/done 无 timer，无需 disarm；record 由 afterEach dispose 清理
    }
  });
});
