/**
 * 自实现进程树 kill 与 pid 判活（设计文档 §3.5 bash_kill）。
 *
 * 为什么不用 pi 的 killProcessTree：它未从主入口导出（pi package.json exports 仅
 * `.`/`./rpc-entry`/`./client`，定义在 dist/utils/shell.d.ts 但子路径不暴露），不可
 * import。分支语义与 pi 实装对齐：Windows `taskkill /F /T`、POSIX 杀进程组
 * `kill -- -<pgid>`（本包后台任务 detached spawn 自成进程组，pgid = pid）；进程组
 * 杀不到时回退单 pid + `pgrep -P` 递归杀残留子进程。
 */

import { spawnSync } from "node:child_process";

import { getLogger } from "@zhushanwen/pi-extension-logger";

const logger = getLogger("base-tool-enhance");

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
