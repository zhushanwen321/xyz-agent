// src/core/output-collector.ts
//
// 结果收集器（Record + CollectResultArgs → AgentResult）。
//
// 收口设计（2026-06-22）：collectResult 全部从 record 读——
//   text ← getFullText(record)（聚合 turns[].text，不再读 session.messages）
//   turns ← record.turnCount
//   toolCalls ← getAllToolCalls(record)（扁平化 turns[].toolCalls）
//   usage ← getTotalUsage(record)（聚合 turns[].usageDelta）
//
// 基础层模块：依赖 execution-record（派生函数）+ types。

import type {
  AgentResult,
  ExecutionRecord,
  ToolCall,
} from "./types.ts";
import {
  getAllToolCalls,
  getFullText,
  getTotalUsage,
} from "./execution-record.ts";
// [F-R1] 值引用 stale-context 分诊 pattern 表（SSOT 在 execute-agent-call，消费点
// isStaleContextErrorMsg 同源）。execution → orchestration 值引用有先例
// （agent-registry.ts → script-lint.ts），且 execute-agent-call 对 execution 仅剩
// type-only import（已擦除），无运行时循环。
import { STALE_CONTEXT_PATTERNS } from "../orchestration/execute-agent-call.ts";

// ============================================================
// Result 收集
// ============================================================

/** collectResult 的入参（session 身份 + 执行控制字段，执行内容从 record 读）。 */
export interface CollectResultArgs {
  startTime: number;
  success: boolean;
  error: string | undefined;
  sessionId: string;
  sessionFile: string | undefined;
  /**
   * [F-1] 本次执行是否要求结构化产出（opts.schema 或 opts.schemaEnv 任一存在）。
   * true 且 run 结束仍无有效 parsedOutput 时：结果不得静默 success——置 success=false
   * 并把三态失败归因写进 error（上层 executeAgentCall 只看 error 判 completed/failed）。
   * 缺省 false（非 schema 模式 parsedOutput===undefined 是正常态，不动成败）。
   */
  schemaExpected?: boolean;
}

/** structured-output tool 名（与 structured-output 扩展 TOOL_NAME 一致，见 session-runner.ts）。 */
const STRUCTURED_OUTPUT_TOOL = "structured-output";

/** F-1 失败摘要截断长度（字符）：错误详情拼进 run 结果 error 字段，防大 payload 撑爆。 */
const FAILED_SO_SUMMARY_MAX_CHARS = 300;

/**
 * 从 toolCalls 提取 structured-output 的 result.details（schema 模式产出）。
 * schema enforcement 保证 agent 调过该 tool（漏调会 steer 重试）；这里只做逆向提取。
 * 未调或无 details 返回 undefined。
 *
 * [F-1 失败吞没修复] isError:true 的调用一律跳过——失败调用的 details（pi 失败
 * 路径默认 {}）不是通过 schema 校验的产出，把它当 parsedOutput 会让 gate 终止/
 * 模型自弃的 run 以 parsedOutput={} 静默 completed。isError 字段缺失（旧 record/
 * 进行中调用）不误伤——仅显式 true 跳过。
 *
 * 导出以便直接单测（纯函数契约）。
 */
export function extractParsedOutput(toolCalls: ToolCall[]): unknown {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const tc = toolCalls[i]!;
    if (tc.toolName === STRUCTURED_OUTPUT_TOOL && tc.isError !== true && tc.result?.details !== undefined) {
      return tc.result.details;
    }
  }
  return undefined;
}

/**
 * [F-R1] 中和动态错误摘要中的 stale-context 命中词：对每个 STALE_CONTEXT_PATTERNS
 * 做大小写不敏感的子串替换为 "[redacted]"（分诊 isStaleContextErrorMsg 是
 * toLowerCase 后的子串匹配，故中和也必须大小写不敏感）。
 *
 * 为何只中和动态段（summarizeToolContent 产物）、不中和固定前缀：前缀是本模块
 * 静态文案，已逐字核对无任何 pattern 命中，且由 output-collector.test.ts 的
 * "messages avoid STALE_CONTEXT_PATTERNS substrings" 用例锁定；动态段是
 * 模型/provider 的原始错误文本（可含 "aborted"/"ctx is stale" 等），不受本模块
 * 控制。不中和的话，拼接结果经 collectResult → result.error 流到
 * execute-agent-call 的 isStaleContextErrorMsg 分诊，SO 失败归因被误诊为
 * stale-context → 跳过重试。
 *
 * 导出以便直接单测（纯函数契约）。
 */
export function neutralizeStalePatterns(text: string): string {
  let out = text;
  for (const pattern of STALE_CONTEXT_PATTERNS) {
    // pattern 当前均为纯小写词/短语（无 regex 元字符），escape 仅为防未来 pattern
    // 演化引入元字符时静默改变语义。
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), "[redacted]");
  }
  return out;
}

