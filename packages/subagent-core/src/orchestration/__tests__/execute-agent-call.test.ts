// src/orchestration/__tests__/execute-agent-call.test.ts
//
// U2: executeAgentCall 透传 stream 给 runner.run
// U3: executeAgentCall retry 递归也透传 stream（不丢、不重建）

import { describe, expect, it, vi } from "vitest";

import {
  DETERMINISTIC_SCHEMA_FAILURE_PREFIX,
  executeAgentCall,
  isDeterministicSchemaFailureMsg,
  isStaleContextErrorMsg,
  STALE_CONTEXT_PATTERNS,
} from "../execute-agent-call.ts";
import { AgentCall } from "../models/agent-call.ts";
import { Budget } from "../models/budget.ts";
import type { AgentRunner } from "../models/ports.ts";
import { describeMissingParsedOutput } from "../../execution/engine/engines/pi/output-collector.ts";
import type { ToolCall } from "../../execution/types.ts";
import { Trace } from "../models/trace.ts";
import type { ExecutionTraceNode } from "../models/types.ts";
import type { AgentCallOpts, AgentResult } from "../models/types.ts";

// ── 测试辅助 ──

function makeMockResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    content: "OK",
    durationMs: 100,
    error: undefined,
    toolCalls: [],
    ...overrides,
  };
}

function makeBaseOpts(): AgentCallOpts {
  return {
    prompt: "test task",
    agent: "worker",
    cwd: "/some/path",
  } as AgentCallOpts;
}

/** 构造一个 traceNode（ExecutionTraceNode 最小子集） */
function makeTraceNode(stepIndex = 0): ExecutionTraceNode {
  return {
    stepIndex,
    agent: "test-agent",
    task: "test task",
    model: "default",
    status: "pending",
  };
}

/** 构造 AgentCall + 关联的 Trace（call.id 与 trace 节点 stepIndex 对齐） */
function makeAgentCallAndTrace(): { call: AgentCall; trace: Trace } {
  const trace = new Trace();
  const traceNode = makeTraceNode(0);
  trace.append(traceNode);
  const call = new AgentCall(0, makeBaseOpts(), traceNode);
  return { call, trace };
}

/** 创建 mock AgentRunner（只实现 run） */
function createMockRunner(impl?: ReturnType<typeof vi.fn>): AgentRunner & { run: ReturnType<typeof vi.fn> } {
  const run = impl ?? vi.fn().mockResolvedValue(makeMockResult());
  return { run } as unknown as AgentRunner & { run: ReturnType<typeof vi.fn> };
}

// ── U2: executeAgentCall 透传 stream 给 runner.run ──

describe("U2: executeAgentCall 透传 stream", () => {
  it("executeAgentCall 传 stream → runner.run 第 4 参收到同一 stream", async () => {
    let capturedStream: unknown;
    const runner = createMockRunner(
      vi.fn().mockImplementation((_opts, _sig, _onEvt, stream) => {
        capturedStream = stream;
        return Promise.resolve(makeMockResult());
      }),
    );

    const fakeStream = { onDelta: vi.fn(), dispose: vi.fn() };
    const { call, trace } = makeAgentCallAndTrace();
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace, undefined, fakeStream as never);

    expect(capturedStream).toBe(fakeStream);
  });

  it("executeAgentCall 不传 stream → runner.run 第 4 参为 undefined", async () => {
    let capturedStream: unknown = "sentinel";
    const runner = createMockRunner(
      vi.fn().mockImplementation((_opts, _sig, _onEvt, stream) => {
        capturedStream = stream;
        return Promise.resolve(makeMockResult());
      }),
    );

    const { call, trace } = makeAgentCallAndTrace();
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(capturedStream).toBeUndefined();
  });
});

// ── U1: finalizeCall 透传 sessionFile 到 trace 节点（方案 A）──

