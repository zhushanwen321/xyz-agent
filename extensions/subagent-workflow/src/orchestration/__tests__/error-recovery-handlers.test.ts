/**
 * error-recovery handlers — handleWorkerExit/Error/ScriptError + postBudgetUpdate 测试。
 *
 * 参考 error-recovery-workflow-call.test.ts 的 mock 构建。通过 vi.useFakeTimers() 跳过
 * scheduleRebuild 的指数退避（1s/2s/4s）。
 *
 * 覆盖：
 * - handleWorkerExit：code=0 正常退出（no-op） / code!=0 委托 handleWorkerError / stale handle 过滤
 * - handleWorkerError：超限（count > MAX=3）→ transition done,failed + emit pending:unregister
 *   / 未超限 → rebuildRuntime（workerHost.start 重建）
 * - handleScriptError：超限 → transition done,failed / workerLogs 捕获
 * - postBudgetUpdate：postMessage budget-update（usedTokens/usedCost）
 * - stale handle 过滤（handle.isCurrent=false）+ terminal stale 守卫（isTerminal 语义）
 * - rebuildRuntime：worker 崩溃后 workerHost.start + scheduleTimeBudget 重排 + replaceRuntime
 *   + 在飞 call 清理（discardInFlightCalls 生效：在飞清除、done 保留）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConcurrencyGate } from "../concurrency-gate.ts";
import {
  handleScriptError,
  handleWorkerError,
  handleWorkerExit,
  handleWorkerMessage,
  postBudgetUpdate,
  rebuildRuntime,
} from "../error-recovery.ts";
import { Budget } from "../models/budget.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import type { AgentResult } from "../models/types.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";

// ── helpers ──────────────────────────────────────────────────

/** 构造一个 status="running" 的 mock WorkflowRun，meta 可配置。 */
function makeRunningRun(opts: {
  workerErrorCount?: number;
  scriptErrorCount?: number;
  budgetTimeMs?: number;
  postMessage?: ReturnType<typeof vi.fn>;
} = {}): WorkflowRun {
  return {
    state: {
      status: "running",
      budget: { usedTokens: 50, usedCost: 0.1 },
      // L9: errorLogs 现在用 push 追加——必须是真实数组，不能省略
      errorLogs: [],
      // rebuildRuntime 内 discardInFlightCalls 遍历 calls + 移除 trace 节点——
      // 必须是真实 Map（空 = 无在飞 call，discard 为 no-op）
      calls: new Map(),
      trace: { removeByStepIndex: vi.fn() },
    },
    meta: {
      startedAt: new Date().toISOString(),
      workerErrorCount: opts.workerErrorCount,
      scriptErrorCount: opts.scriptErrorCount,
    },
    spec: {
      scriptName: "test-wf",
      scriptSource: "execute() {}",
      args: {},
      budgetTimeMs: opts.budgetTimeMs,
    },
    runtime: {
      worker: { postMessage: opts.postMessage ?? vi.fn() },
    },
    // transition 副作用——run.state.status 由调用方通过 mock 控制后再次断言
    transition(target: string, reason?: string): void {
      this.state.status = target;
      if (target === "done") this.state.reason = reason;
    },
    replaceRuntime(rt: unknown): void {
      this.runtime = rt;
    },
  } as unknown as WorkflowRun;
}

/** LifecycleDeps mock：store/workerHost/runner/eventBus/scheduleTimeBudget 可观察。 */
function makeDeps(opts: {
  scheduleTimeBudget?: LifecycleDeps["scheduleTimeBudget"];
} = {}): LifecycleDeps & {
  store: { save: ReturnType<typeof vi.fn> };
  workerHost: { start: ReturnType<typeof vi.fn> };
  eventBus: { emit: ReturnType<typeof vi.fn> };
  onRunDone: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn() })) },
    runner: { run: vi.fn(async () => ({})) },
    runs: new Map(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
    scheduleTimeBudget: opts.scheduleTimeBudget,
  } as unknown as ReturnType<typeof makeDeps>;
}

/** WorkerHandlers 占位（handler 路径递归调本对象上的回调，但测试场景不触发）。 */
function makeHandlers(): WorkerHandlers {
  return {
    onMessage: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onExit: vi.fn(async () => {}),
  } as unknown as WorkerHandlers;
}

