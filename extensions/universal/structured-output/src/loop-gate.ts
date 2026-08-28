/**
 * 有界失败闸门（D3，U2 / M2）——G2「失败必有界」的执行体。
 *
 * 通道选型（设计 §6.3，P3-new 直读 dist 证实）：
 *   参数层失败（事故主形态）在 pi-ai validateToolArguments 抛错、走 agent-loop 的
 *   immediate error 路径——execute 不被调用、beforeToolCall 永不触发；唯一可靠
 *   的计数通道是 tool_execution_end 事件（sequential/parallel 两路径的 immediate
 *   分支均 emitToolExecutionEnd）。
 *
 * 状态机：
 *   - 只统计 name=structured-output 的 isError 事件；其他工具的成功/失败均忽略。
 *   - 错误签名归一化：截掉 "Received arguments:" 起的实参回显，保留校验错误行——
 *     同签名 = 模型无进展（重复同一错误），签名变化 = 模型在推进。
 *   - 连续同签名失败达 MAX_CONSECUTIVE_FAILURES（3）→ terminal 态：
 *     写日志（stderr + appendEntry 双通道，含 §5.2 形态 b 恢复指引）后调
 *     ctx.shutdown() 优雅终止子进程（RPC mode 在 agent_settled 后 exit）。
 *   - 成功调用清零（模型走通即无循环）。
 *
 * 与 workflow-hook 的关系：terminal 态经 onTerminal 回调标记 RetryState.terminal，
 * turn_end hook 据此不再 steer（防御性保留——shutdown 正常生效时进程已终止，
 * 该分支是 shutdown 失败路径下的保险）。
 *
 * 诚实边界（设计 §6.3）：闸门只终止「同签名无进展」这一种循环形态；签名不断
 * 变化的长尾低效不触发闸门，仍由 workflow 层 maxTurns 兜底。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isToolExecutionEndEvent } from "./schema-guards.js";
import { extractToolErrorText } from "./workflow-hook.js";

type PiAPI = ExtensionAPI;

/** 与 tool-definition.ts 的 TOOL_NAME 对应（依赖方向：loop-gate → workflow-hook → schema-guards）。 */
const TOOL_NAME = "structured-output";

/** 连续同签名失败阈值（设计 §6.3：对齐 qwen-code 的 3；workflow 子进程单用途短会话，更快失败更省）。 */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** 实参回显起点标记（pi-ai validation.js 的 errorMessage 格式：错误行 + 空行 + 本标记 + 回显）。 */
const ARGS_ECHO_MARKER = "Received arguments:";

/** 签名截断上限（实施期自定：错误行块由 schema 违规条数决定，500 字符覆盖现实错误列表）。 */
const SIGNATURE_MAX_CHARS = 500;

/**
 * 错误签名归一化：剔除 "Received arguments:" 起的实参回显，保留校验错误行。
 * 同错误不同回显 → 同签名（模型把同样的东西又传了一遍 = 无进展）；
 * 错误行不同 → 不同签名（模型改了参数形态 = 在推进）。
 * 无标记（非参数层错误文本）时用全文截断——归一化对任意错误文本安全。
 */
export function normalizeErrorSignature(errorText: string): string {
	const markerIdx = errorText.indexOf(ARGS_ECHO_MARKER);
	const errorLines = markerIdx >= 0 ? errorText.slice(0, markerIdx) : errorText;
	const signature = errorLines.trim();
	return signature.length <= SIGNATURE_MAX_CHARS
		? signature
		: signature.slice(0, SIGNATURE_MAX_CHARS);
}

/**
 * structured-output 失败循环闸门状态机（纯逻辑，可单测）。
 *
 * 转移表（loop-gate.test.ts 锁定）：
 *   - onToolExecEnd(false)            → 计数/签名清零（成功短路）
 *   - onToolExecEnd(true, text)       → 签名同：计数++；签名异：计数=1（新一轮连续从此失败起算）
 *   - 计数达 MAX_CONSECUTIVE_FAILURES → terminal=true（不可逆；此后任何输入不再变化）
 */
export class LoopGate {
	terminal = false;
	private lastSignature: string | null = null;
	consecutiveFailures = 0;
	/** 最近一次失败的原始终态文本（截断后），供 terminal 日志引用。 */
	lastErrorText: string | null = null;

