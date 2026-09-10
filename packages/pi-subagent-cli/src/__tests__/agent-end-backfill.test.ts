// src/__tests__/agent-end-backfill.test.ts
//
// M2 agent_end 惰性回补验收（设计 docs/design/subagent-agent-end-recovery-replay.md
// §3.3 决策 2 / §4 V3 / §5.2 K1-K2）：
//   - V3：spawn 期 get_state 三轮全部不应答（原事故的现实形态）+ agent_end 时刻恢复
//     应答 → outcome.sessionFile 非空，且恢复耗时 ≤1s（LAZY_GET_STATE_TIMEOUT_MS 上界）；
//   - [U-A3] 回补**也不应答**（超时路径）：agent_end 起 1s 假时钟内 run 必收敛——真正
//     测量控制面单请求（秒级）的收敛上界（V3 用例走的是「应答先到」路径，把
//     LAZY_GET_STATE_TIMEOUT_MS 放大到 10s/100s 它照样绿，约束不了该上界）；
//   - 回补链抛错（reject / 同步 throw）→ killChild 在 finally 必达（R1 MF-2）；
//   - endedCleanly 在同步段先置（回补启动前已 true），回补失败不改写该标记；
//   - K1：回补接线走 identity tracker 既有 addStateListener → applyGetStateFields →
//     handleReady 回填面（requestGetStateOnce 的消费面）；
//   - K2：回补 finally 的 kill 落在已退出子进程上 → killChain 幂等 no-op（不发信号、
//     不抛、可重复）；端到端 race①：子进程在回补窗口内自行退出 → run 正常终态。
//
// 时序手段：vi.useFakeTimers() 控制握手节奏（2s 超时 ×3 + 500ms 间隔）与回补 1s 超时。
// 真实子进程 I/O 不会被纯 microtask 链推进（探针实证：纯 advanceTimersByTimeAsync
// 循环 500 步后 stdout data 仍为 0 字节），故每步用 node:timers/promises 的真实 sleep
// （vitest 假时钟不接管该模块）让出真实事件循环——「假时钟控制协议时序 + 真实 I/O
// 推进」两不误。子进程收命令的事实以子进程自写的状态文件为准（父进程侧 write spy
// 会漏掉注册前已发出的首个握手请求，观测不稳）。

import * as fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as realSleep } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { killChain, type AgentEvent, type KillableChild } from "@zhushanwen/subagent-engine-sdk";

import { PI_KILL_GRACE_MS } from "../constants.ts";
import {
  backfillSessionFileAtAgentEnd,
  getActiveChild,
  killAllActiveChildren,
  orchestrateAgentEndBackfill,
  runSpawnOnce,
  type SpawnRunCallbacks,
  type SpawnRunParams,
  type SpawnRunResult,
} from "../spawn-runner.ts";
import {
  createSessionIdentityTracker,
  type RunEndState,
  type SessionIdentityTracker,
} from "../spawn-run-pump.ts";
import { resetAllEpipeFailures } from "../stdin-writer.ts";

/** fake pi 脚本（rpc 形态子进程，行为按 FAKE_PI_MODE 分派），自写状态文件供测试取证。
 *  backfill：get_state 在 agent_end 前一律扣住不应答（原事故形态「超时无应答」），
 *  prompt 已到且收到第 3 次 get_state（spawn 期三轮耗尽）后发 agent_end；agent_end
 *  之后的 get_state 才应答「仅此路径可见」的 LATE_FILE/LATE_ID——断言该值即证明身份
 *  来自 agent_end 回补而非 spawn 期握手。
 *  no-answer：get_state 全程不应答（spawn 三轮 + agent_end 回补都不应答）——超时路径形态。
 *  self-exit：prompt 即发事件流 + agent_end，随后自行退出（回补窗口内进程自行退出）。
 */
