/**
 * pi 进程退出收殓（D12：后台任务生命周期绑定 pi 进程，不绑定 session）。
 *
 * 绝不能挂在 extension dispose / session_shutdown 上——session 替换（fork/switch/new）
 * 也触发它们，那会误杀全部后台任务（任务跨同进程 session 替换继续运行）。收殓只认
 * process 级信号与进程退出：
 *  - SIGTERM/SIGINT handler：先跑收殓再退出（SIGTERM 不主动 exit——pi rpc-mode 自有
 *    SIGTERM → shutdown 流程，抢 exit 会打断其 tracked-pid 清理与日志 flush）
 *  - process.on("exit")：同步兜底路径（强杀之外的一切退出最终都到这里）——kill-tree
 *    同步 kill + registry 同步原子写
 *  - 幂等：cleaned flag 保证信号 handler 先跑收殓后，exit 兜底再跑一次无害
 *
 * 子进程死后 registry 目录无人再扫（reaper 是 M5）——本单元不管。
 */

import { getLogger } from "@zhushanwen/pi-extension-logger";

import { killProcessTree } from "../kill-tree.ts";
import { emitPendingUnregister } from "./notify.ts";
import { stopPoller } from "./poller.ts";
import { taskToRegistryEntry, writeRegistryEntry } from "./registry.ts";
import { finalizeTask, getActiveTasks } from "./task-store.ts";

const logger = getLogger("base-tool-enhance");

/** SIGINT 收殓后的退出码（Ctrl-C 交互终止惯例码 128+2）。 */
const SIGINT_EXIT_CODE = 130;

let installed = false;
let cleaned = false;

/**
 * 安装进程级收殓（幂等，extension load 时调用一次；同进程 session 替换重新 load
 * 不会重复挂 handler——模块级 installed flag）。
 */
export function installProcessExitGuard(): void {
	if (installed) return;
	installed = true;

	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		reapBackgroundTasksNow();
	};

	// SIGTERM：只收殓不 exit——pi rpc-mode 的 SIGTERM handler（先注册先跑）走自己的
	// shutdown 流程，最终 process.exit 触发下方 exit 兜底（幂等跳过）
	process.once("SIGTERM", cleanup);
	// SIGINT：pi rpc-mode 无 handler，挂 listener 会阻断默认终止——收殓后必须自行
	// exit(130)（Ctrl-C 交互终止惯例码）
	process.once("SIGINT", () => {
		cleanup();
		process.exit(SIGINT_EXIT_CODE);
	});
	// 同步兜底：exit handler 里只能做同步收殓（kill-tree 同步 + registry 同步原子写）
	process.on("exit", cleanup);
}

/**
 * 收殓动作（导出供测试直接调用，不真杀 pi 进程）：
 * 轮询器停止 → 遍历**单例表**活跃条目 kill-tree（单例表 = 本进程任务全集，天然
 * 不含他进程条目——不遍历 registry，否则 ephemeral 附着进程退出会误杀属主进程的
 * 任务）→ registry 写终态 exited(reason:"process-exit")。
 *
 * 终态与轮询器边沿共用 finalizeTask（单一终态归属）。
 */
export function reapBackgroundTasksNow(): void {
	stopPoller();
	for (const task of getActiveTasks()) {
		try {
			killProcessTree(task.pid);
		} catch (err) {
			// 单条 kill 失败不阻断其余条目收殓；进程将退出，残余由 M5 reaper 兜底
			logger.warn("kill-tree failed during process-exit reap", {
				detail: { taskId: task.taskId, pid: task.pid, err: err instanceof Error ? err.message : String(err) },
			});
		}
		const finalized = finalizeTask(task.taskId, {
			exitCode: task.child?.exitCode ?? null,
			reason: "process-exit",
			endedAt: Date.now(),
		});
		if (finalized !== undefined) {
			writeRegistryEntry(finalized.registryPath, taskToRegistryEntry(finalized));
			// 尽力补 emit pending:unregister（§3.5「pi API 若仍可用」）：SIGTERM/SIGINT
			// 信号路径 pi 引用尚活（emit 经模块级 notify 引用，bus 未 dispose 时送达
			// pending listener 落盘）；process.on("exit") 同步路径 bus 可能已 dispose，
			// emit throw 被 notify 内部捕获降级——残留由 session_start 对账兜底。
			// **不 sendMessage**：进程都退了，无投递目标。
			emitPendingUnregister(finalized.taskId, "process-exit", finalized.exitCode ?? null);
		}
	}
}

/** 测试专用：复位幂等 flag（clearTaskStoreForTest 配套）。 */
export function resetProcessExitGuardForTest(): void {
	installed = false;
	cleaned = false;
}
