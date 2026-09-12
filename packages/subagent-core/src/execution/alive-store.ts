// src/execution/alive-store.ts
//
// .alive sidecar 生产者 + pid 探活。
//
// 子进程启动时写 .alive（pid+id+startedAt），心跳检测时读它 + isProcessAlive
// 判活。finalize/cancel 收尾时 remove。与宿主侧终态 sidecar（.state）构成两件套。
//
// 设计对齐 state-marker：单文件 sidecar、best-effort I/O、无全局 index。
//
// [U1 / D3 v7] `.alive` 角色重定义为「跨进程写权声明」：写/删面经 RecordStore 意图
// 原语归口（acquire = markResurrected / acquireWriteLease；release = markFinalized /
// markCancelled / markIdleArchived 内部删）；探针判据 = pid 单判据 + self-pid 排除
// （见 findForeignLiveInstance）。本模块头完整重写（含写权声明语义）归 P4a（D3d）。

import * as fs from "node:fs";

import { getLogger } from "../core/logger.ts";

import type { AliveMarker } from "./types.ts";

const logger = getLogger("subagents");

// ============================================================
// 常量
// ============================================================

/**
 * .alive marker 的软超时（1h，自 record-store.ts 迁移为共享常量）。
 *
 * [U1 / D3b 谱系 #12] 探针判据已退役软超时（findForeignLiveInstance 改 pid 单判据
 * ——跨轮保留 × startedAt 一次性不刷新的组合下，>1h idle 的在持声明会被误判陈旧，
 * 探针超时放行开双写窗）。本常量**保留不删**：现存消费点 = record-store.ts
 * buildRecord 分支 3 / refreshAlive 的 externalInstance 投影（随 P4a 读面收尾一并移除）。
 */
export const ALIVE_SOFT_TIMEOUT_MS = 3_600_000;

// ============================================================
// 公开函数
// ============================================================

/**
 * 在 sessionFile 旁写 .alive sidecar（单行 JSON，跨进程写权声明 acquire）。
 * 覆盖写——同一 sessionFile 只有最后一个 alive marker 有意义。
 * 失败原样上抛（IO 错不吞——acquire 失败 = 双写风险敞口，调用方响亮处理，D3c）。
 */
export function writeAliveMarker(sessionFile: string, marker: AliveMarker): void {
  const alivePath = `${sessionFile}.alive`;
  fs.writeFileSync(alivePath, `${JSON.stringify(marker)}\n`, "utf-8");
}

/**
 * 读 sessionFile 旁的 .alive sidecar。
 * 返回 undefined：不存在 / 损坏 / 解析失败。
 */
export function readAliveMarker(sessionFile: string): AliveMarker | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(`${sessionFile}.alive`, "utf-8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AliveMarker>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.id === "string" &&
      typeof parsed.startedAt === "number"
    ) {
      return parsed as AliveMarker;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 删除 sessionFile 旁的 .alive sidecar（写权声明 release）。
 * best-effort：不存在不抛（finalize/cancel 收尾调，sidecar 可能已被清理）；
 * 存在但删除失败（权限/磁盘错）warn 留痕——release 失败 = 残留声明可能误拦异宿主，
 * 排障需要线索（D3a：泄漏窗 = 至宿主退出，已接受但必须可见）。
 */
export function removeAliveMarker(sessionFile: string): void {
  try {
    fs.unlinkSync(`${sessionFile}.alive`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // 不存在 = 已释放（幂等终态，正常）
    logger.warn("[subagents] alive marker release failed (stale lease may block foreign hosts)", {
      detail: { sessionFile, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * 检测 pid 是否存活。
 *
 * process.kill(pid, 0) 语义：不发信号，仅检查进程是否存在。
 *   - 无异常 → 存活
 *   - ESRCH（No such process）→ 死
 *   - EPERM（Process exists but no permission）→ 存活（保守）
 *   - 其他异常 → 保守判死 false，避免误删活进程
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "EPERM") {
      return true; // 存在但无权限发信号 → 判活
    }
    return false; // ESRCH 或其他异常 → 保守判死
  }
}

/**
 * [v8.5 D → D3c/D3b v7] 异进程活实例探针：sessionFile 是否仍有「另一进程」持有的
 * 写权声明。调用方在 resurrect / fork-from 前必须经此确认无他方持有，防双写同一
 * session jsonl。
 *
 * 判据 = **pid 单判据 + self-pid 排除**（D3 v7，谱系 #12：软超时退役——跨轮保留 ×
 * startedAt 一次性不刷新的组合下，>1h idle 的在持声明会被误判陈旧，探针超时放行
 * 开双写窗）：
 *   - marker.pid === process.pid → undefined（self-pid 排除：本进程的自有声明视同
 *     无 foreign——消除本进程被自己 marker 拦死的重试死锁，D3c）；
 *   - marker.pid 活（isProcessAlive）→ marker（他方在持，拦截）；
 *   - pid 死 / marker 缺失/损坏 → undefined（确死/无声明，放行）。
 */
export function findForeignLiveInstance(sessionFile: string): AliveMarker | undefined {
  const marker = readAliveMarker(sessionFile);
  if (!marker) return undefined;
  if (marker.pid === process.pid) return undefined;
  if (!isProcessAlive(marker.pid)) return undefined;
  return marker;
}

// ============================================================
// 内部工具
// ============================================================

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
