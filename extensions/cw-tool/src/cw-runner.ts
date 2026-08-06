/**
 * cw action 执行核心：白名单校验 + 参数构造 + spawn + 输出解析。
 *
 * 与 Pi SDK 解耦（不 import pi 类型），纯逻辑 + 可注入 spawner，便于单测。
 * 所有错误路径返回 `{ ok: false, error }`，不抛异常（由调用方映射为 tool 返回）。
 */
import type { CwSpawner } from "./cw-spawn.ts";

/** cw 现状全部 action 名（透传 cw，不预映射未来 design 合并）。 */
export const CW_ACTIONS = [
	"create",
	"clarify",
	"plan",
	"design-review",
	"execute",
	"test",
	"exec-review",
	"retrospect",
	"closeout",
	"replan",
	"abort",
	"list",
	"tree",
	"status",
	"handoff",
	"frontier",
] as const;
export type CwAction = (typeof CW_ACTIONS)[number];

/** 只读 action（不推进状态机，query only）。 */
export const READONLY_ACTIONS = ["list", "tree", "status", "handoff", "frontier"] as const;

/** 透传给 cw 的可选参数（flags）。 */
export interface CwToolOptions {
	/** JSON 内容字符串，经 stdin 传给 cw（`cw --input -`）。与 inputFile 互斥。 */
	input?: string;
	/** input 文件路径，直接传 `--input <path>`。与 input 互斥。 */
	inputFile?: string;
	/** execute 关联的 commit（wave 层），传 `--commitHash`。 */
	commitHash?: string;
}

/** 工具返回的 details 结构（结构化成功/失败，调用方按 `ok` 区分）。 */
export type CwDetails =
	| { ok: true; action: string; unitId: string; stdout: string; parsed: true; data: unknown }
	| { ok: true; action: string; unitId: string; stdout: string; parsed: false }
	| { ok: false; action: string; unitId: string; error: string };

/**
 * 白名单校验。返回错误消息（string）或 undefined（放行）。
 *
 * 设计为 string-based，独立于 schema 枚举——schema 是 LLM 输入的第一道约束，
 * 此函数是 execute 内的防御性第二道（直接/程序化调用、宽松 provider 兜底），
 * 同时是单测的核心契约（直接调 executeCwAction 传任意 action 验证拦截）。
 */
export function rejectDisallowedAction(
	action: string,
	allowed: readonly string[],
	toolName: string,
): string | undefined {
	if (!allowed.includes(action)) {
		return `action "${action}" 不在 ${toolName} 白名单。允许的 action: ${allowed.join(", ")}`;
	}
	return undefined;
}

/** input / inputFile 互斥校验。 */
export function rejectConflictingInput(opts: CwToolOptions): string | undefined {
	if (opts.input !== undefined && opts.inputFile !== undefined) {
		return "'input' 和 'inputFile' 互斥，只能传其中一个。";
	}
	return undefined;
}

/**
 * 构建 cw 命令行参数（action 后接 flags）。
 *
 * - unitId 必传 → `--unitId <id>`
 * - input 内容 → `--input -`（经 stdin，见 executeCwAction）
 * - inputFile 路径 → `--input <path>`
 * - commitHash → `--commitHash <sha>`
 */
export function buildCwArgs(action: string, unitId: string, opts: CwToolOptions): string[] {
	const args: string[] = [action, "--unitId", unitId];

	if (opts.inputFile) {
		args.push("--input", opts.inputFile);
	} else if (opts.input !== undefined) {
		args.push("--input", "-");
	}

	if (opts.commitHash) {
		args.push("--commitHash", opts.commitHash);
	}

	return args;
}

/** 尝试把 stdout 解析为 JSON。成功返回解析值，失败返回 undefined。 */
function tryParseJson(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

/**
 * 执行 cw action 的核心逻辑：白名单校验 → 参数冲突校验 → spawn → 解析。
 *
 * 失败判定：非零退出码（含被信号终止的 null）或 stderr 非空 → ok:false（cw 错误信息走 stderr）。
 * 成功后 stdout 尝试 JSON.parse：成功 → parsed:true + data；失败 → parsed:false + 原样 stdout。
 *
 * @param action   调用方请求的 action（运行时再校验白名单）。
 * @param allowed  该工具允许的 action 白名单。
 * @param toolName 工具名（错误消息归属用）。
 * @param unitId   cw unit id（必传）。
 * @param opts     可选 flags。
 * @param spawner  spawn 实现（默认走真实 cw，测试注入 fake）。
 * @param cwd      子进程工作目录。
 */
export async function executeCwAction(
	action: string,
	allowed: readonly string[],
	toolName: string,
	unitId: string,
	opts: CwToolOptions,
	spawner: CwSpawner,
	cwd: string,
): Promise<CwDetails> {
	const base = { action, unitId };

	const actionErr = rejectDisallowedAction(action, allowed, toolName);
	if (actionErr) return { ok: false, ...base, error: actionErr };

	const inputErr = rejectConflictingInput(opts);
	if (inputErr) return { ok: false, ...base, error: inputErr };

	const args = buildCwArgs(action, unitId, opts);
	const stdinPayload = opts.input !== undefined ? opts.input : undefined;

	let result;
	try {
		result = await spawner(args, stdinPayload, cwd);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, ...base, error: `cw spawn 失败: ${msg}` };
	}

	const { stdout, stderr, exitCode } = result;

	// 非零退出码（含 null=被信号终止）或 stderr 非空 → 失败。
	if (exitCode !== 0 || stderr.trim().length > 0) {
		const parts: string[] = [];
		if (exitCode !== 0) parts.push(`exit code ${exitCode ?? "null"}`);
		if (stderr.trim()) parts.push(stderr.trim());
		return { ok: false, ...base, error: parts.join(" | ") };
	}

	const data = tryParseJson(stdout);
	if (data !== undefined) {
		return { ok: true, ...base, stdout, parsed: true, data };
	}
	return { ok: true, ...base, stdout, parsed: false };
}
