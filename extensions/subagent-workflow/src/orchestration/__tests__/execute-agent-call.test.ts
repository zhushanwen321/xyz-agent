// src/orchestration/__tests__/execute-agent-call.test.ts
//
// U2: executeAgentCall 透传 stream 给 runner.run
// U3: executeAgentCall retry 递归也透传 stream（不丢、不重建）

import { describe, expect, it, vi } from "vitest";

import { executeAgentCall } from "../execute-agent-call.ts";
import { AgentCall } from "../models/agent-call.ts";
import { Budget } from "../models/budget.ts";
import type { AgentRunner } from "../models/ports.ts";
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
