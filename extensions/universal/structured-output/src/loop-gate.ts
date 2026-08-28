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
 *   - 错误签名归一化（审查项#7 签名哈希化）：截掉 "Received arguments:" 起的实参
 *     回显后，提取错误字段/路径 token 集合排序哈希为签名——集合不变 = 模型无进展
 *     （重复同一批字段错误），集合变化（含缩小 = 渐进修复）= 模型在推进。旧 500c
 *     前缀截断在大 schema 下会把「修复排序靠后字段」（消息前缀不变）误折叠成同签名。
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

// 依赖方向说明：本模块 → workflow-hook（extractToolErrorText），而 workflow-hook 为
// steer 回灌截断反向 import 本模块的 truncateText——两处引用均为函数声明（ESM 提升），
// 且只在事件回调运行期调用（无模块顶层执行），环安全；见 workflow-hook.ts 同款注释。

/** 与 tool-definition.ts 的 TOOL_NAME 对应。 */
const TOOL_NAME = "structured-output";

/** 连续同签名失败阈值（设计 §6.3：对齐 qwen-code 的 3；workflow 子进程单用途短会话，更快失败更省）。 */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** 实参回显起点标记（pi-ai validation.js 的 errorMessage 格式：错误行 + 空行 + 本标记 + 回显）。 */
const ARGS_ECHO_MARKER = "Received arguments:";

/**
 * 签名/回灌文本截断上限（实施期自定：错误行块由 schema 违规条数决定，500 字符覆盖
 * 现实错误列表）。双消费方：① 签名 fallback 前缀；② steer 回灌错误块截断
 * （workflow-hook 复用，审查项#1——pi-ai validation.js 的实参回显无截断，大 payload
 * 失败时单份 steer ≈11K chars，首部关键信息 = 错误类型 + 字段名保留在 500c 内）。
 */
export const SIGNATURE_MAX_CHARS = 500;

/**
 * 截断到 max 字符（超出追加 "..."）——有界化原语，勿复制（审查项#1：导出复用）。
 * 消费方：LoopGate.lastErrorText（terminal 日志）与 workflow-hook 的 steer 回灌错误块。
 */
export function truncateText(text: string, max = SIGNATURE_MAX_CHARS): string {
	return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/**
 * 从（已剔除实参回显的）错误文本提取字段/路径 token 集合——修复进展的坐标：
 * 修一个字段必然改变失败字段集合，而消息前缀可能纹丝不动（大 schema 下错误行
 * 按序排列，靠后字段的修复不进 500c 前缀——旧前缀方案的误杀根源）。
 *
 * 覆盖两种错误形态（pi 实装版核实的 errorMessage 结构）：
 *   - pi-ai 参数层 bullet 行（validation.js：`  - ${formatValidationPath(error)}: ${message}`，
 *     required/enum 的字段名都在 bullet 路径位）：`  - assessments.0.impact: must be string`
 *   - 日常模式 ajv instancePath（execute.ts 拼接 `${err.instancePath} ${err.message}`）：
 *     `Schema validation failed: /count must be number`
 *
 * 提取不到 token（非校验类错误文本，如 "structured-output call failed"/网络错误）
 * 返回空数组——调用方 fallback 到 500c 前缀。
 */
function extractErrorFieldTokens(errorLines: string): string[] {
	const tokens = new Set<string>();
	// 形态 1：bullet 行路径位（"- " 与 ":" 之间）；字符类覆盖点分路径/数组索引/斜杠
	const bulletPath = /(?:^|\n)\s*-\s+([\w.\-/\[\]]+)\s*:/g;
	// 形态 2：行首/空白/分号后的 ajv instancePath（/a/b/c）——排除紧贴前字符的斜杠
	//（避免把 bullet 路径里的 a/b 拆出半截 token 与形态 1 重复）
	const slashPath = /(?:^|[\s;])\/([\w.\-/\[\]]+)/g;
	for (const re of [bulletPath, slashPath]) {
		for (const m of errorLines.matchAll(re)) {
			tokens.add(m[1]!);
		}
	}
	return [...tokens];
}

/** FNV-1a 32-bit 参数：offset basis / prime（零依赖确定性哈希；签名仅用于等值比较，非加密场景）。 */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** 32-bit 哈希输出为 8 位十六进制。 */
const HEX_RADIX = 16;
const HEX_WIDTH = 8;

function fnv1aHex(input: string): string {
	let hash = FNV_OFFSET_BASIS;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, FNV_PRIME);
	}
	return (hash >>> 0).toString(HEX_RADIX).padStart(HEX_WIDTH, "0");
}

/**
 * 字段集合规范形 → 哈希：排序去重后 join（token 字符类不含逗号，join 无歧义）。
 * 前缀带 token 数便于 appendEntry 日志肉眼判读（同数不同集靠哈希区分）。
 */
function fieldSetSignature(tokens: string[]): string {
	const canonical = [...tokens].sort().join(",");
	return `fields(${tokens.length})#${fnv1aHex(canonical)}`;
}

/** 签名 fallback 截断：裸切片不加 "..."（既有行为——上限即 500，锁定于测试）。 */
function truncateSignature(text: string): string {
	return text.length <= SIGNATURE_MAX_CHARS ? text : text.slice(0, SIGNATURE_MAX_CHARS);
}

/**
 * 错误签名归一化（审查项#7：字段/路径 token 集合哈希）：
 *   1. 剔除 "Received arguments:" 起的实参回显（语义保留——实参变化不等于进展）。
 *   2. 提取字段/路径 token 集合 → 排序哈希为签名：集合不变 = 同签名（无进展）；
 *      集合变化 = 新签名（渐进修复——集合缩小是主形态——不再被前缀截断误折叠）。
 *   3. 提取失败（无任何字段 token）fallback 到 500c 前缀硬上限（既有行为）。
 * 归一化对任意错误文本安全（非校验类错误走 fallback 分支）。
 */
export function normalizeErrorSignature(errorText: string): string {
	const markerIdx = errorText.indexOf(ARGS_ECHO_MARKER);
	const errorLines = (markerIdx >= 0 ? errorText.slice(0, markerIdx) : errorText).trim();
	const tokens = extractErrorFieldTokens(errorLines);
	return tokens.length > 0 ? fieldSetSignature(tokens) : truncateSignature(errorLines);
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
		this.lastErrorText = truncateText(rawText);
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

	/** 当前归一化签名（字段集合哈希或 fallback 前缀；无失败史时 null；测试与日志用）。 */
	get signature(): string | null {
		return this.lastSignature;
	}
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
