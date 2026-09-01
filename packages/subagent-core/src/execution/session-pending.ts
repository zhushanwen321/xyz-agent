// src/execution/session-pending.ts
//
// agent_end 后代判定：读子进程的 session 文件，用 pending-notifications 的
// register − unregister 差集计数（经通知域窄端口 NotifyDomainPorts 注入的
// countActiveFromEntries——core 依赖闭包不含 pi-pending-notifications，见
// core/notify-ports.ts；端口缺席时按零活跃处理 = pending 门全开）判断该 subagent
// 是否还有活跃后代（background subagent / workflow）。
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

import { getLogger } from "../core/logger.ts";
import { getNotifyDomainPorts } from "../core/notify-ports.ts";

const logger = getLogger("subagents");

/** 后代刚完成（unregister）后，notify 唤醒父 agent 可能仍在路上（triggerTurn 的
 *  steer/followUp 经 sendMessage → agent 队列排空（agent-session.js:1081-1087），
 *  不经 EventBus——EventBus 只用于扩展间 pi.events；与主进程处理 agent_end 行存在
 *  毫秒级竞态——explorer 3 秒完成时实测 unregister 先于 agent_end 判定写入，导致
 *  差集 0 误判完成）。此窗口内的 agent_end 不 kill，等父被唤醒后的下一次 agent_end 再判。 */
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
 * 后代唤醒 N 次 → N 次 agent_end）只需读上次 offset 之后的新增行。fork 继承的大
 * session（数十 MB）从「每次整读」降为「首读全量 + 后续增量」。
 * truncate/重建防御：size < offset → 重置全读。EOF 半行（写入竞态）不入账，
 * offset 只推进到完整行边界，下次补读。
 *
 * [LC-6/T6②] entries 只留 register−unregister 差集的**活跃**条目（activeRegisters
 * Map，id → 原始 register entry），不累积全量历史 pending 行——长寿命 orchestrator
 * 的内存从「随 pending 行总数无界涨」收敛为「随活跃后代数有界」（差集化同时把每次
 * 判定的端口/list 重扫从 O(历史行数) 降为 O(活跃数)）。unregister 抵消已内联完成，
 * 下游 countActiveFromEntries 端口（TTL/跨 session 过滤作用于 register entry 本体）
 * 与 list 差集口径的语义与全量读完全一致；latestUnregisterMs（60s 唤醒窗口判据）
 * 独立在 cursor 字段上，不受差集化影响。缺 data.id 的畸形行丢弃（对齐坏行跳过层级，
 * 契约上 register/unregister 必带 data.id）。
 *
 * 剪枝：文件 stat/read 失败（含删除）即删 cursor（下次成功读时全量重建，增量只是
 * 优化不是事实源）；进程 close 后由调用方调 prunePendingCursor 显式回收。
 * 测试隔离用 clearPendingCursors()。
 */
interface PendingReadCursor {
  offset: number;
  activeRegisters: Map<string, unknown>;
  latestUnregisterMs: number;
}

const cursors = new Map<string, PendingReadCursor>();

/** 清空增量游标缓存（测试隔离用）。 */
export function clearPendingCursors(): void {
  cursors.clear();
}

/**
 * [LC-6/T6②] 剪枝单个 sessionFile 的增量游标（子进程 close / session 终态化时调）。
 *
 * 进程死后其 sessionFile 不再有 agent_end 判定，cursor 条目（offset + 活跃后代 Map）
 * 只会滞留不再更新——进程退出路径调用本函数回收。文件删除侧的自动剪枝在
 * accumulatePendingEntries（stat/read 失败即删）。不存在时 no-op。
 */
export function prunePendingCursor(sessionFile: string): void {
  cursors.delete(sessionFile);
}

/** [taste/no-unsafe-cast] pending 行的最小结构守卫：非 null object 即可（字段访问
 *  侧均做了 undefined 检查，全可选类型断言无校验意义，改守卫带运行时检查）。 */
function isPendingLineLike(v: unknown): v is { customType?: string; timestamp?: string } {
  return typeof v === "object" && v !== null;
}

