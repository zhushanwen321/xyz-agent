/**
 * 自实现进程树 kill 与 pid 判活/身份判据（设计文档 §3.5 bash_kill）。
 *
 * 为什么不用 pi 的 killProcessTree：它未从主入口导出（pi package.json exports 仅
 * `.`/`./rpc-entry`/`./client`，定义在 dist/utils/shell.d.ts 但子路径不暴露），不可
 * import。分支语义与 pi 实装对齐：Windows `taskkill /F /T`、POSIX 杀进程组
 * `kill -- -<pgid>`（本包后台任务 detached spawn 自成进程组，pgid = pid）；进程组
 * 杀不到时回退单 pid + `pgrep -P` 递归杀残留子进程。
 *
 * pid 身份判据（getProcessStartTimeSec / pidStartMatchesRegistered）：原定义于
 * reaper.ts，孤儿收殓下沉 runtime 后随 reaper.ts 删除平移至此（u-bte-remove）
 * ——消费方是 bash_kill 前校验与后台 timeout 到点校验（进程内自防御，与收殓无关）。
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";

import { getLogger } from "@zhushanwen/pi-extension-logger";

const logger = getLogger("base-tool-enhance");

/** ps 调用超时：卡死的 ps 不拖垮调用方（超时按取不到处理 → 保守跳过）。 */
const PS_TIMEOUT_MS = 5000;
/** 毫秒 → 秒（epoch 秒换算，spawn-background.ts 同名常量先例）。 */
const MS_PER_SECOND = 1000;

/**
 * pid 判活：kill(pid, 0) 不发信号只做权限校验。
 * ESRCH = 已死（含 libuv 自动 reap 后）；EPERM = 进程存在但属其他用户，仍视为活。
 */
export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * 杀整棵进程树（同步；收殓路径在 process.on("exit") 里跑，必须同步）。
 * 幂等：目标已死时静默成功。
 */
export function killProcessTree(pid: number): void {
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (process.platform === "win32") {
		killProcessTreeWindows(pid);
		return;
	}
	// POSIX：detached spawn 自成进程组（pgid = pid），杀进程组一次性覆盖全部子孙
	try {
		process.kill(-pid, "SIGKILL");
		return;
	} catch (err) {
		logger.debug("process group kill missed, falling back to single pid + descendants", {
			detail: { pid, err: err instanceof Error ? err.message : String(err) },
		});
	}
	// 回退：组长已死（进程组不复存在）时单杀 pid + pgrep -P 递归清理残留子进程
	try {
		process.kill(pid, "SIGKILL");
	} catch (err) {
		// 目标已死：kill 幂等语义，仅留诊断
		logger.debug("single pid kill missed (already dead?)", {
			detail: { pid, err: err instanceof Error ? err.message : String(err) },
		});
	}
	killDescendantsRecursive(pid);
}

function killProcessTreeWindows(pid: number): void {
	try {
		const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
			stdio: "ignore",
			windowsHide: true,
		});
		if (result.error) throw result.error;
	} catch (err) {
		logger.debug("taskkill failed", {
			detail: { pid, err: err instanceof Error ? err.message : String(err) },
		});
	}
}

/** pgrep -P 递归：先杀孙辈再杀子辈（防孙辈在父死后被 reparent 逃逸枚举）。 */
function killDescendantsRecursive(pid: number): void {
	let stdout: string;
	try {
		const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
		if (result.error || result.status !== 0 || !result.stdout) return;
		stdout = result.stdout;
	} catch {
		return;
	}
	for (const line of stdout.split("\n")) {
		const childPid = Number.parseInt(line.trim(), 10);
		if (Number.isInteger(childPid) && childPid > 0) {
			killDescendantsRecursive(childPid);
			try {
				process.kill(childPid, "SIGKILL");
			} catch (err) {
				// 已死：kill 幂等语义，仅留诊断
				logger.debug("descendant kill missed (already dead?)", {
					detail: { pid: childPid, err: err instanceof Error ? err.message : String(err) },
				});
			}
		}
	}
}

/**
 * 取进程 start time（epoch 秒）。ps -o lstart= 跨 macOS/Linux（Linux /proc/
 * <pid>/stat 精度更高但 macOS 无 /proc，统一 ps 保跨平台一致）；= 号去表头。
 * 返回 undefined：进程不存在 / ps 不可用 / 输出不可解析——调用方一律按
 * 「无法校验 → 保守跳过」处理。
 */
export function getProcessStartTimeSec(pid: number): number | undefined {
	let result: SpawnSyncReturns<string>;
	try {
		result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: PS_TIMEOUT_MS,
		});
	} catch {
		return undefined;
	}
	if (result.error || result.status !== 0 || !result.stdout) return undefined;
	// lstart 形如 "Mon Aug 25 14:23:45 2026"（本地时区），Date.parse 按本地时区解释
	const ms = Date.parse(result.stdout.trim());
	return Number.isNaN(ms) ? undefined : Math.floor(ms / MS_PER_SECOND);
}

/**
 * pid 身份判据（§3.6「宁不杀勿误杀」的唯一定义点；原 reaper.ts 单点定义，收殓
 * 下沉后由进程内自防御消费——bash_kill kill 前校验与 background timeout 到点
 * kill 校验共用）。true = 当前占用该 pid 的进程 start time 与登记值匹配，可安全
 * kill。
 *  - 有登记 start time（spawn 时 ps 读取成功）→ 精确比较（同单位 epoch 秒）
 *  - 缺登记 start time（M3 前登记的存量条目 / ps 不可用平台）→ startedAtMs 秒级
 *    降级：登记发生在 spawn 之后（进程先启动、条目后登记），原进程 start time
 *    必然 ≤ floor(startedAtMs/1000)
 */
export function pidStartMatchesRegistered(
	actualStartSec: number,
	registeredStartSec: number | undefined,
	startedAtMs: number,
): boolean {
	return registeredStartSec !== undefined
		? actualStartSec === registeredStartSec
		: actualStartSec <= Math.floor(startedAtMs / MS_PER_SECOND);
}
