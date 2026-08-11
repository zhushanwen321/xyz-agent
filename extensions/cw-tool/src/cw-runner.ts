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

/**
 * 判断 action 是否为只读（属于 {@link READONLY_ACTIONS}）。
 *
 * 只读 action 的两个边界复用此判定（S-3/S-5）：
 * - 不附加 `--workspace`（保守避免 cw 子命令拒收未知选项导致 readonly 查询失败，S-3）；
 * - 不强制 unitId（list/tree/frontier 等全局查询不需要具体 unit，S-5）。
 *
 * 用 `.some(===)` 而非 `.includes()` 以保持 string 入参的类型安全（readonly tuple 的
 * `.includes()` 要求字面量联合类型，传 string 会报错，无需 `as` 宽化）。
 */
export function isReadonlyAction(action: string): boolean {
	return READONLY_ACTIONS.some((a) => a === action);
}

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
	| { ok: true; action: string; unitId: string | undefined; stdout: string; parsed: true; data: unknown }
	| { ok: true; action: string; unitId: string | undefined; stdout: string; parsed: false }
	| { ok: false; action: string; unitId: string | undefined; error: string };

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
 * 探测 cwd 所属 repo 的主目录（repo 级 workspace），供老 cw-cli（<1.6.2，无 store 归一化）兜底。
 *
 * 用 `git rev-parse --path-format=absolute --git-common-dir` 取 git common dir：
 * 同一 repo 的所有 worktree 返回相同路径，dirname 即 repo 主目录。cw store 键控
 * 从 per-cwd 升级为 repo 级（cw-cli ADR-0014）后，spawn cw 时附带 --workspace 让 cw
 * 在 repo 主目录解析/共享状态，避免同一 repo 的 worktree 间状态各自为政。
 *
 * **bare repo + worktree 模式（.bare）**：common-dir basename 是 `.bare` 而非 `.git`，
 * dirname 指向 workspace 容器根（非 git 目录）——传给 cw 会让它 fallback 到错误的 store-key
 * （unit not found）。检测到 basename 非 `.git` 时返回 undefined（不传 --workspace），让老 cw-cli
 * 退回 per-cwd store（读写一致但无 repo 级共享）。新 cw-cli（≥1.6.2）自己归一化，门控支持→不调本函数。
 * 不可用 `--is-bare-repository` 判据——worktree 内它永远返回 false（bare 是 .bare 目录本身）。
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
		// bare repo worktree 模式：common-dir basename 是 .bare（非 .git），dirname 指向容器根（非 git 目录）。
		// 传该值给 cw 会导致 store-key fallback 错误 → unit not found。返回 undefined 退回 per-cwd（读写一致）。
		if (path.basename(gitCommonDir) !== ".git") return undefined;
		return path.dirname(gitCommonDir);
	} catch {
		return undefined;
	}
}

/**
 * cw-cli 支持 store 内部归一化的最低版本（门控阈值）。
 *
 * cw-tool 与 cw-cli 是两个独立 npm 包（cw-tool 经 PATH 裸调 cw、零依赖声明），
 * 两包独立升级。cw-tool 退回纯封装前需探测 cw-cli 是否已落地 store 归一化
 * （cw-cli commit a90e8e8 / 首个 tag v1.6.2：getCwJsonPath 改用 detectCommonDir 归一化
 * 到 git-common-dir），支持则不传 --workspace（纯封装），不支持则兜底 cw-cli ADR-0014
 * 的 detectRepoWorkspace + --workspace。
 *
 * 门控激活（1.6.2）：cw-cli ≥1.6.2 自我用 detectCommonDir 归一化 store-key，同一 repo 的
 * 所有 worktree（含 bare repo）共享 store，cw-tool 无需传 --workspace。旧值 "99.0.0"（placeholder）
 * 使门控永远判定「不支持」→ 永远走兜底，在 bare repo worktree 下 detectRepoWorkspace 返回容器根
 * → cw 定位到不存在的 store → unit not found。
 */
const MIN_CW_CLI_VERSION_FOR_NORMALIZATION = "1.6.2";

/** probe 超时（ms）：cw --version 卡死时 fail-safe 为「不支持」。 */
const CW_VERSION_PROBE_TIMEOUT_MS = 5000;

/** 版本 parse 失败时 reason 截断长度（避免 stdout 过长污染日志）。 */
const VERSION_REASON_MAX_LEN = 60;

/** cw-cli 能力探测结果。 */
export interface CwCliCapability {
	/** true = cw-cli 支持 store 内部归一化（cw-tool 应纯封装，不传 --workspace）。 */
	supported: boolean;
	/** parse 到的 cw 版本号（如 "1.6.1"），parse 失败 = undefined。 */
	version: string | undefined;
	/** 不支持/失败的简要原因（日志/调试用）。 */
	reason?: string;
}

