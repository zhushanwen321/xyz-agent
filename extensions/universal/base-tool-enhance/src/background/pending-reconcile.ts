/**
 * session_start pending 对账（M3，§3.5 接入细则第 4 条——pending 收尾的统一兜底）。
 *
 * 职责：对「session entries 差集显示 active、但任务已终态」的 bt- 任务补写
 * pending:unregister entry。覆盖三类 otherwise 悬空场景（设计原文）：
 *  ① 进程 graceful 退出收殓时 pi API 已不可用，unregister 没写成 entry；
 *  ② 强杀后 reaper 只改 registry（标 orphaned），碰不了 session 文件；
 *  ③ fork 后任务完成通知写进新 session，旧 session 文件的 register 成僵尸。
 *
 * 收尾写法（权威路径）：直接 pi.appendEntry("pending:unregister", {id, reason,
 * status})——**不走 bus emit 作为权威**：pending-notifications 的 unregister listener
 * 落盘条件是其内存 registry 该 id active（其 registry 只在自身 session_start rebuild
 * 后非空），两个 extension 的加载/派发顺序（CLI --extension 顺序用户可控）无保障，
 * 顺序反转时 emit 被静默吞、对账失效。差集消费方 goal 从持久化 entries 算差集
 * （agent-end.ts getEntries()，不读 pending 内存 registry），appendEntry 对守卫直接
 * 生效。appendEntry 之外尽力补一次 emit（listener 就绪时同步其内存视图，失败无害）。
 *
 * 终态判据：registry state ∈ {exited, orphaned}，或（state=running/killing 且
 * kill(pid,0) 判死：收殓/写盘失败遗留的 running 条目按事实终态处理）。
 * 不改 registry——终态写入归 reaper/轮询器（单点归属），对账只清 pending 侧。
 *
 * 执行顺序（index.ts session_start 链内）：reaper 先、对账后——先按属主判定处置
 * 孤儿/补写 registry 终态，对账随后读到正确终态；即使颠倒也无静默错误（对账先见
 * running+pid 活则不动作，下一 session_start 兜底）。
 */

import { getLogger } from "@zhushanwen/pi-extension-logger";

import { isPidAlive } from "../kill-tree.ts";
import { toPendingReason } from "./notify.ts";
import { getRegistryPath, readRegistry } from "./registry.ts";
import { isActiveState, isTerminalState, type RegistryEntry } from "./types.ts";

const logger = getLogger("base-tool-enhance");

/** 本包 task_id 前缀（§2.3，区别于 subagent-workflow 的 bg-/run-）。 */
export const BTE_TASK_ID_PREFIX = "bt-";

/**
 * 对账依赖的最小 pi 面（结构兼容 ExtensionAPI 的子集；测试注入不造完整 pi）。
 */
export interface ReconcilePi {
	appendEntry(customType: string, data?: unknown): void;
	events: { emit(channel: string, data: unknown): void };
}

/** 对账结果（日志 + 测试断言面）。 */
export interface ReconcileResult {
	/** 补写 pending:unregister entry 的任务数。 */
	reconciled: number;
	/** 差集 active 但判据不满足（活任务 / registry 无条目）而保守跳过的 task_id。 */
	skipped: string[];
}

/** entries 的最小可识别形状（duck-typed，与 pending-notifications state.ts EntryLike 同式）。 */
interface EntryLike {
	customType?: string;
	data?: { id?: unknown } | null;
}

function readEntryId(raw: unknown): string | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const entry = raw as EntryLike;
	const id = entry.data?.id;
	return typeof id === "string" ? id : undefined;
}

/**
 * 差集：bt- 前缀 pending:register 且无对应 pending:unregister 的 id 集合。
 * 只认 bt- 前缀——workflow/subagent 的 register 不归本包对账（差集算法与
 * pending-notifications countActiveFromEntries 同构：unregister 全局抵消 + register
 * 去重，id 全局唯一前提）。
 */
