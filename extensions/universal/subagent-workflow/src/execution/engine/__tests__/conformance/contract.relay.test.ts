// contract.relay.test.ts —— conformance relay 变体（E 方案 §2.3，默认 CI 层，免 LLM）。
//
// 断言口径：同一契约，spawn 通道不同——relay 是 pi 引擎的进程拓扑变体，不是引擎身份：
//   1. 协议常量镜像一致性：relay.mjs（零依赖脚本不能 import workspace 包，只能内嵌
//      镜像）与 relay-env.ts SSOT 逐字对齐——改名/改值双侧不同步即此处转红（§10-5）。
//   2. pi-invocation 通道契约：三 env 齐备 → 代理形态；任一缺失 → 直连（全有或全无，
//      E-TUI 零回归）；relay:false 强制直连（probe 语义）。
//   3. buildChildEnv 归属契约：激活时写入 tee 帧路由键（SESSION_ID/RECORD_ID），未激活
//      不写（继承值保持，无 relay 环境不携带误导性 env）。
//
// 真机全链（经代理 spawn 真实 pi）是 live 手动门：engine-conformance.live.test.ts 的
// relay describe（ENGINE_CONFORMANCE_LIVE=1 + relay env 齐备），不在本文件。

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── runSpawn 集成段 mock（与 session-runner-schema-env.test.ts 同模式）──

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
    // 镜像段（C-镜像 describe）读 relay.mjs 源文本走真实实现——session-runner 只消费
    // 上面被替换的几个方法，透传 readFileSync 不影响 runSpawn 集成段的 mock 语义。
    readFileSync: actual.readFileSync,
    promises: actual.promises,
  };
});

vi.mock("../../../alive-store.ts", () => ({
  writeAliveMarker: vi.fn(),
}));

vi.mock("../../../temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { spawn } from "node:child_process";

import {
  RELAY_ENV_NODE,
  RELAY_ENV_RECORD_ID,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_SOCKET,
  RELAY_EXIT_CODES,
  RELAY_PROTOCOL_VERSION,
  isRelayActive,
} from "../../../relay-env.ts";
import { getPiInvocation } from "../../../pi-invocation.ts";
import { runSpawn, type RunOptions, type SessionRunnerContext } from "../../../session-runner.ts";
import { createRecord } from "../../../execution-record.ts";
import { waitForSpawn } from "../../../__tests__/helpers/spawn-mock.ts";

const mockSpawn = vi.mocked(spawn);

/** 被锁定的代理脚本：包根 relay/relay.mjs（与 src/ 平行的零依赖脚本）。 */
const RELAY_SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../relay/relay.mjs",
);

/** relay 激活三 env 齐备的基准值。 */
const RELAY_FULL: Record<string, string> = {
  [RELAY_ENV_SOCKET]: "/tmp/contract-relay.sock",
  [RELAY_ENV_NODE]: "/usr/bin/contract-relay-node",
  [RELAY_ENV_SCRIPT]: "/opt/contract-relay/relay.mjs",
};

const RELAY_ENV_KEYS = [RELAY_ENV_SOCKET, RELAY_ENV_NODE, RELAY_ENV_SCRIPT] as const;

function setRelayEnv(env: Record<string, string> | undefined): void {
  for (const key of [...RELAY_ENV_KEYS, RELAY_ENV_SESSION_ID, RELAY_ENV_RECORD_ID]) {
    delete process.env[key];
  }
  if (env !== undefined) Object.assign(process.env, env);
}

// ── 1. 协议常量镜像一致性（relay-env.ts SSOT ↔ relay.mjs 内嵌镜像）──

