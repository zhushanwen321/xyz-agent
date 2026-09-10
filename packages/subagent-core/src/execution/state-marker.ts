// src/execution/state-marker.ts
//
// 终态 sidecar 单一入口（`.state`）：subagent 收尾时宿主侧写，collectRecords 磁盘
// 重建时读——判「正常结束过」与死因。
//
// 背景（L4 合并）：原有两个互斥 sidecar 是同一概念（宿主侧终态标记）的两份形态——
// `.finalized`（内容 = 可选关闭原因字符串，v8.5 起）与 `.cancelled`（JSON tombstone，
// 带 id/agent/startedAt/endedAt）。按设计「一个 session 要么 finalized 要么 cancelled」，
// 形态分叉只因历史写入点不同。现统一为 `<session>.state`：
//
//   { "status": "finalized" | "cancelled", "reason"?: string, "endedAt"?: number }
//
//   - finalized：reason = 关闭原因（旧格式空内容 → 空串 = 死因不可考 → 重建兜底
//     closedReason=disconnected，不再误导为 gc）；endedAt 不携带（重建用 jsonl 末
//     entry ts / mtime，既有语义不变）。
//   - cancelled：endedAt = 精确结束时间（原 tombstone.endedAt，判定分支消费它）；
//     reason 不携带（原 tombstone 其余字段 id/agent/startedAt 无消费方，随合并删除）。
//
// 读侧**兼容旧两名**（存量文件不迁移重写）：`.state` 优先，缺失时回退 `.finalized`
// / `.cancelled` 并归一为同一 StateMarker。`.alive`（子进程自写 pid 探活，跨进程
// 语义）不并入。
//
// best-effort：写 IO 错静默，不阻断主流程。

import * as fs from "node:fs";

/** 终态 sidecar 扩展名（写侧新名 + 读侧兼容旧名；GC 清理名单与此同源语义）。 */
export const STATE_SIDECAR_EXT = ".state";
const LEGACY_FINALIZED_EXT = ".finalized";
const LEGACY_CANCELLED_EXT = ".cancelled";

// ============================================================
// 类型
// ============================================================

/** 终态二态（互斥）。 */
export type TerminalState = "finalized" | "cancelled";

/** 终态 sidecar 归一形态（新名直读 / 旧名兼容读出共用）。 */
export interface StateMarker {
  status: TerminalState;
  /** finalized 的关闭原因；空串 = 旧格式空文件（死因不可考）；cancelled 恒 undefined。 */
  reason?: string;
  /** cancelled 的精确结束时间；finalized 恒 undefined（重建走 jsonl 末 entry ts）。 */
  endedAt?: number;
}

/** sidecar stat 戳（结构对齐 record-store 的 Stamp——缓存校验用，避免跨模块类型耦合）。 */
export interface SidecarStat {
  mtimeMs: number;
  size: number;
}

// ============================================================
// 写侧（唯一入口：两终态共用 .state）
// ============================================================

/**
 * 写 finalized 终态 sidecar。
 * best-effort：任何 I/O 错误静默（finalize 标记是次要信号，status 已在内存 record 上设好）。
 *
 * @param sessionFile session.jsonl 绝对路径
 * @param reason 可选的关闭原因（磁盘重建用它还原 closedReason）。传 undefined =
 *        空串（死因不可考，重建兜底 disconnected）。
 */
export function writeFinalizedState(sessionFile: string, reason?: string): void {
  writeStateMarker(sessionFile, reason === undefined ? { status: "finalized" } : { status: "finalized", reason });
}

/**
 * 写 cancelled 终态 sidecar。
 * best-effort：写失败不阻断 cancel 主流程（status 已在内存 record 上设好）。
 *
 * @param endedAt 精确结束时间（重建判定分支消费；调用方传 record.endedAt ?? Date.now()）
 */
export function writeCancelledState(sessionFile: string, endedAt: number): void {
  writeStateMarker(sessionFile, { status: "cancelled", endedAt });
}

/** .state 写入 + 旧名清理（互斥由单文件单状态字段构造性保证）。 */
function writeStateMarker(sessionFile: string, marker: StateMarker): void {
  try {
    // 旧名清理（存量残留）：.state 是唯一权威，残留旧文件会被兼容读路径优先让位——
    // 但删除可避免 GC 前重复 stat。force:true 静默 ENOENT（未写过旧名的 session 正常路径）。
    fs.rmSync(`${sessionFile}${LEGACY_FINALIZED_EXT}`, { force: true });
    fs.rmSync(`${sessionFile}${LEGACY_CANCELLED_EXT}`, { force: true });
    fs.writeFileSync(`${sessionFile}${STATE_SIDECAR_EXT}`, JSON.stringify(marker), "utf-8");
  } catch (_e) {
    void _e; // 静默：写失败不阻断收尾主流程。
  }
}

