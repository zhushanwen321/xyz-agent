/**
 * [F1] worker exit 无终态消息 → run failed（非悬挂）+ [SW-DATA-3] store.save 抛错不产生
 * unhandledRejection 的 handler 级回归测试。
 *
 * F1 背景：execute() 返回不可克隆值（function/Symbol/循环引用）→ worker 侧 _safePost 吞掉
 * DataCloneError → return 消息从未发出 → worker exit(0)。旧实现 handleWorkerExit 对
 * code===0 no-op → run 永久 running、runAndWait 无限挂起。
 *
 * 修复语义（本文件锚定）：
 * - exit(0) 且本 runtime 代际未收到 return/error 消息 → transition done,failed +
 *   WORKER_EXITED_WITHOUT_RESULT_MSG 归因 + pending:unregister + onRunDone
 * - exit(0) 但已收到终态消息（script-error 重试退避窗口）→ no-op（rebuild 即将发生）
 * - handleWorkerMessage 的 return/error 分支必须标记 receivedTerminalMessage（判定的依据）
 * - 非零 exit 行为不变（委托 handleWorkerError 重试矩阵）
 *
 * SW-DATA-3 背景：handleReturn / handleWorkerError / handleScriptError 的
 * `await deps.store.save(run)` 未捕获——ENOSPC 等落盘失败时 rejection 经 worker-host 的
 * `void handlers.onXxx(...)` 无人接 → unhandledRejection + pending:unregister / onRunDone
 * 不执行（pending 通知幽灵注销）。修复后 save 失败仅 logger.error，状态机继续推进。
 *
 * mock 构建参考 error-recovery-handlers.test.ts（plain-object WorkflowRun mock）。
 */
import { describe, expect, it, vi } from "vitest";

import {
  handleWorkerExit,
  handleWorkerMessage,
  handleScriptError,
  handleWorkerError,
} from "../error-recovery.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { WorkflowRun } from "../models/workflow-run.ts";
import type { WorkerHandle } from "../worker-handle.ts";

/** [F1] 归因文案——与 error-recovery.ts 常量一致（不直接 import 常量以锚定对外文案）。 */
const EXITED_WITHOUT_RESULT_MSG =
  "worker exited before delivering a result (return value may not be structured-cloneable)";

// ── helpers（对齐 error-recovery-handlers.test.ts）─────────────────

interface RunMockOpts {
  workerErrorCount?: number;
  scriptErrorCount?: number;
  /** 预置 receivedTerminalMessage（模拟 return/error 消息已送达）。 */
  receivedTerminalMessage?: boolean;
}

/** 构造一个 status="running" 的 mock WorkflowRun。 */
function makeRunningRun(opts: RunMockOpts = {}): WorkflowRun {
  return {
    runId: "wf-test",
    state: {
      status: "running",
      budget: { usedTokens: 0, usedCost: 0, isExceeded: () => false },
      errorLogs: [],
      calls: new Map(),
      trace: { removeByStepIndex: vi.fn(), append: vi.fn(), update: vi.fn() },
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
    },
    runtime: {
      worker: { postMessage: vi.fn() },
      receivedTerminalMessage: opts.receivedTerminalMessage,
    },
    transition(target: string, reason?: string): void {
      this.state.status = target;
      if (target === "done") this.state.reason = reason;
    },
    replaceRuntime(rt: unknown): void {
      this.runtime = rt;
    },
  } as unknown as WorkflowRun;
}

/** LifecycleDeps mock：store/workerHost/eventBus/onRunDone 可观察。 */
function makeDeps(): LifecycleDeps & {
  store: { save: ReturnType<typeof vi.fn> };
  eventBus: { emit: ReturnType<typeof vi.fn> };
  onRunDone: ReturnType<typeof vi.fn>;
} {
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn() })) },
    runner: { run: vi.fn(async () => ({})) },
    runs: new Map(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
  } as unknown as ReturnType<typeof makeDeps>;
}

function makeHandlers(): WorkerHandlers {
  return {
    onMessage: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onExit: vi.fn(async () => {}),
  } as unknown as WorkerHandlers;
}

function makeHandle(isCurrent = true): WorkerHandle {
  return { isCurrent } as unknown as WorkerHandle;
}

// ── [F1] handleWorkerExit：exit(0) 无终态消息 → failed ──────────────