describe("U1: finalizeCall sessionFile → trace 节点", () => {
  it("runner.run 返回带 sessionFile 的 result → trace 节点携带 sessionFile", async () => {
    const sessionFilePath = "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl";
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(
        makeMockResult({ sessionId: "session-abc", sessionFile: sessionFilePath }),
      ),
    );
    const { call, trace } = makeAgentCallAndTrace();
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    const node = trace.find(0);
    expect(node).toBeDefined();
    expect(node!.sessionFile).toBe(sessionFilePath);
    expect(node!.sessionId).toBe("session-abc");
  });

  it("runner.run 返回无 sessionFile 的 result → trace 节点 sessionFile undefined", async () => {
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeMockResult({ sessionId: "session-xyz" })),
    );
    const { call, trace } = makeAgentCallAndTrace();
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    const node = trace.find(0);
    expect(node).toBeDefined();
    expect(node!.sessionFile).toBeUndefined();
  });
});

// ── U3: retry 递归也透传 stream ──

describe("U3: executeAgentCall retry 透传 stream", () => {
  it("首次 runner.run 返回 error → retry 时第 4 参仍是同一 stream", async () => {
    vi.useFakeTimers();

    const capturedStreams: unknown[] = [];
    const runner = createMockRunner(
      vi.fn().mockImplementation((_opts, _sig, _onEvt, stream) => {
        capturedStreams.push(stream);
        // 首次 error，第二次成功
        if (capturedStreams.length === 1) {
          return Promise.resolve(makeMockResult({ error: "transient error" }));
        }
        return Promise.resolve(makeMockResult());
      }),
    );

    const fakeStream = { onDelta: vi.fn(), dispose: vi.fn() };
    const { call, trace } = makeAgentCallAndTrace();
    const budget = new Budget();

    const promise = executeAgentCall(call, runner, budget, new AbortController().signal, trace, undefined, fakeStream as never);
    // 推进 retry 退避定时器（BACKOFF_BASE_MS = 1000，首退避 1s）
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(runner.run).toHaveBeenCalledTimes(2);
    // 两次调用的第 4 参都是同一 stream 对象
    expect(capturedStreams[0]).toBe(fakeStream);
    expect(capturedStreams[1]).toBe(fakeStream);

    vi.useRealTimers();
  });
});

// ── isOrphaned 守卫（OB2：S7 残留瞬时污染根除） ──
//
// 谓词为 true 时 finalizeCall 跳过 trace.update，但 markDone 与
// sessionId/sessionFile 同步保留。U4 锁定不传谓词时的现状回归。

