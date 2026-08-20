// src/file-lock.ts
//
// 跨进程异步文件锁（extension 侧共享 util，D5a/D1e，integrity-hardening.md §3.5）。
//
// 为什么存在：worktrees.json（多 pi 进程各一份扩展实例写）与 ext-config 家族
// （runtime + 扩展双写）都是跨进程 RMW——Node 单线程只能保证进程内不交错，
// 挡不住跨进程「后写者基于旧快照覆盖先写者」。
//
// 为什么是 async API 而非 runtime 侧的 withFileLockSync：扩展跑在 pi 子进程的
// async hook 上下文（session_start 等），同步 busy-wait 会阻塞整个 event loop；
// proper-lockfile 的 async lock() 原生支持 retries 指数退避（sync API 与 retries
// 组合抛 ESYNC），不需要 runtime 侧那套自实现 busy-wait。
//
// 锁协议（与 runtime 侧 packages/runtime/src/utils/file-lock.ts 对齐，登记表
// docs/architecture/data-source-registry.md §6）：
//   - lockfile 路径 = <目标文件>.lock（proper-lockfile 默认，双方路径一致才互斥）
//   - realpath:false —— 目标文件不存在也可锁（realpath 默认 true 时 ENOENT），
//     与 runtime 侧参数一致；锁前确保父目录存在
//   - stale 30s：持锁进程崩溃后锁可被夺取（对齐 auth 惯例）
//   - async 版 retries 指数退避：10 次 / factor 2 / 100ms~10s / randomize（对齐 pi
//     FileAuthStorageBackend.withLockAsync，见 runtime auth-storage.ts:48-74 范本）
//   - sync 版 busy-wait 重试（25ms / 预算 1s fail-fast）：对齐 runtime 侧
//     withFileLockSync——proper-lockfile 的 sync API 与 retries 组合抛 ESYNC，
//     重试必须在外层同步循环做；ext-config 家族的扩展侧写方（saveConfig）
//     保持 sync 签名（调用链零波及），与 runtime 对端用同一把 lockfile 互斥
//   - onCompromised：锁被判定 stale 夺取时标记，fn 执行前抛错——防止在失去
//     互斥保证的锁下写盘（对齐 pi throwIfCompromised 语义）
//
// 契约：fn 内禁止任何 await / 再次对本文件加锁（嵌套取锁 ELOCKED → 重试耗尽 →
// 抛错）；持锁范围应为「读文件 + 纯内存变更 + 原子写」，毫秒级。

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import lockfile from "proper-lockfile";

/** 锁参数（默认值对齐 auth-storage.ts 范本；测试可覆盖以缩短等待）。 */
export interface FileLockOptions {
	/** 锁 mtime 超过该值视为持锁者已死可夺取（stale 语义）。默认 30_000ms。 */
	staleMs?: number;
	/** retries 总次数。默认 10。 */
	retries?: number;
}

/** sync 版锁参数（对齐 runtime withFileLockSync 默认值；测试可覆盖以缩短等待）。 */
export interface SyncFileLockOptions {
	/** 锁 mtime 超过该值视为持锁者已死可夺取（stale 语义）。默认 30_000ms。 */
	staleMs?: number;
	/** ELOCKED 重试间隔（同步 sleep）。默认 25ms。 */
	retryDelayMs?: number;
	/** ELOCKED 重试总预算，耗尽 fail-fast。默认 1_000ms。 */
	retryBudgetMs?: number;
}

// 默认锁参数（sync 版导出供对照测试断言与 runtime 侧 utils/file-lock.ts 默认值相等
// ——两侧参数漂移会破坏「同一把锁」的互斥语义；runtime 侧 test/file-lock-parity.test.ts）
export const DEFAULT_STALE_MS = 30_000;
const DEFAULT_RETRIES = 10;
export const DEFAULT_RETRY_DELAY_MS = 25;
export const DEFAULT_RETRY_BUDGET_MS = 1_000;

