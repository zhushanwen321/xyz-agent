/**
 * background 任务核心数据模型（设计文档 docs/design/base-tool-enhance.md §3.5）。
 *
 * 两层存储分工：
 *  - 单例任务表（task-store.ts，模块级 Map）= 运行时权威；条目唯一来源 = 本进程
 *    execute 的 spawn——他进程 / 历史 session 的 running 条目永不进表（零恢复零接管）
 *  - registry.json（registry.ts，per-sessionId 目录）= 持久化权威；M5 reaper 的
 *    孤儿发现源，条目记 ownerPiPid（M2 只负责写入）
 */

import type { ChildProcess } from "node:child_process";

/** 任务状态机：running → killing（intent 瞬态）→ exited；orphaned 由 M5 reaper 写入。 */
export type BackgroundTaskState = "running" | "killing" | "exited" | "orphaned";

/**
 * 终态 reason 枚举（§3.5 bash_output 规格）：
 *  - natural      进程自然退出（含外力终止——观测上不可区分，§3.5 两层存储分工节）
 *  - timeout      后台显式 timeout 定时器触发
 *  - killed       bash_kill 发令
 *  - process-exit pi 进程退出收殓（D12）
 */
export type BackgroundTaskEndReason = "natural" | "timeout" | "killed" | "process-exit";

/**
 * killing intent：bash_kill / 后台 timeout 已发令、轮询器 exit 边沿未确认的瞬态标记。
 * 标记写入单例表与 registry 两侧（查询面立即可见，无「已 kill 仍 running」倒挂）；
 * 轮询边沿据此决定终态 reason，消费后清除。
 */
export interface KillingIntent {
	reason: Extract<BackgroundTaskEndReason, "killed" | "timeout">;
	at: number;
}

/**
 * 单例任务表条目（运行时权威，D17 根基）。
 *
 * child 引用**只用于读 exitCode/signalCode，禁止挂事件监听**——exit 感知统一走
 * 轮询器 kill(pid,0) 边沿；闭包式 exit 监听在同进程 session 替换后指向 stale bus
 * （D17）。child.on("error") 是唯一例外（spawn-background 内的 no-op，防进程崩溃，
 * 不做任何状态推进）。
 */
export interface BackgroundTask {
	taskId: string;
	pid: number;
	/** 原始命令全文（bash_output list 展示时截前 80 字符） */
	command: string;
	outputFile: string;
	/** 本条目 registry.json 路径（收殓同步写终态用；运行时字段，不序列化） */
	registryPath: string;
	startedAt: number;
	state: BackgroundTaskState;
	/** 发起任务的 pi 进程 pid（M5 reaper 属主判定依据；M2 只写入） */
	ownerPiPid: number;
	/** 发起 session（registry 目录归属） */
	sessionId: string;
	exitCode?: number | null;
	reason?: BackgroundTaskEndReason;
	endedAt?: number;
	durationMs?: number;
	/** exit 边沿组装的输出尾部摘要（M3 通知用；M2 存条目不消费） */
	tailSummary?: string;
	/** killing intent（瞬态，终态化时消费）；终态后为 undefined */
	intent?: KillingIntent;
	/** 后台显式 timeout 定时器（到点 kill-tree + 标 intent timeout）；终态化时清除 */
	timeoutTimer?: ReturnType<typeof setTimeout>;
	/**
	 * 子进程 start time（epoch 秒，M3 补写 M5 预告字段）：spawn 后立即读取，供 reaper
	 * 精确比较防 pid 复用误杀；读取失败省略（reaper 降级走 startedAt 秒级校验兜底）。
	 */
	pidStartTime?: number;
	/** spawn 返回的 ChildProcess 引用：仅读 exitCode/signalCode（D17，见接口注释） */
	child?: ChildProcess;
}

/** registry.json 持久化条目（BackgroundTask 剥离运行时字段后的形状）。 */
export interface RegistryEntry {
	taskId: string;
	pid: number;
	command: string;
	outputFile: string;
	startedAt: number;
	state: BackgroundTaskState;
	ownerPiPid: number;
	sessionId: string;
	exitCode?: number | null;
	reason?: BackgroundTaskEndReason;
	endedAt?: number;
	durationMs?: number;
	tailSummary?: string;
	/** 子进程 start time（epoch 秒，reaper pid 复用防御精确比较用；缺失走降级校验）。 */
	pidStartTime?: number;
}

/** 任务是否处于活跃态（轮询器监护对象）。 */
export function isActiveState(state: BackgroundTaskState): boolean {
	return state === "running" || state === "killing";
}

/** 任务是否处于终态（LRU 淘汰对象；orphaned 由 M5 写入，同属终态）。 */
export function isTerminalState(state: BackgroundTaskState): boolean {
	return state === "exited" || state === "orphaned";
}