describe("relay 变体 C-镜像：relay.mjs 内嵌常量与 relay-env.ts SSOT 一致", () => {
  const source = fs.readFileSync(RELAY_SCRIPT_PATH, "utf8");

  /** 字符串常量：`const NAME = "value"` 形式逐字对齐（值来自 SSOT 导出，漂移即红）。 */
  const stringVars: Array<[string, string]> = [
    ["RELAY_ENV_SOCKET", RELAY_ENV_SOCKET],
    ["RELAY_ENV_SESSION_ID", RELAY_ENV_SESSION_ID],
    ["RELAY_ENV_RECORD_ID", RELAY_ENV_RECORD_ID],
  ];

  it.each(stringVars)("镜像字符串常量 %s 与 SSOT 逐字一致", (name, value) => {
    expect(source).toMatch(new RegExp(`${name}\\s*=\\s*["']${value}["']`));
  });

  it("镜像协议版本 RELAY_PROTOCOL_VERSION 与 SSOT 一致", () => {
    expect(source).toMatch(new RegExp(`RELAY_PROTOCOL_VERSION\\s*=\\s*${RELAY_PROTOCOL_VERSION}\\b`));
  });

  it("镜像退出码 RELAY_EXIT_CODES 四值与 SSOT 一致", () => {
    const pairs: Array<[keyof typeof RELAY_EXIT_CODES, number]> = [
      ["VERSION_MISMATCH", RELAY_EXIT_CODES.VERSION_MISMATCH],
      ["SOCKET_UNREACHABLE", RELAY_EXIT_CODES.SOCKET_UNREACHABLE],
      ["SOCKET_CLOSED", RELAY_EXIT_CODES.SOCKET_CLOSED],
      ["MISSING_IDENTITY", RELAY_EXIT_CODES.MISSING_IDENTITY],
    ];
    for (const [key, value] of pairs) {
      expect(source).toMatch(new RegExp(`${key}:\\s*${value}\\b`));
    }
  });

  it("镜像面不自作主张扩充：NODE/SCRIPT 不在镜像表（代理零消费，见 relay.mjs 头注）", () => {
    // 若未来有人在 relay.mjs 加镜像而忘记消费，契约面应当显式扩表——此处断言现状
    // 「镜像常量恰好是代理实际消费的三个 env 名」防镜像面无界生长。
    expect(source).toMatch(/const RELAY_ENV_SOCKET/);
    expect(source).not.toMatch(/const RELAY_ENV_NODE\b/);
    expect(source).not.toMatch(/const RELAY_ENV_SCRIPT\b/);
  });
});

// ── 2. pi-invocation 通道契约（spawn 目标切换：全有或全无 + probe 排除）──

