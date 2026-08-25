/**
 * 后台任务 spawn（D7/D10/D12/D15，设计文档 §3.5 后台任务生命周期数据流 ③④）。
 *
 * spawn 细节：detached（自成进程组，进程树 kill 的语义基础）+ stdio 直接落
 * <dataDir>/base-tool-enhance/<sessionId>/<task_id>.log（append fd，不占内存、
 * 无 pipe backpressure）+ child.unref()（pi 不等它）。abort/interrupt 不传播到
 * 后台任务（D15）——execute 立即返回，本模块不接触 signal。
 */

import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { getLogger } from "@zhushanwen/pi-extension-logger";

import { killProcessTree } from "../kill-tree.ts";
import { ensurePollerRunning } from "./poller.ts";
import { getRegistryPath, taskToRegistryEntry, writeRegistryEntry } from "./registry.ts";
import { countActiveTasks, markKillingIntent, oldestActiveTask, registerSpawnedTask } from "./task-store.ts";
import type { BackgroundTask } from "./types.ts";

/** task_id 随机段熵源字节数（crypto 大数采样，8 字节 = 64 bit）。 */
const TASK_ID_ENTROPY_BYTES = 8;
/** 秒 → 毫秒。 */
const MS_PER_SECOND = 1000;

const logger = getLogger("base-tool-enhance");

/**
 * 并发上限默认值（D10）。M4 配置接缝：maxConcurrentBackground 配置键注入后替换
 * 此常量的取值来源，函数签名不变。
 */
export const DEFAULT_MAX_CONCURRENT_BACKGROUND = 8;

/**
 * task_id 随机段长度（base36 小写）。6 字符 ≈ 31 bit 熵：同毫秒内数百次 spawn 的
 * 生日碰撞概率 ~1e-7（4 字符实测在 500 次内可撞——唯一性是 pending 差集前提，
 * §2.3，熵按此约束取值）。
 */
const TASK_ID_RAND_LENGTH = 6;
const TASK_ID_RADIX = 36;
const TASK_ID_RAND_SPACE = TASK_ID_RADIX ** TASK_ID_RAND_LENGTH;

/** 命令在错误文案中的展示长度上限。 */
const COMMAND_DISPLAY_LIMIT = 80;

/**
 * task_id 生成：`bt-<ts>-<rand>`（前缀 bt- 刻意区别于 subagent-workflow 的
 * bg-/run-，§2.3）。**禁止进程内自增序列**——pi 重启后撞旧 id 会破坏 pending
 * 差集前提（register 被幂等忽略 / 旧 unregister 误消新任务）。
 */
export function generateTaskId(now: number = Date.now()): string {
	return `bt-${now}-${randomRandSegment()}`;
}

/** 均匀 base36 随机段：crypto 随机大数取模，无 base64 字符集替换导致的采样偏置。 */
function randomRandSegment(): string {
	const value = randomBytes(TASK_ID_ENTROPY_BYTES).readBigUInt64BE() % BigInt(TASK_ID_RAND_SPACE);
	return value.toString(TASK_ID_RADIX).padStart(TASK_ID_RAND_LENGTH, "0");
}

/**
 * 后台显式 timeout 解析（秒）。M4 配置接缝：本函数只认 LLM 显式值；M4 的
 * backgroundTimeoutSeconds 配置默认注入发生在调用侧（bash-tool execute），
 * 本函数签名不变。
 * 无效值（非有限/≤0）沿用 pi 内置文案抛错。
 */
