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
 *     required 错误的完整缺失字段列表从 message 解析并入 token（pi-ai bullet 路径位
 *     仅含 requiredProperties[0]，只取路径位会把「修好非首字段」折叠成同签名误杀）。
 *     AP 错误（D4 注入 additionalProperties:false，路径位恒 "root"、错误行无字段名）
 *     的实参回显顶层 keys 以 key:<name> 形式并入——keys 是结构信息不是值：keys 集合
 *     缩小 = 模型在删多余字段 = 真实进展；实参值变化（keys 不变）不产生新签名。
 *     keys 并入按桶门控（仅错误行块含 AP 错误行时生效，见 normalizeErrorSignature
 *     的并集恒定陷阱注释）——required/格式类错误行天然携带字段名，keys 并入反而
 *     制造对流失衡。
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
import {
	extractToolErrorText,
	SIGNATURE_MAX_CHARS,
	truncateText,
} from "./text-primitives.js";

type PiAPI = ExtensionAPI;

// 依赖方向说明：本模块 → text-primitives（共享叶节点，导出复用勿复制）。原先经
// workflow-hook 取 extractToolErrorText 构成的模块环已破除——双方互引的纯函数/常量
// 下沉到 text-primitives，依赖图单向（loop-gate → text-primitives ← workflow-hook）。

/** 与 tool-definition.ts 的 TOOL_NAME 对应。 */
const TOOL_NAME = "structured-output";

/** 连续同签名失败阈值（设计 §6.3：对齐 qwen-code 的 3；workflow 子进程单用途短会话，更快失败更省）。 */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** 实参回显起点标记（pi-ai validation.js 的 errorMessage 格式：错误行 + 空行 + 本标记 + 回显）。 */
const ARGS_ECHO_MARKER = "Received arguments:";

/**
 * TypeBox required message 形态（typebox locale en_US 逐字核实）：
 * "must have required properties X, Y, Z"——单缺失也是复数 "properties"，字段名为
 * 裸标识符 ", " 连接。解析恢复完整缺失字段列表；形态不符 → undefined（走路径位）。
 */
const REQUIRED_MESSAGE_RE = /must have required propert(?:y|ies) (.+)$/;

function parseRequiredMessageFields(message: string): string[] | undefined {
	const m = message.match(REQUIRED_MESSAGE_RE);
	if (!m) return undefined;
	const fields = m[1]!
		.split(",")
		.map((s) => s.trim())
		.filter((s) => /^[\w.\-/\[\]]+$/.test(s));
	return fields.length > 0 ? fields : undefined;
}

/**
 * required bullet 的路径位 = 父路径 + requiredProperties[0]（pi-ai formatValidationPath）。
 * 剥掉末尾首字段段得父路径前缀（"outer.inner" → "outer."；路径位即首字段 → ""），
 * 供 message 中每个缺失字段还原成全路径 token。形态意外（路径位不以首字段结尾）时
 * 退化为整段路径做前缀——token 仍确定性地区分不同缺失集合。
 */
function requiredBulletPrefix(bulletPath: string, firstField: string): string {
	if (bulletPath === firstField) return "";
	const suffix = `.${firstField}`;
	const base = bulletPath.endsWith(suffix) ? bulletPath.slice(0, -suffix.length) : bulletPath;
	return `${base}.`;
}

/**
 * AP（additionalProperties）错误行标记（大小写不敏感子串）。
 *
 * 覆盖两种实装形态：pi-ai 参数层 bullet "  - root: must not have additional
 * properties"（0.84.1 validation.js 探针核实）与日常模式 ajv "must NOT have
 * additional properties"（execute.ts instancePath 拼接形态）——两者大小写不同，
 * 子串取 "additional propert" 双形态通配。required/格式类错误 message 不含该子串。
 * 检测对象是剔除回显后的错误行块整体（而非逐 bullet 行）：ajv AP 行不是 bullet
 * 形态，逐行 bullet 检测会漏检导致该场景 keys 语义回退。
 */
const AP_ERROR_MARKER_RE = /additional propert/i;

