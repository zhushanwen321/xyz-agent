// src/__tests__/chat-session.test.ts
//
// [v1.x] chat 会话管理器单元测试（fake spawn executor + fake ChildProcess——不 spawn
// 真实子进程）。覆盖验收面：
//   - 轮次终态三相位帧（settled/idle/failed）+ active 轮内心跳（F3）与关联键滚动（首轮 runId → 续聊 recordId）；
//   - 续聊轮 recordId 键 streamDelta；
//   - cancel 收敛语义（D3 协议层）：受理 SIGTERM → 等轮终相位 → 超 CANCEL_SETTLE_GRACE_MS
//     杀链升级（fake timers 驱动）；
//   - close force/优雅分流、EPIPE 兜底耗尽 → failed 相位、子进程崩溃 → failed 相位、
//     冷续 resume 参数传递；
//   - 相位竞态边界：superseded 旧会话的相位抑制与注册表隔离（同 recordId 冷续串扰）、
//     settled→idle 间隙投递下新轮 settled 相位不被 idle 边界吞掉；
//   - [F3] 续聊轮轮内心跳：activity 事件 → active 相位帧（recordId 键、无载荷、
//     不 resolve 轮终等待体）；superseded 抑制；首轮零变化（activity 仍走 onEvent）。

import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HostChildStateChangedParams,
  HostRoundLifecycleParams,
  HostStreamDeltaParams,
} from "@zhushanwen/subagent-engine-sdk";
import { CANCEL_SETTLE_GRACE_MS } from "@zhushanwen/subagent-engine-sdk";

import {
  ChatSessionRegistry,
  type ChatHostChannels,
  type ChatSpawnExecutor,
} from "../chat-session.ts";
import {
  killAllActiveChildren,
  registerActiveChild,
  type SpawnRunCallbacks,
  type SpawnRunParams,
  type SpawnRunResult,
} from "../spawn-runner.ts";
import { resetAllEpipeFailures } from "../stdin-writer.ts";

/** fake 子进程：覆盖本链路消费面（stdin 写 / kill / killChain 的 exit 观测）。 */
class FakeChild extends EventEmitter {
  readonly pid = 4242;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: string[] = [];
  readonly stdinWrites: string[] = [];
  /** stdin 写一律抛 EPIPE（EPIPE 兜底场景）。 */
  epipeMode = false;
  /** 无视 SIGTERM（杀链升级场景：只有 SIGKILL 能收割）。 */
  ignoreSigterm = false;
  /** SIGTERM 的优雅收口钩子（pi 真实语义：SIGTERM trap 后先收口再退出——测试驱动）。 */
  onGracefulSigterm: (() => void) | undefined;
  /** 退出钩子（fake executor 挂 onChildStateChanged 触发面）。 */
  onExitHook: (() => void) | undefined;
  readonly stdin = {
    destroyed: false,
    write: (chunk: string): boolean => {
      this.stdinWrites.push(chunk);
      if (this.epipeMode) {
        throw Object.assign(new Error("write EPIPE: pipe broken"), { code: "EPIPE" });
      }
      return true;
    },
  };

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    const name = typeof signal === "number" ? `SIGKILL(${signal})` : signal;
    this.kills.push(name);
    if (signal === "SIGKILL" || typeof signal === "number") {
      this.die(null, "SIGKILL");
      return true;
    }
    if (signal === "SIGTERM") {
      if (this.onGracefulSigterm !== undefined) {
        this.onGracefulSigterm();
        return true;
      }
      if (!this.ignoreSigterm) this.die(null, "SIGTERM");
      return true;
    }
    return true;
  }

  die(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.killed = true;
    this.emit("exit", code, signal);
    this.onExitHook?.();
  }
}

/** fake executor 捕获面（测试驱动轮次事件 + resolve run）。 */
interface Captured {
  params: SpawnRunParams;
  callbacks: SpawnRunCallbacks;
  resolve: (r: SpawnRunResult) => void;
}

function fakeResult(sessionFile = "/tmp/sess-1.jsonl"): SpawnRunResult {
  return {
    content: "round answer",
    turns: 1,
    durationMs: 5,
    success: true,
    error: undefined,
    sessionId: "sess-1",
    sessionFile,
    toolCalls: [],
    parsedOutput: undefined,
    usage: undefined,
    failureKind: undefined,
  };
}