/**
 * 进程内 memoize 缓存：全局单值（cw --version 输出与 cwd 无关，cw-cli 安装版本在进程
 * 生命周期内不变，按 cwd 做 key 多余）。首次探测后整个进程复用；测试用
 * {@link _resetCapabilityCacheForTest} 在 beforeEach 隔离。
 */
let cachedCapability: CwCliCapability | undefined;

/** 测试用：重置 capability 缓存（全局单值，测试 beforeEach 隔离避免串台）。 */
export function _resetCapabilityCacheForTest(): void {
	cachedCapability = undefined;
}

/** 从 cw --version stdout 提取版本号（如 "cw 1.6.1" → [1,6,1]）。失败返回 undefined。 */
function parseCwVersion(stdout: string): number[] | undefined {
	const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) return undefined;
	return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)];
}

/** semver 三段比较：a < b → -1，a === b → 0，a > b → 1。 */
function compareSemver(a: number[], b: number[]): number {
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
	}
	return 0;
}

/**
 * 探测 cw-cli 是否支持 store 内部归一化（门控）。
 *
 * 用 spawner 跑 `cw --version`，parse 版本号与 {@link MIN_CW_CLI_VERSION_FOR_NORMALIZATION}
 * 比较。失败（spawn 失败/parse 不到/超时）→ supported:false（fail-safe，兜底 cw-cli ADR-0014 行为）。
 * 进程内 memoize（全局单值，cw 版本 cwd 无关）：首次探测后缓存，消除重复 spawn。
 *
 * @param parentSignal 调用方 SDK abort signal，与内部 5s 超时合并转发给 spawner（S-4）：
 *   任一 abort 即 abort，让卡死的 `cw --version` 尽快收尾。
 */
