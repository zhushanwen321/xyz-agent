// src/__tests__/chat-protocol.test.ts
//
// [H1 U3] chat 轮 run 派发形态的协议进程内测试：EngineProtocolServer + 真 PiEngine
// + 注入 fake spawnRunner（不 spawn 真实子进程）。断言协议帧面（chat-run 统一，
// 设计 docs/design/subagent-chat-run-unification.md §3.3 D6/D7）：
//   - run chat（首轮）：host/* 反向帧（poolResolved/childSpawned[recordId]/
//     handleReady/streamDelta[runId]）→ run 应答（handle 锚 recordId）——不经
//     ChatSessionRegistry，无 roundLifecycle 相位帧（run 终态 = agent_settled
//     run 应答，见 run-spawn-once.integration 的收割面）；
//   - chat 轮 recordId 锚定的 interact 过渡兼容面（registry 解耦后走 run 域分支：
//     message 热路径 followUp / cancel SIGTERM）；
//   - 冷续 run chat+resume：resume 参数透传（--session 穿透）；
//   - fork-from 形态互斥锚定（无 chat 键 = 无 chatMode）；
//   - conversation gate 负向（A6 方向）：unsupported 引擎同步拒。
//
// fake host 的 write 钩子对反向帧（id: "rev-N"）自动应答 {ok:true}——反向请求两阶段
// 语义不在本测试面（协议 e2e 覆盖 askUser 两阶段）。

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ENGINE_PROTOCOL_VERSION, type EngineCapabilities } from "@zhushanwen/subagent-engine-sdk";

import { PiEngine } from "../pi-engine.ts";
import { EngineProtocolServer, createDefaultPiEngine } from "../server.ts";
import {
  killAllActiveChildren,
  registerActiveChild,
  type SpawnRunCallbacks,
  type SpawnRunParams,
  type SpawnRunResult,
} from "../spawn-runner.ts";
import { resetAllEpipeFailures } from "../stdin-writer.ts";

interface Frame {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: string; message?: string };
}

