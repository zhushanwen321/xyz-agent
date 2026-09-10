// src/__tests__/chat-domain-v1x.test.ts
//
// chat 域协议 v1.x 增量契约断言（W1：docs/design/chat-domain-v1x-liveness-governance.md
// §3.2 D1-A + impl-plan §2 W1 行）。全部从 protocol barrel import（消费方视角——
// 验收条款 2「载荷类型可从 protocol 导出面 import」的可执行证明）：
//   1. host/roundLifecycle 轮次生命周期载荷（关联键 run|record × 相位 settled|idle|failed）
//      的类型面（构造级）+ 行为面（结构守卫正/负样本）；
//   2. host/streamDelta 的 recordId 关联形态（interact 续聊轮，D1-A 裁定）+ v1 形态兼容；
//   3. run.params.chat 会话形态参数（recordId + resume 锚点，对照 EngineHandleData
//      定位形态的闭包断言）；priority 不进协议的字段面证明；
//   4. conversation gate 位负向：manifest 无 gate 位 → chat 请求同步拒（错误码 +
//      恢复指引文案契约，验收 A6 的 SDK 层子集）；
//   5. 版本兼容：ENGINE_PROTOCOL_VERSION 保持 1，v1 形态载荷零破坏（additive-only）。

import { describe, expect, it } from "vitest";

import {
  ENGINE_PROTOCOL_VERSION,
  REVERSE_CHANNEL_TIMEOUT_CLASS,
  assertChatConversationSupported,
  engineConversationUnsupportedError,
  isHostRoundLifecycleParams,
  isHostStreamDeltaParams,
  EngineSdkError,
  type AgentUsage,
  type AssertMutuallyAssignable,
  type EngineCapabilities,
  type EngineHandleData,
  type HostRoundLifecycleParams,
  type HostStreamDeltaParams,
  type ResumeAnchor,
  type RoundActivePhase,
  type RunChatParams,
  type RunParams,
} from "../protocol/index.ts";

// ============================================================
// 1. host/roundLifecycle 轮次生命周期载荷
// ============================================================

describe("host/roundLifecycle 载荷（轮次终态 + record 回写 + resume 锚点）", () => {
  const usage: AgentUsage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 };
  const anchor: ResumeAnchor = {
    sessionRef: { recordId: "rec-1", sessionFile: "/data/sessions/a.jsonl" },
    poolKey: "shared",
  };

  it("关联键 × 相位全形态可构造（run 域轮 = runId；interact 续聊轮 = recordId——D1-A 裁定）", () => {
    const frames: HostRoundLifecycleParams[] = [
      { runId: "run-1", phase: "settled", usage },
      { runId: "run-1", phase: "idle", anchor },
      {
        runId: "run-1",
        phase: "failed",
        error: { code: "engine_run_failed", message: "boom", recovery: "retry" },
      },
      { runId: "run-1", phase: "active" },
      { recordId: "rec-1", phase: "settled" },
      { recordId: "rec-1", phase: "idle", usage, anchor },
      {
        recordId: "rec-1",
        phase: "failed",
        error: { code: "engine_run_failed", message: "EPIPE fallback exhausted", recovery: "retry" },
        anchor,
      },
      { recordId: "rec-1", phase: "active" },
    ];
    expect(frames).toHaveLength(8);
    for (const frame of frames) {
      expect(isHostRoundLifecycleParams(frame)).toBe(true);
    }
  });

  it("active 相位 = 轮内心跳（F3）：无载荷（无文本、无 usage），两键形态均过守卫", () => {
    const runKeyed: HostRoundLifecycleParams = { runId: "run-1", phase: "active" };
    const recordKeyed: HostRoundLifecycleParams = { recordId: "rec-1", phase: "active" };
    expect(isHostRoundLifecycleParams(runKeyed)).toBe(true);
    expect(isHostRoundLifecycleParams(recordKeyed)).toBe(true);
    // 字段面：相位本体只有 phase（无 usage/anchor/error 载荷位——类型层证明）
    type _ActiveKeys = AssertMutuallyAssignable<keyof RoundActivePhase, "phase">;
    const check: _ActiveKeys = true;
    expect(check).toBe(true);
  });

  it("结构守卫负向：无关联键 / 双键 / 未知相位 / failed 缺 error 形状全拒", () => {
    expect(isHostRoundLifecycleParams({ phase: "settled" })).toBe(false);
    expect(
      isHostRoundLifecycleParams({ runId: "r", recordId: "rec", phase: "settled" }),
    ).toBe(false);
    expect(isHostRoundLifecycleParams({ runId: "r", phase: "started" })).toBe(false);
    expect(isHostRoundLifecycleParams({ runId: "r", phase: "failed" })).toBe(false);
    expect(
      isHostRoundLifecycleParams({ runId: "r", phase: "failed", error: { code: 42 } }),
    ).toBe(false);
    expect(isHostRoundLifecycleParams(null)).toBe(false);
    expect(isHostRoundLifecycleParams("settled")).toBe(false);
  });

  it("failed 相位承载结构化失败原因（record 回写「如实标 failed」的载荷面）", () => {
    const frame: HostRoundLifecycleParams = {
      recordId: "rec-9",
      phase: "failed",
      error: { code: "engine_crashed", message: "child exited", recovery: "re-spawn" },
    };
    if (frame.phase !== "failed") throw new Error("discriminant failed");
    expect(frame.error.code).toBe("engine_crashed");
    expect(frame.error.message).toBe("child exited");
  });

  it("idle 相位锚点 = EngineHandleData 定位形态（冷续锚点对照闭包）", () => {
    // Pick<EngineHandleData, 定位三键> 与 ResumeAnchor 双向可赋值——锚点即 handle
    // 定位键的投影子集（诊断字段不随锚点走），类型层漂移在 typecheck 期抓出。
    type _AnchorMatchesHandle = AssertMutuallyAssignable<
      Pick<EngineHandleData, "sessionRef" | "poolKey" | "journalPath">,
      ResumeAnchor
    >;
    const check: _AnchorMatchesHandle = true;
    expect(check).toBe(true);
  });

  it("数据面超时二分归属（终态回执必须被确认，10s 未答 = 引擎故障）", () => {
    expect(REVERSE_CHANNEL_TIMEOUT_CLASS["host/roundLifecycle"]).toBe("data-plane");
  });
});

