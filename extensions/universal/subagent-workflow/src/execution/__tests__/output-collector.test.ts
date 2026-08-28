// src/__tests__/output-collector.test.ts
//
// 锁定 extractParsedOutput 纯函数契约——它被 collectResult 直接消费，决定
// AgentResult.parsedOutput 字段。toUsageTotal / collectResponseText 已删除
// （usage 收口进 getTotalUsage，text 收口进 getFullText，均在 execution-record.test 测）。
import { describe, expect, it } from "vitest";

import { collectResult, describeMissingParsedOutput, extractParsedOutput } from "../output-collector.ts";
import type { ExecutionRecord, ToolCall } from "../types.ts";

// ============================================================
// extractParsedOutput
// ============================================================

describe("extractParsedOutput", () => {
  it("returns undefined for empty toolCalls", () => {
    expect(extractParsedOutput([])).toBeUndefined();
  });

  it("returns undefined when no structured-output call exists", () => {
    const calls: ToolCall[] = [
      { toolName: "bash", result: { details: "x" } },
      { toolName: "read", result: { details: "y" } },
    ];
    expect(extractParsedOutput(calls)).toBeUndefined();
  });

  it("returns undefined when structured-output has no result.details", () => {
    const calls: ToolCall[] = [
      { toolName: "structured-output", result: { content: [] } },
      { toolName: "structured-output", result: {} },
      { toolName: "structured-output" },
    ];
    expect(extractParsedOutput(calls)).toBeUndefined();
  });

  it("returns details when exactly one structured-output call has details", () => {
    const calls: ToolCall[] = [
      { toolName: "bash" },
      { toolName: "structured-output", result: { details: { answer: 42 } } },
    ];
    expect(extractParsedOutput(calls)).toEqual({ answer: 42 });
  });

  it("returns the LAST structured-output details (reverse iteration)", () => {
    const calls: ToolCall[] = [
      { toolName: "structured-output", result: { details: "first" } },
      { toolName: "bash" },
      { toolName: "structured-output", result: { details: "second" } },
    ];
    expect(extractParsedOutput(calls)).toBe("second");
  });

  it("ignores isError structured-output calls without details, picks one with details", () => {
    const calls: ToolCall[] = [
      { toolName: "structured-output", isError: true, result: { content: [{ type: "text", text: "bad" }] } },
      { toolName: "structured-output", result: { details: { ok: true } } },
    ];
    expect(extractParsedOutput(calls)).toEqual({ ok: true });
  });

  // [F-1 失败吞没修复] 失败调用（pi 失败路径 details 默认 {}）的 details 不是
  // schema 校验产出——journal 实锤 tool_end isError=true details={} 曾被当
  // parsedOutput，gate 终止/模型自弃的 run 以 parsedOutput={} 静默 completed。
  it("skips failed structured-output call with details:{} (isError=true) — no parsedOutput", () => {
    const calls: ToolCall[] = [
      { toolName: "bash", result: { content: [] } },
      { toolName: "structured-output", isError: true, result: { details: {}, content: [{ type: "text", text: "Schema validation failed: /target is required" }] } },
    ];
    expect(extractParsedOutput(calls)).toBeUndefined();
  });

  it("skips failed call with details, still picks later valid call (reverse order)", () => {
    const calls: ToolCall[] = [
      { toolName: "structured-output", isError: true, result: { details: {} } },
      { toolName: "structured-output", result: { details: { fixed: true } } },
    ];
    expect(extractParsedOutput(calls)).toEqual({ fixed: true });
  });

  it("isError on non-structured-output calls does not affect extraction", () => {
    const calls: ToolCall[] = [
      { toolName: "bash", isError: true, result: { details: "ignored" } },
      { toolName: "structured-output", result: { details: { answer: 1 } } },
    ];
    expect(extractParsedOutput(calls)).toEqual({ answer: 1 });
  });
});

// ============================================================
// describeMissingParsedOutput（F-1 三态归因）
// ============================================================