/** 组装 harness：registry + channels spy + fake executor（每 spawn 一个新 fake child）。 */
function makeHarness() {
  const children: FakeChild[] = [];
  const captured: Captured[] = [];
  const streamDeltas: HostStreamDeltaParams[] = [];
  const lifecycles: HostRoundLifecycleParams[] = [];
  const childStates: HostChildStateChangedParams[] = [];
  const executor: ChatSpawnExecutor = (params, callbacks) => {
    const child = new FakeChild();
    children.push(child);
    registerActiveChild(params.recordId, child as unknown as ChildProcess);
    const cap: Captured = { params, callbacks, resolve: () => {} };
    captured.push(cap);
    // 对齐真实 executor 的收口面：进程退出 → onChildStateChanged(exited) + run resolve
    // （chat 形态真实时序：agent_settled 已先行 resolve；崩溃路径由 close 兜底 resolve）
    child.onExitHook = () => {
      callbacks.onChildStateChanged?.({
        pid: child.pid,
        recordId: params.recordId,
        state: "exited",
        killed: child.killed,
        ...(child.exitCode !== null ? { exitCode: child.exitCode } : {}),
        ...(child.signalCode !== null ? { signal: child.signalCode } : {}),
      });
      cap.resolve(fakeResult());
    };
    return new Promise<SpawnRunResult>((resolve) => {
      cap.resolve = resolve;
    });
  };
  const channels: ChatHostChannels = {
    streamDelta: (p) => streamDeltas.push(p),
    roundLifecycle: (p) => lifecycles.push(p),
    askUser: () => Promise.resolve({ cancelled: true }),
    childStateChanged: (p) => childStates.push(p),
  };
  const registry = new ChatSessionRegistry({ spawnRunner: executor });
  registry.bindHostChannels(channels);
  return { registry, children, captured, streamDeltas, lifecycles, childStates };
}

/** 驱动一轮的标准事件序列（handleReady → delta → message_end → agent_end → agent_settled → resolve）。 */
async function driveRoundToIdle(cap: Captured, usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }): Promise<void> {
  cap.callbacks.onHandleReady?.({ sessionRef: { sessionId: "sess-1", sessionFile: "/tmp/sess-1.jsonl" }, poolKey: "shared" });
  cap.callbacks.onDelta?.("chunk-1");
  cap.callbacks.onEvent?.({
    type: "message_end",
    ...(usage !== undefined ? { usage } : {}),
  });
  cap.callbacks.onChatRoundEnd?.();
  cap.callbacks.onChatAgentSettled?.();
  cap.resolve(fakeResult());
  await Promise.resolve();
}

describe("ChatSessionRegistry：首轮 run 会话形态", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    killAllActiveChildren();
    resetAllEpipeFailures();
    vi.useRealTimers();
  });

  it("首轮生命周期：settled/idle 相位用 runId 键，idle 带 usage + anchor 回填，run 在 settled 后 resolve", async () => {
    const events: unknown[] = [];
    const runP = h.registry.startRound(
      { recordId: "rec-1", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      {
        runId: "run-1",
        onEvent: (e) => events.push(e),
        stream: { onDelta: () => undefined },
        onHandleReady: (partial) => {
          expect(partial.sessionRef.sessionFile).toBe("/tmp/sess-1.jsonl");
        },
      },
    );
    const cap = h.captured[0];
    expect(cap.params.chatMode).toBe(true);
    expect(cap.params.recordId).toBe("rec-1");

    cap.callbacks.onHandleReady?.({ sessionRef: { sessionId: "sess-1", sessionFile: "/tmp/sess-1.jsonl" }, poolKey: "shared" });
    await driveRoundToIdle(cap, { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 });

    const result = await runP;
    expect(result.sessionFile).toBe("/tmp/sess-1.jsonl");
    // 首轮两相位：runId 键（W1「run 会话形态首轮」裁定）
    expect(h.lifecycles).toHaveLength(2);
    expect(h.lifecycles[0]).toMatchObject({ runId: "run-1", phase: "settled", usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 } });
    expect(h.lifecycles[1]).toMatchObject({
      runId: "run-1",
      phase: "idle",
      usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 },
      anchor: { sessionRef: { recordId: "rec-1", sessionFile: "/tmp/sess-1.jsonl" }, poolKey: "shared" },
    });
    // 相位帧合法性（W1 SDK 判定器收窄）
    for (const f of h.lifecycles) {
      expect(f.recordId).toBeUndefined();
    }
    // 首轮事件走 onEvent 出口（run 通知通道）
    expect(events).toHaveLength(1);
    // 进程未 kill（长驻）
    expect(h.children[0].kills).toHaveLength(0);
  });

  it("首轮 streamMode 未开启时 delta 不外发；续聊轮开启才发 recordId 键 streamDelta", async () => {
    const runP = h.registry.startRound(
      { recordId: "rec-2", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      { runId: "run-2", onEvent: () => undefined },
    );
    const cap = h.captured[0];
    await driveRoundToIdle(cap);
    await runP;
    expect(h.streamDeltas).toHaveLength(0);

    // 续聊轮（streamEnabled=false 的会话）：delta 仍不外发
    const delivered = h.registry.deliverMessage("rec-2", "next", false);
    expect(delivered).toEqual({ ok: true, delivered: true });
    cap.callbacks.onDelta?.("later");
    expect(h.streamDeltas).toHaveLength(0);
  });
});

