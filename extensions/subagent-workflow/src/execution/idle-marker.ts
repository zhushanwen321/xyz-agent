// src/execution/idle-marker.ts
//
// .idle sidecar 生产者/消费者。
//
// 对话模式（chatMode）subagent 轮次完成时写 .idle sidecar，标记该 session 处于
// idle 态（进程已 SIGTERM 回收、record 保留在内存、等待续聊）。与 .alive/.cancelled/
// .finalized 同目录同 sidecar 族。M3 的重建矩阵会用它命中 idle 分支（不依赖 pid 死活）。
//
// 设计对齐 alive-store.ts：单文件 sidecar、best-effort I/O、无全局 index。

import * as fs from "node:fs";

/** .idle sidecar 内容（单行 JSON）。 */
export interface IdleMarker {
  /** subagent record id（sa-<uuid>，对齐 record.id）。 */
  readonly id: string;
  /** session jsonl 文件全路径（与 sidecar 同目录，重建时定位 session）。 */
  readonly sessionFile: string;
  /** 根 Pi session ID（归属判定 + session 隔离过滤，对齐 identity.rootSessionId）。 */
  readonly rootSessionId: string | undefined;
  /** 对话轮次计数（首轮完成 = 1，每完成一轮 +1）。M3 重建时恢复内存 record.round。 */
  readonly round: number;
}

// ============================================================
// 公开函数
// ============================================================

/**
 * 在 sessionFile 旁写 .idle sidecar（单行 JSON）。
 * 覆盖写——同一 sessionFile 只有最新轮次的 idle marker 有意义。
 * best-effort：任何 I/O 错误应被调用方 bestEffort 包裹（idle 状态已在内存 record 上设好，
 * sidecar 是磁盘重建辅助，写失败不阻断 idle 流程）。
 */
export function writeIdleMarker(sessionFile: string, marker: IdleMarker): void {
  const idlePath = `${sessionFile}.idle`;
  fs.writeFileSync(idlePath, `${JSON.stringify(marker)}\n`, "utf-8");
}

/**
 * 读 sessionFile 旁的 .idle sidecar。
 * 返回 undefined：不存在 / 损坏 / 解析失败 / 必填字段缺失。
 */
export function readIdleMarker(sessionFile: string): IdleMarker | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(`${sessionFile}.idle`, "utf-8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<IdleMarker>;
    if (
      typeof parsed.id === "string" &&
      typeof parsed.sessionFile === "string" &&
      typeof parsed.round === "number"
    ) {
      return {
        id: parsed.id,
        sessionFile: parsed.sessionFile,
        rootSessionId: parsed.rootSessionId,
        round: parsed.round,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 删除 sessionFile 旁的 .idle sidecar。
 * best-effort：不存在不抛（close 终态化时调，sidecar 可能已被清理）。
 */
export function removeIdleMarker(sessionFile: string): void {
  try {
    fs.unlinkSync(`${sessionFile}.idle`);
  } catch {
    void 0; // best-effort
  }
}
