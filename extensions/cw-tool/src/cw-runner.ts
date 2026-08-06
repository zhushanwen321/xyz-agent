/**
 * cw action 执行核心：白名单校验 + 参数构造 + spawn + 输出解析。
 *
 * 与 Pi SDK 解耦（不 import pi 类型），纯逻辑 + 可注入 spawner，便于单测。
 * 所有错误路径返回 `{ ok: false, error }`，不抛异常（由调用方映射为 tool 返回）。
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import type { CwSpawner } from "./cw-spawn.ts";

/** cw 全部 action 名（E1 后：clarify 已删、plan→design）。透传 cw，与 cw-cli ALL_ACTIONS 对齐。 */
export const CW_ACTIONS = [
	"create",
	"design",
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

/** git 探测超时（ms）：git 卡死时避免阻塞 agent turn。 */
const GIT_PROBE_TIMEOUT_MS = 5000;

/**
 * 探测 cwd 所属 repo 的主目录（repo 级 workspace）。
 *
 * 用 `git rev-parse --path-format=absolute --git-common-dir` 取 git common dir：
 * 同一 repo 的所有 worktree 返回相同路径，dirname 即 repo 主目录。cw store 键控
 * 从 per-cwd 升级为 repo 级（ADR-0045）后，spawn cw 时附带 --workspace 让 cw
 * 在 repo 主目录解析/共享状态，避免同一 repo 的 worktree 间状态各自为政。
 *
 * 任何失败（非 git 目录、git 不在 PATH、路径不存在、超时）→ undefined（不抛）。
 */
export function detectRepoWorkspace(cwd: string): string | undefined {
	try {
		const result = spawnSync(
			"git",
			["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
			{ encoding: "utf8", timeout: GIT_PROBE_TIMEOUT_MS },
		);
		if (result.status !== 0) return undefined;
		const gitCommonDir = result.stdout.trim();
		if (gitCommonDir.length === 0) return undefined;
		return path.dirname(gitCommonDir);
	} catch {
		return undefined;
	}
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
 * - workspace（repo 主目录，由调用方经 detectRepoWorkspace 探测）→ `--workspace <path>`，位于 --commitHash 之后
 */
export function buildCwArgs(
	action: string,
	unitId: string,
	opts: CwToolOptions,
	workspace?: string,
): string[] {
	const args: string[] = [action, "--unitId", unitId];

	if (opts.inputFile) {
		args.push("--input", opts.inputFile);
	} else if (opts.input !== undefined) {
		args.push("--input", "-");
	}

	if (opts.commitHash) {
		args.push("--commitHash", opts.commitHash);
	}

	if (workspace) {
		args.push("--workspace", workspace);
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

/** cw spawn 默认超时（5 分钟）。cw 卡死时避免永久挂起 agent turn。 */
const DEFAULT_CW_TIMEOUT_MS = 300_000;

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
 * @param spawner   spawn 实现（默认走真实 cw，测试注入 fake）。
 * @param cwd       子进程工作目录。
 * @param signal    可选 SDK abort signal；与超时合并后透传给 spawner，abort 时 spawner kill 子进程。
 * @param timeoutMs spawn 超时（ms），默认 5 分钟；0 表示不限时。超时返回 ok:false "cw 超时"。
 */
export async function executeCwAction(
	action: string,
	allowed: readonly string[],
	toolName: string,
	unitId: string,
	opts: CwToolOptions,
	spawner: CwSpawner,
	cwd: string,
	signal?: AbortSignal,
	timeoutMs: number = DEFAULT_CW_TIMEOUT_MS,
): Promise<CwDetails> {
	const base = { action, unitId };

	const actionErr = rejectDisallowedAction(action, allowed, toolName);
	if (actionErr) return { ok: false, ...base, error: actionErr };

	const inputErr = rejectConflictingInput(opts);
	if (inputErr) return { ok: false, ...base, error: inputErr };

	// repo 级 workspace（ADR-0045）：cwd 在 git repo 内则附加 --workspace <repo 主目录>，
	// 让 cw 跨 worktree 共享状态；探测失败（非 git 目录等）静默跳过。
	const workspace = detectRepoWorkspace(cwd);
	const args = buildCwArgs(action, unitId, opts, workspace);
	const stdinPayload = opts.input !== undefined ? opts.input : undefined;

	// 合并 SDK abort signal 与超时为单个 signal 传给 spawner：spawner（默认实现）在 abort
	// 时 kill 子进程，避免 abort/超时后僵尸 cw 继续推进状态机。
	const combined = new AbortController();
	let timedOut = false;
	const onSdkAbort = (): void => combined.abort();
	if (signal) {
		if (signal.aborted) combined.abort();
		else signal.addEventListener("abort", onSdkAbort, { once: true });
	}
	const timer =
		timeoutMs > 0
			? setTimeout(() => {
					timedOut = true;
					combined.abort();
				}, timeoutMs)
			: undefined;

	let result;
	try {
		result = await spawner(args, stdinPayload, cwd, combined.signal);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, ...base, error: `cw spawn 失败: ${msg}` };
	} finally {
		if (timer) clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", onSdkAbort);
	}

	// 超时优先于结果判定（spawner 被 kill 后 resolve，exitCode 通常为 null）。
	if (timedOut) return { ok: false, ...base, error: "cw 超时" };

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