describe("ChatSessionRegistry：续聊轮（interact message）", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(async () => {
    h = makeHarness();
    const runP = h.registry.startRound(
      { recordId: "rec-1", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      { runId: "run-1", onEvent: () => undefined, stream: { onDelta: () => undefined } },
    );
    await driveRoundToIdle(h.captured[0], { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
    await runP;
    h.lifecycles.length = 0;
  });
  afterEach(() => {
    killAllActiveChildren();
    resetAllEpipeFailures();
    vi.useRealTimers();
  });

  it("续聊轮：delta/settled/idle 用 recordId 键；prompt 带 streamingBehavior followUp；usage 按轮重置", async () => {
    const delivered = h.registry.deliverMessage("rec-1", "next round", false);
    expect(delivered).toEqual({ ok: true, delivered: true });

    const child = h.children[0];
    const promptLine = child.stdinWrites.at(-1);
    expect(promptLine).toBeDefined();
    const cmd = JSON.parse(promptLine!) as { type: string; message: string; streamingBehavior?: string };
    expect(cmd.type).toBe("prompt");
    expect(cmd.message).toBe("next round");
    expect(cmd.streamingBehavior).toBe("followUp");

    // 续聊轮事件流：recordId 键 delta + settled（本轮 usage）+ idle（anchor）
    const cap = h.captured[0];
    cap.callbacks.onDelta?.("round2-chunk");
    cap.callbacks.onEvent?.({ type: "message_end", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } });
    cap.callbacks.onChatRoundEnd?.();
    cap.callbacks.onChatAgentSettled?.();
    await Promise.resolve();

    expect(h.streamDeltas).toEqual([{ recordId: "rec-1", delta: "round2-chunk" }]);
    expect(h.lifecycles[0]).toMatchObject({ recordId: "rec-1", phase: "settled", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } });
    expect(h.lifecycles[0].runId).toBeUndefined();
    expect(h.lifecycles[1]).toMatchObject({
      recordId: "rec-1",
      phase: "idle",
      usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 },
      anchor: { sessionRef: { recordId: "rec-1", sessionFile: "/tmp/sess-1.jsonl" }, poolKey: "shared" },
    });
  });

  it("interrupt=true 映射 steer；冷路径（无会话）拒绝并给冷续指引", () => {
    h.registry.deliverMessage("rec-1", "steer me", true);
    const cmd = JSON.parse(h.children[0].stdinWrites.at(-1)!) as { streamingBehavior?: string };
    expect(cmd.streamingBehavior).toBe("steer");

    const cold = h.registry.deliverMessage("rec-unknown", "hello", false);
    expect(cold.ok).toBe(false);
    if (!cold.ok) expect(cold.code).toBe("engine_session_not_resumable");
  });
});

