/**
 * writeAppendSystemPromptFile 组装矩阵（W2 移交 CRAP 43.1；私有函数，经公共
 * runSpawn 驱动，与 spawn-worktree-guidance.test.ts 同 mock 模式——mock
 * temp-prompt 捕获 appendParts.join 后的完整 content）。
 *
 * 覆盖分支（session-runner.ts g. 段）：
 *   - agentConfig.systemPrompt / appendSystemPrompt 片段 / maxTurns wrap-up hint 的注入与顺序
 *   - ask_user RPC 提示的 mode 门控（rpc=gui 响应 / json=headless 不注入）
 *   - maxTurns 缺省/0 → 不注入 wrap-up hint
 *   - fork depth（env block Depth 行）与 ask_user+wrap-up 的组合互不干扰
 *
 * worktree 分支（WORKTREE_GUIDANCE_PROMPT）已由 spawn-worktree-guidance.test.ts
 * 覆盖，此处不重复。
 */
import type { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ content: "", calls: 0 }));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");

  class FakeChild extends EventEmitter {
    pid = 12345;
    stdout = new PassThrough();
    stdin = new PassThrough();
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

vi.mock("../execution/alive-store.ts", () => ({
  writeAliveMarker: vi.fn(),
}));

vi.mock("../execution/temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string, content: string) => {
    captured.calls++;
    captured.content = content;
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { spawn } from "node:child_process";

import { createRecord } from "../execution/execution-record.ts";
import { runSpawn, type RunOptions, type SessionRunnerContext } from "../execution/session-runner.ts";

const mockSpawn = vi.mocked(spawn);

interface FakeChild {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  killSignal: string | undefined;
  emit(event: string, ...args: unknown[]): boolean;
}

function getLastSpawnedChild(): FakeChild {
  const result = mockSpawn.mock.results.at(-1);
  if (!result) throw new Error("spawn was not called yet");
  return result.value as FakeChild;
}

/** 等待第 targetCount 次 spawn 发生（同测试多次 runSpawn 时按基线递增等待）。 */
async function waitForSpawn(targetCount = 1, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (mockSpawn.mock.results.length < targetCount) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`spawn #${targetCount} not called within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

let seq = 0;

function makeRecord() {
  seq += 1;
  return createRecord(`append-asm-${seq}`, {
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

/** 跑一次 runSpawn 并捕获 appendSystemPrompt content（完成后释放子进程）。 */
async function captureAppendContent(opts: RunOptions, ctx: SessionRunnerContext): Promise<string> {
  const baseline = mockSpawn.mock.results.length;
  const resultPromise = runSpawn(makeRecord(), "test task", opts, ctx);
  await waitForSpawn(baseline + 1);
  const content = captured.content;
  const child = getLastSpawnedChild();
  child.emit("close", 0);
  await resultPromise;
  return content;
}

describe("writeAppendSystemPromptFile 组装（经 runSpawn 驱动）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.content = "";
    captured.calls = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("全片段组装：env block → agent body → 调用方片段 → wrap-up hint，顺序稳定", async () => {
    const content = await captureAppendContent(
      makeRunOpts({
        agentConfig: { systemPrompt: "AGENT-BODY-MARKER" },
        appendSystemPrompt: ["FRAG-ONE", "FRAG-TWO"],
        maxTurns: 5,
      }),
      makeCtx(),
    );
    expect(content).toContain("AGENT-BODY-MARKER");
    expect(content).toContain("FRAG-ONE");
    expect(content).toContain("FRAG-TWO");
    // maxTurns>0 → 注入 wrap-up 收尾提示（rpc steer 未接通的启动期补偿）
    expect(content).toContain("You have a turn limit");
    // 顺序：env block 最前，agent body 在调用方片段前，hint 在其后
    const envIdx = content.indexOf("--- environment");
    const bodyIdx = content.indexOf("AGENT-BODY-MARKER");
    const fragIdx = content.indexOf("FRAG-ONE");
    const hintIdx = content.indexOf("You have a turn limit");
    expect(envIdx).toBeLessThan(bodyIdx);
    expect(bodyIdx).toBeLessThan(fragIdx);
    expect(fragIdx).toBeLessThan(hintIdx);
  });

  it("maxTurns 缺省/0 → 不注入 wrap-up hint（不限时不预告收尾）", async () => {
    const undefinedCase = await captureAppendContent(makeRunOpts(), makeCtx());
    expect(undefinedCase).not.toContain("You have a turn limit");
    const zeroCase = await captureAppendContent(makeRunOpts({ maxTurns: 0 }), makeCtx());
    expect(zeroCase).not.toContain("You have a turn limit");
  });

  it("ask_user RPC 提示 mode 门控：rpc（gui 响应）注入，json（headless）不注入", async () => {
    const opts = makeRunOpts({ agentConfig: { tools: ["ask_user"] } });
    const rpcContent = await captureAppendContent(opts, makeCtx({ mode: "rpc" }));
    expect(rpcContent).toContain("ask_user Tool Availability");
    const jsonContent = await captureAppendContent(opts, makeCtx({ mode: "json" }));
    // headless 无 UI 通道，注入会误导 LLM（W4 守卫）
    expect(jsonContent).not.toContain("ask_user Tool Availability");
  });

  it("mode 响应但 tools 不含 ask_user → 不注入", async () => {
    const content = await captureAppendContent(
      makeRunOpts({ agentConfig: { tools: ["read", "bash"] } }),
      makeCtx({ mode: "rpc" }),
    );
    expect(content).not.toContain("ask_user Tool Availability");
  });

  it("fork 场景：parentForkDepth 传入 → env block 带 Depth 行（buildEnvBlock 取 max 语义）", async () => {
    const content = await captureAppendContent(
      makeRunOpts({ fork: true, parentForkDepth: 2 }),
      makeCtx(),
    );
    expect(content).toContain("Depth:");
    // 无 fork 无嵌套时不出现 Depth 行
    const plain = await captureAppendContent(makeRunOpts(), makeCtx());
    expect(plain).not.toContain("Depth:");
  });

  it("env block 恒为第一段：最小配置也落盘（writePromptToTempFile 必被调用）", async () => {
    await captureAppendContent(makeRunOpts(), makeCtx());
    expect(captured.calls).toBe(1);
    expect(captured.content).toContain("Working directory: /fake/cwd");
  });
});
