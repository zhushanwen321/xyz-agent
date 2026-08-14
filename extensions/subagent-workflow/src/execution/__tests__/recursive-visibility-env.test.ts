// src/__tests__/recursive-visibility-env.test.ts
//
// 递归 subagent 跨层可见性：env 身份贯穿验证（设计 docs/design/recursive-subagent-visibility.md 场景 1b）。
//
// 验证 runSpawn 构造的 childEnv 含 4 个 PI_SUBAGENT_* 身份 env，值 = ctx.sessionRootId /
// record.id / String(record.depth) / ctx.rootCwd（[MF-3] 第 4 个：ROOT cwd，落盘目录编码键）。覆盖 opts.fork=true 与 opts.fork=false 两种（决策 2 无条件注入）。
//
// 这是场景 1（端到端三层嵌套全树可见）的「env 传递机制」确定性验证——不依赖 LLM 配合，
// mock spawn 拦截 childEnv 直接断言。端到端可见性由场景 1（真实 pi CLI + recursive-worker agent）覆盖。

import type { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSubagentSessionDir } from "../path-encoding.ts";

// ── mock modules（同 session-runner-schema-env.test.ts 模式）──

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");

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
    execFileSync: vi.fn(() => ""),
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

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";

import { createRecord } from "../execution-record.ts";
import { type RunOptions, runSpawn, type SessionRunnerContext } from "../session-runner.ts";

const mockSpawn = vi.mocked(spawn);
const mockExec = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);

interface FakeChild {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  killSignal: string | undefined;
  kill(sig?: string): boolean;
  emit(event: string, ...args: unknown[]): boolean;
}

function getLastSpawnedChild(): FakeChild {
  const result = mockSpawn.mock.results.at(-1);
  if (!result) throw new Error("spawn was not called yet");
  return result.value as FakeChild;
}

function getLastSpawnEnv(): Record<string, string | undefined> {
  return (mockSpawn.mock.calls.at(-1)?.[2]?.env as Record<string, string | undefined>) ?? {};
}