/**
 * 从（已剔除实参回显的）错误文本提取字段/路径 token 集合——修复进展的坐标：
 * 修一个字段必然改变失败字段集合，而消息前缀可能纹丝不动（大 schema 下错误行
 * 按序排列，靠后字段的修复不进 500c 前缀——旧前缀方案的误杀根源）。
 *
 * 覆盖两种错误形态（pi 实装版核实的 errorMessage 结构）：
 *   - pi-ai 参数层 bullet 行（validation.js：`  - ${formatValidationPath(error)}: ${message}`）：
 *     enum/类型等错误的字段名在 bullet 路径位：`  - assessments.0.impact: must be string`。
 *     required 是例外（F1）——formatValidationPath 只把 requiredProperties[0] 放进
 *     路径位，其余缺失字段名只在 message（"must have required properties alpha, beta,
 *     gamma"）；本函数解析 message 把完整缺失列表并入 token，否则「修好非首字段」
 *     （列表收缩 = 真实进展）会因路径位不变被折叠成同签名、3 次误杀。
 *   - 日常模式 ajv instancePath（execute.ts 拼接 `${err.instancePath} ${err.message}`）：
 *     `Schema validation failed: /count must be number`
 *
 * 有意决策（披露）：token 集合只含字段/路径、不含错误类型——同一字段换约束试错
 * （"must be string" → "must be number"）折叠为同签名。权衡：换取「集合不变 = 无进展」
 * 的强判定；代价是弱模型对单字段多约束的试错容忍度下降（同字段反复错达阈值即闸门）。
 *
 * 同时报告错误行块是否含 AP 错误行（hasApError）——normalizeErrorSignature 据此
 * 门控 echo keys 并入（分桶动机见该函数注释）。
 *
 * 提取不到 token（非校验类错误文本，如 "structured-output call failed"/网络错误）
 * 返回空数组——调用方 fallback 到 SIGNATURE_MAX_CHARS 前缀。
 */
