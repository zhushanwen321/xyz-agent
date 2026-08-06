// src/execution/session-pending.ts
//
// agent_end 后代判定：读子进程的 session 文件，用 pending-notifications 的
// countActiveFromEntries（register − unregister 差集）判断该 subagent 是否还有
// 活跃后代（background subagent / workflow）。
//
// 背景（v4 递归编排）：层主 planning-agent 派子 subagent 后结束 turn 等待被唤醒。
// 若 runSpawn 在 agent_end 无条件 kill，进程被回收、steer 唤醒送不到，递归树断。
// 判定依据：子进程的 session 文件里 pending:register entry（其进程内 appendEntry
// 同步写盘，见 pi SessionManager._persist）减去 pending:unregister 的差集。
// fork 继承的主 session register 残留由 pending-notifications 的 session_start
// 重建流程补 unregister(expired) 抵消，纯差集不受污染。
//
// 纯函数 + fs，独立于 runSpawn，可单测。

import * as fs from "node:fs";

import { countActiveFromEntries } from "@zhushanwen/pi-pending-notifications";

/** 后代刚完成（unregister）后，notify 唤醒父 agent 可能仍在路上（triggerTurn steer
 *  经进程内 EventBus 发送，与主进程处理 agent_end 行存在毫秒级竞态——explorer 3 秒完成
 *  时实测 unregister 先于 agent_end 判定写入，导致差集 0 误判完成）。此窗口内的
 *  agent_end 不 kill，等父被唤醒后的下一次 agent_end 再判。 */
const RECENT_UNREGISTER_WINDOW_MS = 60_000;

/** 判定结果：count > 0 = 有活跃后代（应保持进程等唤醒）。 */
export interface ActivePendingResult {
	count: number;
	/** 最近窗口内（60s）有 pending:unregister——后代刚完成，唤醒通知可能在路上。 */
	recentUnregister: boolean;
	/** 读取/解析失败的原因（undefined = 成功）。调用方对 error 采取保守策略（不 kill）。 */
	error?: string;
}

/**
 * 读 session 文件计算活跃 pending 数。
 *
 * 快速路径：JSON 序列化无空格（pi appendFileSync 原样写入），行内包含
 * `"customType":"pending:` 才解析，大文件（fork 继承主 session）只付 includes 扫描。
 *
 * 文件不存在（sessionFile 未回填/首次 assistant 前）→ error（调用方保守不 kill）。
 * 坏行跳过（append 中途崩溃的截断行）。
 */
export function readActivePendingFromSessionFile(
	sessionFile: string | undefined,
): ActivePendingResult {
	if (!sessionFile) {
		return { count: 0, recentUnregister: false, error: "no sessionFile (handshake not settled)" };
	}
	let raw: string;
	try {
		raw = fs.readFileSync(sessionFile, "utf-8");
	} catch (err) {
		return {
			count: 0,
			recentUnregister: false,
			error: `session file unreadable: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const entries: unknown[] = [];
	let latestUnregisterMs = 0;
	for (const line of raw.split("\n")) {
		if (!line.includes('"customType":"pending:')) continue;
		try {
			const entry = JSON.parse(line) as { customType?: string; timestamp?: string };
			entries.push(entry);
			if (entry.customType === "pending:unregister" && entry.timestamp) {
				const ts = Date.parse(entry.timestamp);
				if (Number.isFinite(ts) && ts > latestUnregisterMs) latestUnregisterMs = ts;
			}
		} catch {
			// 截断行/坏行跳过——不影响其余 entry 的差集判定（罕见：append 中途崩溃）
			console.debug("[session-pending] skipped malformed pending line in", sessionFile);
		}
	}

	const active = countActiveFromEntries(entries);
	return {
		count: active.count,
		recentUnregister:
			latestUnregisterMs > 0 && Date.now() - latestUnregisterMs < RECENT_UNREGISTER_WINDOW_MS,
	};
}
