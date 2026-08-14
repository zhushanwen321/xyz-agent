// src/execution/lifecycle-predicates.ts
//
// v4 B-1 ExecutionStatus 两态收敛后的派生谓词。
//
// 旧三态（running/idle/cancelled）折为两态（running/closed）后，「对话模式等待续聊」
//（旧 idle）和「正在执行」都是 status="running"，需派生谓词区分。谓词复用已有
// lifecycle-manager.hasIdleTimer（idle timer 是否 armed）与 session-runner.getChildByRecord
//（活进程句柄是否存在），不新增状态记账。
//
// 两种 running 子态（v4 B-1）：
//   - 等待续聊（旧 idle）：isIdle=true（timer armed）。又分两路：
//       A. 进程保活（agent_settled arm timer，未超时）→ isResumable=false（有活进程），
//          续聊走 deliverMessage 热路径 prompt。
//       B. 进程已回收（doFinalizeRoundToIdle / 跨重启重建）→ isResumable=true（无活进程），
//          续聊走 deliverMessage 冷路径 resume spawn。
//   - 正在执行：isIdle=false、isResumable=false（有活进程）。
//
// 时序保证（session-runner.ts:670-686）：agent_settled handler 内 armIdleTimer 在
// onRoundSettled（notify）与 resolveRun（runAndFinalize early-return 检查）之前执行，
// 故 isIdle 在这两个检查点恒为 true——notify 守卫与 early-return 判据可靠。

import { hasIdleTimer } from "./lifecycle-manager.ts";
import { getChildByRecord } from "./session-runner.ts";
import type { ExecutionRecord } from "./types.ts";

/**
 * 活进程句柄是否存在（isResumable 子判据）。
 *
 * 复用 session-runner.spawnedChildren 的 getChildByRecord 查询。child 存在且未 kill
 * = 有活进程句柄（正在执行 / Path A 保活）。进程 close 后 spawnedChildren 已 delete，
 * 返回 undefined = 无活进程（Path B / 跨重启）。
 */
export function hasLiveProcessHandle(recordId: string): boolean {
  const child = getChildByRecord(recordId);
  return child !== undefined && !child.killed;
}

/**
 * 对话模式等待续聊态（旧 idle 收敛后的派生谓词）。
 *
 * 判据：该 record 有 armed idle timer（lifecycle-manager.hasIdleTimer）。agent_settled
 * 时 session-runner arm timer（V2 决策 4）；新 turn / 终态化时 disarm。
 *
 * 注意：isIdle=true 不区分进程保活（Path A）与已回收（Path B）——前者续聊走热路径，
 * 后者走冷路径。进程死活由 {@link isResumable} 区分。
 */
export function isIdle(record: ExecutionRecord): boolean {
  return hasIdleTimer(record.id);
}

/**
 * 可冷路径 resume（running 且无活进程句柄）。
 *
 * 旧 idle 中进程已回收的子态（Path B / 跨重启重建）。deliverMessage 冷路径、GC、
 * close action 的「无活进程立即终态化」分支据此判定。
 *
 * 与 {@link isIdle} 的关系：isResumable=true 蕴含 isIdle 可能为 false（Path B 进程
 * 已退出，timer 未 armed）；isIdle=true（Path A）则 isResumable=false（进程保活）。
 */
export function isResumable(record: ExecutionRecord): boolean {
  return record.status === "running" && !hasLiveProcessHandle(record.id);
}
