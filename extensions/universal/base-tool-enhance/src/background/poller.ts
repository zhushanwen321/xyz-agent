/**
 * 模块级轮询器单例（D17：exit 感知靠轮询不靠 ChildProcess 闭包）。
 *
 * 为什么轮询：同进程 session 替换（fork/switch/new）会重建 eventBus 并重新 load
 * extension，ChildProcess exit 闭包监听里的 bus/pi 引用全部 stale——完成通知在
 * 新 session 不可达。kill(pid,0) 轮询 + 模块级单例跨替换免疫，2s 延迟对分钟级
 * 任务无感。
 *
 * 惰性启停：无 running/killing 条目时清定时器（防空转泄漏），新任务登记时重启。
 *
 * 已知竞态（设计文档 §3.5 原样登记，不修）：同进程 session 替换 dispose → 新实例
 * load 间毫秒窗口任务恰好完成时通知可能落旧 bus——窗口极窄且后果可恢复（bash_output
 * 可查、对账可补），不加同步握手。
 */

import { isPidAlive } from "../kill-tree.ts";
import { readTailSummary } from "./output-tail.ts";
import { taskToRegistryEntry, writeRegistryEntry } from "./registry.ts";
import { finalizeTask, getActiveTasks } from "./task-store.ts";
import type { BackgroundTask } from "./types.ts";

/** 轮询间隔（设计文档 §3.5：约 2s）。 */
export const POLL_INTERVAL_MS = 2000;

let pollTimer: ReturnType<typeof setInterval> | undefined;

/**
 * M3 通知接入点（本单元 no-op 占位）：exit 边沿收尾（单例表 + registry 终态写完）
 * 之后同步回调。M3 在这里接 pending:unregister emit + sendMessage steer。
 * 不在 M2 实现任何通知行为。
 */
let onTaskExitCallback: ((task: BackgroundTask) => void) | undefined;

export function setOnTaskExit(callback: ((task: BackgroundTask) => void) | undefined): void {
	onTaskExitCallback = callback;
}

/** 惰性启动：有活跃条目才跑定时器（spawn 登记与 kill/timeout 标记后调用）。 */
export function ensurePollerRunning(): void {
	if (pollTimer !== undefined) return;
	pollTimer = setInterval(pollTick, POLL_INTERVAL_MS);
	// 不阻止进程退出（收殓路径 stopPoller 统一清理）
	pollTimer.unref?.();
}

export function stopPoller(): void {
	if (pollTimer !== undefined) {
		clearInterval(pollTimer);
		pollTimer = undefined;
	}
}

export function isPollerRunning(): boolean {
	return pollTimer !== undefined;
}

function pollTick(): void {
	const active = getActiveTasks();
	if (active.length === 0) {
		stopPoller();
		return;
	}
	for (const task of active) {
		// libuv 自动 reap 后 kill(pid,0) 报 ESRCH（判死），ChildProcess.exitCode 仍可读
		if (!isPidAlive(task.pid)) {
			finalizeExitedTask(task);
		}
	}
}

/** 测试专用：手动跑一轮轮询（不依赖 2s 定时器）。 */
export function pollTickForTest(): void {
	pollTick();
}

/**
 * exit 边沿收尾（单一终态归属）：读 exitCode → 组装 tail 摘要 → reason 判定
 * （intent.killed → "killed"、intent.timeout → "timeout"、无 intent → "natural"；
 * "process-exit" 由收殓路径直接调 finalizeTask，不经这里）→ 单例表 + registry
 * 两侧写终态 → 触发 onTaskExit 回调（M3 接入点）。
 */
function finalizeExitedTask(task: BackgroundTask): void {
	const exitCode = task.child?.exitCode ?? null;
	const reason = task.intent?.reason ?? "natural";
	const endedAt = Date.now();
	const tailSummary = readTailSummary(task.outputFile);
	const finalized = finalizeTask(task.taskId, { exitCode, reason, endedAt, tailSummary });
	if (finalized === undefined) return;
	writeRegistryEntry(finalized.registryPath, taskToRegistryEntry(finalized));
	onTaskExitCallback?.(finalized);
}
