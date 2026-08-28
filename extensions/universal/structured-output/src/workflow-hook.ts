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

// 反向依赖（环）：loop-gate 为本模块 steer 回灌提供截断原语（审查项#1，导出复用勿复制）。
// 两模块互引均为函数声明（ESM 提升）且只在事件回调运行期调用（无模块顶层执行），环安全。
import { truncateText } from "./loop-gate.js";

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
 *     （仅当「判定要 steer 且发送成功」时调用——守卫链 toolUse/error/aborted/超上限/
 *      成功短路/发送失败均不调，故 toolUse 保留 soCallCount、超上限保留
 *      lastSchemaError，与旧 4-closure 逐点一致）
 *
 * terminal 态（D3/U2）：由 loop-gate 在同签名失败达 3 次时经 markTerminal() 置位，
 * turn_end hook 据此不再 steer——防御性保留：shutdown 正常生效时进程已终止，
 * 此分支是 shutdown 失败路径下的保险。terminal 不影响 onToolExecEnd 记录
 * （闸门自身幂等，重复事件无害）。
 */
export class RetryState {
	soCallCount = 0;
	soSucceededEver = false;
	hookRetryCount = 0;
	lastSchemaError: string | null = null;
	terminal = false;

	/** 闸门 terminal 置位（loop-gate 经 index.ts 回调调用；不可逆，仅 reset() 可清）。 */
	markTerminal(): void {
		this.terminal = true;
	}

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

	/** 五字段归零（当前无调用方；保留作状态机完整契约——含 U2 新增 terminal 态）。 */
	reset(): void {
		this.soCallCount = 0;
		this.soSucceededEver = false;
		this.hookRetryCount = 0;
		this.lastSchemaError = null;
		this.terminal = false;
	}
}

/**
 * 从 tool 执行结果里提取错误文本。
 *
 * Pi 框架在参数层校验失败（immediate 路径）与 execute 抛错时，均构造
 * `{ content: [{ type: "text", text }] }` 塞进 result.content[0].text
 * （agent-loop.js createErrorToolResult；见 extensions/universal/unified-hooks 的
 * extractErrorText 及其文档：SDK 事件结构里没有独立 errorMessage 字段，错误文本只能从
 * result.content 里取）。loop-gate（D3）复用本函数提取签名原料。
 * 这里防御性取多种结构，取不到就返回 undefined（调用方降级为通用提示）。
 */
