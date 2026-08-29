// src/__tests__/session-runner-schema-env.test.ts
//
// Wave 2 (issue #3): schemaEnv bridge 测试。
//
// 覆盖 test-matrix 用例:
//   - T3.9  (boundary): schemaEnv 透传——传入时 childEnv 含 PI_WORKFLOW_SCHEMA
//   - T3.11 (state):    schemaEnv 不传 → childEnv 无 PI_WORKFLOW_SCHEMA（BC-6 tool 层不变）
//   - T3.16 (NFR-compatibility): schemaEnv 不传时 BC-6 childEnv 等价——不传时与合并前
//     行为一致，不注入 PI_WORKFLOW_SCHEMA → structured-output tool 不注册
//
// 测试策略：
//   - applySchemaEnvToChildEnv 纯函数单测（不依赖 runSpawn/spawn mock）
//   - runSpawn 集成测试：通过 mock spawn 拦截 childEnv，验证 schemaEnv 实际注入
//
// D-A6: schemaEnv 经 RunOptions 透传到 runSpawn childEnv。
// BC-6: tool 层 execute 不传 schemaEnv → childEnv 不设 PI_WORKFLOW_SCHEMA → 行为不变。

import type { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock modules (与 run-spawn-integration.test.ts 同模式) ──

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

import { waitForSpawn } from "./helpers/spawn-mock.ts";
import { createRecord } from "../execution-record.ts";
import {
  applySchemaEnvToChildEnv,
  type RunOptions,
  runSpawn,
  SCHEMA_ENV_MAX_BYTES,
  type SessionRunnerContext,
} from "../session-runner.ts";
import { schemaEnvByteLength } from "../../shared/schema-env.ts";

const mockSpawn = vi.mocked(spawn);
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
  return mockSpawn.mock.calls.at(-1)?.[2]?.env as Record<string, string | undefined> ?? {};
}

// ── 公共 fixture ──

function makeRecord() {
  return createRecord("test-1", {
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

// ── applySchemaEnvToChildEnv 纯函数单测 ──

describe("applySchemaEnvToChildEnv (T3.9/T3.11/T3.16)", () => {
  // T3.11: schemaEnv 不传 → childEnv 无 PI_WORKFLOW_SCHEMA
  it("T3.11: schemaEnv 不传时 childEnv 不含 PI_WORKFLOW_SCHEMA（BC-6）", () => {
    const childEnv: Record<string, string | undefined> = { PATH: "/usr/bin" };
    applySchemaEnvToChildEnv(childEnv, undefined);
    expect(childEnv).not.toHaveProperty("PI_WORKFLOW_SCHEMA");
    expect(childEnv.PATH).toBe("/usr/bin"); // 其他 key 不受影响
  });

  // T3.16: schemaEnv 不传时 BC-6 childEnv 等价——合并前后行为一致
  it("T3.16: schemaEnv 不传时 childEnv 等价于合并前（BC-6，不注入 PI_WORKFLOW_SCHEMA）", () => {
    const childEnv: Record<string, string | undefined> = {};
    applySchemaEnvToChildEnv(childEnv, undefined);
    // 不传 schemaEnv 时，childEnv 应与调用前完全一致（不含 PI_WORKFLOW_SCHEMA）
    expect(Object.keys(childEnv)).toHaveLength(0);
    expect(childEnv.PI_WORKFLOW_SCHEMA).toBeUndefined();
  });

  // T3.16 补充: schemaEnv 为空串也不注入（空串不是有效 schema）
  it("T3.16 补充: schemaEnv 为空串时不注入（false-ish 语义）", () => {
    const childEnv: Record<string, string | undefined> = {};
    applySchemaEnvToChildEnv(childEnv, "");
    expect(childEnv).not.toHaveProperty("PI_WORKFLOW_SCHEMA");
  });

  // T3.9: schemaEnv 传入 → childEnv 含 PI_WORKFLOW_SCHEMA
  it("T3.9: schemaEnv 传入时 childEnv 含 PI_WORKFLOW_SCHEMA", () => {
    const childEnv: Record<string, string | undefined> = {};
    const schemaJson = '{"type":"object","properties":{"x":{"type":"number"}}}';
    applySchemaEnvToChildEnv(childEnv, schemaJson);
    expect(childEnv.PI_WORKFLOW_SCHEMA).toBe(schemaJson);
  });

  // T3.9 补充: schemaEnv 值为复杂 JSON 字符串时正确透传
  it("T3.9 补充: schemaEnv 值为复杂 JSON 字符串时完整透传", () => {
    const childEnv: Record<string, string | undefined> = {};
    const schemaJson = JSON.stringify({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number", minimum: 0 },
      },
      required: ["name"],
    });
    applySchemaEnvToChildEnv(childEnv, schemaJson);
    expect(childEnv.PI_WORKFLOW_SCHEMA).toBe(schemaJson);
    // 验证可以 parse 回原始结构
    expect(() => JSON.parse(childEnv.PI_WORKFLOW_SCHEMA!)).not.toThrow();
  });

  // T3.9 补充: schemaEnv 与已有 key 不冲突
  it("T3.9 补充: schemaEnv 注入不覆盖 childEnv 已有 key", () => {
    const childEnv: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      HOME: "/home/user",
    };
    applySchemaEnvToChildEnv(childEnv, '{"x":1}');
    expect(childEnv.PATH).toBe("/usr/bin");
    expect(childEnv.HOME).toBe("/home/user");
    expect(childEnv.PI_WORKFLOW_SCHEMA).toBe('{"x":1}');
  });

  // [SO-DATA-4] 边界内通过：255KB（< 256KiB 上限）正常注入，行为不变
  it("[SO-DATA-4] 255KB schema 正常注入（上限内不误拒）", () => {
    const childEnv: Record<string, string | undefined> = {};
    // ASCII 串 byteLength === length，构造 255KB 纯 JSON body（外层再包一层合法 JSON）
    const padding = "x".repeat(255 * 1024);
    const schemaJson = JSON.stringify({ type: "object", properties: { pad: { const: padding } } });
    expect(schemaEnvByteLength(schemaJson)).toBeLessThanOrEqual(SCHEMA_ENV_MAX_BYTES);
    applySchemaEnvToChildEnv(childEnv, schemaJson);
    expect(childEnv.PI_WORKFLOW_SCHEMA).toBe(schemaJson);
  });

  // [SO-DATA-4] 超限 fail-fast：257KB 拒绝，错误消息含实际大小 + 精简/拆分指引 + E2BIG 归因
  it("[SO-DATA-4] 257KB schema fail-fast 拒绝（错误含实际大小与恢复指引）", () => {
    const childEnv: Record<string, string | undefined> = {};
    const padding = "x".repeat(257 * 1024);
    const schemaJson = JSON.stringify({ type: "object", properties: { pad: { const: padding } } });
    expect(schemaEnvByteLength(schemaJson)).toBeGreaterThan(SCHEMA_ENV_MAX_BYTES);
    expect(() => applySchemaEnvToChildEnv(childEnv, schemaJson)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining("bytes exceeds"),
      }),
    );
    // 错误消息含实际大小、上限、精简/拆分指引与 E2BIG 归因（可操作性验收）
    try {
      applySchemaEnvToChildEnv(childEnv, schemaJson);
      throw new Error("expected applySchemaEnvToChildEnv to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain(String(schemaEnvByteLength(schemaJson))); // 实际大小
      expect(msg).toContain(String(SCHEMA_ENV_MAX_BYTES)); // 上限值
      expect(msg).toContain("simplify the schema"); // 精简指引
      expect(msg).toContain("E2BIG"); // ARG_MAX/E2BIG 约束说明
    }
    // fail-fast：不写入半截值
    expect(childEnv.PI_WORKFLOW_SCHEMA).toBeUndefined();
  });
});

