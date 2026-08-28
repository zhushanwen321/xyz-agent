// src/__tests__/timeout-integration.test.ts
//
// timeoutMs / signal abort → child.kill 端到端路径测试。
//
// 背景：session-runner.ts 无独立 timeoutMs 字段——超时机制是 watchdog（基于
// computeWatchdogMs(opts.maxTurns) 动态计算的下限 30min timer，兜底 SIGTERM）；
// 外部取消通过 opts.signal (AbortSignal) 传播：onAbort → child.kill("SIGTERM")。
// 故「timeout 端到端路径」实际是 watchdog timer + signal abort → child.kill 两条链路。
//
// 本文件聚焦三条终止语义路径（与 run-spawn-integration.test.ts §12 watchdog 测试互补，
// 该文件关注 timer 边界值，本文件关注端到端 kill 语义 + 外部 signal 场景）：
//   1. watchdog 到期 → child.kill（maxTurns 驱动的整体超时兜底）
//   2. 正常完成先于 watchdog 到期 → clearTimeout 生效，不 kill
//   3. 外部 signal abort（运行中 abort / spawn 前已 aborted）→ child.kill
//
// mock 策略（与 run-spawn-integration.test.ts / run-spawn-edges.test.ts 一致）：
//   - node:child_process.spawn → 返回 FakeChild（EventEmitter + PassThrough）。
//   - node:child_process.execFile → err-first callback 默认兜底（buildEnvBlock git branch
//     失败 → catch → branch=""）。
//   - node:fs 同步方法 → mock（避免触碰真实文件系统），promises 保留真实实现。
//   - temp-prompt → mock（返回固定路径，消除 fake-timers flaky）。
//   - alive-store.writeAliveMarker → mock。

import type { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock modules ──
// vitest 把 vi.mock 提升到文件顶部，工厂内部引用模块用 await import。

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");

  // FakeChild：模拟 ChildProcess（EventEmitter + PassThrough streams）。
  class FakeChild extends EventEmitter {
    pid = 12345;
    stdout = new PassThrough();
    stdin = new PassThrough(); // runSpawn 注册 stdin EPIPE handler（session-runner），FakeChild 必须提供
    stderr = new PassThrough();
    killed = false;
    killSignal: string | undefined;
    kill(sig?: string): boolean {
      this.killed = true;
      this.killSignal = sig;
      return true;
    }
  }

  return {
    spawn: vi.fn(() => new FakeChild()),
    // buildEnvBlock 用 execFile 异步取 git branch：默认 err-first 兜底（catch → branch=""）
    execFile: vi.fn(
      (
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, stdout?: string, stderr?: string) => void,
      ) => cb(new Error("execFile not configured in this test")),
    ),
  };
});

vi.mock("node:fs", async () => {
  const actual = await import("node:fs");
  return {
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => false),
      appendFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      readdirSync: vi.fn(() => []),
    },
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    promises: actual.promises,
  };
});

vi.mock("../alive-store.ts", () => ({
  writeAliveMarker: vi.fn(),
}));