describe("isOrphaned 守卫", () => {
  it("U1: 谓词 () => true + 终态成功路径 → trace.update 0 次，markDone 保留（status done + result 已设置）", async () => {
    const { call, trace } = makeAgentCallAndTrace();
    const updateSpy = vi.spyOn(trace, "update");
    const runner = createMockRunner(); // 默认成功 result
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace, undefined, undefined, () => true);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(call.status).toBe("done");
    expect(call.result).toBeDefined();
    expect(call.result?.content).toBe("OK");
  });

  it("U2: 谓词 true + stale-context 失败路径 → trace.update 0 次，markDone 保留（覆盖 stale finalize 调用点）", async () => {
    const { call, trace } = makeAgentCallAndTrace();
    const updateSpy = vi.spyOn(trace, "update");
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeMockResult({ error: "context canceled" })),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace, undefined, undefined, () => true);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(call.status).toBe("done");
    expect(call.result?.error).toBe("context canceled");
  });

  it("U3: 谓词 true + 信号 abort 路径 → trace.update 0 次，markDone 保留（覆盖 abort finalize 调用点）", async () => {
    const { call, trace } = makeAgentCallAndTrace();
    const updateSpy = vi.spyOn(trace, "update");
    // 错误文案不含 stale 模式词，确保走 signal.aborted 分支而非 stale 分支
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeMockResult({ error: "old generation failure" })),
    );
    const controller = new AbortController();
    controller.abort();
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, controller.signal, trace, undefined, undefined, () => true);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(call.status).toBe("done");
    expect(call.result?.error).toBe("old generation failure");
  });

  it("U4: 谓词 undefined（不传）→ trace.update 恰被调用 1 次（现状回归锁定）", async () => {
    const { call, trace } = makeAgentCallAndTrace();
    const updateSpy = vi.spyOn(trace, "update");
    const runner = createMockRunner();
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(trace.find(0)?.status).toBe("completed");
    expect(call.status).toBe("done");
  });

  it("U5: 递归重试透传——可重试失败后成功，谓词 true → 重试后终态 trace.update 仍 0 次", async () => {
    vi.useFakeTimers();
    try {
      const { call, trace } = makeAgentCallAndTrace();
      const updateSpy = vi.spyOn(trace, "update");
      const runner = createMockRunner(
        vi.fn()
          .mockResolvedValueOnce(makeMockResult({ error: "transient error" }))
          .mockResolvedValueOnce(makeMockResult()),
      );
      const budget = new Budget();

      const promise = executeAgentCall(call, runner, budget, new AbortController().signal, trace, undefined, undefined, () => true);
      // 推进首退避 1s（BACKOFF_BASE_MS = 1000）
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(runner.run).toHaveBeenCalledTimes(2);
      expect(call.attempts).toBe(2);
      // 谓词穿透递归层：重试后终态也不写 trace
      expect(updateSpy).not.toHaveBeenCalled();
      expect(call.status).toBe("done");
      expect(call.result?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── W4b: STALE_CONTEXT_PATTERNS 对齐 pi 真实文案（stale 分诊） ──
//
// pi 0.84.x 真实 stale 文案（extensions/runner.ts:531，dist runner.js:567）：
// "This extension ctx is stale after session replacement or reload. Do not use
//  a captured pi or command ctx after ctx.newSession(), ..."
// 旧 patterns（"stale context"/"stalecontext"）与该文案零匹配（词序相反），
// stale 错误曾退化为普通错误照常重试 3 次——W4b 词序修正 + 对齐 scheduler
// 已验证 marker 'stale after session replacement'（runtime.ts STALE_CTX_MARKER）。

/** pi 真实 stale 文案前半（含 marker 全文前缀，锚定真实串而非自造缩写）。 */
const PI_REAL_STALE_MESSAGE =
  "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

describe("W4b: stale 分诊对齐 pi 真实文案", () => {
  it("真实文案全文 → isStaleContextErrorMsg true（'ctx is stale' 词序 + scheduler marker 双命中）", () => {
    expect(isStaleContextErrorMsg(PI_REAL_STALE_MESSAGE)).toBe(true);
  });

  it("patterns 含 scheduler 已验证 marker 'stale after session replacement'", () => {
    expect(STALE_CONTEXT_PATTERNS).toContain("stale after session replacement");
    expect(STALE_CONTEXT_PATTERNS).toContain("ctx is stale");
  });

  it("真实文案 → executeAgentCall 不重试（runner.run 恰 1 次）+ markDone failed", async () => {
    const { call, trace } = makeAgentCallAndTrace();
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeMockResult({ error: PI_REAL_STALE_MESSAGE })),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(call.status).toBe("done");
    expect(call.result?.error).toBe(PI_REAL_STALE_MESSAGE);
    expect(trace.find(0)?.status).toBe("failed");
  });

  it("普通 transient 错误 → 不命中 stale（照常进入重试路径，现状回归）", () => {
    expect(isStaleContextErrorMsg("transient network error")).toBe(false);
    expect(isStaleContextErrorMsg(undefined)).toBe(false);
  });
});

// ── MF-1: 确定性 schema 失败不重试 ──
//
// 回归背景（第五轮实测）：gate 终止子进程后 collectResult F-1 置归因 error →
// executeAgentCall 判非 stale 走可重试分支 → 不可满足 schema 下循环至
// MAX_ATTEMPTS=3（实测 attempts=3、4 子进程、235s vs 修复前 67.3s）。
// 修复：归因 error 带机器标记（SSOT = DETERMINISTIC_SCHEMA_FAILURE_PREFIX），
// 分诊短路。用真实链路产物（describeMissingParsedOutput）作 error 输入，锁定
// collectResult → executeAgentCall 全链路分诊行为。
//
// 三态可重试性矩阵（完整锁定在 output-collector.test 的 MF-1 describe）：
//   态① 从未调用 SO → 不可重试；态② isError（gate 终止/不可满足 schema）→ 不可重试；
//   态③ 调用过但无 details → 可重试（保留既有重试语义）。

/** 构造态②真实产物（isError SO 调用，schema 校验失败——gate 终止回归场景）。 */
function state2Attribution(): string {
  const soCalls: ToolCall[] = [
    {
      toolName: "structured-output",
      isError: true,
      result: { details: {}, content: [{ type: "text", text: "Schema validation failed: /target is required" }] },
    },
  ];
  const msg = describeMissingParsedOutput(soCalls);
  expect(msg).toBeDefined();
  return msg!;
}

describe("MF-1: 确定性 schema 失败不重试", () => {
  it("态②真实产物（gate 终止/schema 校验失败归因）→ runner.run 恰 1 次 + 终态 failed", async () => {
    const attribution = state2Attribution();
    expect(isDeterministicSchemaFailureMsg(attribution)).toBe(true);

    const { call, trace } = makeAgentCallAndTrace();
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeMockResult({ error: attribution })),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    // 修复前：循环至 MAX_ATTEMPTS=3（4 次子进程）；修复后：恰 1 次
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(call.attempts).toBe(1);
    expect(call.status).toBe("done");
    expect(trace.find(0)?.status).toBe("failed");
  });

  it("态①真实产物（never called，缺 extension 环境确定性）→ 同样不重试", async () => {
    const attribution = describeMissingParsedOutput([])!;
    const { call, trace } = makeAgentCallAndTrace();
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeMockResult({ error: attribution })),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(call.attempts).toBe(1);
    expect(trace.find(0)?.status).toBe("failed");
  });

  it("MF-2 计数不再低估：retry 不发生 → usage consume 恰一次、totalCallCount=1", async () => {
    const attribution = state2Attribution();
    const { call, trace } = makeAgentCallAndTrace();
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(
        makeMockResult({ error: attribution, usage: { input: 100, output: 50, cost: 0.01 } }),
      ),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    // 修复前：3 attempts → consume×3（usedTokens×3）；修复后：恰一次加权消耗
    // （input×1 + output×2 = 100 + 100 = 200，权重见 budget.ts）
    expect(budget.usedTokens).toBe(200);
    expect(budget.usedCost).toBeCloseTo(0.01);
    expect(budget.totalCallCount).toBe(1);
  });

  it("MF-3 归因不再混合：终态 error 保持归因原文（不被重试轮次覆盖）", async () => {
    const attribution = state2Attribution();
    const { call, trace } = makeAgentCallAndTrace();
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeMockResult({ error: attribution })),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(call.result?.error).toBe(attribution);
  });

  it("态③（no details，无标记）→ 照常重试（可重试语义保留）", async () => {
    vi.useFakeTimers();
    try {
      // 态③真实文案（不带确定性标记）——矩阵执行面锁定：无标记 = 可重试
      const msg = describeMissingParsedOutput([
        { toolName: "structured-output", result: { content: [] } },
      ])!;
      expect(isDeterministicSchemaFailureMsg(msg)).toBe(false);

      const { call, trace } = makeAgentCallAndTrace();
      const runner = createMockRunner(
        vi.fn()
          .mockResolvedValueOnce(makeMockResult({ error: msg }))
          .mockResolvedValueOnce(makeMockResult()),
      );
      const budget = new Budget();

      const promise = executeAgentCall(call, runner, budget, new AbortController().signal, trace);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(runner.run).toHaveBeenCalledTimes(2);
      expect(call.status).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("分诊交叉锁定：标记词不命中任何 STALE_CONTEXT_PATTERNS（stale 分诊在前也不误吞）", () => {
    const lower = DETERMINISTIC_SCHEMA_FAILURE_PREFIX.toLowerCase();
    for (const pattern of STALE_CONTEXT_PATTERNS) {
      expect(lower.includes(pattern)).toBe(false);
    }
    // 两个分诊只命中确定性分支，互不污染
    expect(isStaleContextErrorMsg(DETERMINISTIC_SCHEMA_FAILURE_PREFIX)).toBe(false);
    expect(isDeterministicSchemaFailureMsg(DETERMINISTIC_SCHEMA_FAILURE_PREFIX)).toBe(true);
  });
});