describe("ChatSessionRegistry：cancel 收敛（D3 协议层）", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    killAllActiveChildren();
    resetAllEpipeFailures();
    vi.useRealTimers();
  });

  it("轮进行中 cancel：SIGTERM 受理 → pi 优雅收口（settled/idle 相位）→ 收敛返回", async () => {
    const runP = h.registry.startRound(
      { recordId: "rec-c1", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      { runId: "run-c1", onEvent: () => undefined },
    );
    const cap = h.captured[0];
    // 首轮已完成（idle），续聊轮进行中
    await driveRoundToIdle(cap);
    await runP;
    h.lifecycles.length = 0;
    h.registry.deliverMessage("rec-c1", "long round", false);

    // SIGTERM trap 后优雅收口（对齐 pi：SIGTERM handler 先到达 idle 再退出）
    h.children[0].onGracefulSigterm = () => {
      cap.callbacks.onChatRoundEnd?.();
      cap.callbacks.onChatAgentSettled?.();
      h.children[0].die(null, "SIGTERM");
    };
    const cancelP = h.registry.cancel("rec-c1");
    // 受理即 SIGTERM（对齐 run 域 cancel 形态）
    expect(h.children[0].kills).toEqual(["SIGTERM"]);
    const r = await cancelP;
    expect(r).toEqual({ ok: true, delivered: true });
    // 收敛信号 = 轮终相位（settled 先于进程退出）
    expect(h.lifecycles.map((f) => f.phase)).toEqual(["settled", "idle"]);
  });

  it("收敛超时 → CANCEL_SETTLE_GRACE_MS 后杀链升级（SIGKILL）→ failed(aborted) 相位", async () => {
    vi.useFakeTimers();
    const runP = h.registry.startRound(
      { recordId: "rec-c2", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      { runId: "run-c2", onEvent: () => undefined },
    );
    const cap = h.captured[0];
    await driveRoundToIdle(cap);
    await runP;
    h.lifecycles.length = 0;
    h.children[0].ignoreSigterm = true;
    h.registry.deliverMessage("rec-c2", "stuck round", false);

    const cancelP = h.registry.cancel("rec-c2");
    await vi.advanceTimersByTimeAsync(3_000);
    // 3s 收敛宽限耗尽 → 杀链（SIGTERM 重发 → 30s grace → SIGKILL）
    expect(h.children[0].kills).toContain("SIGTERM");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.children[0].kills.some((k) => k.startsWith("SIGKILL"))).toBe(true);
    const r = await cancelP;
    expect(r).toEqual({ ok: true, delivered: true });

    const failed = h.lifecycles.find((f) => f.phase === "failed");
    expect(failed).toMatchObject({ recordId: "rec-c2" });
    expect(failed?.phase === "failed" && failed.error.code).toBe("engine_round_aborted");
    expect(failed?.phase === "failed" && failed.error.message).toContain("cancel");
    // 会话消亡
    expect(h.registry.has("rec-c2")).toBe(false);
  });

  it("[F-6] 收敛超时后会话已消亡（closed）→ 升级等待体注册前快速收口，不等满 grace 总窗", async () => {
    vi.useFakeTimers();
    const runP = h.registry.startRound(
      { recordId: "rec-f6", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      { runId: "run-f6", onEvent: () => undefined },
    );
    const cap = h.captured[0];
    await driveRoundToIdle(cap);
    await runP;
    h.lifecycles.length = 0;
    h.children[0].ignoreSigterm = true;
    h.registry.deliverMessage("rec-f6", "stuck round", false);

    const cancelP = h.registry.cancel("rec-f6");
    // settle 超时（resolve(false)，等待体自删）；microtask 未 flush——cancel 续体未跑
    vi.advanceTimersByTime(3_000);
    // 同 tick 内子进程消亡（exit 已消费：closed=true、failed 相位已射给空等待体集合）
    h.children[0].die(null, "SIGTERM");
    expect(h.registry.has("rec-f6")).toBe(false);

    // 修复前：此处注册 33s 升级等待体，消亡会话无相位再来 → await 白等满窗；
    // 修复后：closed 检查直接走既有收口返回
    const r = await cancelP;
    expect(r).toEqual({ ok: true, delivered: true });
    // 杀链升级未发起（会话已消亡，无收割对象）
    expect(h.children[0].kills).toEqual(["SIGTERM"]);
  });

  it("idle 态 cancel：无在途轮 → 受理即返回（无收敛对象）", async () => {
    const runP = h.registry.startRound(
      { recordId: "rec-c3", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      { runId: "run-c3", onEvent: () => undefined },
    );
    await driveRoundToIdle(h.captured[0]);
    await runP;
    h.lifecycles.length = 0;

    const r = await h.registry.cancel("rec-c3");
    expect(r).toEqual({ ok: true, delivered: true });
    expect(h.children[0].kills).toEqual(["SIGTERM"]);
    // 无在途轮：不发射 failed（进程回收非轮次事件）
    expect(h.lifecycles.filter((f) => f.phase === "failed")).toHaveLength(0);
  });
});

describe("ChatSessionRegistry：close / 崩溃 / EPIPE / 冷续", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    killAllActiveChildren();
    resetAllEpipeFailures();
    vi.useRealTimers();
  });

  it("close force 且轮进行中：杀链收割 → failed(aborted/close)；会话消亡后 message 冷拒绝", async () => {
    const runP = h.registry.startRound(
      { recordId: "rec-x1", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      { runId: "run-x1", onEvent: () => undefined },
    );
    const cap = h.captured[0];
    // 首轮进行中（未 settled）直接 force close
    const r = h.registry.close("rec-x1", true);
    expect(r).toEqual({ ok: true, delivered: true });
    await runP.catch(() => undefined);
    await Promise.resolve();

    const failed = h.lifecycles.find((f) => f.phase === "failed");
    expect(failed).toMatchObject({ runId: "run-x1" });
    expect(failed?.phase === "failed" && failed.error.code).toBe("engine_round_aborted");
    expect(h.registry.has("rec-x1")).toBe(false);
    const cold = h.registry.deliverMessage("rec-x1", "anyone", false);
    expect(cold.ok).toBe(false);
  });

  it("close 优雅（force:false）且轮进行中：标记 closeAfterRound，idle 收口后收割", async () => {
    const runP = h.registry.startRound(
      { recordId: "rec-x2", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      { runId: "run-x2", onEvent: () => undefined },
    );
    const cap = h.captured[0];
    const r = h.registry.close("rec-x2", false);
    expect(r).toEqual({ ok: true, delivered: true });
    expect(h.children[0].kills).toHaveLength(0); // 未立即杀

    await driveRoundToIdle(cap);
    await runP;
    // idle 相位发射后收割（closeAfterRound 消费）
    expect(h.children[0].kills).toEqual(["SIGTERM"]);
  });

  it("子进程外部崩溃 mid-round：failed(crashed) 相位（含 signal 详情）+ 会话消亡", async () => {
    const runP = h.registry.startRound(
      { recordId: "rec-x3", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      { runId: "run-x3", onEvent: () => undefined },
    );
    h.children[0].die(1, null);
    await runP.catch(() => undefined);
    await Promise.resolve();

    const failed = h.lifecycles.find((f) => f.phase === "failed");
    expect(failed?.phase === "failed" && failed.error.code).toBe("engine_round_crashed");
    expect(failed?.phase === "failed" && failed.error.message).toContain("exit code 1");
    expect(h.registry.has("rec-x3")).toBe(false);
  });

  it("[SR-4] 子进程退出 → channels.childStateChanged 上报 exited（宿主镜像据此取消挂起 dialog）", async () => {
    const runP = h.registry.startRound(
      { recordId: "rec-sr4", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      { runId: "run-sr4", onEvent: () => undefined },
    );
    h.children[0].die(1, null);
    await runP.catch(() => undefined);
    await Promise.resolve();

    expect(h.childStates).toHaveLength(1);
    expect(h.childStates[0]).toMatchObject({
      pid: h.children[0].pid,
      recordId: "rec-sr4",
      state: "exited",
      // FakeChild.die 是唯一退出路径且置 killed=true（载荷 killed 语义 = 已终止）
      killed: true,
      exitCode: 1,
    });
  });

  it("EPIPE 兜底耗尽：failed(epipe_exhausted) 相位 + 结构化失败返回", async () => {
    const runP = h.registry.startRound(
      { recordId: "rec-x4", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      { runId: "run-x4", onEvent: () => undefined },
    );
    await driveRoundToIdle(h.captured[0]);
    await runP;
    h.children[0].epipeMode = true;
    h.lifecycles.length = 0;

    const first = h.registry.deliverMessage("rec-x4", "m1", false);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.code).toBe("engine_session_not_resumable");
    expect(h.lifecycles).toHaveLength(0);

    const second = h.registry.deliverMessage("rec-x4", "m2", false);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("engine_interact_failed");
    const failed = h.lifecycles.find((f) => f.phase === "failed");
    expect(failed?.phase === "failed" && failed.error.code).toBe("engine_round_epipe_exhausted");
  });

  it("冷续 run（resume 锚点）：resumeSessionFile 透传 executor，同 recordId 旧会话被收割重建", async () => {
    const first = h.registry.startRound(
      { recordId: "rec-x5", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      { runId: "run-x5a", onEvent: () => undefined },
    );
    await driveRoundToIdle(h.captured[0]);
    await first;
    expect(h.children[0].kills).toHaveLength(0);

    const second = h.registry.startRound(
      {
        recordId: "rec-x5",
        task: "hi again",
        agentName: "a",
        model: "p/m",
        sessionDir: "/tmp/s",
        cwd: "/tmp",
        resumeSessionFile: "/tmp/sess-1.jsonl",
      },
      { runId: "run-x5b", onEvent: () => undefined },
    );
    // 旧会话收割（superseded）
    expect(h.children[0].kills).toEqual(["SIGTERM"]);
    expect(h.captured[1].params.resumeSessionFile).toBe("/tmp/sess-1.jsonl");
    expect(h.captured[1].params.chatMode).toBe(true);
    await driveRoundToIdle(h.captured[1]);
    await second;
  });
});

describe("ChatSessionRegistry：相位竞态边界（同 recordId 冷续串扰 / 间隙投递）", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    killAllActiveChildren();
    resetAllEpipeFailures();
    vi.useRealTimers();
  });

  it("superseded 旧会话在途轮被杀：不发射同 recordId 键的 failed 相位，新会话正常发相位", async () => {
    const first = h.registry.startRound(
      { recordId: "rec-s5", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      { runId: "run-s5a", onEvent: () => undefined },
    );
    await driveRoundToIdle(h.captured[0]);
    await first;
    h.lifecycles.length = 0;

    // 旧会话在途续聊轮（相位面已切 recordId 键）
    expect(h.registry.deliverMessage("rec-s5", "in-flight round", false)).toEqual({ ok: true, delivered: true });

    // 同 recordId 冷续 run：旧会话置 superseded + 杀链（fake child 同步死于 SIGTERM）
    const second = h.registry.startRound(
      {
        recordId: "rec-s5",
        task: "cold resume",
        agentName: "a",
        model: "p/m",
        sessionDir: "/tmp/s",
        cwd: "/tmp",
        resumeSessionFile: "/tmp/sess-1.jsonl",
      },
      { runId: "run-s5b", onEvent: () => undefined },
    );
    expect(h.children[0].kills).toEqual(["SIGTERM"]);
    // 修复前：旧会话消亡时对 recordId 键 emit failed——与新会话在途轮同键串扰，
    // core 冷续刚建立即收到该 record 的 failed 帧会误终态化新轮；修复后零帧
    // （superseded 信号本身 = 新 run 的 start，core 无需旧会话帧）
    expect(h.lifecycles).toHaveLength(0);

    // 新会话首轮正常发射（runId 键 settled/idle）
    await driveRoundToIdle(h.captured[1]);
    await second;
    expect(h.lifecycles.map((f) => f.phase)).toEqual(["settled", "idle"]);
    expect(h.lifecycles[0]).toMatchObject({ runId: "run-s5b", phase: "settled" });
    expect(h.lifecycles[1]).toMatchObject({ runId: "run-s5b", phase: "idle" });
  });

  it("superseded 旧会话迟到 exit（真实子进程 exit 事件异步到达）：不清掉新会话注册表条目", async () => {
    const first = h.registry.startRound(
      { recordId: "rec-s5l", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      { runId: "run-s5la", onEvent: () => undefined },
    );
    await driveRoundToIdle(h.captured[0]);
    await first;
    h.lifecycles.length = 0;

    // 旧 child 忽略 SIGTERM → startRound 的 stale 防御发出信号后旧进程仍存活，
    // 新会话先建立（对齐生产时序：exit 事件晚于新会话插入注册表）
    h.children[0].ignoreSigterm = true;
    const second = h.registry.startRound(
      {
        recordId: "rec-s5l",
        task: "cold resume",
        agentName: "a",
        model: "p/m",
        sessionDir: "/tmp/s",
        cwd: "/tmp",
        resumeSessionFile: "/tmp/sess-1.jsonl",
      },
      { runId: "run-s5lb", onEvent: () => undefined },
    );
    expect(h.registry.has("rec-s5l")).toBe(true);

    // 旧进程此刻才退出：旧会话的迟到消亡不得清掉同 recordId 键的新会话条目
    // （修复前 sessions.delete 按 recordId 盲删 → interact 控制面对活会话失效）
    h.children[0].die(null, "SIGTERM");
    expect(h.registry.has("rec-s5l")).toBe(true);
    expect(h.registry.deliverMessage("rec-s5l", "next", false)).toEqual({ ok: true, delivered: true });
    expect(h.lifecycles).toHaveLength(0); // 旧会话 idle 态消亡本就无相位；新会话轮在途未收口

    await driveRoundToIdle(h.captured[1]);
    await second;
    expect(h.lifecycles.map((f) => f.phase)).toEqual(["settled", "idle"]);
  });

  it("settled→idle 间隙投递下一条消息：下一轮 settled 相位不被 idle 边界吞掉", async () => {
    const runP = h.registry.startRound(
      { recordId: "rec-s6", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      { runId: "run-s6", onEvent: () => undefined, stream: { onDelta: () => undefined } },
    );
    const cap = h.captured[0];
    cap.callbacks.onHandleReady?.({ sessionRef: { sessionId: "sess-1", sessionFile: "/tmp/sess-1.jsonl" }, poolKey: "shared" });

    // 首轮 agent_end → settled；宿主在 settled 帧与 idle 帧（agent_settled）之间投递下一条
    cap.callbacks.onChatRoundEnd?.();
    expect(h.lifecycles.at(-1)).toMatchObject({ runId: "run-s6", phase: "settled" });
    expect(h.registry.deliverMessage("rec-s6", "next round", false)).toEqual({ ok: true, delivered: true });
    cap.callbacks.onChatAgentSettled?.(); // 旧轮空闲边界：不得清掉新轮的 roundActive
    // [F-4 S6 引擎半边] 旧轮 agent_settled 的 idle 帧被 armedSeq 判别抑制（新轮已 arm、
    // 进行中）——修复前旧 idle 帧同键放行，core handleChatRoundPhase(idle) 拆掉新轮
    // 中段守护 + 误挂 5min idle timer → 新轮进行中超 5min 被误杀
    expect(h.lifecycles.map((f) => f.phase)).toEqual(["settled"]);
    cap.resolve(fakeResult());
    await runP;
    h.lifecycles.length = 0;

    // 新一轮 agent_end：settled 必须发射（修复前 roundActive 被旧轮 agent_settled 覆写，
    // handleRoundEnd 的 !roundActive 守卫拦截 → 该轮 settled 永不发射）
    cap.callbacks.onEvent?.({ type: "message_end", usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 } });
    cap.callbacks.onChatRoundEnd?.();
    expect(h.lifecycles).toHaveLength(1);
    expect(h.lifecycles[0]).toMatchObject({ recordId: "rec-s6", phase: "settled", usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 } });

    // 该轮自己的 agent_settled：正常清位 + idle 相位
    cap.callbacks.onChatAgentSettled?.();
    expect(h.lifecycles).toHaveLength(2);
    expect(h.lifecycles[1]).toMatchObject({ recordId: "rec-s6", phase: "idle" });
  });
});

describe("ChatSessionRegistry：[F3] 续聊轮轮内心跳（activity → active 相位）", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(async () => {
    h = makeHarness();
    const runP = h.registry.startRound(
      { recordId: "rec-1", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      { runId: "run-1", onEvent: () => undefined, stream: { onDelta: () => undefined } },
    );
    await driveRoundToIdle(h.captured[0]);
    await runP;
    h.lifecycles.length = 0;
    // 续聊轮进行中（本轮工具执行期——activity 信号的触发窗）
    h.registry.deliverMessage("rec-1", "long tool round", false);
  });
  afterEach(() => {
    killAllActiveChildren();
    resetAllEpipeFailures();
    vi.useRealTimers();
  });

  it("续聊轮 activity 事件 → active 相位帧（recordId 键、无载荷）；其他事件仍吞掉", () => {
    const cap = h.captured[0];
    cap.callbacks.onEvent?.({ type: "activity" });
    cap.callbacks.onEvent?.({ type: "activity" });
    // 节流归 translator（到达本层的 activity 已 ≤1/s）——每事件一帧
    expect(h.lifecycles).toEqual([
      { recordId: "rec-1", phase: "active" },
      { recordId: "rec-1", phase: "active" },
    ]);

    // 其余事件维持吞掉（行为面最小化）：message 记账等不外发任何帧
    cap.callbacks.onEvent?.({ type: "message_end", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
    expect(h.lifecycles).toHaveLength(2);
  });

  it("首轮零变化：首轮 activity 走 onEvent 出口（run 通知通道），不产生 active 相位帧", async () => {
    const events: unknown[] = [];
    const first = h.registry.startRound(
      { recordId: "rec-f3f", task: "hi", agentName: "a", model: "p/m", sessionDir: "/tmp/s", cwd: "/tmp" },
      { runId: "run-f3f", onEvent: (e) => events.push(e) },
    );
    const cap = h.captured[1];
    cap.callbacks.onHandleReady?.({ sessionRef: { sessionId: "s", sessionFile: "/tmp/sess.jsonl" }, poolKey: "shared" });
    // 首轮进行中（firstRoundDone=false）：activity 是普通事件行——runId 键通知通道
    cap.callbacks.onEvent?.({ type: "activity" });
    expect(events).toEqual([{ type: "activity" }]);
    expect(h.lifecycles).toHaveLength(0); // 无 active 帧（首轮守护刷新面 = ctx.onEvent）

    await driveRoundToIdle(cap);
    await first;
    expect(h.lifecycles.filter((f) => f.phase === "active")).toHaveLength(0);
  });

  it("[红线] active 发射不 resolve 轮终等待体：cancel 在途时 activity 到达不提前收敛，超时走杀链升级", async () => {
    vi.useFakeTimers();
    const cap = h.captured[0];
    // SIGTERM 无效（模拟长工具执行期不受中断影响、子进程继续跑）——cancel 进入
    // 轮终等待窗（同步收口路径测不出「等待体在册」期间的行为）
    h.children[0].ignoreSigterm = true;
    const cancelP = h.registry.cancel("rec-1");
    let returned = false;
    void cancelP.then(() => {
      returned = true;
    });

    // 工具执行期 activity 心跳到达（cancel 的轮终等待体在册期间）
    cap.callbacks.onEvent?.({ type: "activity" });
    expect(h.lifecycles.some((f) => f.phase === "active")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    // 修复红线验证：active 帧已发射但轮终等待体未被 resolve——cancel 不误判轮终
    // （若 active 经 emitPhase 发射（逐一 resolve roundTerminalWaiters），此处
    // cancel 已被 activity 提前收敛返回）
    expect(returned).toBe(false);
    expect(h.children[0].kills).toEqual(["SIGTERM"]); // 未提前收敛 → 无杀链升级

    // 无真轮终相位：收敛宽限耗尽 → 超时 resolve(false) → 杀链升级（SIGTERM 重发 →
    // 30s grace → SIGKILL）→ 收敛返回（与存量升级用例同时序）
    await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_GRACE_MS);
    expect(h.children[0].kills).toContain("SIGTERM");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.children[0].kills.some((k) => k.startsWith("SIGKILL"))).toBe(true);
    const r = await cancelP;
    expect(r).toEqual({ ok: true, delivered: true });
    expect(returned).toBe(true);
  });

  it("superseded 旧会话的 activity 抑制：残留进程的心跳不得以 recordId 键刷新新轮", async () => {
    // 旧 child 忽略 SIGTERM（冷续 stale 防御收割后残留进程仍在跑、事件仍流入旧会话）
    h.children[0].ignoreSigterm = true;
    const second = h.registry.startRound(
      {
        recordId: "rec-1",
        task: "cold resume",
        agentName: "a",
        model: "p/m",
        sessionDir: "/tmp/s",
        cwd: "/tmp",
        resumeSessionFile: "/tmp/sess-1.jsonl",
      },
      { runId: "run-1b", onEvent: () => undefined },
    );
    // 旧会话（killReason=superseded）的迟到 activity：抑制发射
    h.captured[0].callbacks.onEvent?.({ type: "activity" });
    expect(h.lifecycles).toHaveLength(0);

    // 新会话正常面不受影响：首轮 settled/idle 相位照常
    await driveRoundToIdle(h.captured[1]);
    await second;
    expect(h.lifecycles.map((f) => f.phase)).toEqual(["settled", "idle"]);
  });
});