vi.mock("../temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { spawn } from "node:child_process";
import * as fs from "node:fs";

import { createRecord } from "../execution-record.ts";
import {
  computeWatchdogMs,
  type RunOptions,
  resolveSpawnWatchdogMs,
  runSpawn,
  SPAWN_WATCHDOG_ENV,
  type SessionRunnerContext,
} from "../session-runner.ts";

const mockSpawn = vi.mocked(spawn);
const mockExistsSync = vi.mocked(fs.existsSync);

/**
 * spawn mock 返回的 fake child 类型（结构子集）。
 * FakeChild 定义在 vi.mock 工厂内部（作用域隔离），测试代码通过此类型访问成员。
 */
interface FakeChild {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  killSignal: string | undefined;
  kill(sig?: string): boolean;
  emit(event: string, ...args: unknown[]): boolean;
}

/** 从最近一次 spawn 调用取回返回的 FakeChild。 */
function lastSpawnedChild(): FakeChild {
  const result = mockSpawn.mock.results.at(-1);
  if (!result) throw new Error("spawn was not called yet");
  return result.value as FakeChild;
}

// ============================================================
// 辅助：向 stdout 写一行（自动补换行）
// ============================================================

function emitStdoutLine(child: FakeChild, obj: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify(obj)}\n`);
}

/** 构造 session header 行（stdout 首行）。 */
function sessionHeader(id = "sess-abc"): Record<string, unknown> {
  return {
    type: "session",
    id,
    timestamp: "2026-07-03T12-00-00-000Z",
    cwd: "/tmp/test",
  };
}

// ============================================================
// 辅助：构造最小合法的 record / opts / ctx
// ============================================================

function makeRecord() {
  return createRecord("run-1", {
    agent: "general-purpose",
    model: "test-model",
    mode: "sync",
    task: "do something",
    startedAt: 1_000_000,
    rootSessionId: "root-session",
    parentRecordId: undefined,
    depth: 0,
  });
}

function makeOpts(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    resolved: {
      model: {
        id: "test-model",
        name: "Test Model",
        provider: "test",
        reasoning: false,
      },
      thinkingLevel: undefined,
    },
    agentConfig: undefined,
    appendSystemPrompt: undefined,
    skillPath: undefined,
    schema: undefined,
    maxTurns: undefined,
    graceTurns: undefined,
    signal: undefined,
    onEvent: undefined,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<SessionRunnerContext> = {}): SessionRunnerContext {
  return {
    cwd: "/tmp/test",
    agentDir: "/tmp/test/agents",
    skillDirs: [],
    mainCwd: "/tmp/test",
    mainSessionFile: undefined,
    sessionRootId: "root-session-test",
    rootCwd: "/tmp/test",
    ...overrides,
  };
}

/**
 * fake timers 下推进时间直到 spawn 被调用（返回 child 控制器，与共享 helper 的 void 返回
 * 不同，故就地维护）。
 *
 * [快照语义] 同 helpers/spawn-mock.ts 的 waitForSpawn：记调用时 baseline，等待其后的
 * **新** spawn——支持同一测试/文件内多次 runSpawn（旧 `length === 0` 只对首次有效）。
 *
 * runSpawn 在 mkdirSync + writePromptToTempFile（mock 的 async I/O）之后才调 spawn。
 * 每次推进 10ms 让轮询 setTimeout 触发，advanceTimersByTimeAsync 同时 flush 已 resolve
 * 的 I/O promise，使 runSpawn 继续走到 spawn。
 */
async function waitForSpawnFake(timeoutSteps = 200): Promise<FakeChild> {
  const baseline = mockSpawn.mock.results.length;
  for (let i = 0; i < timeoutSteps; i++) {
    if (mockSpawn.mock.results.length > baseline) break;
    await vi.advanceTimersByTimeAsync(10);
  }
  if (mockSpawn.mock.results.length <= baseline) {
    throw new Error("spawn was not called (fake timers did not progress to spawn)");
  }
  return lastSpawnedChild();
}

/**
 * 真实 timers 下轮询直到 spawn 被调用（返回 child 控制器；用于 signal abort 测试——
 * 不需要推进 watchdog，用 queueMicrotask 触发 abort，真实 timers 下 mock I/O 正常 resolve）。
 *
 * [快照语义] 同 helpers/spawn-mock.ts 的 waitForSpawn：记 baseline 等**新** spawn，
 * 支持同文件多次 runSpawn。
 */
async function waitForSpawnReal(timeoutMs = 1000): Promise<FakeChild> {
  const start = Date.now();
  const baseline = mockSpawn.mock.results.length;
  while (mockSpawn.mock.results.length <= baseline) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`spawn was not called within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  return lastSpawnedChild();
}

// ============================================================
// 测试
// ============================================================