export function resolveBackgroundTimeoutSec(explicitSec: number | undefined): number | undefined {
	if (explicitSec === undefined) return undefined;
	if (!Number.isFinite(explicitSec) || explicitSec <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	return explicitSec;
}

export interface SpawnBackgroundOptions {
	command: string;
	/** execute ctx.cwd（权威 cwd） */
	cwd: string;
	/** pi getAgentDir() 同源 dataDir */
	dataDir: string;
	sessionId: string;
	/** LLM 显式 timeout（秒）；undefined = 不限时（M4 注入配置默认值） */
	timeoutSec?: number;
	/** 测试接缝：并发上限（生产走 DEFAULT_MAX_CONCURRENT_BACKGROUND）。 */
	maxConcurrent?: number;
}

export type SpawnBackgroundResult =
	| { ok: true; task: BackgroundTask }
	| { ok: false; error: string };

function shellForPlatform(): { shell: string; args: string[] } {
	if (process.platform === "win32") {
		return { shell: process.env.ComSpec || "cmd.exe", args: ["/c"] };
	}
	return { shell: process.env.SHELL || "/bin/sh", args: ["-c"] };
}

/**
 * 启动后台任务：并发检查 → spawn（输出重定向 .log）→ 单例表登记 + registry 写
 * running 条目 → 显式 timeout 定时器 → 启动轮询器。
 * 立即返回，不等待命令退出（turn 不被占用，G1）。
 */
export function spawnBackgroundTask(opts: SpawnBackgroundOptions): SpawnBackgroundResult {
	const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_BACKGROUND;
	if (countActiveTasks() >= maxConcurrent) {
		const oldest = oldestActiveTask();
		if (oldest !== undefined) {
			const cmd = truncateCommand(oldest.command);
			return {
				ok: false,
				error:
					`Background task limit reached (max ${maxConcurrent} concurrent). ` +
					`Oldest task: ${oldest.taskId} (${cmd}). ` +
					`Kill it with bash_kill {task_id:"${oldest.taskId}"} or wait for it to finish.`,
			};
		}
	}

	// cwd 校验对齐 pi 内置文案（bash.js createLocalBashOperations）
	try {
		accessOrThrow(opts.cwd);
	} catch {
		return {
			ok: false,
			error: `Working directory does not exist: ${opts.cwd}\nCannot execute bash commands.`,
		};
	}

	const taskId = generateTaskId();
	const registryPath = getRegistryPath(opts.dataDir, opts.sessionId);
	const outputFile = join(dirname(registryPath), `${taskId}.log`);
	mkdirSync(dirname(outputFile), { recursive: true });

	const { shell, args } = shellForPlatform();
	let outputFd: number | undefined;
	let child;
	try {
		outputFd = openSync(outputFile, "a");
		child = spawn(shell, [...args, opts.command], {
			cwd: opts.cwd,
			detached: true,
			stdio: ["ignore", outputFd, outputFd],
		});
		// 唯一的事件监听例外：no-op error listener 防 spawn 异步失败 emit error 无监听
		// 导致进程崩溃（EventEmitter 语义）。不做任何状态推进——exit 感知归轮询器（D17）。
		child.on("error", () => {});
		child.unref();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Failed to start background command: ${message}` };
	} finally {
		// 子进程已继承 fd 副本（含 spawn 同步失败路径：fd 未被子进程持有），父进程侧
		// 描述符统一在此关闭防句柄泄漏
		if (outputFd !== undefined) {
			try {
				closeSync(outputFd);
			} catch (err) {
				// 已关闭/不可关闭均不掩盖主流程，仅留诊断
				logger.debug("background spawn output fd close failed", {
					detail: { outputFile, err: err instanceof Error ? err.message : String(err) },
				});
			}
		}
	}

	if (child.pid === undefined) {
		return { ok: false, error: "Failed to start background command: no pid acquired" };
	}

	const task: BackgroundTask = {
		taskId,
		pid: child.pid,
		command: opts.command,
		outputFile,
		registryPath,
		startedAt: Date.now(),
		state: "running",
		ownerPiPid: process.pid,
		sessionId: opts.sessionId,
		child,
	};

	if (opts.timeoutSec !== undefined) {
		armBackgroundTimeout(task, opts.timeoutSec);
	}

	// 登记顺序：单例表（运行时权威）→ registry（持久化）→ 轮询器。
	// registry 写失败不阻断（条目停留 running 由 M5 reaper 兜底，§3.5）
	registerSpawnedTask(task);
	writeRegistryEntry(registryPath, taskToRegistryEntry(task));
	ensurePollerRunning();
	return { ok: true, task };
}

/**
 * 后台显式 timeout（D6：任务寿命可由使用者显式约束）。到点：kill-tree + 两侧标
 * killing intent（reason 候选 timeout）——实际终态由轮询器边沿收尾写（单一终态
 * 归属），此处不写终态。
 */
function armBackgroundTimeout(task: BackgroundTask, timeoutSec: number): void {
	const timer = setTimeout(() => {
		killProcessTree(task.pid);
		const marked = markKillingIntent(task.taskId, "timeout");
		if (marked === undefined) return;
		writeRegistryEntry(marked.registryPath, taskToRegistryEntry(marked));
		ensurePollerRunning();
	}, timeoutSec * MS_PER_SECOND);
	timer.unref?.();
	task.timeoutTimer = timer;
}

function accessOrThrow(cwd: string): void {
	// 独立小函数：保持与内置 fsAccess(constants.F_OK) 语义一致的同步版本
	accessSync(cwd, constants.F_OK);
}

export function truncateCommand(command: string): string {
	return command.length > COMMAND_DISPLAY_LIMIT
		? `${command.slice(0, COMMAND_DISPLAY_LIMIT)}…`
		: command;
}