/**
 * [内部共享] 读 session 文件并把 pending register/unregister 行累积进 per-file 增量
 * 游标的**活跃差集**（见 PendingReadCursor）。readActivePendingFromSessionFile（count
 * 口径）与 listActivePendingFromSessionFile（清单口径，T2-②）共用同一 cursor——两个
 * 口径交错调用同一文件时差集不错位、不重复读已消费区间。
 *
 * 快速路径：行内含 pending 值（`"pending:register"` / `"pending:unregister"`）才解析，
 * 大量 message 行只付 includes 扫描跳过 JSON.parse。
 * [S-4] 按值匹配而非 `"customType":"pending:` 序列化格式——后者耦合 pi 的 JSON 序列化
 * 空格习惯（冒号后无空格），pi 改 pretty-print 会导致全过滤 → count=0 → keep-alive
 * 静默失效 → recursive tree 被杀、steer 丢失。值字符串本身不受序列化空格影响。
 *
 * 文件不存在（sessionFile 未回填/首次 assistant 前）→ error（调用方保守不 kill）。
 * [LC-6] stat/read 失败（含文件被删）剪枝 cursor——下次成功读时全量重建（增量只是
 * 优化不是事实源），防「已删文件 cursor 永久滞留」。坏行跳过（append 中途崩溃的截断行）。
 */