/**
 * schema 模式下无有效 parsedOutput 时的三态失败归因（F-1）。
 *
 * 返回 undefined 表示 toolCalls 里有可用的 parsedOutput（无需归因）。
 * 三态判定优先级：校验失败（有 isError 调用）> 从未调用 SO tool > 调用过但无 details。
 *
 * 文案约束：不得命中 execute-agent-call 的 STALE_CONTEXT_PATTERNS（"aborted" 等
 * 子串）——命中会被误诊为 stale-context 跳过重试。固定前缀静态无命中（测试锁定）；
 * 动态段经 neutralizeStalePatterns 中和（F-R1）。
 *
 * 导出以便直接单测（纯函数契约）。
 */
export function describeMissingParsedOutput(toolCalls: ToolCall[]): string | undefined {
  if (extractParsedOutput(toolCalls) !== undefined) return undefined;
  const soCalls = toolCalls.filter((tc) => tc.toolName === STRUCTURED_OUTPUT_TOOL);
  if (soCalls.length === 0) {
    // 覆盖独立安装盲区（C1）：schema enforcement 依赖 SO extension 注册 tool，
    // 未安装时 agent 无工具可调、steer 无法生效——只能在这里事后暴露。
    return (
      "Agent finished without producing a structured output: the structured-output tool was never called. " +
      "Recovery: verify the structured-output extension is installed and enabled for this agent, " +
      "and that the agent's final answer conforms to the requested schema."
    );
  }
  const failed = soCalls.filter((tc) => tc.isError === true);
  if (failed.length > 0) {
    const last = failed[failed.length - 1]!;
    // [F-R1] 先截断后中和：截断边界把 pattern 切断时不产生新命中（半截词本就
    // 匹配不到分诊子串），完整落入截断窗口的 pattern 一定被中和。
    const lastErrorSummary = neutralizeStalePatterns(summarizeToolContent(last.result?.content));
    // [F-R4] 失败原因分类：isError 只说明「调用失败」，原因未必是 schema 校验
    // （provider 错误/pi abort/扩展内部错误同样走 isError），硬编码
    // "(schema validation)" 会误导排障。按最后错误的实际内容分类——权威锚点是
    // structured-output 扩展校验失败的固定文案前缀 "Schema validation failed: ..."
    //（structured-output/src/execute.ts），大小写不敏感匹配；其余归为 execution
    // failure。在已中和的摘要上分类：中和仅替换 stale 词，与校验词无交集。
    const failureKind = lastErrorSummary.toLowerCase().includes("validation failed")
      ? "schema validation"
      : "execution failure";
    return (
      `Agent finished without a valid structured output: ${failed.length} structured-output call(s) failed ` +
      `(${failureKind}). Last error: ${lastErrorSummary}`
    );
  }
  return (
    "Agent finished without a valid structured output: structured-output was called but none of the " +
    "successful calls carried result details."
  );
}

/** 从 tool result.content 提取可读错误文本（[{type:"text",text}] 形态，防御未知形状）。 */
function summarizeToolContent(content: unknown): string {
  let summary = "(no detail)";
  if (Array.isArray(content)) {
    const texts = content
      .map((item) => (item && typeof item === "object" && "text" in item ? String((item as { text: unknown }).text) : ""))
      .filter((t) => t !== "");
    if (texts.length > 0) summary = texts.join(" ");
  } else if (typeof content === "string" && content !== "") {
    summary = content;
  }
  return summary.length > FAILED_SO_SUMMARY_MAX_CHARS
    ? `${summary.slice(0, FAILED_SO_SUMMARY_MAX_CHARS)}...`
    : summary;
}

/**
 * 从 record + args 组装 AgentResult。每个字段来源单一且收口于 record：
 *   text      ← getFullText(record)（聚合 turns[].text，单一数据源）
 *   turns     ← record.turnCount
 *   toolCalls ← getAllToolCalls(record)（扁平化 turns[].toolCalls）
 *   usage     ← getTotalUsage(record)（聚合 turns[].usageDelta，全零则 undefined）
 *   parsedOutput ← extractParsedOutput(toolCalls)
 *
 * startTime 算 durationMs。
 *
 * success 双来源判定（调用方传入）：
 *   ① session.prompt() 抛错 → args.success=false
 *   ② prompt 成功但 record.lastError 非空（message_end stopReason=error）→ success=false
 */
export function collectResult(
  record: ExecutionRecord,
  args: CollectResultArgs,
): AgentResult {
  const toolCalls = getAllToolCalls(record);
  const parsedOutput = extractParsedOutput(toolCalls);
  const result: AgentResult = {
    text: getFullText(record),
    turns: record.turnCount,
    durationMs: Date.now() - args.startTime,
    success: args.success,
    error: args.error,
    sessionId: args.sessionId,
    toolCalls,
    usage: getTotalUsage(record),
    sessionFile: args.sessionFile,
    parsedOutput,
  };
  // [F-1 失败吞没修复] schema 模式下 run 结束仍无有效 parsedOutput 时不得静默
  // success：只在「本将成功」的路径上标注（success=false 的路径已有真实 error/
  // abort 语义，不覆写）。error 经 mapToWorkflowAgentResult（仅 !success 透传）
  // → executeAgentCall（error!==undefined 即 failed）逐层可见。
  if (args.schemaExpected === true && result.success && parsedOutput === undefined) {
    result.success = false;
    result.error = describeMissingParsedOutput(toolCalls) ?? result.error;
  }
  return result;
}
