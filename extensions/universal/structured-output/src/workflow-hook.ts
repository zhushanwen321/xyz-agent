/**
 * Workflow hook：turn_end 时检查模型是否成功调用 structured-output 工具。
 * 未成功时通过 pi.sendUserMessage({deliverAs:"steer"}) 注入 steering message 重试。
 * 最多重试 MAX_HOOK_RETRIES 次，防止无限循环。
 *
 * RetryState：从旧 4 个 mutable 闭包（soCallCount/soSucceededEver/hookRetryCount/
 * lastSchemaError）显式化为类——per-turn reset 时机成为可单测的显式契约：
 * onTurnEnd() 仅在「判定要 steer」时调用（守卫链 toolUse/超上限/成功短路均不调）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isToolExecutionEndEvent, isTurnEndEvent } from "./schema-guards.js";

/** Pi Extension API — properly typed via ExtensionAPI from pi-coding-agent SDK */
type PiAPI = ExtensionAPI;

// 与 tool-definition.ts 的 TOOL_NAME 对应（本模块只监听该工具的 execution 事件；
// 保持依赖图单向：workflow-hook → schema-guards，不 import tool-definition）。
const TOOL_NAME = "structured-output";
const MAX_HOOK_RETRIES = 2;

/**
 * structured-output 调用状态机（IF-7，export 契约——M5 从本模块 import）。
 *
 * 转移表（M4-TC-2 单测锁定）：
 *   - onToolExecEnd(false)      → soCallCount++ / soSucceededEver=true（成功短路终态）
 *   - onToolExecEnd(true, err)  → soCallCount++ / lastSchemaError=err ?? 通用提示
 *   - onTurnEnd()               → soCallCount=0 / hookRetryCount++ / lastSchemaError=null
 *     （仅当 workflow-hook 判定要 steer 时调用——toolUse/超上限/成功短路均不调，
 *      故 toolUse 保留 soCallCount、超上限保留 lastSchemaError，与旧 4-closure 逐点一致）
 */
export class RetryState {
	soCallCount = 0;
	soSucceededEver = false;
	hookRetryCount = 0;
	lastSchemaError: string | null = null;

	/** 记录一次 structured-output tool 执行结果。hasError = event.isError === true。 */
	onToolExecEnd(hasError: boolean, errorMsg?: string): { shouldSteer: boolean } {
		this.soCallCount++;
		if (!hasError) {
			this.soSucceededEver = true;
			return { shouldSteer: false };
		}
		this.lastSchemaError = errorMsg ?? "structured-output call failed";
		return { shouldSteer: true };
	}

	/** turn 收尾（仅当要 steer 时调用）：重置本 turn 计数、累计重试次数、清空错误。 */
	onTurnEnd(): void {
		this.soCallCount = 0;
		this.hookRetryCount++;
		this.lastSchemaError = null;
	}

	/** 四字段归零（当前无调用方；保留作状态机完整契约）。 */
	reset(): void {
		this.soCallCount = 0;
		this.soSucceededEver = false;
		this.hookRetryCount = 0;
		this.lastSchemaError = null;
	}
}

/**
 * 从 tool 执行结果里提取错误文本。
 *
 * Pi 框架在 tool execute 抛错时，构造 `{ content: [{ type: "text", text }] }`
 * 塞进 result.content[0].text（见 extensions/unified-hooks 的 extractErrorText 及其
 * 文档：SDK 事件结构里没有独立 errorMessage 字段，错误文本只能从 result.content 里取）。
 * 这里防御性取多种结构，取不到就返回 undefined（调用方降级为通用提示）。
 */
function extractToolErrorText(result: unknown): string | undefined {
	// 常见结构：{ content: [{ type: "text", text: "..." }] }
	if (typeof result === "object" && result !== null) {
		const content = (result as Record<string, unknown>).content;
		if (Array.isArray(content)) {
			for (const item of content) {
				if (typeof item === "object" && item !== null) {
					const text = (item as Record<string, unknown>).text;
					if (typeof text === "string" && text.length > 0) return text;
				}
			}
		}
		// 兜底：某些 tool 直接塞 { error: "..." }
		const err = (result as Record<string, unknown>).error;
		if (typeof err === "string" && err.length > 0) return err;
	}
	return undefined;
}