describe("describeMissingParsedOutput", () => {
  it("returns undefined when a valid parsedOutput exists", () => {
    const calls: ToolCall[] = [
      { toolName: "structured-output", isError: true, result: { details: {} } },
      { toolName: "structured-output", result: { details: { ok: 1 } } },
    ];
    expect(describeMissingParsedOutput(calls)).toBeUndefined();
  });

  it("state 1: validation failure — isError calls present, error carries last summary", () => {
    const calls: ToolCall[] = [
      { toolName: "structured-output", isError: true, result: { details: {}, content: [{ type: "text", text: "Schema validation failed: /target is required" }] } },
    ];
    const msg = describeMissingParsedOutput(calls);
    expect(msg).toContain("failed");
    expect(msg).toContain("1 structured-output call(s) failed");
    expect(msg).toContain("Schema validation failed: /target is required");
  });

  it("state 2: structured-output never called — error hints to check extension install (C1 blind spot)", () => {
    const calls: ToolCall[] = [
      { toolName: "bash", result: { content: [] } },
      { toolName: "read", result: { content: [] } },
    ];
    const msg = describeMissingParsedOutput(calls);
    expect(msg).toContain("structured-output tool was never called");
    expect(msg).toContain("structured-output extension is installed");
  });

  it("state 3: SO called successfully but no details", () => {
    const calls: ToolCall[] = [
      { toolName: "structured-output", result: { content: [] } },
    ];
    const msg = describeMissingParsedOutput(calls);
    expect(msg).toContain("none of the successful calls carried result details");
  });

  it("empty toolCalls → state 2 (never called)", () => {
    expect(describeMissingParsedOutput([])).toContain("never called");
  });

  it("summary truncates long error text (300 chars cap)", () => {
    const longText = "x".repeat(500);
    const calls: ToolCall[] = [
      { toolName: "structured-output", isError: true, result: { details: {}, content: [{ type: "text", text: longText }] } },
    ];
    const msg = describeMissingParsedOutput(calls);
    expect(msg).toContain("...");
    expect(msg!.length).toBeLessThan(longText.length);
  });

  // 文案约束：不得命中 execute-agent-call 的 STALE_CONTEXT_PATTERNS（"aborted" 等），
  // 否则会被误诊为 stale-context 跳过重试。
  it("messages avoid STALE_CONTEXT_PATTERNS substrings (no false stale-context triage)", () => {
    const samples = [
      describeMissingParsedOutput([])!,
      describeMissingParsedOutput([{ toolName: "structured-output", isError: true, result: { details: {} } }])!,
      describeMissingParsedOutput([{ toolName: "structured-output", result: { content: [] } }])!,
    ];
    for (const msg of samples) {
      const lower = msg.toLowerCase();
      expect(lower).not.toContain("aborted");
      expect(lower).not.toContain("ctx is stale");
      expect(lower).not.toContain("context canceled");
    }
  });
});

// ============================================================
// collectResult — F-1 集成行为（schemaExpected → 失败标注）
// ============================================================

describe("collectResult — F-1 schemaExpected 失败标注", () => {
  /** 最小 ExecutionRecord stub（collectResult 只读 turns/toolCalls 派生面）。 */
  function makeRecordWithCalls(calls: ToolCall[]): ExecutionRecord {
    return {
      id: "rec-1",
      turns: [{ toolCalls: calls, text: "done", turnCount: 1, closed: true }],
      turnCount: 1,
    } as unknown as ExecutionRecord;
  }

  const baseArgs = {
    startTime: Date.now(),
    sessionId: "s-1",
    sessionFile: undefined,
  };

  it("schemaExpected + failed SO call (details:{}) + success=true → success=false + error attributed", () => {
    const record = makeRecordWithCalls([
      { toolName: "structured-output", isError: true, result: { details: {}, content: [{ type: "text", text: "validation boom" }] } },
    ]);
    const result = collectResult(record, { ...baseArgs, success: true, error: undefined, schemaExpected: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("validation boom");
    expect(result.parsedOutput).toBeUndefined();
  });

  it("schemaExpected + never called SO + success=true → error hints extension check", () => {
    const record = makeRecordWithCalls([{ toolName: "bash", result: { content: [] } }]);
    const result = collectResult(record, { ...baseArgs, success: true, error: undefined, schemaExpected: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("structured-output extension is installed");
  });

  it("schemaExpected + valid details → success preserved (S3 e2e semantics no regression)", () => {
    const record = makeRecordWithCalls([
      { toolName: "structured-output", result: { details: { answer: 42 } } },
    ]);
    const result = collectResult(record, { ...baseArgs, success: true, error: undefined, schemaExpected: true });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.parsedOutput).toEqual({ answer: 42 });
  });

  it("no schemaExpected (plain mode) + no SO call → success unchanged", () => {
    const record = makeRecordWithCalls([{ toolName: "bash", result: { content: [] } }]);
    const result = collectResult(record, { ...baseArgs, success: true, error: undefined });
    expect(result.success).toBe(true);
    expect(result.parsedOutput).toBeUndefined();
  });

  it("success=false path: existing error not overwritten by F-1 attribution", () => {
    const record = makeRecordWithCalls([]);
    const result = collectResult(record, { ...baseArgs, success: false, error: "provider boom", schemaExpected: true });
    expect(result.success).toBe(false);
    expect(result.error).toBe("provider boom");
  });
});