const FAKE_PI_SCRIPT = `
import readline from "node:readline";
import fs from "node:fs";
const mode = process.env.FAKE_PI_MODE ?? "backfill";
const send = (obj) => { process.stdout.write(JSON.stringify(obj) + "\\n"); };
const sessionDirArg = (() => {
  const i = process.argv.indexOf("--session-dir");
  return i >= 0 ? process.argv[i + 1] : "/tmp/fake-sessions";
})();
const LATE_FILE = sessionDirArg + "/late-backfill-20260910.jsonl";
const LATE_ID = "late-backfill-sess";
const STATUS = process.env.FAKE_PI_STATUS;
const status = { getStateCount: 0, withheldBeforeAgentEnd: 0, withheldAfterAgentEnd: 0, answersAfterAgentEnd: 0, agentEndSent: false, prompts: 0 };
const flush = () => { if (STATUS) fs.writeFileSync(STATUS, JSON.stringify(status)); };
flush();
let promptSeen = false;
const rl = readline.createInterface({ input: process.stdin });
const emitAgentEnd = () => {
  if (status.agentEndSent) return;
  status.agentEndSent = true;
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "late-recovered" } });
  send({ type: "turn_end" });
  send({ type: "message_end", message: { usage: { input: 1, output: 1 }, stopReason: "stop" } });
  send({ type: "agent_end", willRetry: false, reason: "end_turn" });
  flush();
  if (mode === "self-exit") setTimeout(() => process.exit(0), 20);
};
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "get_state") {
    status.getStateCount++;
    if (status.agentEndSent && mode === "backfill") {
      status.answersAfterAgentEnd++;
      send({ type: "response", command: "get_state", success: true, id: msg.id, data: { sessionFile: LATE_FILE, sessionId: LATE_ID } });
    } else if (status.agentEndSent) {
      status.withheldAfterAgentEnd++;
    } else {
      status.withheldBeforeAgentEnd++;
    }
    flush();
    if (mode !== "self-exit" && promptSeen && status.getStateCount >= 3) emitAgentEnd();
    return;
  }
  if (msg.type === "prompt") {
    status.prompts++;
    promptSeen = true;
    flush();
    if (mode === "self-exit") emitAgentEnd();
    return;
  }
});
`;

/** 子进程自写状态（测试只读，权威来源 = 子进程实际收到的命令）。 */
interface ChildStatus {
  getStateCount: number;
  withheldBeforeAgentEnd: number;
  withheldAfterAgentEnd: number;
  answersAfterAgentEnd: number;
  agentEndSent: boolean;
  prompts: number;
}

/** spawn 期握手轮数（源码内私有）：3 轮 = fake 0 / 2.5s / 5s。 */
const SPAWN_HANDSHAKE_ROUNDS = 3;
/** 假时钟步长（每次 advance 的毫秒数）。 */
const FAKE_STEP_MS = 10;
/** 回补恢复预算：≤980ms 假时钟（< LAZY_GET_STATE_TIMEOUT_MS=1000）。 */
const RECOVERY_BUDGET_STEPS = 98;

interface Harness {
  rootDir: string;
  sessionDir: string;
  scriptPath: string;
  statusFile: string;
  lateFile: string;
  events: AgentEvent[];
  handleReady: Array<{ sessionRef: Record<string, string>; poolKey: string }>;
  stateChanges: Array<{ pid: number; state: string; killed: boolean; exitCode?: number; signal?: string }>;
  argv1Saved: string | undefined;
}

