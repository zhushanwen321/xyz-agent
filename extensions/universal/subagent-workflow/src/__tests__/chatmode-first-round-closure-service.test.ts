// src/__tests__/chatmode-first-round-closure-service.test.ts（P1 抽包留壳：subject 为 subagent-core 件真链路，注入 pi/session-delivery 真机制，见 impl-plan 偏差 #17）
//
// [V2 决策 2/3] chatMode 首轮闭环——onRoundSettled 注入 + runAndFinalize early return
// + double-notify 防护（Step 4a 改动 2/3）。
//
// 改动 2：buildSessionRunnerContext 注入 onRoundSettled 回调——设 record.status=idle +
//   round+=1 + notifyComplete（轻量 idle 化，不调 doFinalizeRoundToIdle）。
// 改动 3：runAndFinalize 检测 chatMode + status===idle（onRoundSettled 已设）→ early return，
//   不进现有 chatMode 分流（那是 close 后 done/failed/cancelled 终态化的）。
// double-notify 防护：onRoundSettled notify + kickOffChatRound.then notify 同 id:round，
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
vi.mock( "@zhushanwen/subagent-core/core/logger.ts", () => ({ getLogger: () => loggerMock }));

// mock session-runner：runSpawn 受控返回 result，killAllSpawnedChildren 空实现。
// [M3] getChildByRecord 返回活进程假句柄：让 piAdapter.hasRunningBackground 的判定只能靠
// 「!hasIdleTimer 排除等待续聊 record」通过（还原生产 Path A：轮次完成、进程保活）。
vi.mock( "@zhushanwen/subagent-core/execution/engine/engines/pi/session-runner.ts", () => ({
  runSpawn: vi.fn(),
  killAllSpawnedChildren: vi.fn(),
  getChildByRecord: vi.fn(() => ({ killed: false, kill: () => true })),
}));

import { runSpawn, getChildByRecord } from "@zhushanwen/subagent-core/execution/engine/engines/pi/session-runner.ts";
import type { SessionRunnerContext } from "@zhushanwen/subagent-core/execution/engine/engines/pi/session-runner.ts";
import { armIdleTimer, disarmIdleTimer } from "@zhushanwen/subagent-core/execution/lifecycle-manager.ts";
import { createRecord, updateFromEvent } from "@zhushanwen/subagent-core/execution/execution-record.ts";
import { ModelConfigService } from "@zhushanwen/subagent-core/execution/model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "@zhushanwen/subagent-core/execution/model-resolver.ts";
import { RecordStore } from "@zhushanwen/subagent-core/execution/record-store.ts";
import { SubagentService } from "@zhushanwen/subagent-core/execution/subagent-service.ts";
import type { PiLike } from "@zhushanwen/subagent-core/execution/subagent-service.ts";
import { createDelivery } from "@xyz-agent/session-delivery";
import { configureNotifyDomain, resetNotifyDomainForTests } from "@zhushanwen/subagent-core/core/notify-ports.ts";
import type {
  AgentResult,
  ExecutionRecord,
  ExecuteOptions,
} from "@zhushanwen/subagent-core/execution/types.ts";

// 投递内核经通知域窄端口注入（u0-notify）——[M3] 的「同 id:round dedup 吞第二次」
// 依赖真实内核 dedupe 语义，注入真实 createDelivery（降级直发无 dedupe 会发 2 条）。
beforeEach(() => {
  configureNotifyDomain({ createDelivery });
});
afterEach(() => {
  resetNotifyDomainForTests();
});

const mockRunSpawn = vi.mocked(runSpawn);
const mockGetChildByRecord = vi.mocked(getChildByRecord);

const STUB_MODEL: ModelInfo = {
  id: "test-model",
  name: "Test",
  provider: "test",
  reasoning: false,
};