export function collectUnsettledTaskIds(entries: unknown[]): Set<string> {
	const unregistered = new Set<string>();
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		if ((raw as EntryLike).customType !== "pending:unregister") continue;
		const id = readEntryId(raw);
		if (id !== undefined && id.startsWith(BTE_TASK_ID_PREFIX)) unregistered.add(id);
	}
	const active = new Set<string>();
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		if ((raw as EntryLike).customType !== "pending:register") continue;
		const id = readEntryId(raw);
		if (id === undefined || !id.startsWith(BTE_TASK_ID_PREFIX)) continue;
		if (unregistered.has(id) || active.has(id)) continue;
		active.add(id);
	}
	return active;
}

/**
 * 对账主体（同步：readRegistry / kill(pid,0) / appendEntry 均同步，session_start
 * 链内毫秒级完成）。每个僵尸任务 appendEntry 一次 + 尽力 emit 一次。
 */
export function reconcilePendingEntries(
	pi: ReconcilePi,
	dataDir: string,
	sessionId: string,
	entries: unknown[],
): ReconcileResult {
	const result: ReconcileResult = { reconciled: 0, skipped: [] };
	const unsettled = collectUnsettledTaskIds(entries);
	if (unsettled.size === 0) return result;

	const registry = readRegistry(getRegistryPath(dataDir, sessionId));
	for (const id of unsettled) {
		const entry = registry.get(id);
		if (entry === undefined) {
			// registry 无条目：终态无从判定（LRU 淘汰的终态条目其 unregister entry 应已
			// 落盘，差集里还出现 = spawn 后 registry 写失败等罕见路径）——保守不动作，
			// 差集残留交给 pending 自身 TTL 之外的 next-session 对账重查
			result.skipped.push(id);
			continue;
		}
		if (!isTerminalByRegistry(entry)) {
			// D12 活任务（running/killing 且 pid 活）：任务跨 session 替换续存，不收尾
			result.skipped.push(id);
			continue;
		}
		const pendingReason = settledPendingReason(entry);
		try {
			pi.appendEntry("pending:unregister", { id, reason: pendingReason, status: pendingReason });
		} catch (err) {
			logger.warn("reconcile appendEntry failed; retry on next session_start", {
				detail: { id, err: err instanceof Error ? err.message : String(err) },
			});
			continue;
		}
		// 尽力补 emit（listener 就绪时同步 pending 内存视图，缩短 pending_notifications
		// 工具列表的不一致窗口；失败无害——appendEntry 已是权威路径）
		try {
			pi.events.emit("pending:unregister", { id, reason: pendingReason });
		} catch (err) {
			logger.debug("reconcile best-effort emit failed (harmless)", {
				detail: { id, err: err instanceof Error ? err.message : String(err) },
			});
		}
		result.reconciled++;
	}
	if (result.reconciled > 0) {
		logger.debug("pending reconcile settled zombie registers", {
			detail: { reconciled: result.reconciled, skipped: result.skipped.length },
		});
	}
	return result;
}

/** 终态判据（§3.5 接入细则 4 原文）：registry 终态，或 active 状态但 pid 已判死。 */
function isTerminalByRegistry(entry: RegistryEntry): boolean {
	if (isTerminalState(entry.state)) return true;
	return isActiveState(entry.state) && !isPidAlive(entry.pid);
}

/**
 * 收尾 reason/status 映射：
 *  - exited：按条目 reason/exitCode 走 toPendingReason（与 exit 边沿 emit 同一映射，
 *    两路径写出的 entry 语义一致）；reason 缺失按 pending mapReasonToStatus 的
 *    default=completed 语义处理（防御分支，正常路径 finalize 必写 reason）
 *  - orphaned / running+判死：cancelled（任务非自身成败地终止/消失）
 */
function settledPendingReason(entry: RegistryEntry): "completed" | "failed" | "time_limited" | "cancelled" {
	if (entry.state === "exited" && entry.reason !== undefined) {
		return toPendingReason(entry.reason, entry.exitCode ?? null);
	}
	return "cancelled";
}