function accumulatePendingEntries(
  sessionFile: string | undefined,
): { activeRegisters: Map<string, unknown>; latestUnregisterMs: number; error?: string } {
  const emptyAcc = { activeRegisters: new Map<string, unknown>(), latestUnregisterMs: 0 };
  if (!sessionFile) {
    return { ...emptyAcc, error: "no sessionFile (handshake not settled)" };
  }

  let size: number;
  try {
    size = fs.statSync(sessionFile).size;
  } catch (err) {
    // [LC-6] 读失败（含 ENOENT 文件被删）→ 剪枝，防已删文件 cursor 永久滞留
    cursors.delete(sessionFile);
    return {
      ...emptyAcc,
      error: `session file unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let cursor = cursors.get(sessionFile);
  if (cursor === undefined || size < cursor.offset) {
    // 首次（全量）或文件被 truncate/重建（offset 越界）→ 重置从头读
    cursor = { offset: 0, activeRegisters: new Map<string, unknown>(), latestUnregisterMs: 0 };
  }

  let chunk: string;
  try {
    if (cursor.offset === 0) {
      chunk = fs.readFileSync(sessionFile, "utf-8");
    } else {
      const len = size - cursor.offset;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(sessionFile, "r");
      try {
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
    // [LC-6] 读失败（含 ENOENT 文件被删）→ 剪枝（同 stat 失败路径）
    cursors.delete(sessionFile);
    return {
      ...emptyAcc,
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
      // [LC-6] 差集内联：register 入活跃 Map（同 id 重 register 覆盖 = 差集语义），
      // unregister 抵消移除。缺 data.id 的畸形行丢弃（契约必带 id，对齐坏行跳过层级）。
      const customType = entry.customType;
      const data = (entry as { data?: unknown }).data;
      const id =
        typeof data === "object" && data !== null && typeof (data as { id?: unknown }).id === "string"
          ? (data as { id: string }).id
          : undefined;
      if (customType === "pending:register" && id !== undefined) {
        cursor.activeRegisters.set(id, entry);
      } else if (customType === "pending:unregister" && id !== undefined) {
        cursor.activeRegisters.delete(id);
      }
      if (customType === "pending:unregister" && entry.timestamp) {
        const ts = Date.parse(entry.timestamp);
        if (Number.isFinite(ts) && ts > cursor.latestUnregisterMs) cursor.latestUnregisterMs = ts;
      }
    } catch {
      // 截断行/坏行跳过——不影响其余 entry 的差集判定（罕见：append 中途崩溃）
      logger.debug("skipped malformed pending line", { sessionFile });
    }
  }

  return { activeRegisters: cursor.activeRegisters, latestUnregisterMs: cursor.latestUnregisterMs };
}

/**
 * 读 session 文件计算活跃 pending 数（增量读 + 差集，见 PendingReadCursor）。
 */
export function readActivePendingFromSessionFile(
  sessionFile: string | undefined,
): ActivePendingResult {
  const acc = accumulatePendingEntries(sessionFile);
  if (acc.error) {
    return { count: 0, recentUnregister: false, error: acc.error };
  }

  // 计数器经通知域窄端口解析（缺省实现恒 0 = 零活跃，pending 门全开——安全侧缺省
  // 收敛在端口层，见 core/notify-ports.ts DEFAULT_NOTIFY_PORTS；此处 `?? 0` 仅防御
  // 宿主注入部分端口对象的形态）。[LC-6] 入参是差集后的活跃 register 集合（unregister
  // 抵消已内联），端口语义（TTL/跨 session 过滤作用于 register entry 本体）不受影响。
  const countActive = getNotifyDomainPorts().countActiveFromEntries;
  const active = countActive ? countActive([...acc.activeRegisters.values()]) : 0;
  return {
    count: active,
    recentUnregister:
      acc.latestUnregisterMs > 0 &&
      Date.now() - acc.latestUnregisterMs < RECENT_UNREGISTER_WINDOW_MS,
  };
}

/** 活跃 pending 清单条目（T2-② 后代补杀的 id/sessionId 线索）。 */
export interface ActivePendingItem {
  /** pending 操作 id（register − unregister 差集的键，id 全局唯一）。 */
  id: string;
  /**
   * 注册时的后代 pi session id（pending:register entry data.sessionId）——
   * 反查后代 sessionFile 的线索。缺失（异常形态）时 undefined，调用方降级处理。
   */
  sessionId: string | undefined;
  /** 操作来源类型（workflow / session / process），诊断用。 */
  type: string | undefined;
}

/** listActivePendingFromSessionFile 的结果（error 非空时 items 为空）。 */
export interface ActivePendingListResult {
  items: ActivePendingItem[];
  /** 读取/解析失败的原因（undefined = 成功）。 */
  error?: string;
}

/** pending:register/unregister entry 的 data 最小形状（对齐 pending-notifications
 *  extension 的 RegisterEntryData/UnregisterEntryData：id 均在 data.id）。 */
interface PendingEntryDataLike {
  id?: unknown;
  sessionId?: unknown;
  type?: unknown;
}

/** entry.data 的运行时守卫（[taste/no-unsafe-cast]：字段访问前校验）。 */
function isPendingEntryDataLike(v: unknown): v is PendingEntryDataLike {
  return typeof v === "object" && v !== null;
}

/**
 * [T2-② / P-T2b 主路径] 读 session 文件列出活跃 pending 清单（register − unregister
 * 差集，按 data.id）。与 readActivePendingFromSessionFile 共享 per-file 增量游标的
 * 活跃差集（count 与 list 交错调用不错位）。
 *
 * 与 count 口径的两点刻意差异（后代补杀语境）：
 * 1. 不经 countActiveFromEntries 端口——补杀需要「谁还活着」的 id/sessionId 线索，
 *    端口只给数量（差集本身已由游标内联完成，此处直接遍历活跃 register）。
 * 2. 不套用端口的 TTL/跨 session 过期语义——层主死后，TTL 过期或跨 session 的后代
 *    同样是无人管理的孤儿进程，列入补杀正是本函数的目的而非误杀。
 */
export function listActivePendingFromSessionFile(
  sessionFile: string | undefined,
): ActivePendingListResult {
  const acc = accumulatePendingEntries(sessionFile);
  if (acc.error) {
    return { items: [], error: acc.error };
  }

  const items: ActivePendingItem[] = [];
  for (const [id, raw] of acc.activeRegisters) {
    if (!isPendingLineLike(raw)) continue;
    const data = (raw as { data?: unknown }).data;
    if (!isPendingEntryDataLike(data)) continue;
    items.push({
      id,
      sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
      type: typeof data.type === "string" ? data.type : undefined,
    });
  }
  return { items };
}