/** 等待 runSpawn 内部调到 spawn（async，spawn 在 writePromptToTempFile await 之后才调）。 */
async function waitForSpawn(timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (mockSpawn.mock.results.length === 0) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`spawn was not called within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── fixture ──

function makeRecord(overrides: { id?: string; depth?: number } = {}) {
  return createRecord(overrides.id ?? "sa-test-record", {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: "test task",
    startedAt: Date.now(),
    rootSessionId: "should-be-overridden-by-sessionRootId-source",
    parentRecordId: undefined,
    depth: overrides.depth ?? 0,
  });
}

function makeRunOpts(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    resolved: { model: { provider: "test", id: "model" }, thinkingLevel: undefined },
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
    cwd: "/fake/cwd",
    agentDir: "/fake/agent",
    skillDirs: [],
    mainCwd: "/fake/cwd",
    sessionRootId: "root-main-session",
    rootCwd: "/fake/cwd",
    ...overrides,
  };
}

// ── runSpawn childEnv 身份 env 注入（场景 1b）──

describe("runSpawn 跨进程身份 env 注入（递归可见性场景 1b）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockExec.mockReturnValue("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("非 fork（fork=false/undefined）：无条件注入 4 个身份 env（决策 2）", async () => {
    const record = makeRecord({ id: "sa-aaa", depth: 0 });
    const ctx = makeCtx({ sessionRootId: "root-main" });
    const opts = makeRunOpts({ fork: false });

    const resultPromise = runSpawn(record, "test task", opts, ctx);
    await waitForSpawn();
    const childEnv = getLastSpawnEnv();

    expect(childEnv.PI_SUBAGENT_ROOT_SESSION_ID).toBe("root-main");
    expect(childEnv.PI_SUBAGENT_SELF_RECORD_ID).toBe("sa-aaa");
    expect(childEnv.PI_SUBAGENT_DEPTH).toBe("0");
    // [MF-3] 第 4 个贯穿 env：ROOT cwd（子进程落盘目录编码键）
    expect(childEnv.PI_SUBAGENT_ROOT_CWD).toBe("/fake/cwd");
    // fork=false 不注入 fork depth env（与既有行为一致，本测试不改变它）
    expect(childEnv.PI_SUBAGENT_FORK_DEPTH).toBeUndefined();

    const child = getLastSpawnedChild();
    child.emit("close", 0);
    await resultPromise;
  });

  it("fork=true：4 个身份 env 与 fork depth env 共存（决策 2 无条件注入不依赖 fork）", async () => {
    const record = makeRecord({ id: "sa-bbb", depth: 2 });
    const ctx = makeCtx({ sessionRootId: "root-main" });
    const opts = makeRunOpts({ fork: true, parentForkDepth: 1 });

    const resultPromise = runSpawn(record, "test task", opts, ctx);
    await waitForSpawn();
    const childEnv = getLastSpawnEnv();

    // 身份 env 无条件存在（决策 2）
    expect(childEnv.PI_SUBAGENT_ROOT_SESSION_ID).toBe("root-main");
    expect(childEnv.PI_SUBAGENT_SELF_RECORD_ID).toBe("sa-bbb");
    expect(childEnv.PI_SUBAGENT_DEPTH).toBe("2");
    expect(childEnv.PI_SUBAGENT_ROOT_CWD).toBe("/fake/cwd");
    // fork depth env 同时存在（fork=true + parentForkDepth=1 → 2）
    expect(childEnv.PI_SUBAGENT_FORK_DEPTH).toBe("2");

    const child = getLastSpawnedChild();
    child.emit("close", 0);
    await resultPromise;
  });

  it("深层 record（depth=3）：DEPTH env = String(record.depth)，正确贯穿嵌套层级", async () => {
    const record = makeRecord({ id: "sa-deep", depth: 3 });
    const ctx = makeCtx({ sessionRootId: "root-topmost" });

    const resultPromise = runSpawn(record, "test task", makeRunOpts(), ctx);
    await waitForSpawn();
    const childEnv = getLastSpawnEnv();

    expect(childEnv.PI_SUBAGENT_DEPTH).toBe("3");
    expect(childEnv.PI_SUBAGENT_SELF_RECORD_ID).toBe("sa-deep");
    expect(childEnv.PI_SUBAGENT_ROOT_SESSION_ID).toBe("root-topmost");

    const child = getLastSpawnedChild();
    child.emit("close", 0);
    await resultPromise;
  });

  it("ROOT_SESSION_ID 恒等于 ctx.sessionRootId（贯穿真 ROOT，非 record.rootSessionId）", async () => {
    // record.rootSessionId 是 createRecord 时写入的值（可能来自旧逻辑），但 env 注入用的是
    // ctx.sessionRootId（经 buildSessionRunnerContext 从 this.sessionRootId 透传，贯穿真 ROOT）。
    // 这保证深层 subagent 的子进程仍归顶层 ROOT（设计决策 1/3）。
    const record = makeRecord({ id: "sa-ccc" }); // record.rootSessionId = fixture 默认值
    const ctx = makeCtx({ sessionRootId: "real-root-session" });

    const resultPromise = runSpawn(record, "test task", makeRunOpts(), ctx);
    await waitForSpawn();
    const childEnv = getLastSpawnEnv();

    // env 用 ctx.sessionRootId，不是 record.rootSessionId
    expect(childEnv.PI_SUBAGENT_ROOT_SESSION_ID).toBe("real-root-session");
    expect(childEnv.PI_SUBAGENT_ROOT_SESSION_ID).not.toBe(record.rootSessionId);

    const child = getLastSpawnedChild();
    child.emit("close", 0);
    await resultPromise;
  });

  it("[MF-3 回归] worktree 模式（mainCwd=checkout ≠ rootCwd）：sessionDir 用 ROOT cwd 编码，深层 record 落盘到 ROOT 可扫描段", async () => {
    // 模拟 B（worktree 子进程）spawn C：ctx.cwd/mainCwd = checkout 路径，rootCwd = 真 ROOT cwd。
    // 旧实现 sessionDir 用 ctx.mainCwd 编码 → enc(checkout) 段，ROOT 磁盘重建扫不到（MF-3）。
    const rootCwd = "/root/project";
    const checkoutPath = "/var/folders/worktree/pi-subagents/--root-project--/branch";
    const agentDir = "/fake/agent";
    const record = makeRecord({ id: "sa-deep", depth: 2 });
    const ctx = makeCtx({ cwd: checkoutPath, mainCwd: checkoutPath, rootCwd, agentDir });

    const resultPromise = runSpawn(record, "test task", makeRunOpts(), ctx);
    await waitForSpawn();
    const childEnv = getLastSpawnEnv();
    const spawnArgs = mockSpawn.mock.calls.at(-1)?.[1] as string[];

    // 第 4 个 env 贯穿 ROOT cwd
    expect(childEnv.PI_SUBAGENT_ROOT_CWD).toBe(rootCwd);
    // spawn --session-dir 指向 enc(ROOT cwd)（非 enc(checkout)）
    expect(spawnArgs).toContain(getSubagentSessionDir(agentDir, rootCwd));
    expect(spawnArgs).not.toContain(getSubagentSessionDir(agentDir, checkoutPath));

    const child = getLastSpawnedChild();
    child.emit("close", 0);
    await resultPromise;
  });
});
