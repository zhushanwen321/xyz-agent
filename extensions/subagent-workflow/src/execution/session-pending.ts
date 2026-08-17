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
 * [perf] per-file 增量游标：session 文件 append-only，同文件重复判定（层主被多个
 * 后代唤醒 N 次 → N 次 agent_end）只需读上次 offset 之后的新增行，累计 entries
 * 差集语义与全量读完全一致。fork 继承的大 session（数十 MB）从「每次整读」降为
 * 「首读全量 + 后续增量」。
 * truncate/重建防御：size < offset → 重置全读。EOF 半行（写入竞态）不入账，
 * offset 只推进到完整行边界，下次补读。
 * 内存量级：每 sessionFile 一条（offset + 后代 entries，均有限）；测试隔离用
 * clearPendingCursors()。
 */
interface PendingReadCursor {
  offset: number;
  entries: unknown[];
  latestUnregisterMs: number;
}

const cursors = new Map<string, PendingReadCursor>();

/** 清空增量游标缓存（测试隔离用）。 */
export function clearPendingCursors(): void {
  cursors.clear();
}

/** [taste/no-unsafe-cast] pending 行的最小结构守卫：非 null object 即可（字段访问
 *  侧均做了 undefined 检查，全可选类型断言无校验意义，改守卫带运行时检查）。 */
function isPendingLineLike(v: unknown): v is { customType?: string; timestamp?: string } {
  return typeof v === "object" && v !== null;
}

/**
 * 读 session 文件计算活跃 pending 数（增量读，见 PendingReadCursor）。
 *
 * 快速路径：行内含 pending 值（`"pending:register"` / `"pending:unregister"`）才解析，
 * 大量 message 行只付 includes 扫描跳过 JSON.parse。
 * [S-4] 按值匹配而非 `"customType":"pending:` 序列化格式——后者耦合 pi 的 JSON 序列化
 * 空格习惯（冒号后无空格），pi 改 pretty-print 会导致全过滤 → count=0 → keep-alive
 * 静默失效 → recursive tree 被杀、steer 丢失。值字符串本身不受序列化空格影响。
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

  let size: number;
  try {
    size = fs.statSync(sessionFile).size;
  } catch (err) {
    return {
      count: 0,
      recentUnregister: false,
      error: `session file unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let cursor = cursors.get(sessionFile);
  if (cursor === undefined || size < cursor.offset) {
    // 首次（全量）或文件被 truncate/重建（offset 越界）→ 重置从头读
    cursor = { offset: 0, entries: [], latestUnregisterMs: 0 };
  }

  let chunk: string;
  try {
    if (cursor.offset === 0) {
      chunk = fs.readFileSync(sessionFile, "utf-8");
    } else {
      const fd = fs.openSync(sessionFile, "r");
      try {
        const len = size - cursor.offset;
        const buf = Buffer.alloc(len);
        let total = 0;
        while (total < len) {
          const n = fs.readSync(fd, buf, total, len - total, cursor.offset + total);
          if (n <= 0) break;
          total += n;
        }
        chunk = buf.toString("utf-8", 0, total);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (err) {
    return {
      count: 0,
      recentUnregister: false,
      error: `session file unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 只消费到最后一个完整行：EOF 半行（append 写入竞态）不入账，offset 不推进，
  // 下次从该行起点重读（补全后正常入账）。
  const lastNl = chunk.lastIndexOf("\n");
  const complete = lastNl === -1 ? "" : chunk.slice(0, lastNl);
  cursor.offset += Buffer.byteLength(complete, "utf-8");
  cursors.set(sessionFile, cursor);

  for (const line of complete.split("\n")) {
    // [S-4] 按值匹配：countActiveFromEntries 只消费 register/unregister 两种 customType，
    // 故只需检测这两个值字符串；冒号前后空格变化不影响（值始终是连续子串）。
    if (!line.includes('"pending:register"') && !line.includes('"pending:unregister"')) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (!isPendingLineLike(entry)) continue;
      cursor.entries.push(entry);
      if (entry.customType === "pending:unregister" && entry.timestamp) {
        const ts = Date.parse(entry.timestamp);
        if (Number.isFinite(ts) && ts > cursor.latestUnregisterMs) cursor.latestUnregisterMs = ts;
      }
    } catch {
      // 截断行/坏行跳过——不影响其余 entry 的差集判定（罕见：append 中途崩溃）
      console.debug("[session-pending] skipped malformed pending line in", sessionFile);
    }
  }

  const active = countActiveFromEntries(cursor.entries);
  return {
    count: active.count,
    recentUnregister:
      cursor.latestUnregisterMs > 0 &&
      Date.now() - cursor.latestUnregisterMs < RECENT_UNREGISTER_WINDOW_MS,
  };
}