/** 构造 mock WorkerHandle（isCurrent 可配）。 */
function makeHandle(isCurrent = true): WorkerHandle {
  return { isCurrent } as unknown as WorkerHandle;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── handleWorkerExit ─────────────────────────────────────────

describe("handleWorkerExit", () => {
  it("code=0 正常退出：no-op（不 transition、不 save）", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();
    const handle = makeHandle(true);

    await handleWorkerExit(run, 0, handle, deps, makeHandlers());

    expect(run.state.status).toBe("running"); // 未改
    expect(deps.store.save).not.toHaveBeenCalled();
    expect(deps.eventBus.emit).not.toHaveBeenCalled();
  });

  it("code!=0 异常退出：委托 handleWorkerError → 超 MAX 重试 → transition done,failed", async () => {
    // workerErrorCount 已达 MAX=3 → handleWorkerError 内 count=4 > 3 → failed
    const run = makeRunningRun({ workerErrorCount: 3 });
    const deps = makeDeps();
    const handle = makeHandle(true);

    await handleWorkerExit(run, 1, handle, deps, makeHandlers());

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toContain("Worker exited with code 1");
    // 持久化 + 完成通知
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("stale handle（isCurrent=false）：丢弃 exit 事件，不处理", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();
    const staleHandle = makeHandle(false);

    await handleWorkerExit(run, 1, staleHandle, deps, makeHandlers());

    // 状态未变，store 未 save
    expect(run.state.status).toBe("running");
    expect(deps.store.save).not.toHaveBeenCalled();
  });

  it("run 已终态（done）：stale 守卫前置丢弃", async () => {
    const run = makeRunningRun();
    run.state.status = "done";
    (run.state as { reason?: string }).reason = "completed";
    const deps = makeDeps();
    const handle = makeHandle(true);

    await handleWorkerExit(run, 1, handle, deps, makeHandlers());

    expect(deps.store.save).not.toHaveBeenCalled();
  });
});

// ── handleWorkerError ────────────────────────────────────────

describe("handleWorkerError", () => {
  it("count > MAX（3）：transition done,failed + save + emit pending:unregister", async () => {
    // workerErrorCount=3 → count=4 > MAX
    const run = makeRunningRun({ workerErrorCount: 3 });
    const deps = makeDeps();

    await handleWorkerError(run, new Error("worker boom"), deps, makeHandlers());

    expect(run.meta.workerErrorCount).toBe(4);
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toBe("worker boom");
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.eventBus.emit).toHaveBeenCalledWith("pending:unregister", {
      id: undefined, // mock run 无 runId
      reason: "failed",
    });
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("count <= MAX：退避 + rebuildRuntime（workerHost.start 重建新 runtime）", async () => {
    const run = makeRunningRun({ workerErrorCount: 0 }); // count=1 <= MAX
    const deps = makeDeps();

    const promise = handleWorkerError(run, new Error("transient"), deps, makeHandlers());

    // 推进指数退避（第 1 次重试：1s）
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(run.meta.workerErrorCount).toBe(1);
    // 状态仍 running（重试不改 status）
    expect(run.state.status).toBe("running");
    // workerHost.start 被调（rebuildRuntime 内重建 worker）
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
  });

  it("终态（done）：stale 守卫前置丢弃（不递增 workerErrorCount）", async () => {
    const run = makeRunningRun();
    run.state.status = "done";
    (run.state as { reason?: string }).reason = "completed";
    const deps = makeDeps();

    await handleWorkerError(run, new Error("stale"), deps, makeHandlers());

    expect(run.meta.workerErrorCount).toBeUndefined(); // 未递增
    expect(deps.store.save).not.toHaveBeenCalled();
  });
});

// ── handleScriptError ────────────────────────────────────────

describe("handleScriptError", () => {
  it("count > MAX（3）：transition done,failed + 捕获 workerLogs", async () => {
    const run = makeRunningRun({ scriptErrorCount: 3 }); // count=4 > MAX
    const deps = makeDeps();
    const workerLogs = [
      { level: "error" as const, message: "line 5 boom" },
    ];

    await handleScriptError(run, "TypeError: x is undefined", workerLogs, deps, makeHandlers());

    expect(run.meta.scriptErrorCount).toBe(4);
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toContain("Workflow failed after 3 retries");
    expect(run.state.error).toContain("TypeError: x is undefined");
    // workerLogs 捕获到 errorLogs
    expect(run.state.errorLogs).toEqual(workerLogs);
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("count <= MAX：退避 + rebuildRuntime", async () => {
    const run = makeRunningRun({ scriptErrorCount: 1 }); // count=2 <= MAX
    const deps = makeDeps();

    const promise = handleScriptError(run, "ReferenceError", [], deps, makeHandlers());

    // 第 2 次重试退避：2s
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(run.meta.scriptErrorCount).toBe(2);
    expect(run.state.status).toBe("running");
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
  });

  it("terminal 状态：stale 守卫前置丢弃", async () => {
    const run = makeRunningRun();
    run.state.status = "done";
    (run.state as { reason?: string }).reason = "completed";
    const deps = makeDeps();

    await handleScriptError(run, "late error", [], deps, makeHandlers());

    expect(run.meta.scriptErrorCount).toBeUndefined();
    expect(deps.store.save).not.toHaveBeenCalled();
  });
});

// ── postBudgetUpdate ─────────────────────────────────────────

describe("postBudgetUpdate", () => {
  it("向 worker postMessage budget-update（usedTokens/usedCost）", () => {
    const postMessage = vi.fn();
    const run = makeRunningRun({ postMessage });

    postBudgetUpdate(run);

    expect(postMessage).toHaveBeenCalledWith({
      type: "budget-update",
      budget: { usedTokens: 50, usedCost: 0.1 },
    });
  });

  it("runtime 不存在时 no-op（不抛错）", () => {
    const run = makeRunningRun();
    // runtime.worker.postMessage 为 undefined 时应安全
    run.runtime = undefined;

    expect(() => postBudgetUpdate(run)).not.toThrow();
  });
});

// ── rebuildRuntime ───────────────────────────────────────────

describe("rebuildRuntime", () => {
  it("worker 崩溃后重建：workerHost.start + replaceRuntime（保持 running）", () => {
    const run = makeRunningRun({ budgetTimeMs: 0 }); // 无时间预算
    const deps = makeDeps();

    rebuildRuntime(run, deps, makeHandlers());

    // workerHost.start 被调（构造新 worker）
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
    // replaceRuntime 被调（新 runtime 绑定，mock 内仅替换 runtime 字段）
    expect(run.runtime).toBeDefined();
    // status 仍 running（replaceRuntime 不改 status）
    expect(run.state.status).toBe("running");
  });

  it("带 budgetTimeMs 时重排 scheduleTimeBudget 计时器", () => {
    const run = makeRunningRun({ budgetTimeMs: 5000 });
    const scheduleTimeBudget = vi.fn(() => undefined);
    const deps = makeDeps({ scheduleTimeBudget });

    rebuildRuntime(run, deps, makeHandlers());

    // D-12 regression fix (round-2 #2)：replaceRuntime 后重排时间预算
    expect(scheduleTimeBudget).toHaveBeenCalledTimes(1);
    // 第 1 参 = runId（mock run 无 runId），第 2 参 = budgetTimeMs
    const args = scheduleTimeBudget.mock.calls[0]!;
    expect(args[1]).toBe(5000);
  });

  it("无 scheduleTimeBudget 注入时不重排（向后兼容，不抛错）", () => {
    const run = makeRunningRun({ budgetTimeMs: 5000 });
    const deps = makeDeps({ scheduleTimeBudget: undefined });

    expect(() => rebuildRuntime(run, deps, makeHandlers())).not.toThrow();
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
  });

  it("rebuildRuntime 后同步清理在飞 call（status !== done 清除、done 保留）", () => {
    const run = makeRunningRun({ budgetTimeMs: 0 });
    // 注入在飞 call（running）与已完成 call（done）+ trace 节点移除 spy
    const removeByStepIndex = vi.fn();
    const calls = new Map<number, { id: number; status: string }>([
      [7, { id: 7, status: "running" }],
      [8, { id: 8, status: "done" }],
    ]);
    (run.state as { calls: unknown }).calls = calls;
    (run.state as { trace: unknown }).trace = { removeByStepIndex };
    const deps = makeDeps();

    rebuildRuntime(run, deps, makeHandlers());

    // 在飞 call（running）被移除（含 trace 节点）；已完成 call（done）保留供重跑 replay
    expect(calls.has(7)).toBe(false);
    expect(calls.has(8)).toBe(true);
    expect(removeByStepIndex).toHaveBeenCalledTimes(1);
    expect(removeByStepIndex).toHaveBeenCalledWith(7);
    // 重建本身不受影响
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
  });
});

// ── orphan call guard（S7-second 竞态回归） ─────────────────
//
// 复刻 gate-report §3 的竞态形态：dispatch agent-call → 立即 rebuildRuntime（同步
// discard 在飞 call）→ 旧 dispatch 的 promise 以失败/成功 resolve → 迟到的旧代际
// 结果不得经 postAgentResult 投给**新 worker** 的同 callId pending（否则重跑中的
// agent() 被旧结果劫持 resolve 为空串 → 脚本假成功，PHASE_B 子进程被连带收割）。
//
// 用真实 WorkflowRun/RunRuntime/Trace/Budget（而非 makeRunningRun 的简化 mock）：
// rebuildRuntime → replaceRuntime → release 的 abort 旧 controller / terminate 旧
// worker / discardInFlightCalls 全链路需要真实聚合根行为才成立。

/** 手动控制的 deferred——精确编排「dispatch 挂起 → rebuild → 旧 promise settle」交错。 */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** flush 微任务队列（dispatch 的 fire-and-forget promise 链推进到稳定态）。 */
async function flushMicrotasks(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

/** 构造真实 WorkflowRun（真实状态机/replaceRuntime/Trace/Budget）+ 初始 RunRuntime。 */
function makeRealRun(runId: string): WorkflowRun {
  const run = new WorkflowRun(
    runId,
    {
      scriptName: "test-wf",
      scriptSource: "agent('hi')",
      args: {},
      scriptPath: "/tmp/test-wf.js",
    },
    {
      status: "running",
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
  // 初始 worker mock 必须带 terminate——真实 replaceRuntime 会 release 旧 runtime
  const initialWorker = {
    postMessage: vi.fn(),
    terminate: vi.fn(async () => {}),
  } as unknown as WorkerHandle;
  run.assignRuntime(new RunRuntime(initialWorker, new ConcurrencyGate(), new AbortController()));
  return run;
}

/** agent-call 消息（opts 无 skill/schema——resolveAgentOpts 直通，无 IO）。 */
function makeAgentCallMsg(callId: number): unknown {
  return {
    type: "agent-call",
    callId,
    opts: { prompt: "test task", agent: "worker", description: "test-slug" },
  };
}

/** 从 postMessage spy 的调用记录中找 type:"agent-result" 且 callId 匹配的报文。 */
function findAgentResultPost(
  postMessage: ReturnType<typeof vi.fn>,
  callId: number,
): { type: string; callId: number; result: AgentResult; cached: boolean } | undefined {
  for (const call of postMessage.mock.calls) {
    const msg = call[0] as { type?: string; callId?: number };
    if (msg?.type === "agent-result" && msg.callId === callId) {
      return msg as never;
    }
  }
  return undefined;
}

describe("orphan call guard（rebuild 后迟到 completion 不投递新 worker）", () => {
  it("失败路径：discard + 重跑替换后，旧 dispatch 的失败 completion 不投新 worker、不复活 Map 条目", async () => {
    const run = makeRealRun("wf-orphan-1");
    const deps = makeDeps();
    // rebuild 的新 worker——postMessage 记录用于断言「孤儿结果未投递」
    const newWorkerPost = vi.fn();
    deps.workerHost.start.mockImplementation(
      () =>
        ({ postMessage: newWorkerPost, terminate: vi.fn(async () => {}) }) as unknown as WorkerHandle,
    );
    const handlers = makeHandlers();

    // 旧 runtime 代际：dispatch callId=1，runner 挂起（模拟在飞子进程）
    const deferredA = createDeferred<AgentResult>();
    deps.runner.run.mockImplementation(() => deferredA.promise);
    await handleWorkerMessage(run, makeAgentCallMsg(1), deps, handlers);
    await flushMicrotasks();
    expect(run.state.calls.get(1)?.status).toBe("running");

    // worker 崩溃 → rebuildRuntime：replaceRuntime（abort 旧 controller）+ 同步 discard 在飞 call
    rebuildRuntime(run, deps, handlers);
    expect(run.state.calls.has(1)).toBe(false);
    expect(run.state.trace.find(1)).toBeUndefined();

    // 新 worker 重跑脚本：同 callId=1 再 dispatch（重跑实例 B 挂起在飞）
    const deferredB = createDeferred<AgentResult>();
    deps.runner.run.mockImplementation(() => deferredB.promise);
    await handleWorkerMessage(run, makeAgentCallMsg(1), deps, handlers);
    await flushMicrotasks();
    const rerunCall = run.state.calls.get(1);
    expect(rerunCall).toBeDefined();

    // 旧 dispatch 的 promise 以失败 resolve（abort 收割子进程后的迟到 finalize，
    // error 含 "aborted" 命中 stale-context 快速路径——真实形态）
    deferredA.resolve({ content: "", error: "Subprocess aborted by runtime shutdown" });
    await flushMicrotasks();

    // 孤儿失败结果不得投给新 worker（否则劫持重跑 pending 为空串假成功）
    expect(findAgentResultPost(newWorkerPost, 1)).toBeUndefined();
    // calls Map 无孤儿复活条目：callId=1 仍是重跑实例 B
    expect(run.state.calls.get(1)).toBe(rerunCall);
  });

  it("成功路径：discard 后旧 dispatch 的成功 completion 不投新 worker、不复活 Map/trace 条目", async () => {
    const run = makeRealRun("wf-orphan-2");
    const deps = makeDeps();
    const newWorkerPost = vi.fn();
    deps.workerHost.start.mockImplementation(
      () =>
        ({ postMessage: newWorkerPost, terminate: vi.fn(async () => {}) }) as unknown as WorkerHandle,
    );

    const deferred = createDeferred<AgentResult>();
    deps.runner.run.mockImplementation(() => deferred.promise);
    await handleWorkerMessage(run, makeAgentCallMsg(2), deps, makeHandlers());
    await flushMicrotasks();

    rebuildRuntime(run, deps, makeHandlers());
    expect(run.state.calls.has(2)).toBe(false);

    // 旧 promise 以成功 resolve（runner 已完成、结果晚于 rebuild 到达）
    deferred.resolve({ content: "late success", durationMs: 5, error: undefined, toolCalls: [] });
    await flushMicrotasks();

    expect(findAgentResultPost(newWorkerPost, 2)).toBeUndefined();
    expect(run.state.calls.has(2)).toBe(false);
    expect(run.state.trace.find(2)).toBeUndefined();
  });

  it("catch 路径：discard 后旧 dispatch 的异常 reject 不投新 worker、不复活 Map 条目", async () => {
    // catch 块的 logger.error 会打印——静默防噪音
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const run = makeRealRun("wf-orphan-3");
      const deps = makeDeps();
      const newWorkerPost = vi.fn();
      deps.workerHost.start.mockImplementation(
        () =>
          ({ postMessage: newWorkerPost, terminate: vi.fn(async () => {}) }) as unknown as WorkerHandle,
      );

      const deferred = createDeferred<AgentResult>();
      deps.runner.run.mockImplementation(() => deferred.promise);
      await handleWorkerMessage(run, makeAgentCallMsg(3), deps, makeHandlers());
      await flushMicrotasks();

      rebuildRuntime(run, deps, makeHandlers());
      expect(run.state.calls.has(3)).toBe(false);

      deferred.reject(new Error("runner exploded"));
      await flushMicrotasks();

      expect(findAgentResultPost(newWorkerPost, 3)).toBeUndefined();
      expect(run.state.calls.has(3)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("非孤儿正常路径：成功 completion 照常投递 agent-result（守卫不误伤）", async () => {
    const run = makeRealRun("wf-orphan-4");
    const deps = makeDeps();
    const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;
    deps.runner.run.mockImplementation(
      async () => ({ content: "real result", durationMs: 1, error: undefined, toolCalls: [] }) as AgentResult,
    );

    await handleWorkerMessage(run, makeAgentCallMsg(4), deps, makeHandlers());
    await flushMicrotasks(20);

    const posted = findAgentResultPost(postMessage, 4);
    expect(posted).toBeDefined();
    expect(posted?.result.content).toBe("real result");
    expect(run.state.calls.get(4)?.status).toBe("done");
    expect(run.state.trace.find(4)?.status).toBe("completed");
  });
});
