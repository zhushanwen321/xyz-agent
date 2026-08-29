// src/runtime/execution/finalized-marker.ts
//
// Finalized 状态的 sidecar 持久化。
//
// 背景：subagent 执行完成（done/failed）后，session.jsonl 的最终写入可能因进程
// 异常终止而丢失。`.finalized` sidecar 标记该 session 已正常结束，collectRecords
// 重建时可用它区分「正常结束但文件截断」与「执行中断」。
//
// 设计：对称 cancelled sidecar（tombstone-store.ts）。`.finalized` 内容为可选的
// 关闭原因字符串（v8.5 起 writeFinalized 第二参数写入），旧格式为空文件——空内容
// 表示死因不可考，磁盘重建兜底 closedReason=disconnected（不再误导为 gc）。
// 与 `.cancelled` 互斥——一个 session 要么 finalized 要么 cancelled，不可能两者兼有。
//
// best-effort：写 IO 错静默，不阻断主流程。

import * as fs from "node:fs";

// ============================================================
// 公开函数
// ============================================================

/**
 * 在 session.jsonl 旁写 `.finalized` sidecar。
 * best-effort：任何 I/O 错误静默（finalize 标记是次要信号，status 已在内存 record 上设好）。
 *
 * 与 `.cancelled` 互斥（BC-4）：写前删除 `.cancelled`（如存在），确保不会两者共存。
 *
 * @param sessionFile session.jsonl 绝对路径
 * @param reason 可选的 L2 关闭原因写入 sidecar 内容（v8.5 起）：磁盘重建时用它区分
 *        真实死因（user-close / parent-* 等），替代旧的「一律 gc」误导标签。传
 *        undefined = 空文件（旧格式兼容：未知死因，重建兜底 disconnected）。
 */
export function writeFinalized(sessionFile: string, reason?: string): void {
  try {
    // BC-4 互斥：清理可能存在的 .cancelled。force:true 静默 ENOENT——
    // 未 cancel 过的 session（done/failed/aborted）本就无 .cancelled，属正常路径。
    // 此前用 unlinkSync+bestEffort 记 console.debug，取消嵌套链条时每层 ENOENT 刷屏。
    fs.rmSync(`${sessionFile}.cancelled`, { force: true });
    fs.writeFileSync(`${sessionFile}.finalized`, reason ?? "", "utf-8");
  } catch (_e) {
    void _e; // 静默：写失败不阻断 finalize 主流程。
  }
}

/**
 * 读 session.jsonl 旁的 `.finalized` sidecar 内容携带的关闭原因。
 * 返回 trim 后的字符串：sidecar 存在时可能为空串（旧格式空文件 / 未携 reason）。
 * 返回 undefined：sidecar 不存在 / 读取失败（与空串区分「没正常结束过」）。
 */
export function readFinalizedReason(sessionFile: string): string | undefined {
  try {
    return fs.readFileSync(`${sessionFile}.finalized`, "utf-8").trim();
  } catch {
    return undefined;
  }
}

/**
 * 读 session.jsonl 旁的 `.finalized` sidecar 是否存在。
 * 返回 true：sidecar 存在（内容不校验，存在性即信号）。
 * 返回 false：sidecar 不存在 / 读取失败。
 */
export function readFinalized(sessionFile: string): boolean {
  try {
    fs.accessSync(`${sessionFile}.finalized`);
    return true;
  } catch {
    return false;
  }
}
