// src/orchestration/__tests__/agent-call-stream.test.ts
//
// [H2 W3] 原 U4/U5（dispatchAgentCall 创建 SubagentStream + widgetKey 格式）与
// U6（streamSink undefined 降级）锁定的是 pump 旁路 streaming 通道——该族随设计
// subagent-workflow-record-unification.md D2「stream 通道承接」退役：pump 不再
// 构造 SubagentStream（streaming 由 service 派发路径既有通道承载），streamSink
// 注入面保留给 W4 之前的旧 runner 回退路径。
//
// 本文件改为锁定退役后的行为：
// - U4'：streamSink 已注入时 dispatchAgentCall 也不再创建 stream（setWidget 零调用）
// - U6：streamSink=undefined 时 runner.run 仍被调用，无异常（原行为保留）

import { describe, expect, it, vi } from "vitest";

import { handleWorkerMessage } from "../worker-message-pump.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import { Trace } from "../models/trace.ts";
import type { WorkflowRun } from "../models/workflow-run.ts";
import type { AgentResult } from "../models/types.ts";

// ── helpers ──────────────────────────────────────────────────

function makeMockResult(): AgentResult {
  return { content: "OK", durationMs: 10, error: undefined, toolCalls: [] };
}

/** 构造 status="running" 的 mock WorkflowRun，含 trace/budget/calls/runtime */
function makeRunningRun(runId: string): WorkflowRun {
  const trace = new Trace();
  const controller = new AbortController();
  return {
    runId,
    spec: { scriptName: "test-wf", scriptSource: "agent('hi')", args: {}, runId, slug: undefined },
    state: {
      status: "running" as const,
      reason: undefined,
      trace,
      budget: {
        usedTokens: 0,
        usedCost: 0,
        totalCallCount: 0,
        consume: vi.fn(),
        isExceeded: vi.fn(() => false),
        incrementCallCount: vi.fn(),
      },
      calls: new Map(),
      scriptResult: undefined,
    },
    meta: { startedAt: new Date().toISOString(), workerErrorCount: 0, scriptErrorCount: 0 },
    runtime: {
      controller,
      worker: { postMessage: vi.fn() },
    },
    transition: vi.fn(),
    replaceRuntime: vi.fn(),
  } as unknown as WorkflowRun;
}

/** LifecycleDeps mock，runner.run 可控制返回值，streamSink 可配置 */
function makeDeps(opts: {
  streamSink?: { setWidget: ReturnType<typeof vi.fn> };
  runnerResult?: AgentResult;
} = {}): LifecycleDeps {
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn() },
    runner: { run: vi.fn(async () => opts.runnerResult ?? makeMockResult()) },
    runs: new Map(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
    streamSink: opts.streamSink,
  } as unknown as LifecycleDeps;
}

function makeHandlers(): WorkerHandlers {
  return {
    onMessage: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onExit: vi.fn(async () => {}),
  } as unknown as WorkerHandlers;
}

/** agent-call 消息 */
function makeAgentCallMsg(callId: number): unknown {
  return {
    type: "agent-call",
    callId,
    phase: "test-phase",
    opts: { prompt: "test task", agent: "worker", description: "test-slug" },
  };
}

// ── U4': stream 通道退役（负面断言） ──

describe("U4': [H2 W3] dispatchAgentCall 不再创建 SubagentStream", () => {
  it("streamSink 已注入 → setWidget 零调用（streaming 由 service 派发路径承载，D2）", async () => {
    const setWidget = vi.fn();
    const deps = makeDeps({ streamSink: { setWidget } });
    const run = makeRunningRun("wf-test-123");
    const handlers = makeHandlers();

    await handleWorkerMessage(run, makeAgentCallMsg(0), deps, handlers);
    // dispatchAgentCall 内 void dispatchCall()（fire-and-forget），等 microtask 完成
    await vi.waitFor(() => {
      expect(run.state.calls.get(0)?.status).toBe("done");
    });

    expect(setWidget).not.toHaveBeenCalled();
  });
});

// ── U6: streamSink 为 undefined 时不报错 ──

describe("U6: streamSink undefined 降级", () => {
  it("streamSink=undefined → runner.run 仍被调用，无异常", async () => {
    const runnerRun = vi.fn(async () => makeMockResult());
    const deps = {
      store: { save: vi.fn(async () => {}) },
      workerHost: { start: vi.fn() },
      runner: { run: runnerRun },
      runs: new Map(),
      eventBus: { emit: vi.fn() },
      onRunDone: vi.fn(),
      log: vi.fn(),
      // streamSink 不设 = undefined
    } as unknown as LifecycleDeps;
    const run = makeRunningRun("wf-test-456");
    const handlers = makeHandlers();

    await handleWorkerMessage(run, makeAgentCallMsg(0), deps, handlers);

    expect(runnerRun).toHaveBeenCalledTimes(1);
  });
});