/**
 * 注册 turn_end hook，检查模型是否成功调用 structured-output 工具。
 * 未成功时通过 pi.sendUserMessage({deliverAs:"steer"}) 注入 steering message 重试。
 *
 * 两种失败形态都会触发 steer：
 * 1. 完全没调用（soCallCount === 0）→ 注入"必须调用"提示 + 正确 schema
 * 2. 调了但全是 isError（soCallCount > 0 && !soSucceededEver）→ 注入具体校验错误
 *    + 正确 schema。旧实现在此处撒手交给 Pi 自然修正，但模型遇到 "Invalid JSON Schema"
 *    时无法自行修正（它不知道正确 schema 长什么样），实测会放弃 → 子进程正常退出 →
 *    workflow 把单点失败放大成整批崩溃。故此处主动 steer 并回灌错误细节。
 *
 * 检测时序：Pi 保证同 turn 内所有 tool_execution_end 都在 turn_end 之前触发，
 * 故 turn_end 读取的状态已反映本 turn 全部 tool 调用结果。
 */
export function setupWorkflowHook(pi: PiAPI, schemaJson: string): void {
	const state = new RetryState();

	// 追踪 structured-output 调用结果：
	// 成功 → soSucceededEver=true（终态，后续不再干预）
	// 失败 → soCallCount++，记录 lastSchemaError，由 turn_end 决定是否 steer 重试
	pi.on("tool_execution_end", async (event: unknown) => {
		if (!isToolExecutionEndEvent(event)) return;
		if (event.toolName !== TOOL_NAME) return;
		state.onToolExecEnd(
			event.isError === true,
			extractToolErrorText(event.result) ?? "structured-output call failed",
		);
	});

	pi.on("turn_end", async (event: unknown) => {
		// 守卫链：以下情况均直接 return（不调 onTurnEnd——toolUse 保留 soCallCount、
		// 超上限保留 lastSchemaError，与旧 4-closure 逐点一致）：
		// 1. 已经成功调用过 structured-output，不再干预
		// 2. 不是合法 turn_end 事件
		// 3. stopReason="toolUse" → 模型还在调工具链，不需要干预
		// 4. 超过重试上限：放弃，让子进程自然结束（调用方据 result.error 判定失败）
		if (state.soSucceededEver) return;
		if (!isTurnEndEvent(event)) return;
		if (event.message?.stopReason === "toolUse") return;
		if (state.hookRetryCount >= MAX_HOOK_RETRIES) return;

		// 完全没调用 OR 调了但全是失败 → 都需要 steer。两种情况共用重试上限与计数。
		const calledButFailed = state.soCallCount > 0;
		// 构造 reminder 时 lastSchemaError 必须仍是本 turn 的错误文本，
		// 故 onTurnEnd()（清空 lastSchemaError）必须在 reminder 构造之后调用。
		const reminder = calledButFailed
			? [
					"[MANDATORY] Your structured-output call FAILED validation:",
					state.lastSchemaError ?? "structured-output call failed",
					"",
					"The schema is enforced by the system (PI_WORKFLOW_SCHEMA) — do NOT pass your own `schema` parameter.",
					`The required schema for your \`data\` is: ${schemaJson}`,
					"Call the structured-output tool AGAIN with ONLY the `data` parameter conforming to this schema.",
					"Do NOT output the result as text — call the tool.",
				].join("\n")
			: [
					"[MANDATORY] You MUST call the structured-output tool now.",
					"Your task requires a structured output. Do NOT respond with plain text.",
					`The schema is enforced by the system. Call structured-output with ONLY \`data\` matching this shape: ${schemaJson}`,
					"Do NOT pass a `schema` parameter — the system validates `data` against the authoritative schema automatically.",
					"This is enforced by the workflow system. Just call the tool.",
				].join("\n");

		// 按本 turn 重置计数、累计重试次数、清空 lastSchemaError（steer 后本 turn 状态归零）
		state.onTurnEnd();
		pi.sendUserMessage(reminder, { deliverAs: "steer" });
	});
}
