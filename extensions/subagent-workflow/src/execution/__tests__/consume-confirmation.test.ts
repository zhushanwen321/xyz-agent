// src/execution/__tests__/consume-confirmation.test.ts
//
// M2-B3 消费确认清除：turn_start 事件 → pendingMessages FIFO shift。
//
// 设计决策 6：busy 投递（follow_up/steer）时消息缓存进 record.pendingMessages；
// pi 开始新 turn（turn_start 事件）= 消费了一条排队消息，shift 最老的一条（FIFO）。
// pendingMessages 只在 deliverToRunning 时 push，prompt（idle 续聊）不 push，
// 故 idle 续聊的 turn_start 清除空数组 no-op（安全）。
//
// 集成测试：FakeChild 模拟子进程 stdout 发 turn_start 事件，走 runSpawn 真实 stdout pump
// → handleSdkEvent → case "turn_start" → shift。验证端到端路由。

import { spawn } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const { FakeChild } = await import("./helpers/spawn-mock.ts");
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

describe("消费确认清除：turn_start shift pendingMessages (M2-B3 决策 6)", () => {
  it("turn_start 事件 → pendingMessages FIFO shift 最老一条", async () => {
    const record = makeRecord("run-turn-start");
    record.pendingMessages = [
      { id: "m1", text: "a", interrupt: false, sentAt: 1 },
      { id: "m2", text: "b", interrupt: true, sentAt: 2 },
    ] satisfies PendingMessage[];

    const runPromise = runSpawn(record, "task", makeOpts(), makeCtx());
    await waitForSpawn(vi.mocked(mockedSpawn));
    const child = lastSpawnedChild(vi.mocked(mockedSpawn));

    // turn_start = pi 开始新 turn（消费了一条排队消息）→ shift 最老的 m1
    emitStdoutLine(child, { type: "turn_start" });
    expect(record.pendingMessages!.length).toBe(1);
    expect(record.pendingMessages![0]!.id).toBe("m2"); // m1 已 shift，剩 m2

    // 第二个 turn_start → shift m2
    emitStdoutLine(child, { type: "turn_start" });
    expect(record.pendingMessages!.length).toBe(0); // 全清

    // 清理：close child 让 runSpawn resolve
    child.emit("close", 0);
    await runPromise;
  });

  it("pendingMessages 为空时 turn_start no-op（安全，不报错）", async () => {
    const record = makeRecord("run-empty");
    // pendingMessages 保持 undefined（模拟 idle 续聊 prompt 的 turn_start）

    const runPromise = runSpawn(record, "task", makeOpts(), makeCtx());
    await waitForSpawn(vi.mocked(mockedSpawn));
    const child = lastSpawnedChild(vi.mocked(mockedSpawn));

    emitStdoutLine(child, { type: "turn_start" }); // no-op，不报错
    expect(record.pendingMessages).toBeUndefined();

    child.emit("close", 0);
    await runPromise;
  });
});