/** fake 子进程（最小面：stdin 记录 / kill / exit 观测）。 */
class FakeChild extends EventEmitter {
  readonly pid = 7777;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: string[] = [];
  readonly stdinWrites: string[] = [];
  onExitHook: (() => void) | undefined;
  readonly stdin = {
    destroyed: false,
    write: (chunk: string): boolean => {
      this.stdinWrites.push(chunk);
      return true;
    },
  };

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.kills.push(String(signal));
    if (signal === "SIGKILL") this.die(null, "SIGKILL");
    else this.die(null, "SIGTERM");
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

interface Captured {
  params: SpawnRunParams;
  callbacks: SpawnRunCallbacks;
  resolve: (r: SpawnRunResult) => void;
}

function fakeResult(): SpawnRunResult {
  return {
    content: "chat round answer",
    turns: 1,
    durationMs: 3,
    success: true,
    error: undefined,
    sessionId: "sess-chat",
    sessionFile: "/tmp/chat-sess.jsonl",
    toolCalls: [],
    parsedOutput: undefined,
    usage: undefined,
    failureKind: undefined,
  };
}

/** 协议 harness：server + PiEngine（注入 fake executor）+ 帧收集 + 反向帧自动应答。 */
function makeHarness() {
  const captured: Captured[] = [];
  const children: FakeChild[] = [];
  const frames: Frame[] = [];
  const executor = (params: SpawnRunParams, callbacks: SpawnRunCallbacks): Promise<SpawnRunResult> => {
    const child = new FakeChild();
    children.push(child);
    registerActiveChild(params.recordId, child as unknown as ChildProcess);
    const cap: Captured = { params, callbacks, resolve: () => {} };
    captured.push(cap);
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
  let server: EngineProtocolServer;
  const write = (frame: unknown): void => {
    frames.push(frame as Frame);
    const id = (frame as { id?: unknown }).id;
    // 反向帧自动应答（数据面 {ok:true}）
    if (typeof id === "string") server.handleFrame({ id, result: { ok: true } });
  };
  const engine = new PiEngine({ spawnRunner: executor });
  server = new EngineProtocolServer({ write, engine });
  return { server, engine, frames, captured, children };
}

/** 微任务冲刷（dispatch 是 async——应答帧在 microtask 后落位）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function reverseFrames(frames: Frame[], method: string): Frame[] {
  return frames.filter((f) => f.method === method);
}

async function initialize(h: ReturnType<typeof makeHarness>): Promise<void> {
  h.server.handleFrame({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      hostInfo: { name: "t", version: "0", dataRoot: "/tmp" },
      engineConfig: {},
    },
  });
  await flush();
}

const HANDLE = {
  v: 1 as const,
  engineId: "pi",
  sessionRef: { recordId: "rec-chat-1", sessionFile: "/tmp/chat-sess.jsonl" },
  poolKey: "shared",
  adapterVersion: "1.0.0",
};

describe("chat 轮 run 派发形态协议面（进程内 server + PiEngine）", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    killAllActiveChildren();
    resetAllEpipeFailures();
  });

  it("首轮 run chat：反向帧链（recordId 锚定）→ run 应答 handle 锚 recordId；无 roundLifecycle 相位帧", async () => {
    await initialize(h);
    h.server.handleFrame({
      id: 2,
      method: "run",
      params: {
        runId: "run-chat-1",
        task: { prompt: "hi", conversation: true, description: "chat-e2e" },
        ctx: { poolKey: "shared", cwd: "/tmp", model: "p/m", streamMode: "stream" },
        chat: { recordId: "rec-chat-1" },
      },
    });
    await flush();
    const cap = h.captured[0];
    expect(cap.params.chatMode).toBe(true);
    expect(cap.params.recordId).toBe("rec-chat-1");

    cap.callbacks.onChildSpawned?.(7777, "rec-chat-1");
    cap.callbacks.onHandleReady?.({ sessionRef: { sessionId: "sess-chat", sessionFile: "/tmp/chat-sess.jsonl" }, poolKey: "shared" });
    cap.callbacks.onDelta?.("hello ");
    cap.callbacks.onEvent?.({ type: "message_end", usage: { input: 12, output: 6, cacheRead: 0, cacheWrite: 0 } });
    cap.resolve(fakeResult());
    await flush();

    // childSpawned 用 chat recordId 锚定（区别于一次性 run 的 runId 锚定）
    const spawned = reverseFrames(h.frames, "host/childSpawned")[0];
    expect(spawned?.params).toMatchObject({ pid: 7777, recordId: "rec-chat-1" });
    // streamDelta：per-run runId 键（与 one-shot 共用 server stream wiring）
    const delta = reverseFrames(h.frames, "host/streamDelta")[0];
    expect(delta?.params).toEqual({ runId: "run-chat-1", delta: "hello " });
    // [H1 U3] run 路径不经 registry：无 roundLifecycle 相位帧（轮终 = agent_settled
    // 的 run 应答，收割面见 run-spawn-once.integration）
    expect(reverseFrames(h.frames, "host/roundLifecycle")).toHaveLength(0);
    // run 应答：handle 锚定 recordId
    const runResp = h.frames.find((f) => f.id === 2);
    expect(runResp?.error).toBeUndefined();
    const result = runResp?.result as { handle: { sessionRef: Record<string, string> }; outcome: { content: string } };
    expect(result.handle.sessionRef.recordId).toBe("rec-chat-1");
    expect(result.handle.sessionRef.sessionFile).toBe("/tmp/chat-sess.jsonl");
    expect(result.outcome.content).toBe("chat round answer");
  });

  it("chat 轮 interact 过渡兼容面（registry 解耦 → run 域分支）：message followUp 直写 + cancel SIGTERM", async () => {
    await initialize(h);
    h.server.handleFrame({
      id: 2,
      method: "run",
      params: {
        runId: "run-chat-2",
        task: { prompt: "hi", conversation: true },
        ctx: { poolKey: "shared", cwd: "/tmp", model: "p/m", streamMode: "stream" },
        chat: { recordId: "rec-chat-2" },
      },
    });
    await flush();
    const cap = h.captured[0];
    cap.resolve(fakeResult());
    await flush();

    // recordId 锚定的活跃子进程（fake executor 注册面）→ message 热路径直写
    h.server.handleFrame({
      id: 3,
      method: "interact",
      params: {
        handle: { ...HANDLE, sessionRef: { recordId: "rec-chat-2", sessionFile: "/tmp/chat-sess.jsonl" } },
        action: { kind: "message", payload: "next round" },
      },
    });
    await flush();
    const resp = h.frames.find((f) => f.id === 3);
    expect(resp?.result).toEqual({ ok: true, delivered: true });
    // prompt 命令：streamingBehavior followUp（缺省 interrupt——run 域投递形态）
    const cmd = JSON.parse(h.children[0].stdinWrites.at(-1)!) as { type: string; message: string; streamingBehavior?: string };
    expect(cmd).toMatchObject({ type: "prompt", message: "next round", streamingBehavior: "followUp" });

    // cancel：run 域分支 = SIGTERM（无 registry 收敛等待）
    h.server.handleFrame({
      id: 4,
      method: "interact",
      params: { handle: { ...HANDLE, sessionRef: { recordId: "rec-chat-2" } }, action: { kind: "cancel" } },
    });
    await flush();
    const cancelResp = h.frames.find((f) => f.id === 4);
    expect(cancelResp?.result).toEqual({ ok: true, delivered: true });
    expect(h.children[0].kills).toContain("SIGTERM");
  });

  it("冷续 run chat+resume：resume 锚点透传 executor（--session 续写）", async () => {
    await initialize(h);
    h.server.handleFrame({
      id: 2,
      method: "run",
      params: {
        runId: "run-cold",
        task: { prompt: "continue", conversation: true },
        ctx: { poolKey: "shared", cwd: "/tmp", model: "p/m" },
        chat: {
          recordId: "rec-cold",
          resume: { sessionRef: { recordId: "rec-cold", sessionFile: "/tmp/old-session.jsonl" }, poolKey: "shared" },
        },
      },
    });
    await flush();
    expect(h.captured[0].params.resumeSessionFile).toBe("/tmp/old-session.jsonl");
    expect(h.captured[0].params.chatMode).toBe(true);
    h.captured[0].resolve(fakeResult());
    await flush();
    const resp = h.frames.find((f) => f.id === 2);
    expect(resp?.error).toBeUndefined();
  });

  it("一次性 run 的 task.forkSource 透传 executor（--fork 接收面，fork-from 协议载体）", async () => {
    // 链路定位：宿主 run 帧 task.forkSource（remote-engine toSdkTaskSubset 映射产物）→
    // PiEngine run → SpawnRunParams.forkSource → buildSpawnArgs `--fork <path>`（后者
    // 已有 spawn-args.test 专项直测）。fork-from 是一次性 run 形态（无 chat 键）。
    await initialize(h);
    h.server.handleFrame({
      id: 2,
      method: "run",
      params: {
        runId: "run-fork-from",
        task: { prompt: "resume", forkSource: "/tmp/sa-src.jsonl" },
        ctx: { poolKey: "shared", cwd: "/tmp", model: "p/m" },
      },
    });
    await flush();
    expect(h.captured[0].params.forkSource).toBe("/tmp/sa-src.jsonl");
    // 形态互斥锚定：fork-from 走一次性 run（无 chatMode；chat 轮续写走 resumeSessionFile）。
    expect(h.captured[0].params.chatMode).toBeUndefined();
    expect(h.captured[0].params.resumeSessionFile).toBeUndefined();
    h.captured[0].resolve(fakeResult());
    await flush();
    const resp = h.frames.find((f) => f.id === 2);
    expect(resp?.error).toBeUndefined();
  });
});

describe("chat 轮 gate 负向（A6 方向）", () => {
  it("conversation unsupported 的引擎：run chat 同步拒 engine_capability_unsupported；一次性 run 不受影响面（gate 只拦 chat）", async () => {
    const frames: Frame[] = [];
    // 结构化委托形态（spread 会丢 class 原型方法）：只覆写 capabilities.conversation
    const base = createDefaultPiEngine();
    const engine = {
      id: base.id,
      probe: (opts?: { force?: boolean }) => base.probe(opts),
      run: (task: Parameters<PiEngine["run"]>[0], ctx: Parameters<PiEngine["run"]>[1]) => base.run(task, ctx),
      interact: (handle: Parameters<PiEngine["interact"]>[0], action: Parameters<PiEngine["interact"]>[1]) =>
        base.interact(handle, action),
      read: (handle: Parameters<PiEngine["read"]>[0]) => base.read(handle),
      capabilities: (): EngineCapabilities => ({ ...base.capabilities(), conversation: "unsupported" }),
    };
    const server = new EngineProtocolServer({ write: (f) => frames.push(f as Frame), engine });
    server.handleFrame({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: ENGINE_PROTOCOL_VERSION,
        hostInfo: { name: "t", version: "0", dataRoot: "/tmp" },
        engineConfig: {},
      },
    });
    await flush();
    server.handleFrame({
      id: 2,
      method: "run",
      params: {
        runId: "run-gate",
        task: { prompt: "hi", conversation: true },
        ctx: { poolKey: "shared", cwd: "/tmp", model: "p/m" },
        chat: { recordId: "rec-gate" },
      },
    });
    await flush();
    const resp = frames.find((f) => f.id === 2);
    expect(resp?.error?.code).toBe("engine_capability_unsupported");
    expect(resp?.error?.message).toContain("conversation");
  });
});