/**
 * 跨进程文件锁内执行 async fn：拿不到锁时指数退避重试（100ms~10s/randomize），
 * 重试耗尽抛 proper-lockfile 的 ELOCKED 错误（调用方决定降级路径）；
 * unlock 放 finally（fn 抛错也释放，compromised 时 unlock 失败可忽略）。
 */
export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	opts?: FileLockOptions,
): Promise<T> {
	// 锁前确保父目录存在：proper-lockfile 创建 lockfile（<目标>.lock）需要目录在
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	// onCompromised：锁被 stale 夺取（进程卡死超时等）时标记，fn 执行前抛错，
	// 防止在失去互斥保证的锁下写盘（对齐 pi throwIfCompromised）。
	let compromised: Error | undefined;
	const release = await lockfile.lock(filePath, {
		realpath: false,
		retries: {
			retries: opts?.retries ?? DEFAULT_RETRIES,
			factor: 2,
			minTimeout: 100,
			maxTimeout: 10_000,
			randomize: true,
		},
		stale: opts?.staleMs ?? DEFAULT_STALE_MS,
		onCompromised: (err: Error) => {
			compromised = err;
		},
	});
	try {
		if (compromised) throw compromised;
		return await fn();
	} finally {
		try {
			await release();
		} catch (unlockErr) {
			// 锁已 compromised（被 stale 夺取）时 unlock 必然失败且可忽略——
			// 记录留痕（对齐 pi finally 的 catch 语义：不外抛、不静默）。
			console.debug(
				"[file-lock] unlock failed after compromise (ignorable):",
				unlockErr instanceof Error ? unlockErr.message : String(unlockErr),
			);
		}
	}
}

/**
 * 同步跨进程文件锁内执行 fn：lockSync(realpath:false) + ELOCKED busy-wait 重试，
 * 预算耗尽抛带 ELOCKED code 的错误；unlock 放 finally（fn 抛错也释放）。
 *
 * 与 async 版锁同一把 lockfile（<目标文件>.lock）——sync/async API 在磁盘上
 * 是同一协议，互斥不依赖调用形态。适用场景：调用链必须保持 sync 签名
 * （如 llm-shared saveConfig，permission/rename-session 的命令回调零波及）。
 * sleep 用 Atomics.wait（真 sleep 不烧 CPU，对齐 runtime 侧实现）。
 */
export function withFileLockSync<T>(
	filePath: string,
	fn: () => T,
	opts?: SyncFileLockOptions,
): T {
	const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;
	const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	const retryBudgetMs = opts?.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS;

	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const deadline = Date.now() + retryBudgetMs;
	let release: (() => void) | undefined;
	while (release === undefined) {
		try {
			release = lockfile.lockSync(filePath, { realpath: false, stale: staleMs });
		} catch (err) {
			if (!isElocked(err)) throw err;
			if (Date.now() >= deadline) {
				throw Object.assign(
					new Error(
						`[file-lock] ${filePath} 写锁获取失败：ELOCKED 重试预算 ${retryBudgetMs}ms 耗尽` +
						`（持锁方临界区异常或已崩溃，stale ${staleMs}ms 后可夺取）。恢复指引：稍后重试本次写入。`,
						// cause 挂原始 ELOCKED 错误，保留 proper-lockfile 诊断信息
						{ cause: err },
					),
					{ code: "ELOCKED" },
				);
			}
			sleepSync(retryDelayMs);
		}
	}
	try {
		return fn();
	} finally {
		release();
	}
}

function isElocked(err: unknown): boolean {
	// in 收窄而非 as 断言（extensions taste/no-unsafe-catch：全可选属性断言 = 无校验）
	return err instanceof Error && "code" in err && err.code === "ELOCKED";
}

/** Atomics.wait 需要一个共享内存对象作等待目标；4 字节 = 一个 Int32 元素，仅占位不被写入。 */
const SLEEP_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function sleepSync(ms: number): void {
	Atomics.wait(SLEEP_WAIT_BUFFER, 0, 0, ms);
}
