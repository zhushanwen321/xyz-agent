// src/execution/__tests__/chatmode-round-notify-real-chain.test.ts
//
// [N2] chatMode 轮次通知正文——真实 session-runner 链路测试。
//
// round2 审查实证的断链：agent_settled → onRoundSettled 先 notifyComplete（此时
// record.result 从未被写——成功轮次的 MF-2 原写点 doFinalizeRoundToIdle 对
// runAndFinalize early return 不可达）→ 轮次通知正文恒 "(empty)"，turns[].text 已累积
// 但 notify 读的是 record.result。修复：onRoundSettled 在 notify 前从本轮 turns 派生
// 回复文本（对齐 collectResult 的 getFullText）写入 record.result。
//
// 与 chatmode-first-round-closure-service.test.ts（mock session-runner）不同，本文件用
// 真实 session-runner（FakeChild 驱动 text_delta / agent_settled）+ 真实
// service.execute(conversation:true)，禁止手工预置 record.result——那正是掩盖断链的方式。
// mock 结构与 run-spawn-chatmode-settled.test.ts 一致（FakeChild + session-pending count=0）。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({ getLogger: () => loggerMock }));

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
    // tmp 目录创建/清理走真实实现（本文件用例级隔离需要）
    mkdtempSync: actual.mkdtempSync,
    rmSync: actual.rmSync,
    promises: actual.promises,
  };
});

// removeAliveMarker 一并 mock（finalize-record 消费；成功轮次 early return 不触达，防御性补全）
vi.mock("../alive-store.ts", () => ({
  writeAliveMarker: vi.fn(),
  removeAliveMarker: vi.fn(),
}));

// chatMode agent_end 早返回不读后代判定；统一 count=0（对齐 harness）。
vi.mock("../session-pending.ts", () => ({
  readActivePendingFromSessionFile: vi.fn(() => ({ count: 0 })),
}));

vi.mock("../temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { _resetLifecycleState } from "../lifecycle-manager.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../model-resolver.ts";
import type { ExecutionRecord } from "../types.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import {
  emitStdoutLine,
  lastSpawnedChild,
  sessionHeader,
  waitForSpawn,
} from "./helpers/spawn-mock.ts";

const mockSpawn = vi.mocked(spawn);

const STUB_MODEL: ModelInfo = { id: "test-model", name: "Test", provider: "test", reasoning: false };

/** 最小合法 registry（initModel fail-fast 需要；resolveModel 第三层直接透传 ctxModel）。 */
function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

function makePi(): PiLike & {
  appendEntry: ReturnType<typeof vi.fn>;
  events: { emit: ReturnType<typeof vi.fn> };
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return { appendEntry: vi.fn(), events: { emit: vi.fn() }, sendMessage: vi.fn() };
}

/** 暴露私有 store 的接口（测试专用 cast）。 */
interface ServiceInternals {
  store: { getMutable(id: string): ExecutionRecord | undefined };
}

describe("[N2] chatMode 轮次通知正文：真实 session-runner 链路", () => {
  let agentDir: string;
  let service: SubagentService;
  let pi: ReturnType<typeof makePi>;
  let internals: ServiceInternals;

  beforeEach(() => {
    vi.clearAllMocks();
    // lifecycle-manager 模块级单例（idleTimers Map 跨用例共享），每用例前清空防泄漏。
    _resetLifecycleState();
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "round-notify-"));
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    modelService.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "root-session",
      ctxModel: STUB_MODEL,
    });
    service = new SubagentService({ cwd: agentDir, modelService });
    pi = makePi();
    service.initSession({ pi, sessionId: "root-session" });
    internals = service as unknown as ServiceInternals;
  });

  afterEach(() => {
    service.dispose();
    _resetLifecycleState();
    vi.restoreAllMocks();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("真实 execute(conversation:true) + FakeChild 驱动 text_delta/agent_settled → 通知正文含本轮真实回复（非 (empty)）", async () => {
    const ROUND_REPLY = "THE ROUND REPLY";

    // 真实链路：execute → kickOffBackground → runAndFinalize → 真实 runSpawn → FakeChild。
    // ctx.onRoundSettled 由 buildSessionRunnerContext 注入（真实回调，非 mock）。
    const handle = await service.execute({
      task: "tell me something",
      slug: "round-notify",
      conversation: true,
    });

    await waitForSpawn(mockSpawn);
    const child = lastSpawnedChild(mockSpawn);

    // 真实事件链：header（握手加速）→ text_delta（本轮回复累积进 turns）→ turn_end →
    // agent_end（chatMode 保活）→ agent_settled（真空闲：armIdleTimer → onRoundSettled）。
    emitStdoutLine(child, sessionHeader("sess-round-1"));
    emitStdoutLine(child, {
      type: "message_update",
      // type 对齐 pi-ai AssistantMessageEvent 真实协议（text 增量 = "text_delta"，带 contentIndex）。
      // 曾用 {type:"text"} 假类型——旧实现不查 type 只看 delta 碰巧兼容；现实现按 type 正向
      // 分流（toolcall_delta 不混入 text 流），假类型事件被正确丢弃，fake 必须对齐真实协议。
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: ROUND_REPLY },
    });
    emitStdoutLine(child, { type: "turn_end" });
    emitStdoutLine(child, { type: "agent_end", willRetry: false });
    emitStdoutLine(child, { type: "agent_settled" });

    // agent_settled → onRoundSettled（round+1 + record.result 派生 + notifyComplete）→
    // 无其他 busy background → 立即 flush → pi.sendMessage。
    await vi.waitFor(() => {
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    });

    const sentMsg = pi.sendMessage.mock.calls[0]![0] as { customType: string; content: string };
    expect(sentMsg.customType).toBe("subagent-bg-notify");
    expect(sentMsg.content).toContain("finished a round");
    // [N2] 核心：正文含本轮真实回复文本（修复前此处是 "(empty)"）
    expect(sentMsg.content).toContain(ROUND_REPLY);
    expect(sentMsg.content).not.toContain("(empty)");

    // record 侧：turns 已累积 + result 从 turns 真实派生（非手工预置）+ running-resumable
    const record = internals.store.getMutable(handle.subagentId);
    expect(record).toBeDefined();
    expect(record!.turns[0]!.text).toBe(ROUND_REPLY);
    expect(record!.result).toBe(ROUND_REPLY);
    expect(record!.status).toBe("running");
    expect(record!.round).toBe(1);

    // 收尾：close 让 runSpawn resolve → runAndFinalize 续体 early return → .then 的
    // notifyComplete 被同 id:round dedup 吞——总发送数仍恰为 1。
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    // [C2] close 现状语义扩展：终态化不再发新通知（总数仍 1），末条轮次通知含
    // Full transcript 指针行——真实链路 sessionHeader 已回填 record.sessionFile
    //（session-runner.ts:1039），chatMode:true 经 toNotifyRecord 条件透传到通知正文。
    const lastMsg = pi.sendMessage.mock.calls[0]![0] as { content: string; details?: { sessionFile?: string } };
    expect(lastMsg.details?.sessionFile).toBe(record!.sessionFile);
    expect(lastMsg.content).toContain(`\n\nFull transcript: ${record!.sessionFile}`);
  });
});
