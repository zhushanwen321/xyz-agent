// src/execution/__tests__/consume-confirmation.test.ts
//
// MF-5 消费确认清除：message_start(role=user) 事件 → pendingMessages FIFO shift。
//
// 设计决策 6（spec L251）：busy 投递（follow_up/steer）时消息缓存进 record.pendingMessages；
// pi 开始消费一条 user 消息（message_start(role=user)）= 消费了一条排队消息，shift 最老的一条（FIFO）。
// 只对 user 消息清除——assistant/toolResult 的 message_start 不消费 pendingMessages。
// turn_start 是 1:N（一条消息多 turn），用它清除会连 shift 掉尚未消费的排队消息，破坏 FIFO（MF-5）。
// pi 源码确认 rpc mode 对注入的 steer/follow_up emit message_start(role=user)（agent-loop.ts:184）。
//
// 集成测试：FakeChild 模拟子进程 stdout 发 message_start 事件，走 runSpawn 真实 stdout pump
// → handleSdkEvent → case "message_start" → shift。验证端到端路由。

import { spawn } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const { FakeChild } = await import("./helpers/spawn-mock.ts");
  return {
    spawn: vi.fn(() => new FakeChild()),
    // buildEnvBlock 的 git branch 调用（execFile 异步）：默认 err-first 兜底 → catch → branch=""
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

vi.mock("../alive-store.ts", () => ({ writeAliveMarker: vi.fn() }));

vi.mock("../temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { spawn as mockedSpawn } from "node:child_process";
import {
  emitStdoutLine,
  lastSpawnedChild,
  makeCtx,
  makeOpts,
  makeRecord,
  waitForSpawn,
} from "./helpers/spawn-mock.ts";
import { runSpawn } from "../session-runner.ts";
import type { PendingMessage } from "../types.ts";

describe("消费确认清除：message_start(user) shift pendingMessages (MF-5 决策 6)", () => {
  it("message_start(role=user) 事件 → pendingMessages FIFO shift 最老一条", async () => {
    const record = makeRecord("run-message-start");
    record.pendingMessages = [
      { id: "m1", text: "a", interrupt: false, sentAt: 1 },
      { id: "m2", text: "b", interrupt: true, sentAt: 2 },
    ] satisfies PendingMessage[];

    const runPromise = runSpawn(record, "task", makeOpts(), makeCtx());
    await waitForSpawn(vi.mocked(mockedSpawn));
    const child = lastSpawnedChild(vi.mocked(mockedSpawn));

    // message_start(role=user) = pi 开始消费一条排队消息 → shift 最老的 m1
    emitStdoutLine(child, { type: "message_start", message: { role: "user" } });
    expect(record.pendingMessages!.length).toBe(1);
    expect(record.pendingMessages![0]!.id).toBe("m2"); // m1 已 shift，剩 m2

    // 第二个 message_start(user) → shift m2
    emitStdoutLine(child, { type: "message_start", message: { role: "user" } });
    expect(record.pendingMessages!.length).toBe(0); // 全清

    // 清理：close child 让 runSpawn resolve
    child.emit("close", 0);
    await runPromise;
  });

  it("pendingMessages 为空时 message_start(user) no-op（安全，不报错）", async () => {
    const record = makeRecord("run-empty");
    // pendingMessages 保持 undefined（模拟 idle 续聊 prompt 的 message_start）

    const runPromise = runSpawn(record, "task", makeOpts(), makeCtx());
    await waitForSpawn(vi.mocked(mockedSpawn));
    const child = lastSpawnedChild(vi.mocked(mockedSpawn));

    emitStdoutLine(child, { type: "message_start", message: { role: "user" } }); // no-op，不报错
    expect(record.pendingMessages).toBeUndefined();

    child.emit("close", 0);
    await runPromise;
  });

  it("message_start(role=assistant) 不 shift pendingMessages（只 user 消息消费排队）", async () => {
    const record = makeRecord("run-assistant");
    record.pendingMessages = [
      { id: "m1", text: "a", interrupt: false, sentAt: 1 },
    ] satisfies PendingMessage[];

    const runPromise = runSpawn(record, "task", makeOpts(), makeCtx());
    await waitForSpawn(vi.mocked(mockedSpawn));
    const child = lastSpawnedChild(vi.mocked(mockedSpawn));

    // assistant 的 message_start 不消费 pendingMessages（MF-5：只 user 消息 1:1 清除）
    emitStdoutLine(child, { type: "message_start", message: { role: "assistant" } });
    expect(record.pendingMessages!.length).toBe(1); // 不变

    child.emit("close", 0);
    await runPromise;
  });

  it("turn_start 不 shift pendingMessages（1:N 会破坏 FIFO，MF-5）", async () => {
    const record = makeRecord("run-turn-start-noop");
    record.pendingMessages = [
      { id: "m1", text: "a", interrupt: false, sentAt: 1 },
    ] satisfies PendingMessage[];

    const runPromise = runSpawn(record, "task", makeOpts(), makeCtx());
    await waitForSpawn(vi.mocked(mockedSpawn));
    const child = lastSpawnedChild(vi.mocked(mockedSpawn));

    // turn_start 不再清除（改由 message_start 承担，MF-5）
    emitStdoutLine(child, { type: "turn_start" });
    expect(record.pendingMessages!.length).toBe(1); // 不变

    child.emit("close", 0);
    await runPromise;
  });
});