// ============================================================
// 2. host/streamDelta 关联键扩展
// ============================================================

describe("host/streamDelta 关联键（interact 续聊轮以 recordId 关联）", () => {
  it("v1 形态（runId）不受影响——additive-only 的向后兼容证明", () => {
    const v1Form: HostStreamDeltaParams = { runId: "run-1", delta: "text" };
    expect(isHostStreamDeltaParams(v1Form)).toBe(true);
  });

  it("v1.x 形态（recordId，经 handle.sessionRef）可构造且过守卫", () => {
    const roundForm: HostStreamDeltaParams = { recordId: "rec-1", delta: "text" };
    expect(isHostStreamDeltaParams(roundForm)).toBe(true);
  });

  it("结构守卫负向：无键 / 双键 / delta 非 string 全拒", () => {
    expect(isHostStreamDeltaParams({ delta: "x" })).toBe(false);
    expect(isHostStreamDeltaParams({ runId: "r", recordId: "rec", delta: "x" })).toBe(false);
    expect(isHostStreamDeltaParams({ runId: "r", delta: 42 })).toBe(false);
    expect(isHostStreamDeltaParams(undefined)).toBe(false);
  });

  it("载荷字段面无 priority（wire 不承载，留 core 侧调度）", () => {
    type _DeltaKeys = AssertMutuallyAssignable<keyof HostStreamDeltaParams, "runId" | "recordId" | "delta">;
    const check: _DeltaKeys = true;
    expect(check).toBe(true);
  });
});

// ============================================================
// 3. run.params.chat 会话形态参数
// ============================================================