function makeHarness(mode: string): Harness {
  const rootDir = fs.mkdtempSync(join(tmpdir(), "pi-cli-backfill-"));
  const sessionDir = join(rootDir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const scriptPath = join(rootDir, "fake-pi-backfill.mjs");
  fs.writeFileSync(scriptPath, FAKE_PI_SCRIPT);
  process.env.FAKE_PI_MODE = mode;
  process.env.FAKE_PI_STATUS = join(rootDir, "child-status.json");
  const argv1Saved = process.argv[1];
  process.argv[1] = scriptPath; // getPiInvocation 分支 1：node <script> <args>
  return {
    rootDir,
    sessionDir,
    scriptPath,
    statusFile: join(rootDir, "child-status.json"),
    lateFile: join(sessionDir, "late-backfill-20260910.jsonl"),
    events: [],
    handleReady: [],
    stateChanges: [],
    argv1Saved,
  };
}

function restoreHarness(h: Harness): void {
  process.argv[1] = h.argv1Saved ?? "";
  delete process.env.FAKE_PI_MODE;
  delete process.env.FAKE_PI_STATUS;
  fs.rmSync(h.rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

/** 读子进程状态文件（子进程尚未写出时返回 undefined）。 */
function readStatus(h: Harness): ChildStatus | undefined {
  try {
    return JSON.parse(fs.readFileSync(h.statusFile, "utf8")) as ChildStatus;
  } catch {
    return undefined;
  }
}

function callbacksOf(h: Harness): SpawnRunCallbacks {
  return {
    onEvent: (e) => h.events.push(e),
    onHandleReady: (p) => h.handleReady.push(p),
    onChildSpawned: () => {},
    onChildStateChanged: (p) => h.stateChanges.push(p),
    onDelta: () => {},
  };
}

function baseParams(h: Harness, overrides: Partial<SpawnRunParams> = {}): SpawnRunParams {
  return {
    recordId: "rec-backfill-1",
    task: "backfill me",
    agentName: "backfill-agent",
    model: "prov/model-1",
    sessionDir: h.sessionDir,
    cwd: h.rootDir,
    ...overrides,
  };
}

/** 等 runSpawnOnce 完成 spawn + registerActiveChild（后续挂 kill 探针）。 */
async function waitForActiveChild(recordId: string): Promise<ChildProcess> {
  for (let i = 0; i < 200; i++) {
    const child = getActiveChild(recordId);
    if (child !== undefined) return child;
    await realSleep(1);
  }
  throw new Error(`active child not registered: ${recordId}`);
}

/** 真实 macrotask 让出（推进回补/收尾的异步链）。 */
function realTurn(): Promise<void> {
  return realSleep(0).then(() => undefined);
}

afterEach(() => {
  vi.useRealTimers();
  killAllActiveChildren();
  resetAllEpipeFailures();
});

describe("M2 agent_end 惰性回补", () => {
  it("V3：spawn 期 get_state 三轮不应答 + agent_end 恢复应答 → outcome.sessionFile 非空且恢复 ≤1s", async () => {
    const h = makeHarness("backfill");
    vi.useFakeTimers();
    try {
      const recordId = "rec-v3";
      const runPromise = runSpawnOnce(baseParams(h, { recordId }), callbacksOf(h));
      let settled = false;
      const tracked = runPromise.then(
        (r) => {
          settled = true;
          return r;
        },
        (e: unknown) => {
          settled = true;
          throw e;
        },
      );

      // 阶段 1：假时钟推进到子进程收到第 4 次 get_state（= spawn 期三轮 + agent_end 回补）。
      let phase1Steps = 0;
      let statusAtBackfill: ChildStatus | undefined;
      for (; phase1Steps < 1500 && !settled; phase1Steps++) {
        await vi.advanceTimersByTimeAsync(FAKE_STEP_MS);
        const status = readStatus(h);
        if (status !== undefined && status.getStateCount >= SPAWN_HANDSHAKE_ROUNDS + 1) {
          statusAtBackfill = status;
          break;
        }
        await realSleep(1);
      }

      // spawn 期三轮全部被扣住（原事故形态：超时无应答）——子进程侧计数为权威
      // （「无应答」⇒ 该窗口内不可能有身份可回填；父进程侧 handleReady 的时序与
      // 状态文件轮询有竞态，不做断言）
      expect(statusAtBackfill?.getStateCount).toBe(SPAWN_HANDSHAKE_ROUNDS + 1);
      expect(statusAtBackfill?.withheldBeforeAgentEnd).toBe(SPAWN_HANDSHAKE_ROUNDS);
      expect(statusAtBackfill?.agentEndSent).toBe(true);

      // 阶段 2：回补应答到达 → 回填身份 → kill → close 收尾，假时钟推进必须 < 1s
      let recoverySteps = 0;
      for (; recoverySteps < RECOVERY_BUDGET_STEPS && !settled; recoverySteps++) {
        await vi.advanceTimersByTimeAsync(FAKE_STEP_MS);
        await realSleep(1);
      }
      expect(settled).toBe(true);
      expect(recoverySteps * FAKE_STEP_MS).toBeLessThan(1_000);

      const result: SpawnRunResult = await tracked;
      // 身份来自 agent_end 回补（LATE_* 仅在 agent_end 之后的应答里出现）
      expect(result.sessionFile).toBe(h.lateFile);
      expect(result.sessionId).toBe("late-backfill-sess");
      expect(result.success).toBe(true); // endedCleanly（同步段置位）→ exit 0 口径
      expect(result.content).toBe("late-recovered");
      // 回补走 identity 既有回填面：handleReady 恰一次（applyGetStateFields 幂等，不重发）
      expect(h.handleReady).toEqual([
        {
          sessionRef: { sessionId: "late-backfill-sess", sessionFile: h.lateFile },
          poolKey: "shared",
        },
      ]);
      // kill（finally）落在存活子进程上：SIGTERM 收割
      expect(h.stateChanges.map((s) => s.state)).toEqual(["running", "exited"]);
      expect(h.stateChanges[1]).toMatchObject({ killed: true, signal: "SIGTERM" });

      // 子进程侧终态：恰好 4 次 get_state（3 轮握手 + 1 次回补，无多余重试），
      // 且 spawn 期 3 次全部不应答、agent_end 后应答恰 1 次
      expect(readStatus(h)).toMatchObject({
        getStateCount: SPAWN_HANDSHAKE_ROUNDS + 1,
        withheldBeforeAgentEnd: SPAWN_HANDSHAKE_ROUNDS,
        answersAfterAgentEnd: 1,
        prompts: 1,
      });
      expect(readStatus(h)?.agentEndSent).toBe(true);
    } finally {
      restoreHarness(h);
    }
  }, 30_000);

  it("[U-A3] 回补也不应答（超时路径）：agent_end 起 1s 假时钟内 run 必收敛，真正测量 ≤1s 上界", async () => {
    // 既有 V3 用例验的是「应答先到」路径（LAZY_GET_STATE_TIMEOUT_MS 放大到 10s/100s
    // 它照样绿——约束不了 1s 上界）。本用例对端在 agent_end 后同样扣住应答，run 的收敛
    // 只能由回补超时（控制面单请求，秒级）驱动：断言「agent_end 起 1s 假时钟内 settle」，
    // 值域锚定规则 19 的控制面单请求量级。
    const h = makeHarness("no-answer");
    vi.useFakeTimers();
    try {
      const recordId = "rec-no-answer";
      const runPromise = runSpawnOnce(baseParams(h, { recordId }), callbacksOf(h));
      let settled = false;
      const tracked = runPromise.then(
        (r) => {
          settled = true;
          return r;
        },
        (e: unknown) => {
          settled = true;
          throw e;
        },
      );

      // 阶段 1：推进到子进程发出 agent_end（spawn 期三轮握手全部被扣住）。
      // 状态文件读取在子进程写入瞬间可能读到半截 JSON（readStatus 返回 undefined）——
      // 以「完整解析出 agentEndSent」为跳出条件并留档，避免随后重读踩写窗口。
      let statusAtAgentEnd: ChildStatus | undefined;
      for (let i = 0; i < 1500 && !settled; i++) {
        await vi.advanceTimersByTimeAsync(FAKE_STEP_MS);
        const status = readStatus(h);
        if (status?.agentEndSent === true) {
          statusAtAgentEnd = status;
          break;
        }
        await realSleep(1);
      }
      expect(statusAtAgentEnd?.agentEndSent).toBe(true);
      expect(settled).toBe(false); // 回补尚未超时：run 必须还在等

      // 阶段 2：agent_end 起 ≤1s 假时钟内必须收敛（回补超时上界；更大即超时值域失守）
      await vi.advanceTimersByTimeAsync(1_000);
      for (let i = 0; i < 400 && !settled; i++) await realSleep(5); // 真实 close I/O 收敛
      expect(settled).toBe(true);

      const result: SpawnRunResult = await tracked;
      expect(result.success).toBe(true); // endedCleanly（同步段置位）→ exit 0 口径
      expect(result.sessionFile).toBeUndefined(); // 回补 miss（对端全程不应答）
      expect(result.sessionId).toBeUndefined();
      // 走过的确实是超时路径而非「应答先到」：agent_end 后的 get_state 一条都没被应答
      expect(readStatus(h)).toMatchObject({
        getStateCount: SPAWN_HANDSHAKE_ROUNDS + 1, // 3 轮握手 + 1 次 agent_end 回补
        answersAfterAgentEnd: 0,
        withheldAfterAgentEnd: 1,
      });
    } finally {
      restoreHarness(h);
    }
  }, 30_000);

  it("回补段 reject → killChild 在 finally 必达；endedCleanly 同步段先置且不受回补失败影响", async () => {
    const runEnd: RunEndState = { endedCleanly: false };
    const observed: Array<{ at: string; endedCleanly: boolean }> = [];
    const killSources: string[] = [];

    orchestrateAgentEndBackfill({
      runEnd,
      recordId: "rec-throw",
      backfill: () => {
        observed.push({ at: "backfill-start", endedCleanly: runEnd.endedCleanly });
        // 回补结果处理链抛错（设计 §3.4：onHandleReady → server 组帧链）
        return Promise.reject(new Error("onHandleReady → server 组帧链抛错"));
      },
      killChild: (source) => {
        observed.push({ at: "kill", endedCleanly: runEnd.endedCleanly });
        killSources.push(source);
      },
    });

    // 同步段：调用返回时标记已置位、回补已启动，但 kill 尚未发生（await 挂起中）
    expect(runEnd.endedCleanly).toBe(true);
    expect(observed).toEqual([{ at: "backfill-start", endedCleanly: true }]);
    expect(killSources).toEqual([]);

    await realTurn();
    expect(observed).toEqual([
      { at: "backfill-start", endedCleanly: true },
      { at: "kill", endedCleanly: true },
    ]);
    expect(killSources).toEqual(["agent_end final kill"]);
    expect(runEnd.endedCleanly).toBe(true); // 回补失败不改写同步段标记
  });

  it("回补段同步 throw → killChild 仍在 finally 必达（同步路径不经 await）", async () => {
    const runEnd: RunEndState = { endedCleanly: false };
    const killSources: string[] = [];

    orchestrateAgentEndBackfill({
      runEnd,
      recordId: "rec-sync-throw",
      backfill: () => {
        throw new Error("同步抛错（回补组帧）");
      },
      killChild: (source) => killSources.push(source),
    });

    expect(runEnd.endedCleanly).toBe(true);
    // 同步抛错在 try 内被 catch → finally 同帧执行：调用返回时 kill 已必达
    expect(killSources).toEqual(["agent_end final kill"]);
    await realTurn();
    expect(killSources).toEqual(["agent_end final kill"]);
    expect(runEnd.endedCleanly).toBe(true);
  });

  it("K1：回补接线走 identity 既有回填面（addStateListener → applyGetStateFields → handleReady）", async () => {
    const ready: Array<{ sessionRef: Record<string, string>; poolKey: string }> = [];
    const identity: SessionIdentityTracker = createSessionIdentityTracker("/tmp/k1-sessions", {
      onEvent: () => {},
      onHandleReady: (p) => ready.push(p),
    });
    const writes: string[] = [];
    const child = {
      stdin: {
        destroyed: false,
        write(line: string): boolean {
          writes.push(line);
          return true;
        },
      },
    } as unknown as ChildProcess;

    const backfill = backfillSessionFileAtAgentEnd(child, identity);
    // 回补请求已发出（requestGetStateOnce 单次 get_state，无重试）
    expect(writes).toHaveLength(1);
    const sent = JSON.parse(writes[0]!) as { id: string; type: string };
    expect(sent.type).toBe("get_state");

    // 应答经 stdout pump 的分发路径到达 → 身份落位 + handleReady
    identity.dispatchStateResponse(sent.id, true, {
      sessionFile: "/tmp/k1-sessions/late.jsonl",
      sessionId: "late-1",
    });
    await backfill;

    expect(identity.sessionFile).toBe("/tmp/k1-sessions/late.jsonl");
    expect(identity.sessionId).toBe("late-1");
    expect(ready).toEqual([
      {
        sessionRef: { sessionId: "late-1", sessionFile: "/tmp/k1-sessions/late.jsonl" },
        poolKey: "shared",
      },
    ]);
  });

  it("K2：回补 finally 的 kill 落在已退出子进程 → killChain 幂等 no-op（不发信号、不抛、可重复）", async () => {
    const killSpy = vi.fn(() => true);
    const reaped = {
      exitCode: 0,
      signalCode: null,
      kill: killSpy,
      once: vi.fn(),
    } as unknown as KillableChild;
    // 与 runSpawnOnce 的 killChild 同形（同名杀链、同 grace、同 unrefTimers）
    const killChild = (source: string): void => {
      void killChain(reaped, {
        graceMs: PI_KILL_GRACE_MS,
        unrefTimers: true,
        escalationNote: `child rec-k2 (source: ${source})`,
      });
    };
    const backfillRuns: string[] = [];
    const runEnd: RunEndState = { endedCleanly: false };

    orchestrateAgentEndBackfill({
      runEnd,
      recordId: "rec-k2",
      backfill: async () => {
        backfillRuns.push("miss（子进程已自行退出，无应答）");
        return {};
      },
      killChild,
    });

    await realTurn();
    expect(backfillRuns).toHaveLength(1); // 回补已跑完 → finally 已进入
    expect(killSpy).not.toHaveBeenCalled(); // exitCode 非 null → 杀链早退，不发信号
    expect(reaped.once).not.toHaveBeenCalled(); // 早退路径不注册 exit 监听

    killChild("agent_end final kill"); // race：重复调用（回补窗口内进程自行退出）
    await realTurn();
    expect(killSpy).not.toHaveBeenCalled();
    expect(reaped.exitCode).toBe(0); // 退出态未被改写
  });

  it("race①：子进程在回补窗口内自行退出 → run 正常终态（exit 0）、回补 miss、kill 对已回收进程 no-op", async () => {
    const h = makeHarness("self-exit");
    vi.useFakeTimers();
    try {
      const recordId = "rec-self-exit";
      const runPromise = runSpawnOnce(baseParams(h, { recordId }), callbacksOf(h));
      let settled = false;
      const tracked = runPromise.then(
        (r) => {
          settled = true;
          return r;
        },
        (e: unknown) => {
          settled = true;
          throw e;
        },
      );

      const child = await waitForActiveChild(recordId);
      const killSpy = vi.spyOn(child, "kill");

      for (let i = 0; i < 400 && !settled; i++) {
        await vi.advanceTimersByTimeAsync(FAKE_STEP_MS);
        await realSleep(1);
      }
      expect(settled).toBe(true);

      const result = await tracked;
      expect(result.success).toBe(true); // endedCleanly 同步段先置 → close 走 exit 0
      expect(result.sessionFile).toBeUndefined(); // 无任何 get_state 应答 → 回补 miss

      // 推过回补 1s 超时：finally 的 kill 落在已回收进程上，no-op（不发信号、不抛）
      for (let i = 0; i < 120; i++) {
        await vi.advanceTimersByTimeAsync(FAKE_STEP_MS);
        await realSleep(1);
      }
      expect(killSpy).not.toHaveBeenCalled();
      expect(child.exitCode).toBe(0);
      expect(readStatus(h)?.withheldBeforeAgentEnd).toBeGreaterThanOrEqual(1);
      expect(h.stateChanges.at(-1)).toMatchObject({
        state: "exited",
        killed: false,
        exitCode: 0,
      });
    } finally {
      restoreHarness(h);
    }
  }, 30_000);
});