export async function probeCwCliNormalization(
	spawner: CwSpawner,
	cwd: string,
	parentSignal?: AbortSignal,
): Promise<CwCliCapability> {
	if (cachedCapability) return cachedCapability;

	const minVersion = parseCwVersion(MIN_CW_CLI_VERSION_FOR_NORMALIZATION);
	if (!minVersion) {
		// MIN_CW_CLI_VERSION_FOR_NORMALIZATION 本身非法（不应发生）——保守不支持
		const fallback: CwCliCapability = { supported: false, version: undefined, reason: "MIN_CW_CLI_VERSION_FOR_NORMALIZATION 非法" };
		cachedCapability = fallback;
		return fallback;
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CW_VERSION_PROBE_TIMEOUT_MS);
	// 合并调用方 SDK signal：任一 abort（5s 超时 fail-safe 或调用方主动 abort）即 abort（S-4）。
	const onParentAbort = (): void => controller.abort();
	if (parentSignal) {
		if (parentSignal.aborted) controller.abort();
		else parentSignal.addEventListener("abort", onParentAbort, { once: true });
	}
	let result: CwCliCapability;
	try {
		const spawnResult = await spawner(["--version"], undefined, cwd, controller.signal);
		if (spawnResult.exitCode !== 0) {
			result = { supported: false, version: undefined, reason: `cw --version exit ${spawnResult.exitCode ?? "null"}` };
		} else {
			const v = parseCwVersion(spawnResult.stdout);
			if (!v) {
				result = { supported: false, version: undefined, reason: `version parse fail: ${spawnResult.stdout.trim().slice(0, VERSION_REASON_MAX_LEN)}` };
			} else {
				const supported = compareSemver(v, minVersion) >= 0;
				result = { supported, version: v.join("."), reason: supported ? undefined : `version ${v.join(".")} < ${MIN_CW_CLI_VERSION_FOR_NORMALIZATION}` };
			}
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		result = { supported: false, version: undefined, reason: `probe failed: ${msg}` };
	} finally {
		clearTimeout(timer);
		if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
	}

	cachedCapability = result;
	return result;
}

/** input / inputFile 互斥校验。 */
export function rejectConflictingInput(opts: CwToolOptions): string | undefined {
	if (opts.input !== undefined && opts.inputFile !== undefined) {
		return "'input' 和 'inputFile' 互斥，只能传其中一个。";
	}
	return undefined;
}

/**
 * unitId 缺失校验（S-5）。写 action 缺 unitId → 返回错误消息；只读 action 或已传 unitId → undefined（放行）。
 *
 * schema 已把 unitId 改为 Optional（只读 action 不需要），此函数是写 action 的运行时第二道约束
 * （直接/程序化调用、宽松 provider 兜底），与 rejectDisallowedAction / rejectConflictingInput 同族。
 */
export function rejectMissingUnitId(action: string, unitId: string | undefined): string | undefined {
	if (unitId === undefined && !isReadonlyAction(action)) {
		return `action "${action}" 需要 unitId（只读 action ${READONLY_ACTIONS.join("/")} 可省略）`;
	}
	return undefined;
}

/**
 * 构建 cw 命令行参数（action 后接 flags）。
 *
 * - unitId（若提供）→ `--unitId <id>`；undefined 则省略（只读 action 不需要，S-5）
 * - input 内容 → `--input -`（经 stdin，见 executeCwAction）
 * - inputFile 路径 → `--input <path>`
 * - commitHash → `--commitHash <sha>`
 * - workspace（repo 主目录，由调用方经 detectRepoWorkspace 探测）→ `--workspace <path>`，位于 --commitHash 之后
 */
export function buildCwArgs(
	action: string,
	unitId: string | undefined,
	opts: CwToolOptions,
	workspace?: string,
): string[] {
	const args: string[] = [action];
	if (unitId !== undefined) {
		args.push("--unitId", unitId);
	}

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
 * 失败判定：非零退出码（含被信号终止的 null）→ ok:false（stderr 折进错误消息；S-2 按 exitCode 判定）。
 * 成功后 stdout 尝试 JSON.parse：成功 → parsed:true + data；失败 → parsed:false + 原样 stdout。
 *
 * @param action   调用方请求的 action（运行时再校验白名单）。
 * @param allowed  该工具允许的 action 白名单。
 * @param toolName 工具名（错误消息归属用）。
 * @param unitId   cw unit id（写 action 必传；只读 action 可省略，见 rejectMissingUnitId）。
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
	unitId: string | undefined,
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

	// unitId 运行时校验（S-5）：写 action 缺 unitId → 清晰错误（schema 已把 unitId 改 Optional）。
	const unitIdErr = rejectMissingUnitId(action, unitId);
	if (unitIdErr) return { ok: false, ...base, error: unitIdErr };

	// workspace 门控（cw-cli ADR-0014 store-workspace decoupling）：cw-cli 支持 store 内部归一化
	// （probe 版本 >= MIN_CW_CLI_VERSION_FOR_NORMALIZATION）→ 纯封装不传 --workspace；
	// 不支持 → 兜底 cw-cli ADR-0014 的 detectRepoWorkspace + --workspace（保持向后兼容）。
	// 只读 action 始终不传（S-3：保守避免 cw 子命令拒收未知选项导致 readonly 查询失败）。
	let workspace: string | undefined;
	// 降级标记：老 cw-cli（不支持归一化）+ bare repo / 非 git（detectRepoWorkspace 返回 undefined）。
	// 写动作若失败，错误消息追加升级指引（准则 6：错误指向恢复动作）。
	let degradedNoWorkspace = false;
	if (isReadonlyAction(action)) {
		workspace = undefined;
	} else {
		const capability = await probeCwCliNormalization(spawner, cwd, signal);
		if (capability.supported) {
			workspace = undefined;
		} else {
			workspace = detectRepoWorkspace(cwd);
			degradedNoWorkspace = workspace === undefined;
		}
	}
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

	// S-2：按 exitCode 判定失败（防御性，不依赖 cw 是否向 stderr 写非错误诊断信息）。
	// 非零退出码（含 null=被信号终止）→ 失败；stderr 折进错误消息（成功时 stderr 不导致失败）。
	if (exitCode !== 0) {
		const parts: string[] = [`exit code ${exitCode ?? "null"}`];
		if (stderr.trim()) parts.push(stderr.trim());
		let error = parts.join(" | ");
		// 老 cw-cli（<1.6.2）+ 探测不到 repo 级 workspace（非 git 目录 / bare repo worktree /
		// git 不可用）：写动作退回 per-cwd store（读写一致但无 repo 级共享），多数情况能跑通；
		// 若仍失败，追加升级指引帮用户切到归一化 cw-cli（准则 6：错误指向恢复动作）。
		// 措辞同时覆盖两种降级原因（非 git 场景不误导为 bare repo 问题）。
		if (degradedNoWorkspace) {
			error += "\n👉 cw-cli 版本过低（<1.6.2 不支持 store-key 归一化），且当前目录未探测到 repo 级 workspace（非 git 目录 / bare repo worktree / git 不可用），写动作退回 per-cwd store（读写一致但无 repo 级共享）。建议升级：npm i -g @zhushanwen/coding-workflow@latest";
		}
		return { ok: false, ...base, error };
	}

	const data = tryParseJson(stdout);
	if (data !== undefined) {
		return { ok: true, ...base, stdout, parsed: true, data };
	}
	return { ok: true, ...base, stdout, parsed: false };
}