/** 最小合法 registry（initModel fail-fast 需要；resolveModel 第三层直接透传 ctxModel）。 */
function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

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

  it("runAndFinalize chatMode 首轮（isIdle：timer armed）early return：不进 finalize 分流，record 保持 running-resumable", async () => {
    // [N3] 真实 isIdle 路径：守卫判据是 `record.chatMode && isIdle(record)`（isIdle = hasIdleTimer，
    // 非 status 值）。旧用例手工赋 status="idle" 且未 arm timer——守卫求值 false 不 early return，
    // 通过路径是「非法状态值被 tryTransition 拒绝」，与守卫无关（假覆盖）。此处构造生产可达状态：
    // agent_settled 已执行（armIdleTimer + onRoundSettled round+1），status 保持 running。
    const record = makeRecord(true);
    record.status = "running";
    record.round = 1; // onRoundSettled 已 +1
    internals.store.register(record);
    armIdleTimer(record.id, () => {}); // 真实 arm（isIdle=true），模拟 agent_settled
    try {
      await callRunAndFinalize(record, true);

      // [改动 3] early return 守卫正分支生效：不进 finalize 分流——round 不被
      // finalizeRoundToIdle 二次 +1（仍 1）、record.result 不被覆写（MF-2 写点会写
      // makeResult.text="done"，early return 后保持 undefined）、未 archive、store 仍持有。
      expect(record.status).toBe("running");
      expect(record.round).toBe(1);
      expect(record.result).toBeUndefined();
      expect(internals.store.getMutable(record.id)).toBe(record);
    } finally {
      disarmIdleTimer(record.id);
    }
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
    //
    // [N2] 禁止手工预置 record.result（这正是掩盖「通知正文恒 (empty)」断链的方式）——
    // 轮次文本经真实 updateFromEvent 累积进 turns，真实 onRoundSettled 回调派生写入
    // record.result（对齐 collectResult 的 getFullText）后 notify。
    const pi = makePi();
    service.initSession({ pi, sessionId: "root-session" }); // 换上带 spy 的 pi
    const record = makeRecord(true);
    record.status = "running";
    updateFromEvent(record, { type: "text_delta", delta: "first-round-done" });
    updateFromEvent(record, { type: "turn_end" });
    internals.store.register(record);
    armIdleTimer(record.id, () => {}); // 模拟 agent_settled：轮次完成、等待续聊（Path A）
    try {
      // 真实回调链：round 0→1 + record.result 从 turns 派生 + notifyComplete
      internals.buildSessionRunnerContext().onRoundSettled!(record);
      expect(record.round).toBe(1);
      expect(record.result).toBe("first-round-done"); // 真实派生（非手工预置）

      // [M3] 立即 flush——同步断言 sendMessage 已发出（旧实现此处挂 60s timer，0 次调用）
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      const sentMsg = pi.sendMessage.mock.calls[0]![0] as { customType: string; content: string };
      expect(sentMsg.customType).toBe("subagent-bg-notify");
      expect(sentMsg.content).toContain("finished a round");
      expect(sentMsg.content).toContain("first-round-done");

      // double-notify 防护（原用例语义保留）：onRoundSettled notify + kickOffChatRound.then
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

// ── [N1] one-shot 成功完成通知（SP-5 回退 resumable 后仍送达）──────────────

describe("[N1] one-shot 成功完成通知：SP-5 回退 resumable 后仍送达", () => {
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
    // 还原默认活进程句柄实现（其他用例的 busy 判定依赖）
    mockGetChildByRecord.mockImplementation(() => ({ killed: false, kill: () => true }));
  });

  it("真实 execute + mock runSpawn(success) → 恰 1 条 subagent-bg-notify（status=closed、正文含真实结果），record 保持可升级", async () => {
    // 真实链路：execute → kickOffChatRound → runAndFinalize（SP-5 分支 → finalizeRoundToIdle
    // 回退 running-resumable）→ .then notifyComplete → BgNotifier → pi.sendMessage。
    // round2 审查实证：旧守卫（closed/isIdle only）对 SP-5 完成态恒拒绝 → 发送数 0。
    modelService.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "root-session",
      ctxModel: STUB_MODEL,
    });
    const pi = makePi();
    service.initSession({ pi, sessionId: "root-session" }); // 换上带 spy 的 pi

    // one-shot 成功完成态：进程已死（close 后 spawnedChildren 已清理）——getChildByRecord
    // 返回 undefined，SP-5 回退的 record 因此 isResumable（running + 无活进程）。
    mockRunSpawn.mockResolvedValueOnce(makeResult(true));
    mockGetChildByRecord.mockImplementation(() => undefined);
    try {
      const handle = await service.execute({ task: "one shot task", slug: "oneshot-n1" });

      await vi.waitFor(() => {
        expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      });
      const sentMsg = pi.sendMessage.mock.calls[0]![0] as {
        customType: string;
        content: string;
        details?: { status?: string };
      };
      expect(sentMsg.customType).toBe("subagent-bg-notify");
      // 完成语义：status=closed（对齐 tool 契约 "runs once, notifies on completion"；
      // running 分支文案不含 worktree patchFile 提示，one-shot 需要 closed 分支）
      expect(sentMsg.details?.status).toBe("closed");
      expect(sentMsg.content).toContain("completed");
      expect(sentMsg.content).toContain("done"); // makeResult(true).text，经 MF-2 写入 record.result

      // 恰好 1 条：无第二个通知点（onRoundSettled 仅 chatMode；.then 后无再触发）
      await new Promise((r) => setTimeout(r, 20));
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);

      // SP-5 语义不破坏：record 回退 running-resumable（可 message 升级续聊），未终态化
      const record = internals.store.getMutable(handle.subagentId);
      expect(record).toBeDefined();
      expect(record!.status).toBe("running");
      expect(record!.result).toBe("done");
    } finally {
      mockGetChildByRecord.mockImplementation(() => ({ killed: false, kill: () => true }));
    }
  });
});
