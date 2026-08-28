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
//
// [U2 重锁 2026-08-28] 设计 §7.4「RetryState 增 terminal 态」为允许的基线变更：
//   - ②：同 turn 3 次同签名失败 → 闸门（loop-gate）在第 3 次 terminal + shutdown，
//     turn_end 不再 steer（旧基线：single steer）——硬闸门接管软 steer
//   - ③：第 3 轮失败同时是第 3 次同签名失败 → terminal 抢在 hookRetryCount 上限
//     之前拦截（旧基线：超上限放弃）；steer 总数仍 2，新增 shutdown 副作用断言

import { afterEach, describe, expect, it, vi } from "vitest";

// ── mock pi 公共 fixture（M5-T4：与 structured-output.test.ts Workflow hook 组共享）──
// on() 收集回调，emit() 按注册顺序触发（第二参数恒传含 shutdown 的 handlerCtx），
// sendUserMessage/appendEntry/ctx.shutdown spy。
import {
  createMockPi,
  FAILED_TOOL_END,
  failedToolEndWith,
  loadExtension,
  restoreSchemaEnv,
  SCHEMA,
  SCHEMA_ENV_NAME,
  SUCCESS_TOOL_END,
  turnEndPayload,
} from "./mock-pi-fixture.js";

const originalSchemaEnv = process.env[SCHEMA_ENV_NAME];

afterEach(() => {
  // fixture 的 restoreSchemaEnv 只处理 env；vi.restoreAllMocks 必须在消费方保留
  restoreSchemaEnv(originalSchemaEnv);
  vi.restoreAllMocks();
});

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

  it("② [U2 重锁] 3 same-signature failures in one turn → gate terminal + shutdown at 3rd, turn_end does NOT steer (was: single steer)", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    expect(pi.ctx.shutdown).not.toHaveBeenCalled(); // 2 次 < 阈值 3
    // 第 3 次同签名失败：闸门 terminal → onTerminal 标记 RetryState.terminal + shutdown
    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    expect(pi.ctx.shutdown).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "structured-output:gate",
      expect.objectContaining({ event: "terminated", consecutiveFailures: 3 }),
    );

    // turn_end：守卫链第 0 条（terminal）拦截 → 不 steer（旧基线：1 次 steer）
    await pi.emit("turn_end", turnEndPayload());
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("③ [U2 重锁] 3 failed turns → exactly 2 steers; 3rd failure (same signature ×3) hits gate terminal BEFORE retry-cap give-up → shutdown", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    // 失败→steer 循环 3 轮：前 2 轮 steer（失败次数 1、2），第 3 轮失败是第 3 次
    // 同签名失败 → 闸门 terminal + shutdown；turn_end 被守卫链第 0 条拦截不 steer。
    // steer 总数与旧基线一致（2），拦截者从 hookRetryCount 上限变为 terminal。
    for (let i = 0; i < 3; i++) {
      await pi.emit("tool_execution_end", FAILED_TOOL_END);
      await pi.emit("turn_end", turnEndPayload());
    }
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(pi.ctx.shutdown).toHaveBeenCalledTimes(1);
  });

  it("④ after a successful call, later failed calls never steer again (soSucceededEver short-circuit; gate count cleared by success)", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    // 成功调用 → soSucceededEver=true（终态）。后续失败调用 + turn_end 均不干预。
    // 闸门侧：成功清零后仅 1 次失败，未达阈值 → 无 shutdown（软硬闸门互不干扰）。
    await pi.emit("tool_execution_end", SUCCESS_TOOL_END);
    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    await pi.emit("turn_end", turnEndPayload());

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.ctx.shutdown).not.toHaveBeenCalled();
  });

  // [U2 新增基线] 设计 §7.4：terminal 是 shutdown 失效路径下的保险分支——
  // 本测试锁「terminal 后 hook 彻底哑火」：即使 turn_end 带不同 stopReason/
  // 后续失败继续到达，也不再有任何 steer。
  it("⑤ [U2] after gate terminal, no steer under ANY subsequent turn_end shape (shutdown-failure insurance)", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    // 3 次同签名失败 → terminal
    for (let i = 0; i < 3; i++) {
      await pi.emit("tool_execution_end", FAILED_TOOL_END);
    }
    expect(pi.ctx.shutdown).toHaveBeenCalledTimes(1);

    // 保险分支：后续任意 turn 形态（toolUse / end_turn）与失败均不 steer
    await pi.emit("turn_end", turnEndPayload("toolUse"));
    await pi.emit("tool_execution_end", failedToolEndWith("a different error"));
    await pi.emit("turn_end", turnEndPayload());
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    // terminal 幂等：第 4+ 次失败不重复 shutdown
    expect(pi.ctx.shutdown).toHaveBeenCalledTimes(1);
  });
});