// ── runSpawn 集成测试：schemaEnv 经 RunOptions → childEnv ──

describe("runSpawn schemaEnv childEnv 注入 (T3.9/T3.11)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // T3.11: schemaEnv 不传 → childEnv 的 PI_WORKFLOW_SCHEMA 保持 process.env 原值
  // BC-6: applySchemaEnvToChildEnv 不注入新值，但 process.env 可能已有此 key（子进程继承父环境）。
  // 验证点: 不传 schemaEnv 时我们的代码不修改 PI_WORKFLOW_SCHEMA。
  it("T3.11 (integration): RunOptions 无 schemaEnv → childEnv 继承 process.env 原值（BC-6）", async () => {
    const record = makeRecord();
    const opts = makeRunOpts({ schemaEnv: undefined });
    const ctx = makeCtx();

    const resultPromise = runSpawn(record, "test task", opts, ctx);
    await waitForSpawn(mockSpawn);
    const childEnv = getLastSpawnEnv();
    // BC-6: schemaEnv 未传入 → PI_WORKFLOW_SCHEMA 应为 process.env 原值（我们的代码不注入）
    expect(childEnv.PI_WORKFLOW_SCHEMA).toBe(process.env.PI_WORKFLOW_SCHEMA);

    const child = getLastSpawnedChild();
    child.emit("close", 0);
    await resultPromise;
  });

  // T3.9: schemaEnv 传入 → childEnv 含 PI_WORKFLOW_SCHEMA
  it("T3.9 (integration): RunOptions 有 schemaEnv → childEnv 含 PI_WORKFLOW_SCHEMA", async () => {
    const record = makeRecord();
    const schemaJson = '{"type":"object","properties":{"result":{"type":"string"}}}';
    const opts = makeRunOpts({ schemaEnv: schemaJson });
    const ctx = makeCtx();

    const resultPromise = runSpawn(record, "test task", opts, ctx);
    await waitForSpawn(mockSpawn);
    const childEnv = getLastSpawnEnv();
    expect(childEnv.PI_WORKFLOW_SCHEMA).toBe(schemaJson);

    // 关闭子进程
    const child = getLastSpawnedChild();
    child.emit("close", 0);
    await resultPromise;
  });

  // T3.9 + fork: schemaEnv 与 fork env 共存时不冲突
  it("T3.9 + fork: schemaEnv 与 fork depth env 共存不冲突", async () => {
    const record = createRecord("test-fork-1", {
      agent: "general-purpose",
      model: "test/model",
      mode: "sync",
      task: "test task",
      startedAt: Date.now(),
      rootSessionId: "s1",
      parentRecordId: undefined,
      depth: 1,
    });
    const schemaJson = '{"type":"object"}';
    const opts = makeRunOpts({
      schemaEnv: schemaJson,
      fork: true,
      parentForkDepth: 0,
    });
    const ctx = makeCtx();

    const resultPromise = runSpawn(record, "test task", opts, ctx);
    await waitForSpawn(mockSpawn);
    const childEnv = getLastSpawnEnv();
    // fork depth env 应存在
    expect(childEnv.PI_SUBAGENT_FORK_DEPTH).toBe("1");
    // schemaEnv 也应存在
    expect(childEnv.PI_WORKFLOW_SCHEMA).toBe(schemaJson);

    const child = getLastSpawnedChild();
    child.emit("close", 0);
    await resultPromise;
  });
});