export function extractToolErrorText(result: unknown): string | undefined {
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

/** steer 发送失败告警的 appendEntry customType（session JSONL 持久化，不进 LLM 上下文）。 */
export const HOOK_ENTRY_TYPE = "structured-output:hook";

/**
 * steer 发送失败告警（审查项#8 失败路径）：双通道落盘（同 loop-gate writeTerminatedLog
 * 惯例）——stderr 直出 + appendEntry 持久化。预算未扣减由「不调 onTurnEnd」结构保证，
 * 下一个正常收尾的轮仍会重试 steer，不产生静默哑火。
 */
function writeSteerFailedLog(pi: PiAPI, hookRetryCount: number, err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	process.stderr.write(
		`[structured-output hook] steer send failed (retry budget NOT consumed, will retry at next turn end): ${message}\n`,
	);
	try {
		pi.appendEntry(HOOK_ENTRY_TYPE, {
			event: "steer_send_failed",
			hookRetryCount,
			error: message,
			guidance:
				"The steering message could not be delivered (e.g. compaction in progress or extension deactivated); the retry budget was preserved and the hook will retry at the next turn end.",
		});
	} catch (appendErr) {
		// appendEntry 失败不阻断 hook——stderr 通道已落，此处补诊断（同 cache-probe 惯例）
		process.stderr.write(
			`[structured-output hook] appendEntry failed: ${appendErr instanceof Error ? appendErr.message : String(appendErr)}\n`,
		);
	}
}

/**
 * 注册 turn_end hook，检查模型是否成功调用 structured-output 工具。
 * 未成功时通过 pi.sendUserMessage({deliverAs:"steer"}) 注入 steering message 重试。
 * 最多重试 MAX_HOOK_RETRIES 次，防止无限循环。
 *
 * @returns 共享的 RetryState（U2：index.ts 拿它接线 loop-gate 的 onTerminal 回调）。
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
export function setupWorkflowHook(pi: PiAPI, schemaJson: string): RetryState {
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
		// 守卫链：以下情况均直接 return（不调 onTurnEnd——toolUse/error/aborted 保留
		// soCallCount、超上限保留 lastSchemaError，与旧 4-closure 逐点一致）：
		// 0. 闸门 terminal（D3/U2）：同签名失败已满 3 次、shutdown 已发——不再 steer，
		//    让进程终止（防御性保留：shutdown 正常生效时进程已死，到不了这里）
		// 1. 已经成功调用过 structured-output，不再干预
		// 2. 不是合法 turn_end 事件
		// 3. stopReason="toolUse" → 模型还在调工具链，不需要干预
		// 4. stopReason="error"/"aborted"（审查项#9）→ 本轮异常终止：此刻注入的 steer
		//    在本轮不会被消费，chatMode 复用子进程时会泄漏成下一轮的陈旧指令——不发送。
		//    不调 onTurnEnd（预算不扣减），状态保留到下一个正常收尾的轮再判定 steer。
		// 5. 超过重试上限：放弃，让子进程自然结束（调用方据 result.error 判定失败）
		if (state.terminal) return;
		if (state.soSucceededEver) return;
		if (!isTurnEndEvent(event)) return;
		if (event.message?.stopReason === "toolUse") return;
		if (event.message?.stopReason === "error" || event.message?.stopReason === "aborted") return;
		if (state.hookRetryCount >= MAX_HOOK_RETRIES) return;

		// 完全没调用 OR 调了但全是失败 → 都需要 steer。两种情况共用重试上限与计数。
		const calledButFailed = state.soCallCount > 0;
		// 构造 reminder 时 lastSchemaError 必须仍是本 turn 的错误文本，
		// 故 onTurnEnd()（清空 lastSchemaError）必须在发送成功之后调用。
		// 错误块经 truncateText 截断（审查项#1，500c 上限沿用 loop-gate 签名常量）：
		// pi-ai validation.js 的实参回显无截断，大 payload 失败时原始错误 ≈11K chars；
		// 首部关键信息（错误类型 + 字段名）位于错误文本头部，截断后仍完整保留。
		const reminder = calledButFailed
			? [
					"[MANDATORY] Your structured-output call FAILED validation:",
					truncateText(state.lastSchemaError ?? "structured-output call failed"),
					"",
					"The schema is enforced by the system (PI_WORKFLOW_SCHEMA) — this tool's parameter schema IS the required shape of your result.",
					`The required schema for your result is: ${schemaJson}`,
					"Fix your arguments to conform to this schema and call the structured-output tool AGAIN.",
					"Do NOT output the result as text — call the tool.",
				].join("\n")
			: [
					"[MANDATORY] You MUST call the structured-output tool now.",
					"Your task requires a structured output. Do NOT respond with plain text.",
					`Your arguments ARE the data — call structured-output with your result as the tool's arguments, matching this shape: ${schemaJson}`,
					"The schema is enforced by the system; your arguments are validated against the authoritative schema automatically.",
					"This is enforced by the workflow system. Just call the tool.",
				].join("\n");

		// 审查项#8：await 发送结果——发送失败（如 compaction 中 prompt() 抛错 / 扩展已
		// 被 assertActive 拒绝）不扣减重试预算（不调 onTurnEnd），否则 fire-and-forget
		// 丢一份 steer + 白扣一次预算，两次即永久哑火。
		// pi 0.84.1 实装（loader.js）：extension 侧 sendUserMessage 同步转发且吞掉异步
		// rejection（转 emitError）返回 void——await 对 undefined 立即解析；此处的
		// try/catch 兜住同步 throw（assertActive）与未来 pi 返回真 Promise 的形态。
		try {
			await pi.sendUserMessage(reminder, { deliverAs: "steer" });
		} catch (err) {
			writeSteerFailedLog(pi, state.hookRetryCount, err);
			return;
		}
		// 发送成功才按本 turn 重置计数、累计重试次数、清空 lastSchemaError
		state.onTurnEnd();
	});

	// U2：暴露共享状态——index.ts 接线 loop-gate 的 onTerminal 回调（markTerminal）
	return state;
}