function extractErrorFieldTokens(errorLines: string): { tokens: string[]; hasApError: boolean } {
	const tokens = new Set<string>();
	// 形态 1：bullet 行（路径位 + message）；字符类覆盖点分路径/数组索引/斜杠
	const bulletLine = /(?:^|\n)[ \t]*-[ \t]+([\w.\-/\[\]]+):[ \t]*([^\n]+)/g;
	// 形态 2：行首/空白/分号后的 ajv instancePath（/a/b/c）——排除紧贴前字符的斜杠
	//（避免把 bullet 路径里的 a/b 拆出半截 token 与形态 1 重复）
	const slashPath = /(?:^|[\s;])\/([\w.\-/\[\]]+)/g;
	for (const m of errorLines.matchAll(bulletLine)) {
		const path = m[1]!;
		const requiredFields = parseRequiredMessageFields(m[2]!);
		if (!requiredFields) {
			tokens.add(path);
			continue;
		}
		for (const field of requiredFields) {
			tokens.add(`${requiredBulletPrefix(path, requiredFields[0]!)}${field}`);
		}
	}
	for (const m of errorLines.matchAll(slashPath)) {
		tokens.add(m[1]!);
	}
	return { tokens: [...tokens], hasApError: AP_ERROR_MARKER_RE.test(errorLines) };
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
 * 从原始错误消息的 "Received arguments:" 段提取实参顶层 keys 集合（AP 误杀修复）。
 *
 * 背景（D4）：additionalProperties:false 默认注入后，模型带多余字段时 pi-ai 0.84.1
 * validation.js 报 "  - root: must not have additional properties"——bullet 路径位
 * 恒为 "root"（根级非 required 错误不进 formatValidationPath 特判，本机探针核实），
 * 错误行块不含多余字段名，字段 token 恒同集合；而模型逐个删除多余字段是真实进展，
 * 仅凭错误行块会折叠成同签名、3 次 terminal 误杀。实参回显段是
 * JSON.stringify(toolCall.arguments, null, 2) 产物（validation.js 逐字核实），可
 * JSON.parse——顶层 keys 是结构信息：keys 集合缩小 = 模型在删字段 = 进展 → 并入
 * token 集合产生新签名。
 *
 * 与「剔除实参回显」既有语义的兼容区分（本意不变）：剔除回显的本意是「实参值变化
 * 不算进展」——keys 是结构不是值：值变化（keys 不变）不影响签名，既有语义保留；
 * keys 变化（结构变化）才产生新签名。回显段缺失 / JSON 解析失败 / 非 plain object
 * （null、数组、原始值）一律返回空数组（不贡献 token）——签名退化为仅错误行块口径
 * （如 steer 截断后的残缺回显、适配层改写过 errorMessage 的场景），不会比修复前更差。
 *
 * 调用方门控（并集恒定陷阱，见 normalizeErrorSignature 注释）：本函数结果仅在错误
 * 行块含 AP 错误行时以 key:<name> 前缀并入签名——required 渐进修复场景 keys 与缺失
 * 列表对流，无条件并入会使 token 并集恒定、签名恒定，3 次误杀（实测教训）。
 */
function parseArgsEchoTopLevelKeys(errorText: string, markerIdx: number): string[] {
	const echoSection = errorText.slice(markerIdx + ARGS_ECHO_MARKER.length).trim();
	if (!echoSection) return [];
	try {
		const parsed: unknown = JSON.parse(echoSection);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
		return Object.keys(parsed);
	} catch {
		return [];
	}
}

/**
 * 错误签名归一化（审查项#7：字段/路径 token 集合哈希；token 分桶版）：
 *   1. 剔除 "Received arguments:" 起的实参回显的「值」——值变化不等于进展（既有
 *      语义保留）。
 *   2. 提取字段/路径 token 集合，桶语义：
 *      - 常规桶（无前缀）：bullet 路径位 / required message 字段 / ajv instancePath
 *        （extractErrorFieldTokens 既有逻辑）——required/格式类错误行天然携带字段名，
 *        token 集合演化（含缩小）即进展坐标。
 *      - AP 桶（key:<name> 前缀）：仅当错误行块含 AP 错误行（hasApError）时，实参回显
 *        顶层 keys 并入——AP 错误行无字段名（路径位恒 root），keys 集合是唯一进展
 *        坐标（keys 缩小 = 删多余字段 = 进展）；前缀防 keys 与常规桶同名字段 token 混淆。
 *   3. 集合不变 = 同签名（无进展）；集合变化 = 新签名（渐进修复不再被折叠）。
 *   4. 提取失败（无任何 token）fallback 到 500c 前缀硬上限（既有行为）。
 *
 * 并集恒定陷阱（keys 分桶动机，第四轮实测误杀教训）：旧实现把 echo keys 无条件
 * 并入常规 token（无前缀）。required 渐进修复场景下，模型每轮修好 1 个字段时该字段
 * 从错误行的缺失列表「迁移」到实参回显 keys——缺失 token 集缩小恰好被 keys 集增大
 * 抵消，token 并集恒定 → 签名恒定 → 第 3 次同签名 terminal 误杀（6 required 字段
 * 每轮修 1 个的探针实测复现：三轮签名恒 fields(6)#…）。而对流只发生在 required 类
 * 错误（错误行携带字段名 + 实参同步增长）；AP 错误行无字段名、keys 是其唯一信号——
 * 故按「是否存在 AP 错误行」门控 keys 并入：required/格式场景 keys 退出签名（进展
 * 由错误行 token 独家刻画），AP 场景 keys 进 AP 桶（机制保留）。
 *
 * 归一化对任意错误文本安全（非校验类错误 / 回显段残缺均走 fallback 或退化口径）。
 */
export function normalizeErrorSignature(errorText: string): string {
	const markerIdx = errorText.indexOf(ARGS_ECHO_MARKER);
	const errorLines = (markerIdx >= 0 ? errorText.slice(0, markerIdx) : errorText).trim();
	const { tokens, hasApError } = extractErrorFieldTokens(errorLines);
	// echo keys 分桶门控（见上方并集恒定陷阱）：仅 AP 错误行存在时并入，带 key: 前缀
	if (hasApError && markerIdx >= 0) {
		for (const key of parseArgsEchoTopLevelKeys(errorText, markerIdx)) {
			tokens.push(`key:${key}`);
		}
	}
	const unique = [...new Set(tokens)];
	return unique.length > 0 ? fieldSetSignature(unique) : truncateSignature(errorLines);
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
		this.lastErrorText = truncateText(rawText, SIGNATURE_MAX_CHARS);
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
