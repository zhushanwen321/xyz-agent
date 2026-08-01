/**
 * Tool Error Handler Hook
 *
 * Records tool execution errors for post-hoc debugging via appendEntry.
 *
 * Design: tool errors already surface in the conversation flow via pi's native
 * tool result (isError → error content fed back to LLM). This hook does NOT
 * call ctx.ui.notify — that would duplicate the error in the TUI notification
 * area, and the "bash error" wording misleads (the error may be a hook's
 * block reason, not a real crash). We only appendEntry for audit trail.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";

const logger = getLogger("unified-hooks");

/**
 * Subset of `ToolExecutionEndEvent` fields used by this hook.
 * Local interface because the SDK's full event type is not re-exported
 * by the CI ambient type stubs.
 *
 * `result` 形如 `{ content: Array<{ type: "text", text: string }>, isError: boolean }`
 * （Pi 框架在 tool execute throw 时塞入 error content）。SDK 事件结构里没有独立
 * errorMessage 字段——错误文本只能从 result.content 里取。
 */
interface ToolExecutionEndLikeEvent {
  isError: boolean;
  toolName: string;
  toolCallId: string;
  result?: unknown;
}

/** ExtensionContext 的最小子集，仅声明 unified-hooks 内部用到的 ui 字段。 */
export interface HookContext {
  // headless / RPC 会话 ctx.ui 可能为 undefined（TUI 未初始化）。
  ui?: {
    // type 必须用 SDK 字面量联合，否则非法值（如 "warn"）会被 Pi 降级为 info 静默丢失。
    notify(msg: string, type?: "info" | "warning" | "error"): void;
  };
}

/**
 * 从 tool 执行结果里提取错误文本。
 *
 * Pi 框架在 tool execute 抛错时，构造 `{ content: [{ type: "text", text }] }`
 * 塞进 result.content[0].text。不同 tool / 框架版本可能格式略有差异，这里防御性
 * 取多种结构，取不到就返回 undefined（调用方降级，不阻断）。
 */
function extractErrorText(result: unknown): string | undefined {
  // 常见结构：{ content: [{ type: "text", text: "..." }] }
  const contentArr = getContentArray(result);
  if (contentArr) {
    for (const item of contentArr) {
      const text = getStringProperty(item, "text");
      if (text) return text;
    }
  }

  // 兜底：某些工具直接塞 { error: "..." }
  return getStringProperty(result, "error");
}

/** 若 result.content 是数组则返回它，否则 undefined。 */
function getContentArray(result: unknown): unknown[] | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const content = (result as Record<string, unknown>).content;
  return Array.isArray(content) ? content : undefined;
}

/** 类型守卫：返回 obj[key] 当它是非空 string，否则 undefined。 */
function getStringProperty(obj: unknown, key: string): string | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const val = (obj as Record<string, unknown>)[key];
  return typeof val === "string" && val.length > 0 ? val : undefined;
}

export function setupToolErrorHandler(pi: ExtensionAPI): void {
  pi.on("tool_execution_end", async (event: unknown) => {
    const e = event as ToolExecutionEndLikeEvent;
    if (!e.isError) return;

    // 提取错误文本：tool execute throw 时 Pi 把 error.message 塞进 result.content。
    // SDK 事件无 errorMessage 字段，只能从这里捞；拿不到也不阻断（降级到无详情）。
    const errorText = extractErrorText(e.result);

    // appendEntry 持久化到 session entries，供事后排查（无 UI、不泄漏）。
    // errorText 一起存上——事后排查能看到真实原因（如 "hub disposed"）。
    // 不调 ctx.ui.notify——tool error 已在对话流里（pi 原生 tool result），
    // notify 会重复显示且措辞（"bash error"）误导。
    logger.warn(`[unified-hooks] ${e.toolName} error (callId=${e.toolCallId})`, {
      toolName: e.toolName,
      toolCallId: e.toolCallId,
      errorText: errorText ?? null,
    });
  });
}