describe("timeoutMs / signal abort → child.kill 端到端路径", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    // [F-4 假红源修复] env 隔离：多数用例默认 maxTurns=undefined →
    // resolveSpawnWatchdogMs 走 env 兑底分支，宿主 export SPAWN_WATCHDOG 即假红
    //（极端值 3e9 还会在 assertSafeTimerDelay fail-fast 直接炸掉 runSpawn）。
    // 用例内显式 stubEnv 的值照常叠加生效（inner describe 的 afterEach
    // unstubAllEnvs 与本处兼容）。
    vi.stubEnv(SPAWN_WATCHDOG_ENV, "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // ── 1. watchdog 到期 → child.kill ──
  //
  // [R1] watchdog = setTimeout(() => child.kill("SIGTERM"), computeWatchdogMs(maxTurns))。
  // computeWatchdogMs 下限 30min（SPAWN_WATCHDOG_FLOOR_MS），maxTurns=6 → max(30min, 30min)=30min。
  // 子进程卡死（turn_end 永不触发）时 limiter 失效，watchdog 兜底 kill 防资源泄漏。
  describe("watchdog 到期 → signal abort → child.kill", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("watchdog 到期（超过 computeWatchdogMs 阈值）→ child.kill(SIGTERM) 被调用", async () => {
      const record = makeRecord();
      // maxTurns=6 → computeWatchdogMs = max(30min, 6*5min) = 30min
      // 不 await：runSpawn 内部 await 子进程 close，watchdog kill 后还需 emit close 才 resolve
      const promise = runSpawn(record, "Task: hang", makeOpts({ maxTurns: 6 }), makeCtx());

      const child = await waitForSpawnFake();

      // spawn 后尚未触发 kill
      expect(child.killed).toBe(false);

      // 推进时间越过 watchdog 阈值（30 * 60 * 1000 + 100ms 余量）
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 100);

      // watchdog 触发 child.kill("SIGTERM")
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");

      // 收尾：emit close 让 runSpawn resolve（避免悬挂）
      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 143); // SIGTERM = 128+15

      const result = await promise;
      // 信号终止（>=128）视为正常完成
      expect(result.success).toBe(true);
    });
  });

  // ── 2. watchdog 默认不挂载 + env 兑底（预算语义对齐 2026-08）──
  //
  // 语义：maxTurns 未传 → env 兑底；显式 0/负 → 压过 env 不挂（U5，SP-6 参数 > env，
  // 旧实现 maxTurns:0 落到 env 兑底，参数显式关不掉 watchdog，已废）；
  // env XYZ_SUBAGENT_SPAWN_WATCHDOG_MS 设置时按绝对时限兑底挂载（hang 泄漏防线
  // opt-in）。resolveSpawnWatchdogMs 是挂载判定唯一入口。
  describe("watchdog 默认不挂载 + env 兑底（预算语义对齐）", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    it("resolveSpawnWatchdogMs：maxTurns 未传/0/负数且 env 未设 → undefined（不挂）", () => {
      vi.stubEnv(SPAWN_WATCHDOG_ENV, ""); // 空串 = 未设（raw falsy）
      expect(resolveSpawnWatchdogMs(undefined)).toBeUndefined();
      expect(resolveSpawnWatchdogMs(null)).toBeUndefined();
      expect(resolveSpawnWatchdogMs(0)).toBeUndefined();
      expect(resolveSpawnWatchdogMs(-5)).toBeUndefined();
    });

    it("resolveSpawnWatchdogMs：env 设置 → 绝对时限；非法值 → undefined；maxTurns 有效优先", () => {
      vi.stubEnv(SPAWN_WATCHDOG_ENV, "60000");
      expect(resolveSpawnWatchdogMs(undefined)).toBe(60_000);
      // [U5] SP-6 参数 > env：显式 0 压过 env 兑底 → 不挂（旧实现落成 60000）
      expect(resolveSpawnWatchdogMs(0)).toBeUndefined();
      expect(resolveSpawnWatchdogMs(-5)).toBeUndefined();
      // maxTurns 有效（>0）→ turns 估算优先于 env 兑底
      expect(resolveSpawnWatchdogMs(6)).toBe(computeWatchdogMs(6));
      vi.stubEnv(SPAWN_WATCHDOG_ENV, "abc");
      expect(resolveSpawnWatchdogMs(undefined)).toBeUndefined();
      vi.stubEnv(SPAWN_WATCHDOG_ENV, "-1");
      expect(resolveSpawnWatchdogMs(undefined)).toBeUndefined();
    });

    // [U1] setTimeout 2^31-1 溢出 fail-fast：溢出 delay 被 Node 置 1ms 立即触发
    //（watchdog 变「启动即杀」），两路径（env 兑底 / turns 估算）都必须在入口拦截。
    it("resolveSpawnWatchdogMs：env 值溢出（>2^31-1）→ fail-fast throw（不静默 clamp/不挂）", () => {
      vi.stubEnv(SPAWN_WATCHDOG_ENV, "3000000000");
      expect(() => resolveSpawnWatchdogMs(undefined)).toThrowError(/2147483647/);
      expect(() => resolveSpawnWatchdogMs(undefined)).toThrowError(/Recovery/);
    });

    it("resolveSpawnWatchdogMs：maxTurns 估算值溢出 → fail-fast throw", () => {
      vi.stubEnv(SPAWN_WATCHDOG_ENV, "");
      // maxTurns=1e6 → 估算 5e9 ms > 2^31-1，入口拦截
      expect(() => resolveSpawnWatchdogMs(1_000_000)).toThrowError(/2147483647/);
    });

    // [F-R3] maxTurns 垃圾值网格：NaN/""/null/0/负数（含 ±Infinity）。
    // 旧实现 NaN/"" 绕过 Number.isFinite 且压过 env 兑底成「显式不限」。
    it("resolveSpawnWatchdogMs：maxTurns NaN → fail-fast throw（压过 env）；\"\"→Number(\"\")=0 显式不限；null/0/负数网格（F-R3）", () => {
      vi.stubEnv(SPAWN_WATCHDOG_ENV, "60000");
      // NaN：非有限数 fail-fast（与 timer-delay U1 同语义），不再压过 env 兑底成「显式不限」
      expect(() => resolveSpawnWatchdogMs(NaN)).toThrowError(/not a finite number/);
      expect(() => resolveSpawnWatchdogMs(NaN)).toThrowError(/Recovery/);
      // ±Infinity：同非有限数 fail-fast
      expect(() => resolveSpawnWatchdogMs(Infinity)).toThrowError(/not a finite number/);
      // ""：Number("") === 0 → 与显式 0 同路径（显式不限，压过 env，U5 语义不回归）
      expect(resolveSpawnWatchdogMs("" as unknown as number)).toBeUndefined();
      // null → 未传语义，env 兑底生效
      expect(resolveSpawnWatchdogMs(null)).toBe(60_000);
      // 0 / 负数 → 显式不限，压过 env（既有 U5 网格不回归）
      expect(resolveSpawnWatchdogMs(0)).toBeUndefined();
      expect(resolveSpawnWatchdogMs(-5)).toBeUndefined();
    });

    it("maxTurns 未传 → 推进 56min 不 kill（旧实现 50min 估算会误杀）", async () => {
      vi.stubEnv(SPAWN_WATCHDOG_ENV, "");
      const record = makeRecord();
      const promise = runSpawn(record, "Task: no-turns", makeOpts({ maxTurns: undefined }), makeCtx());

      const child = await waitForSpawnFake();
      expect(child.killed).toBe(false);

      // 旧实现的估算默认（10 turns → 50min）已过，仍不 kill = watchdog 未挂载
      await vi.advanceTimersByTimeAsync(56 * 60 * 1000);
      expect(child.killed).toBe(false);

      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 0);
      const result = await promise;
      expect(result.success).toBe(true);
    });

    it("maxTurns: 0（显式关不掉的旧默认已废）→ 同样不挂 watchdog", async () => {
      vi.stubEnv(SPAWN_WATCHDOG_ENV, "");
      const record = makeRecord();
      const promise = runSpawn(record, "Task: zero-turns", makeOpts({ maxTurns: 0 }), makeCtx());

      const child = await waitForSpawnFake();
      await vi.advanceTimersByTimeAsync(56 * 60 * 1000);
      expect(child.killed).toBe(false);

      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 0);
      const result = await promise;
      expect(result.success).toBe(true);
    });

    // [U5] SP-6 参数 > env：显式 maxTurns:0 压过 SPAWN_WATCHDOG_ENV 兑底——
    // 旧实现落成 env 时限 kill，参数显式关不掉 watchdog。
    it("maxTurns: 0 + env=60000 → 显式 0 压过 env，61s 不 kill（U5）", async () => {
      vi.stubEnv(SPAWN_WATCHDOG_ENV, "60000");
      const record = makeRecord();
      const promise = runSpawn(record, "Task: zero-turns-override", makeOpts({ maxTurns: 0 }), makeCtx());

      const child = await waitForSpawnFake();
      // 推进越过 env 兑底时限（60s）：若 maxTurns:0 未压过 env，此处已被 kill
      await vi.advanceTimersByTimeAsync(61 * 1000);
      expect(child.killed).toBe(false);

      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 0);
      const result = await promise;
      expect(result.success).toBe(true);
    });

    it("env SPAWN_WATCHDOG_MS=60000 + maxTurns 未传 → 1min 兑底 kill", async () => {
      vi.stubEnv(SPAWN_WATCHDOG_ENV, "60000");
      const record = makeRecord();
      const promise = runSpawn(record, "Task: env-watchdog", makeOpts(), makeCtx());

      const child = await waitForSpawnFake();
      // 非贴边断言：waitForSpawnFake 每步 10ms 推进，watchdog 挂载时刻有 ≤10ms 抖动，
      // 用 55s / 61s 两个窗口避开 60s 贴边比较
      await vi.advanceTimersByTimeAsync(55_000);
      expect(child.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");

      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 143);
      const result = await promise;
      expect(result.success).toBe(true);
    });
  });

  // ── 3. watchdog 到期前正常完成 → clearTimeout 生效，不 kill ──
  describe("watchdog 到期前正常完成 → 不 kill", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("正常 close(0) 先于 watchdog 到期 → clearTimeout 生效，推进时间后 child 未被 kill", async () => {
      const record = makeRecord();
      // maxTurns=6 → watchdog=30min
      const promise = runSpawn(record, "Task: quick", makeOpts({ maxTurns: 6 }), makeCtx());

      const child = await waitForSpawnFake();

      // 正常完成：emit header + close(0)（远早于 30min watchdog）
      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;
      expect(result.success).toBe(true);

      // close 后 runSpawn 已 clearTimeout(watchdog)；推进 30+ 分钟验证 watchdog 未触发 kill
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 100);

      expect(child.killed).toBe(false);
      expect(child.killSignal).toBeUndefined();
    });
  });

  // ── 3. 外部 signal abort → child.kill ──
  //
  // [d] onAbort = () => child.kill("SIGTERM")，opts.signal.addEventListener("abort", onAbort, {once:true})。
  // 前置检查：if (opts.signal?.aborted) onAbort()——spawn 前已 aborted 时 addEventListener
  // 不会触发，立即 kill 兑现取消语义。
  describe("外部 signal abort → child.kill", () => {
    it("运行中 abort signal → child.kill(SIGTERM) 被调用，success=false（取消语义）", async () => {
      const controller = new AbortController();
      const record = makeRecord();
      const promise = runSpawn(
        record,
        "Task: cancelled",
        makeOpts({ signal: controller.signal }),
        makeCtx(),
      );

      const child = await waitForSpawnReal();

      // abort 必须在 spawn 之后（addEventListener 已注册）。
      // queueMicrotask 延迟到当前微任务清空后触发，确保 listener 已挂载。
      queueMicrotask(() => controller.abort());

      // emit header + close（被 kill 后子进程退出，signal 终止 exitCode>=128）
      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 143); // SIGTERM = 128+15

      const result = await promise;

      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");
      // signal.aborted 路径：success=false，但 error 为 undefined（取消不算 error）
      expect(result.success).toBe(false);
      expect(result.error).toBeUndefined();
    });

    it("spawn 前已 aborted 的 signal → 前置检查立即 kill，兑现取消语义", async () => {
      // 覆盖 session-runner.ts L570: if (opts.signal?.aborted) onAbort()
      // 已 aborted 的 signal addEventListener("abort") 不会再触发回调，
      // 故 runSpawn 在注册 listener 后立即前置检查，直接 kill 兑现取消。
      const controller = new AbortController();
      controller.abort(); // spawn 前已 abort

      const record = makeRecord();
      const promise = runSpawn(
        record,
        "Task: pre-aborted",
        makeOpts({ signal: controller.signal }),
        makeCtx(),
      );

      const child = await waitForSpawnReal();

      // 前置检查在 spawn 后同步执行 → child 立即被 kill
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");

      // 收尾：emit close 让 runSpawn resolve
      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 143);

      const result = await promise;
      // signal.aborted → success=false，error undefined
      expect(result.success).toBe(false);
      expect(result.error).toBeUndefined();
    });
  });
});