describe("handleWorkerExit — [F1] exit(0) 无终态消息", () => {
  it("exit(0) 且未收到 return/error → run 转 done,failed，归因 structured-cloneable，unregister + onRunDone", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();

    await handleWorkerExit(run, 0, makeHandle(), deps, makeHandlers());

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toBe(EXITED_WITHOUT_RESULT_MSG);
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "pending:unregister",
      expect.objectContaining({ id: "wf-test", reason: "failed" }),
    );
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
    expect(deps.store.save).toHaveBeenCalledTimes(1);
  });

  it("exit(0) 但已收到终态消息（script-error 重试退避窗口）→ no-op，不被误判 failed", async () => {
    const run = makeRunningRun({ receivedTerminalMessage: true });
    const deps = makeDeps();

    await handleWorkerExit(run, 0, makeHandle(), deps, makeHandlers());

    expect(run.state.status).toBe("running");
    expect(deps.store.save).not.toHaveBeenCalled();
    expect(deps.eventBus.emit).not.toHaveBeenCalled();
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });

  it("stale handle（isCurrent=false）仍被丢弃——修复不破坏 G-025", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();

    await handleWorkerExit(run, 0, makeHandle(false), deps, makeHandlers());

    expect(run.state.status).toBe("running");
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });

  it("已终态（done）的 run 不受影响", async () => {
    const run = makeRunningRun();
    run.transition("done", "completed");
    const deps = makeDeps();

    await handleWorkerExit(run, 0, makeHandle(), deps, makeHandlers());

    expect(run.state.reason).toBe("completed");
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });

  it("非零 exit 行为不变：委托 handleWorkerError（未超限 → 退避后 rebuild 重试，不直接 failed）", async () => {
    // fake timers 跳过 scheduleRebuild 的真实 1s 退避
    vi.useFakeTimers();
    try {
      const run = makeRunningRun();
      const deps = makeDeps();
      const handlers = makeHandlers();

      const pending = handleWorkerExit(run, 1, makeHandle(), deps, handlers);
      await vi.advanceTimersByTimeAsync(1000); // 退避 1s → 触发 rebuildRuntime
      await pending;

      // 未超限 → rebuild（workerHost.start 重建），run 保持 running、不判 failed
      expect(run.state.status).toBe("running");
      expect(run.meta.workerErrorCount).toBe(1);
      expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
      expect(deps.onRunDone).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── [F1] handleWorkerMessage：return/error 标记 receivedTerminalMessage ────

describe("handleWorkerMessage — [F1] 终态消息标记", () => {
  it("return 消息将 runtime.receivedTerminalMessage 置 true，随后正常 transition done,completed", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();

    await handleWorkerMessage(run, { type: "return", result: { ok: 1 } }, deps, makeHandlers());

    expect((run.runtime as { receivedTerminalMessage?: boolean }).receivedTerminalMessage).toBe(true);
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("completed");
  });

  it("error 消息同样置 true——在 rebuild 前的退避窗口内捕获（replaceRuntime 前 start 时刻）", async () => {
    // 断言时机说明：标记的生命周期是「本 runtime 代际」。await 整个 handleWorkerMessage
    // 后 scheduleRebuild 已完成 replaceRuntime，runtime 已换新代际（flag=false 属正确语义）。
    // 真正需要标记保护的窗口是退避期间（旧 worker exit(0) 到达、run.runtime 仍指向旧代际），
    // 故在 rebuildRuntime 调 workerHost.start 的时刻（replaceRuntime 之前）捕获。
    vi.useFakeTimers();
    try {
      const run = makeRunningRun();
      const deps = makeDeps();
      let flagAtRebuildStart: boolean | undefined;
      (deps.workerHost.start as ReturnType<typeof vi.fn>).mockImplementation(() => {
        flagAtRebuildStart = (run.runtime as { receivedTerminalMessage?: boolean }).receivedTerminalMessage;
        return { postMessage: vi.fn() };
      });

      const pending = handleWorkerMessage(run, { type: "error", error: "boom" }, deps, makeHandlers());
      await vi.advanceTimersByTimeAsync(1000); // 跳过 scheduleRebuild 真实 1s 退避
      await pending;

      expect(flagAtRebuildStart).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── [SW-DATA-3] store.save 抛错 → 不产生 unhandledRejection，状态机继续 ────

describe("store.save 抛错（ENOSPC 等）— [SW-DATA-3] 不阻断终态推进", () => {
  it("handleReturn（经 handleWorkerMessage return 分支）：save reject 被吸收，unregister + onRunDone 照常", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();
    deps.store.save.mockRejectedValue(new Error("ENOSPC: no space left on device"));

    // 旧实现：await 裸抛 → handleWorkerMessage reject（worker-host 侧 void 掉）→
    // unhandledRejection + 幽灵注销。修复后必须正常 resolve。
    await expect(
      handleWorkerMessage(run, { type: "return", result: { ok: 1 } }, deps, makeHandlers()),
    ).resolves.toBeUndefined();

    expect(run.state.status).toBe("done");
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "pending:unregister",
      expect.objectContaining({ id: "wf-test" }),
    );
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("handleWorkerError 重试超限：save reject 被吸收，终态 + 通知照常", async () => {
    const run = makeRunningRun({ workerErrorCount: 3 });
    const deps = makeDeps();
    deps.store.save.mockRejectedValue(new Error("ENOSPC: no space left on device"));

    await expect(
      handleWorkerError(run, new Error("worker crash"), deps, makeHandlers()),
    ).resolves.toBeUndefined();

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "pending:unregister",
      expect.objectContaining({ id: "wf-test", reason: "failed" }),
    );
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("handleScriptError 重试超限：save reject 被吸收，终态 + 通知照常", async () => {
    const run = makeRunningRun({ scriptErrorCount: 3 });
    const deps = makeDeps();
    deps.store.save.mockRejectedValue(new Error("ENOSPC: no space left on device"));

    await expect(
      handleScriptError(run, "script boom", [], deps, makeHandlers()),
    ).resolves.toBeUndefined();

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "pending:unregister",
      expect.objectContaining({ id: "wf-test", reason: "failed" }),
    );
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });
});