describe("relay 变体 C-通道：getPiInvocation 三分支契约", () => {
  const originalArgv = process.argv;
  const originalExecPath = process.execPath;

  beforeEach(() => {
    // 落到「node + 不存在脚本 → pi-in-PATH」稳定断言直连形态
    Object.defineProperty(process, "argv", { value: ["node", "/nonexistent"], configurable: true });
    Object.defineProperty(process, "execPath", { value: "/usr/bin/node", configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "argv", { value: originalArgv, configurable: true });
    Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
    setRelayEnv(undefined);
  });

  it("三 env 齐备 → 代理形态（command=NODE、args[0]=SCRIPT，userArgs 原样后置）", () => {
    setRelayEnv(RELAY_FULL);
    const result = getPiInvocation(["--mode", "rpc", "--session-dir", "/x"]);
    expect(result.command).toBe(RELAY_FULL[RELAY_ENV_NODE]);
    expect(result.args).toEqual([
      RELAY_FULL[RELAY_ENV_SCRIPT],
      "--mode",
      "rpc",
      "--session-dir",
      "/x",
    ]);
  });

  it.each([...RELAY_ENV_KEYS])("env 缺失 %s → 回落直连（全有或全无，E-TUI 零回归）", (missing) => {
    const partial = { ...RELAY_FULL };
    delete partial[missing];
    setRelayEnv(partial);
    const result = getPiInvocation(["--mode", "rpc"]);
    expect(result.command).toBe("pi");
    expect(result.args).toEqual(["--mode", "rpc"]);
  });

  it("relay:false → 直连（probe 探 pi 本体可解析性，不经 relay）", () => {
    setRelayEnv(RELAY_FULL);
    const result = getPiInvocation(["--version"], { relay: false });
    expect(result.command).toBe("pi");
    expect(result.args).toEqual(["--version"]);
  });
});

// ── 3. buildChildEnv 归属契约（runSpawn 集成，mock spawn 捕获 childEnv）──

describe("relay 变体 C-归属：buildChildEnv 激活写入 / 未激活不写", () => {
  interface FakeChild {
    pid: number;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    emit(event: string, ...args: unknown[]): boolean;
  }

  function makeRecord(): ReturnType<typeof createRecord> {
    return createRecord("relay-env-record-1", {
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

  function makeRunOpts(): RunOptions {
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
    };
  }

  function makeCtx(): SessionRunnerContext {
    return {
      cwd: "/fake/cwd",
      agentDir: "/fake/agent",
      skillDirs: [],
      mainCwd: "/fake/cwd",
      sessionRootId: "relay-root-session",
      rootCwd: "/fake/cwd",
    };
  }

  function getLastSpawnEnv(): Record<string, string | undefined> {
    return (mockSpawn.mock.calls.at(-1)?.[2]?.env as Record<string, string | undefined>) ?? {};
  }

  function getLastSpawnedChild(): FakeChild {
    const result = mockSpawn.mock.results.at(-1);
    if (!result) throw new Error("spawn was not called yet");
    return result.value as FakeChild;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setRelayEnv(undefined);
  });

  afterEach(() => {
    setRelayEnv(undefined);
    vi.restoreAllMocks();
  });

  it("激活：childEnv 写入归属键（SESSION_ID=ctx.sessionRootId、RECORD_ID=record.id）", async () => {
    setRelayEnv(RELAY_FULL);
    const record = makeRecord();
    const ctx = makeCtx();
    const resultPromise = runSpawn(record, "test task", makeRunOpts(), ctx);
    await waitForSpawn(mockSpawn);
    const childEnv = getLastSpawnEnv();
    expect(childEnv[RELAY_ENV_SESSION_ID]).toBe(ctx.sessionRootId);
    expect(childEnv[RELAY_ENV_RECORD_ID]).toBe(record.id);
    // 顺带契约：激活时 spawn 目标即代理（command=NODE、args[0]=SCRIPT）
    expect(mockSpawn.mock.calls.at(-1)?.[0]).toBe(RELAY_FULL[RELAY_ENV_NODE]);
    expect(mockSpawn.mock.calls.at(-1)?.[1]?.[0]).toBe(RELAY_FULL[RELAY_ENV_SCRIPT]);

    const child = getLastSpawnedChild();
    child.emit("close", 0);
    await resultPromise;
  });

  it("未激活：不写入归属键（继承 process.env 原值，无 relay 环境零噪声）", async () => {
    setRelayEnv(undefined);
    const record = makeRecord();
    const ctx = makeCtx();
    const resultPromise = runSpawn(record, "test task", makeRunOpts(), ctx);
    await waitForSpawn(mockSpawn);
    const childEnv = getLastSpawnEnv();
    // 「不写」的精确语义 = 继承值保持（本用例前置已删，故 undefined），而非写 record 值
    expect(childEnv[RELAY_ENV_SESSION_ID]).toBe(process.env[RELAY_ENV_SESSION_ID]);
    expect(childEnv[RELAY_ENV_RECORD_ID]).toBe(process.env[RELAY_ENV_RECORD_ID]);
    expect(childEnv[RELAY_ENV_SESSION_ID]).not.toBe(ctx.sessionRootId);
    expect(childEnv[RELAY_ENV_RECORD_ID]).not.toBe(record.id);

    const child = getLastSpawnedChild();
    child.emit("close", 0);
    await resultPromise;
  });

  it("未激活但环境残留归属值：继承值保持不被覆盖（无害性锁定）", async () => {
    // 场景：孙进程链上 runtime 已剥离三激活 env（relay-registry 剥离逻辑），但主进程 env
    // 残留旧归属值——buildChildEnv 未激活不写 = 不覆盖继承值（设计 §5.2-2 语义）。
    setRelayEnv({ [RELAY_ENV_SESSION_ID]: "stale-inherited-sid", [RELAY_ENV_RECORD_ID]: "stale-inherited-rid" });
    expect(isRelayActive(process.env)).toBe(false);
    const record = makeRecord();
    const ctx = makeCtx();
    const resultPromise = runSpawn(record, "test task", makeRunOpts(), ctx);
    await waitForSpawn(mockSpawn);
    const childEnv = getLastSpawnEnv();
    expect(childEnv[RELAY_ENV_SESSION_ID]).toBe("stale-inherited-sid");
    expect(childEnv[RELAY_ENV_RECORD_ID]).toBe("stale-inherited-rid");

    const child = getLastSpawnedChild();
    child.emit("close", 0);
    await resultPromise;
  });
});
