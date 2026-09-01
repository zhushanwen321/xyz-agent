/**
 * 模块级单例任务表（运行时权威，D17 的根基）。
 *
 * 为什么模块级而不是 extension 实例级：pi 同进程 session 替换（/fork、选择器切换、
 * RPC session.*）会重新 load extension 实例，实例级状态随 dispose 消失；模块级 Map
 * 跨替换存活，任务表无需恢复（pending-notifications 的 unsubscribers 列表同范式）。
 *
 * 条目唯一来源 = 本进程 execute 的 spawn（registerSpawnedTask 全仓唯一调用点 =
 * spawn-background.ts）。他进程 / 历史 session 的 running 条目**永不进表**——
 * 零恢复零接管，孤儿处置权统一归收殓侧（u-bte-remove 后 = xyz-agent runtime）
 * 按属主裁决；终态条目可从 registry 读，仅供 bash_output 查历史。
 *
 * 终态条目 LRU 上限 MAX_TERMINAL_ENTRIES（与 registry 对称），淘汰后 bash_output
 * 回落 registry 查询。
 */

import {
	isActiveState,
	isTerminalState,
	type BackgroundTask,
	type BackgroundTaskEndReason,
	type KillingIntent,
} from "./types.ts";

/** 终态条目 LRU 上限（§3.5 两层存储分工：单例表与 registry 对称采用 LRU 50）。 */
export const MAX_TERMINAL_TASKS = 50;

const taskTable = new Map<string, BackgroundTask>();

/**
 * 登记新任务（条目唯一入口，仅 spawn-background 调用）。
 * 同 taskId 已存在 = 编码错误（task_id 含 ts+rand 保证全局唯一），防御性覆盖并保留
 * 日志语义由调用方保证不发生。
 */
export function registerSpawnedTask(task: BackgroundTask): void {
	taskTable.set(task.taskId, task);
}

export function getTask(taskId: string): BackgroundTask | undefined {
	return taskTable.get(taskId);
}

/** 全部条目（running/killing/exited/orphaned），bash_output list 用。 */
export function getAllTasks(): BackgroundTask[] {
	return [...taskTable.values()];
}

/** 活跃条目（running | killing），轮询器监护对象。 */
export function getActiveTasks(): BackgroundTask[] {
	return getAllTasks().filter((t) => isActiveState(t.state));
}

export function countActiveTasks(): number {
	return getActiveTasks().length;
}

/** 最老活跃任务（并发上限满时列入错误文案）。 */
export function oldestActiveTask(): BackgroundTask | undefined {
	return getActiveTasks().sort((a, b) => a.startedAt - b.startedAt)[0];
}

/**
 * 标 killing intent（瞬态 running→killing）。bash_kill 与后台 timeout 定时器共用；
 * 调用方负责同步写 registry 侧（两侧一致是查询面可见性前提）。
 */
export function markKillingIntent(
	taskId: string,
	reason: KillingIntent["reason"],
): BackgroundTask | undefined {
	const task = taskTable.get(taskId);
	if (task === undefined || !isActiveState(task.state)) return undefined;
	task.state = "killing";
	task.intent = { reason, at: Date.now() };
	return task;
}

export interface FinalizeOutcome {
	exitCode: number | null;
	reason: BackgroundTaskEndReason;
	endedAt: number;
	tailSummary?: string;
}

/**
 * 终态化（exited）：唯一终态写入口。轮询器 exit 边沿、进程退出收殓两条路径收敛
 * 到这里（bash_kill 不直接写终态——单一终态归属，§3.5「bash_kill 终态收尾的
 * 单点归属」）。消费 intent、清 timeout 定时器、算 durationMs、LRU 淘汰溢出终态。
 */
export function finalizeTask(taskId: string, outcome: FinalizeOutcome): BackgroundTask | undefined {
	const task = taskTable.get(taskId);
	if (task === undefined || isTerminalState(task.state)) return task;
	if (task.timeoutTimer !== undefined) {
		clearTimeout(task.timeoutTimer);
		task.timeoutTimer = undefined;
	}
	task.state = "exited";
	task.exitCode = outcome.exitCode;
	task.reason = outcome.reason;
	task.endedAt = outcome.endedAt;
	task.durationMs = outcome.endedAt - task.startedAt;
	task.tailSummary = outcome.tailSummary;
	task.intent = undefined;
	task.child = undefined; // 终态后不再需要 exitCode，释放 ChildProcess 引用
	evictTerminalOverflow();
	return task;
}

/** 终态条目超上限时按 endedAt 升序淘汰最老（LRU；endedAt 缺失退 startedAt）。 */
function evictTerminalOverflow(): void {
	const terminal = getAllTasks()
		.filter((t) => isTerminalState(t.state))
		.sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
	const excess = terminal.length - MAX_TERMINAL_TASKS;
	for (let i = 0; i < excess; i++) {
		taskTable.delete(terminal[i].taskId);
	}
}

/** 测试专用：清空单例表（模块级状态跨测试文件存活，必须显式复位）。 */
export function clearTaskStoreForTest(): void {
	for (const task of taskTable.values()) {
		if (task.timeoutTimer !== undefined) clearTimeout(task.timeoutTimer);
	}
	taskTable.clear();
}
