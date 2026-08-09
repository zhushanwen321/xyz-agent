// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）
// 运行命令：npx vitest run tests/characterization-hook.test.ts
//
// [HISTORICAL 背景] 行为基线测试（characterization test）：
// 在 M4 拆模块重构（src/index.ts 单文件 → 6 模块，setupWorkflowHook 的 4 个
// mutable 闭包 → RetryState 显式类）之前，对旧 setupWorkflowHook 的对外行为
// 锁基线。重构（M4-T6）后本文件必须零改动继续全绿——这是「重构不改行为」的证明。
//
// 锁定旧实现的两个微妙时序（重构时最容易悄悄改变的）：
//   1. soCallCount 只在「判定要 steer 的分支」重置——toolUse / 超上限的 turn_end
//      直接 return，不重置计数（toolUse 后同一 turn 链的失败累计仍走 FAILED 分支）
//   2. lastSchemaError 只在 steer 后清空——超上限时保留最近错误（turn 自然结束）

import { afterEach, describe, expect, it, vi } from "vitest";

// ── mock pi（与 structured-output.test.ts 的 Workflow hook 组同构）──
// on() 收集回调，emit() 按注册顺序触发，sendUserMessage spy。

const SCHEMA_ENV_NAME = "PI_WORKFLOW_SCHEMA";
const originalSchemaEnv = process.env[SCHEMA_ENV_NAME];

function createMockPi() {
  const handlers = new Map<string, ((event: unknown) => Promise<void> | void)[]>();
  const sendUserMessage = vi.fn();
  return {
    sendUserMessage,
    registerTool: vi.fn(),
    on: vi.fn((event: string, cb: (event: unknown) => Promise<void> | void) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(cb);
    }),
    // 驱动器：按注册顺序触发某事件的所有回调
    async emit(event: string, payload: unknown): Promise<void> {
      for (const cb of handlers.get(event) ?? []) {
        await cb(payload);
      }
    },
  };
}

async function loadExtension(mockPi: ReturnType<typeof createMockPi>, schemaJson: string): Promise<void> {
  process.env[SCHEMA_ENV_NAME] = schemaJson;
  // 动态 import 确保每次拿到模块级 const（环境变量已设好）。
  // vitest 默认缓存模块，这里用 vi.resetModules + 动态 import 重置。
  vi.resetModules();
  const mod = await import("../src/index.js");
  mod.default(mockPi);
}

afterEach(() => {
  if (originalSchemaEnv === undefined) delete process.env[SCHEMA_ENV_NAME];
  else process.env[SCHEMA_ENV_NAME] = originalSchemaEnv;
  vi.restoreAllMocks();
});

const SCHEMA = JSON.stringify({ type: "object", properties: { count: { type: "number" } }, required: ["count"] });
// 校验失败时 Pi 把 execute() 抛出的 error.message 塞进 result.content[0].text。
const FAILED_TOOL_END = {
  type: "tool_execution_end",
  toolName: "structured-output",
  isError: true,
  result: { content: [{ type: "text", text: "Schema validation failed: /count must be number" }] },
};
const SUCCESS_TOOL_END = {
  type: "tool_execution_end",
  toolName: "structured-output",
  isError: false,
  result: { details: { count: 5 } },
};
const turnEndPayload = (stopReason = "end_turn") => ({ message: { stopReason } });

// ── 时序断言（4 个）：旧 4-closure 实现的行为基线 ──────────────

describe("characterization: setupWorkflowHook timing (baseline before RetryState refactor)", () => {
  it("① toolUse turn_end does not reset soCallCount → next turn's failure steers with FAILED validation (not MUST call)", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    // turn 1: 失败调用 + toolUse turn_end → 不干预（模型还在调工具链）
    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    await pi.emit("turn_end", turnEndPayload("toolUse"));
    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    // turn 2: 再次失败调用 + end_turn → steer。soCallCount 未被 toolUse turn 重置
    //（累计 2），calledButFailed=true → 文案走 FAILED validation 分支而非 MUST call。
    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    await pi.emit("turn_end", turnEndPayload());
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const msg = pi.sendUserMessage.mock.calls[0]![0] as string;
    expect(msg).toContain("FAILED validation");
    expect(msg).not.toContain("MUST call the structured-output tool");
  });

  it("② multiple failed calls in one turn → single steer at turn_end (soCallCount accumulates)", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    await pi.emit("turn_end", turnEndPayload());

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("③ stops steering after MAX_HOOK_RETRIES (=2): 3 failed turns → exactly 2 steers, 3rd turn ends without error", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    // 失败→steer 循环 3 轮：前 2 轮 steer，第 3 轮 hookRetryCount=2 >= MAX → 放弃。
    // emit 不抛错（超上限分支正常 return）= 子进程自然结束路径。
    for (let i = 0; i < 3; i++) {
      await pi.emit("tool_execution_end", FAILED_TOOL_END);
      await pi.emit("turn_end", turnEndPayload());
    }
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("④ after a successful call, later failed calls never steer again (soSucceededEver short-circuit)", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    // 成功调用 → soSucceededEver=true（终态）。后续失败调用 + turn_end 均不干预。
    await pi.emit("tool_execution_end", SUCCESS_TOOL_END);
    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    await pi.emit("turn_end", turnEndPayload());

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});