	/** 记录一次 structured-output tool 执行结果。hasError = event.isError === true。 */
	onToolExecEnd(hasError: boolean, errorText?: string): {
		terminal: boolean;
		/** 仅在「本次调用触发 terminal」时为 true（幂等：terminal 后恒 false）。 */
		newlyTerminal: boolean;
	} {
		if (this.terminal) return { terminal: true, newlyTerminal: false };

		if (!hasError) {
			this.consecutiveFailures = 0;
			this.lastSignature = null;
			this.lastErrorText = null;
			return { terminal: false, newlyTerminal: false };
		}

		const rawText = errorText ?? "structured-output call failed";
		this.lastErrorText = truncate(rawText);
		const signature = normalizeErrorSignature(rawText);
		if (signature === this.lastSignature) {
			this.consecutiveFailures++;
		} else {
			this.lastSignature = signature;
			this.consecutiveFailures = 1;
		}

		if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			this.terminal = true;
			return { terminal: true, newlyTerminal: true };
		}
		return { terminal: false, newlyTerminal: false };
	}

	/** 当前归一化签名（无失败史时 null；测试与日志用）。 */
	get signature(): string | null {
		return this.lastSignature;
	}
}

function truncate(text: string, max = SIGNATURE_MAX_CHARS): string {
	return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/** terminal 日志的 appendEntry customType（session.jsonl 持久化，不进 LLM 上下文）。 */
export const GATE_ENTRY_TYPE = "structured-output:gate";

/**
 * terminal 态日志（§5.2 形态 b）：
 *   - stderr：子进程 stderr 直出（xyz-agent runtime 的 pi-*.jsonl tee / 本地探针可见）
 *   - appendEntry：session JSONL 持久化记录（事后排查通道，不进 LLM 上下文）
 * 两者内容同源，指引文案逐字对齐设计 §5.2。
 */
function writeTerminatedLog(pi: PiAPI, gate: LoopGate): void {
	const lastError = gate.lastErrorText ?? "(no error text)";
	const stderrLines = [
		`[structured-output gate] Terminated: the same validation error occurred ${MAX_CONSECUTIVE_FAILURES} times consecutively; shutting down this single-purpose workflow subprocess.`,
		`Last error: ${lastError}`,
		"👉 (workflow 作者) 检查 workflow 脚本的 outputSchema 是否过苛（深嵌套/超长 required），或更换更强模型后重跑该步骤。",
	].join("\n");
	// stderr 已销毁（EPIPE）时错误走流 error 事件而非同步 throw（同 cache-probe 惯例）
	process.stderr.write(`${stderrLines}\n`);

	try {
		pi.appendEntry(GATE_ENTRY_TYPE, {
			event: "terminated",
			consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
			signature: gate.signature,
			lastError,
			guidance:
				"Check the workflow script's outputSchema (too strict / deep nesting / long required) or switch to a stronger model, then re-run this step.",
		});
	} catch (err) {
		// appendEntry 失败不阻断 shutdown——stderr 通道已落，此处补诊断（同 cache-probe 惯例）
		process.stderr.write(
			`[structured-output gate] appendEntry failed: ${err instanceof Error ? err.message : String(err)}\n`,
		);
	}
}

export interface LoopGateOptions {
	/** terminal 触发时的回调（index.ts 用于标记 RetryState.terminal，hook 据此停 steer）。 */
	onTerminal?: () => void;
}

/**
 * 注册 tool_execution_end 闸门监听（仅 workflow 模式装配，见 index.ts）。
 *
 * terminal 触发时序：onTerminal 回调（同步，先标记 hook 状态）→ 写日志 →
 * ctx.shutdown()（RPC mode 置 shutdownRequested，agent_settled 后进程 exit(0)，
 * 父进程走「子进程结束但未产出 structured-output」的既有失败路径）。
 */
export function setupLoopGate(pi: PiAPI, options: LoopGateOptions = {}): LoopGate {
	const gate = new LoopGate();

	pi.on("tool_execution_end", async (event: unknown, ctx: ExtensionContext) => {
		if (!isToolExecutionEndEvent(event)) return;
		if (event.toolName !== TOOL_NAME) return;

		const outcome = gate.onToolExecEnd(
			event.isError === true,
			extractToolErrorText(event.result),
		);
		if (!outcome.newlyTerminal) return;

		options.onTerminal?.();
		writeTerminatedLog(pi, gate);
		ctx.shutdown();
	});

	return gate;
}
