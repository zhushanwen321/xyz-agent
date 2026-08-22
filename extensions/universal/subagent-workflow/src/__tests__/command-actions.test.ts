/**
 * command-actions — RPC 模式 slash command action 解析纯函数测试。
 *
 * 覆盖 parseSubagentRpcCommand / parseWorkflowRpcCommand：
 * - 正常路径（action + id 齐全）
 * - missing-id 边界（action 有但 id 缺失）
 * - removed 边界（已移除的 workflow lifecycle verb → lifecycle-removed 提示，
 *   run 一次性生命周期后 pause/resume 不可用）
 * - noop 边界（空串 / 未知 action / 无参列表查看）
 *
 * 纯函数无外部依赖，直接断言返回值。
 */
import { describe, expect, it } from "vitest";

import {
  parseSubagentRpcCommand,
  parseWorkflowRpcCommand,
} from "../interface/command-actions.ts";

// ============================================================
// parseSubagentRpcCommand
// ============================================================

describe("parseSubagentRpcCommand", () => {
  it("cancel + recordId → { action: 'cancel', recordId }", () => {
    expect(parseSubagentRpcCommand("cancel bg-jwt-research")).toEqual({
      action: "cancel",
      recordId: "bg-jwt-research",
    });
  });

  it("cancel 无 recordId → cancel-missing-id", () => {
    expect(parseSubagentRpcCommand("cancel")).toEqual({ action: "cancel-missing-id" });
  });

  it("cancel 后跟多个空格再 id → 正确解析 id（trim 后）", () => {
    expect(parseSubagentRpcCommand("cancel   bg-x")).toEqual({
      action: "cancel",
      recordId: "bg-x",
    });
  });

  it("空串 → noop", () => {
    expect(parseSubagentRpcCommand("")).toEqual({ action: "noop" });
  });

  it("纯空白 → noop", () => {
    expect(parseSubagentRpcCommand("   ")).toEqual({ action: "noop" });
  });

  it("未知 action → noop", () => {
    expect(parseSubagentRpcCommand("foobar bg-x")).toEqual({ action: "noop" });
  });

  it("无参（列表查看，GUI 不走此路径但需兜底）→ noop", () => {
    expect(parseSubagentRpcCommand("bg-jwt-research")).toEqual({ action: "noop" });
  });
});

// ============================================================
// parseWorkflowRpcCommand
// ============================================================

describe("parseWorkflowRpcCommand", () => {
  it("pause + runId → { action: 'lifecycle-removed', verb: 'pause' }（run 一次性生命周期，不可挂起）", () => {
    expect(parseWorkflowRpcCommand("pause run-abc")).toEqual({
      action: "lifecycle-removed",
      verb: "pause",
    });
  });

  it("resume + runId → { action: 'lifecycle-removed', verb: 'resume' }（run 一次性生命周期，不可恢复）", () => {
    expect(parseWorkflowRpcCommand("resume run-def")).toEqual({
      action: "lifecycle-removed",
      verb: "resume",
    });
  });

  it("abort + runId → { action: 'abort', runId }", () => {
    expect(parseWorkflowRpcCommand("abort run-ghi")).toEqual({
      action: "abort",
      runId: "run-ghi",
    });
  });

  it("pause 无 runId → lifecycle-removed（removed verb 优先于 missing-id 判定——提示语义优先）", () => {
    expect(parseWorkflowRpcCommand("pause")).toEqual({
      action: "lifecycle-removed",
      verb: "pause",
    });
  });

  it("resume 无 runId → lifecycle-removed（removed verb 优先于 missing-id 判定）", () => {
    expect(parseWorkflowRpcCommand("resume")).toEqual({
      action: "lifecycle-removed",
      verb: "resume",
    });
  });

  it("abort 无 runId → lifecycle-missing-id with verb", () => {
    expect(parseWorkflowRpcCommand("abort")).toEqual({
      action: "lifecycle-missing-id",
      verb: "abort",
    });
  });

  it("空串 → noop", () => {
    expect(parseWorkflowRpcCommand("")).toEqual({ action: "noop" });
  });

  it("纯空白 → noop", () => {
    expect(parseWorkflowRpcCommand("  ")).toEqual({ action: "noop" });
  });

  it("未知 action → noop", () => {
    expect(parseWorkflowRpcCommand("status run-abc")).toEqual({ action: "noop" });
  });

  it("无参（列表查看）→ noop", () => {
    expect(parseWorkflowRpcCommand("run-abc")).toEqual({ action: "noop" });
  });
});