describe("run.params.chat（会话形态参数 + 冷续 resume 锚点）", () => {
  const v1Run: RunParams = {
    runId: "run-1",
    task: { prompt: "do" },
    ctx: { poolKey: "shared", cwd: "/tmp" },
  };

  it("v1 形态（无 chat 字段）零破坏——旧宿主/引擎语义不变", () => {
    expect(v1Run.chat).toBeUndefined();
  });

  it("chat 载荷可构造：recordId + 冷续锚点（HostChatRoundTicket「record」字段的承载位）", () => {
    const chatRun: RunParams = {
      ...v1Run,
      task: { prompt: "hi", conversation: true },
      chat: {
        recordId: "rec-1",
        resume: { sessionRef: { sessionFile: "/data/sessions/a.jsonl" }, poolKey: "shared" },
      },
    };
    expect(chatRun.chat?.recordId).toBe("rec-1");
    expect(chatRun.chat?.resume?.sessionRef.sessionFile).toBe("/data/sessions/a.jsonl");
  });

  it("首轮新 session（无 resume）与冷续（带 resume）两形态均可表达", () => {
    const first: RunChatParams = { recordId: "rec-1" };
    const cold: RunChatParams = {
      recordId: "rec-1",
      resume: { sessionRef: { recordId: "rec-1", sessionFile: "/s/a.jsonl" }, poolKey: "shared" },
    };
    expect(first.resume).toBeUndefined();
    expect(cold.resume?.poolKey).toBe("shared");
  });

  it("字段面 = recordId | resume（无 priority / 无其他宿主编排字段渗入）", () => {
    type _ChatKeys = AssertMutuallyAssignable<keyof RunChatParams, "recordId" | "resume">;
    const check: _ChatKeys = true;
    expect(check).toBe(true);
  });
});

// ============================================================
// 4. conversation gate 位负向（验收 A6 的 SDK 层子集）
// ============================================================

describe("conversation gate：manifest 无 gate 位的引擎收到 chat 请求同步拒", () => {
  const noGateCaps: Pick<EngineCapabilities, "conversation"> = { conversation: "unsupported" };

  it("unsupported → 抛 engine_capability_unsupported，recovery 含恢复指引闭环", () => {
    expect(() => assertChatConversationSupported("zcode", noGateCaps)).toThrowError(EngineSdkError);
    let thrown: unknown;
    try {
      assertChatConversationSupported("zcode", noGateCaps);
    } catch (err) {
      thrown = err;
    }
    const e = thrown as EngineSdkError;
    expect(e.code).toBe("engine_capability_unsupported");
    // 文案契约：detail 含引擎 id + 能力位依据；recovery 双通道（去参降级 / 修声明升级）
    expect(e.message).toContain("zcode");
    expect(e.message).toContain("capabilities.conversation = 'unsupported'");
    expect(e.recovery).toContain("去掉 conversation 参数");
    expect(e.recovery).toContain("修 manifest capabilities");
    expect(e.recovery).toContain("升级引擎包");
    // data 携带结构化判据（GUI/日志分流用）
    expect(e.data).toEqual({ engineId: "zcode", capability: "conversation", declared: "unsupported" });
  });

  it("具名构造器独立可消费（协议 error 帧投影形态完整）", () => {
    const err = engineConversationUnsupportedError("old-engine");
    expect(err.toStructured()).toMatchObject({
      code: "engine_capability_unsupported",
      message: expect.stringContaining("old-engine"),
      recovery: expect.stringContaining("升级引擎包"),
    });
  });

  it("native → 放行（chat 路由正常，A6 的 run 域不受影响方向）", () => {
    expect(() =>
      assertChatConversationSupported("pi", { conversation: "native" }),
    ).not.toThrow();
  });
});

// ============================================================
// 5. 版本兼容（major 不 bump；增量 additive-only）
// ============================================================

describe("版本兼容（v1.x = 可选载荷增量，无 minor 协商位）", () => {
  it("ENGINE_PROTOCOL_VERSION 保持 1（chat 增量不 bump major、不引入 minor 位）", () => {
    expect(ENGINE_PROTOCOL_VERSION).toBe(1);
  });

  it("v1 全量形态仍可构造（run 帧 / streamDelta / 生命周期 recordId 形态共存不互斥）", () => {
    const v1Run: RunParams = {
      runId: "r",
      task: { prompt: "p" },
      ctx: { poolKey: "shared", cwd: "/" },
    };
    const v1Delta: HostStreamDeltaParams = { runId: "r", delta: "d" };
    const v1xCycle: HostRoundLifecycleParams = { recordId: "rec", phase: "settled" };
    expect(v1Run.chat).toBeUndefined();
    expect(isHostStreamDeltaParams(v1Delta)).toBe(true);
    expect(isHostRoundLifecycleParams(v1xCycle)).toBe(true);
  });
});
