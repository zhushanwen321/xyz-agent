// src/execution/__tests__/spawn-worktree-guidance.test.ts
//
// worktree 模式认知纠正提示注入测试。
//
// 背景：worktree checkout 放 os.tmpdir()（路径形似临时沙箱），子 agent 无 worktree 语义
// 提示时误判 cwd 为"空隔离目录"，主动 cd 别处放弃隔离（wave-agent 事故 session 019ff64c）。
// 修复在 runSpawn 的 appendParts 注入 WORKTREE_GUIDANCE_PROMPT。
//
// 验证：
//   - worktree 模式（opts.worktree 传入）→ appendSystemPrompt content 含 WORKTREE_GUIDANCE_PROMPT
//   - 非 worktree 模式 → content 不含 worktree 提示
//
// 测试策略：mock writePromptToTempFile 捕获拼接后的 appendParts content（vi.hoisted 防
// vi.mock hoisting 引用未初始化变量），断言含/不含 worktree 提示标识。

import type { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 捕获 writePromptToTempFile 的 content 参数（appendParts.join("\n\n")）。
// vi.hoisted 保证变量在 vi.mock factory hoisting 前已声明可用。
const captured = vi.hoisted(() => ({ content: "" }));

// ── mock modules（与 session-runner-schema-env.test.ts 同模式）──

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

vi.mock("../engine/engines/pi/temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string, content: string) => {
    captured.content = content;
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { spawn } from "node:child_process";

import { createRecord } from "../execution-record.ts";
import { runSpawn, type RunOptions, type SessionRunnerContext } from "../engine/engines/pi/session-runner.ts";

const mockSpawn = vi.mocked(spawn);

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

async function waitForSpawn(timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (mockSpawn.mock.results.length === 0) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`spawn was not called within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeRecord() {
  return createRecord("wt-guidance-1", {
    agent: "general-purpose",
    model: "test/model",
    mode: "sync",
    task: "test task",
    startedAt: Date.now(),
    rootSessionId: "s1",
    parentRecordId: undefined,
    depth: 0,
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
    sessionRootId: "root-session-test",
    rootCwd: "/fake/cwd",
    ...overrides,
  };
}

describe("worktree guidance prompt injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.content = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("worktree 模式 → appendSystemPrompt content 含 worktree 认知纠正提示", async () => {
    const record = makeRecord();
    const opts = makeRunOpts({
      worktree: {
        path: "/tmp/pi-subagents/--fake--/pi-sub-sa-wt-guidance-1",
        branch: "pi-sub-sa-wt-guidance-1",
        baseCommit: "abc123",
        mainCwd: "/fake/cwd",
      },
    });
    const ctx = makeCtx();

    const resultPromise = runSpawn(record, "test task", opts, ctx);
    await waitForSpawn();

    // content 含 WORKTREE_GUIDANCE_PROMPT 的标题
    expect(captured.content).toContain("Git Worktree");
    // 含关键纠正信息：cwd 含完整项目代码（非临时沙箱）
    expect(captured.content).toContain("complete project source code");
    // 含防 cd 别处的行为指引
    expect(captured.content).toContain("Do NOT");

    const child = getLastSpawnedChild();
    child.emit("close", 0);
    await resultPromise;
  });

  it("非 worktree 模式 → content 不含 worktree 认知提示", async () => {
    const record = makeRecord();
    const opts = makeRunOpts(); // 不传 worktree
    const ctx = makeCtx();

    const resultPromise = runSpawn(record, "test task", opts, ctx);
    await waitForSpawn();

    expect(captured.content).not.toContain("Git Worktree");

    const child = getLastSpawnedChild();
    child.emit("close", 0);
    await resultPromise;
  });
});
