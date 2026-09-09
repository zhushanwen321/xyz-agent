// src/execution/engine/engines/pi/__tests__/late-response-runspawn-e2e.test.ts
//
// [U1 D1] runSpawn 端到端：迟到 get_state response 的生产链路回填（实施计划 u1-acquire
// 验收条款①的接线覆盖——startGetStateHandshake → performGetStateHandshake onLateResponse
// → backfillSessionFileFromLateGetState）。
//
// 场景（设计 §1 生产事故根因链的最小复现）：并发/慢冷启动拖过握手 7s 预算 → 三次重试
// 全部超时 resolve 空（D1 前此后 sessionFile 永久缺失）→ pi 就绪后迟到的应答经 stdout
// pump 到达 resolver → 不再被丢弃，幂等回填 record.sessionFile + 补 handshakeResult.sessionId。
//
// mock 模式对齐 execution/__tests__/run-spawn-rpc-mode.test.ts（vi.mock 文件作用域独立
// 声明）；fake timers 驱动握手超时（7s 真实等待不可接受）。

import { spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const { FakeChild } = await import("../../../../__tests__/helpers/spawn-mock.ts");
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
    promises: actual.promises,
  };
});

vi.mock("../../../../alive-store.ts", () => ({
  writeAliveMarker: vi.fn(),
  readAliveMarker: vi.fn(() => undefined),
  isProcessAlive: vi.fn(() => false),
}));

vi.mock("../temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { spawn as mockSpawnFn } from "node:child_process";

import { runSpawn } from "../session-runner.ts";
import {
  emitStdoutLine,
  type FakeChild,
  makeCtx,
  makeOpts,
  makeRecord,
} from "../../../../__tests__/helpers/spawn-mock.ts";

const mockSpawn = vi.mocked(mockSpawnFn);

const LATE_SESSION_FILE = "/tmp/test/agents/subagents/--tmp-test--/sessions/late-session.jsonl";

/**
 * 捕获握手发到 stdin 的 get_state 请求 id（不回应——让三次重试自然超时）。
 * FakeChild.stdin 是 PassThrough：listener 挂上后从缓冲重放已写数据，#1 也能捕获。
 */
function captureGetStateIds(child: FakeChild): string[] {
  const ids: string[] = [];
  child.stdin.on("data", (data: Buffer | string) => {
    const text = typeof data === "string" ? data : data.toString();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const cmd = JSON.parse(line) as { type?: string; id?: string };
        if (cmd.type === "get_state" && cmd.id) ids.push(cmd.id);
      } catch {
        // 非 JSON 行（prompt 命令等）忽略
      }
    }
  });
  return ids;
}

describe("runSpawn D1 迟到接受端到端（握手超时后迟到 response 回填）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("三次握手重试全部超时 → 迟到 response 到达 → record.sessionFile 被回填", async () => {
    const record = makeRecord("run-late-1");
    const promise = runSpawn(record, "Task: late-response-e2e", makeOpts(), makeCtx());

    // 跨过 runSpawn 前置 await（buildEnvBlock / temp-prompt mock，微任务级）→ spawn 已调，
    // 同步段（setupFreshChild → startGetStateHandshake → get_state #1）已执行。
    await vi.advanceTimersByTimeAsync(5);
    const child = mockSpawn.mock.results.at(-1)!.value as FakeChild;
    const ids = captureGetStateIds(child);
    await vi.advanceTimersByTimeAsync(1); // PassThrough 缓冲重放 → 捕获 #1
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(record.sessionFile).toBeUndefined(); // 尚未回填

    // 走完全部重试（3 × 2s 超时 + 2 × 0.5s 间隔）：握手 resolve 空——D1 前的「永久缺失」起点
    await vi.advanceTimersByTimeAsync(7_100);
    expect(record.sessionFile).toBeUndefined();

    // pi 就绪后迟到应答经 stdout pump 匹配原 resolver → 迟到接受回填（被测主断言）
    emitStdoutLine(child, {
      type: "response",
      command: "get_state",
      success: true,
      id: ids[0],
      data: { sessionFile: LATE_SESSION_FILE, sessionId: "sess-late-e2e" },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(record.sessionFile).toBe(LATE_SESSION_FILE);

    // 正常收尾：close → runSpawn resolve，回填结果保持（不被收尾反查覆盖）
    child.stdout.end();
    child.emit("close", 0);
    const result = await promise;
    expect(result.success).toBe(true);
    expect(record.sessionFile).toBe(LATE_SESSION_FILE);
    expect(result.sessionFile).toBe(LATE_SESSION_FILE);
  });

  it("握手超时 + close 收尾：接入点 2 扫描兜底在收尾链中执行（mock 目录空 → miss 不炸）", async () => {
    const record = makeRecord("run-late-2");
    const promise = runSpawn(record, "Task: late-after-close", makeOpts(), makeCtx());
    await vi.advanceTimersByTimeAsync(5);
    const child = mockSpawn.mock.results.at(-1)!.value as FakeChild;
    captureGetStateIds(child);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(7_100); // 握手超时 resolve 空
    expect(record.sessionFile).toBeUndefined();

    // close 收尾链：backfillSessionFileByLookup lookupId 缺失 → 扫描兜底执行。
    // 本文件 mock readdirSync 恒 []（无候选）→ miss，record 保持缺失（finalize 走
    // crashed 语义），收尾链不炸（接入点 2 的端到端冒烟）。
    child.stdout.end();
    child.emit("close", 0);
    const result = await promise;

    expect(record.sessionFile).toBeUndefined();
    expect(result.success).toBe(true);
  });
});