// ============================================================
// 读侧（.state 优先；旧名兼容归一）
// ============================================================

/**
 * 读终态 sidecar（.state 优先，缺失回退旧名）。
 *
 * 旧名回退顺序 **.cancelled → .finalized**：与合并前判定分支的优先级逐点一致
 * （原实现分支 1 = tombstone，分支 2 = finalized；两者共存时 cancelled 胜出——
 * 存量残留文件仍可能出现该形态）。
 *
 * 返回 undefined：三者皆无 / 内容无法判读（旧 .cancelled 损坏时不认 cancelled——
 * 对齐旧语义，避免把损坏残留误判成终态）。
 *
 * 边界对齐（与合并前逐点等价）：
 *   - `.state` 存在但内容损坏 → {status:"finalized"}（对齐旧 .finalized「存在性即
 *     信号」的宽语义；不误判 cancelled）；
 *   - 旧 `.finalized` 存在 → reason = 内容 trim（读失败 → undefined → 重建 disconnected）；
 *   - 旧 `.cancelled` 存在且结构合法 → {status:"cancelled", endedAt}。
 */
export function readStateMarker(sessionFile: string): StateMarker | undefined {
  const fromNew = readNewStateMarker(sessionFile);
  if (fromNew !== undefined) return fromNew;
  const fromCancelled = readLegacyCancelledMarker(sessionFile);
  if (fromCancelled !== undefined) return fromCancelled;
  return readLegacyFinalizedMarker(sessionFile);
}

function readNewStateMarker(sessionFile: string): StateMarker | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(`${sessionFile}${STATE_SIDECAR_EXT}`, "utf-8");
  } catch {
    return undefined; // sidecar 不存在（正常——未终态化的 record 无 sidecar）。
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StateMarker>;
    if (parsed.status === "cancelled") {
      return typeof parsed.endedAt === "number"
        ? { status: "cancelled", endedAt: parsed.endedAt }
        : { status: "cancelled" };
    }
    if (parsed.status === "finalized") {
      return typeof parsed.reason === "string"
        ? { status: "finalized", reason: parsed.reason }
        : { status: "finalized" };
    }
    return { status: "finalized" }; // 结构不合法 → 存在性信号（降级，不误判 cancelled）。
  } catch {
    return { status: "finalized" }; // JSON 损坏 → 同上。
  }
}

function readLegacyFinalizedMarker(sessionFile: string): StateMarker | undefined {
  try {
    const content = fs.readFileSync(`${sessionFile}${LEGACY_FINALIZED_EXT}`, "utf-8").trim();
    return { status: "finalized", reason: content };
  } catch {
    return undefined;
  }
}

function readLegacyCancelledMarker(sessionFile: string): StateMarker | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(`${sessionFile}${LEGACY_CANCELLED_EXT}`, "utf-8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { status?: unknown; endedAt?: unknown };
    if (parsed.status !== "cancelled") return undefined; // 结构不合法 → 降级（对齐旧 readCancelledTombstone）。
    return typeof parsed.endedAt === "number"
      ? { status: "cancelled", endedAt: parsed.endedAt }
      : { status: "cancelled" };
  } catch {
    return undefined; // JSON 损坏 → 降级。
  }
}

// ============================================================
// stat 戳（缓存校验）
// ============================================================

/**
 * 终态 sidecar 的合并 stat 戳（.state + 两个旧名一起取）。
 *
 * 为什么合并：record-store 的 per-file 缓存按戳校验失效——读侧要兼容旧名，若戳只盯
 * `.state`，旧 sidecar 被 GC 删除/内容变化时缓存不失效（读到过期终态）。合并 = 任一
 * 相关文件出现/消失/变化都改变戳（mtime 取最大、size 求和；旧名不再新增，碰撞面仅
 * 限「等量增删」的极端重叠，可接受）。
 *
 * 返回 null：三者皆不存在（未终态化）。
 */
export function statStateStamp(sessionFile: string): SidecarStat | null {
  let found = false;
  let mtimeMs = 0;
  let size = 0;
  for (const ext of [STATE_SIDECAR_EXT, LEGACY_FINALIZED_EXT, LEGACY_CANCELLED_EXT]) {
    try {
      const st = fs.statSync(`${sessionFile}${ext}`);
      found = true;
      mtimeMs = Math.max(mtimeMs, st.mtimeMs);
      size += st.size;
    } catch (_e) {
      void _e; // 该扩展名不存在——继续收集其余。
    }
  }
  return found ? { mtimeMs, size } : null;
}
