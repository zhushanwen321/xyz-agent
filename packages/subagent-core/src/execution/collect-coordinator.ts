// src/execution/collect-coordinator.ts
//
// collectCoordinator：notifyComplete 唯一路由入口——async 直通 / sync 批缓冲 / 闭合检测
// （subagent-sync-collect 设计 §3.1.4 终态数据流 / D2 隐式批 / D5 service 层缓冲）。
//
// 职责（U2）：
//   route(record)：
//     - record.collectMode !== "sync" → deps.notifyAsync（现状 notifier.notify 路径，
//       执行序列逐字节一致，G3/A5 零回归）；
//     - record.collectMode === "sync" → deps.toNotifyRecord 终态快照登记入缓冲（内存，
//       登记时定格——record 对象后续可变不影响快照）→ 闭合检测。
//
//   闭合判定（⛔3 已核实 U1，impl-plan §7）：缓冲非空 && 无非终态 sync 成员。
//   「非终态」口径 = collectMode="sync" && 无 batchFinalized 标记 && status !== "closed"
//   ——池排队成员在 store.register 时即 status="running"，自动计入非终态（闭合等待它）；
//   batchFinalized=true 的已离场成员不阻止闭合。
//
//   跨轮续累（D2 隐式批）：缓冲跨多次 route 累积不清空（分两轮派 2+1 sync → 闭合时
//   单批三成员）；flush 后缓冲清空，后续 sync 成员自然开新批（语义 = "等所有 sync 待收"）。
//
// flush 注入式（U3 挂点）：deps.flushBatch 由宿主注入——U3 接 notifier.notifyBatch
//（单条批投递 + ledger sync-batch hash 写账 + batchFinalized 落标）；U2 生产缺省 =
// service 注入的逐条 async 降级投递（不丢通知的最小可用形态），测试注入 fake 断言
// 闭合条件。flush 同步 void：投递失败语义归 flush 实现方（与 notifier.notify 同风格）。
//
// 不变量：
//   - 每个成员只登记一次：notifyComplete 调用点自带 CAS/gate 单次性（与既有 notify
//     单次性同源——cancelBackground CAS 抢锁 / kickOffBackground.then gate / watchdog
//     CAS），协调器不重复去重，不改变 at-least-once 语义。
//   - toNotifyRecord 返回 undefined（gate 未过/非终态）→ 静默跳过不入缓冲，与 async
//     路径的静默跳过对称——调用点 gate 语义不变，协调器不重复判定。
//   - 闭合判定只敏感于「是否还有非终态 sync」：本条终态在 store 的可见性（archive 后
//     磁盘重建时序）不影响判定正确性。

import type { BgNotifyRecord } from "./notifier.ts";
import type { ExecutionRecord, SubagentRecord } from "./types.ts";

/** 闭合判定的全 record 扫描上限（service 冷路径 COLD_LOOKUP_SCAN_LIMIT 同量级）。 */
export const COLLECT_SCAN_LIMIT = 1000;

/** 协调器宿主依赖（全部注入——协调器零 service/store 直依，可独立单测）。 */
export interface CollectCoordinatorDeps {
  /** async 直通（现状 notifier.notify 路径，字节不变）。 */
  notifyAsync(record: ExecutionRecord): void;
  /** record → 通知快照（登记时定格）。undefined = gate 未过/非终态（静默跳过）。 */
  toNotifyRecord(record: ExecutionRecord): BgNotifyRecord | undefined;
  /** 全量 record 快照枚举（闭合判定数据源；service.collectRecords 同源过滤域）。 */
  listRecords(limit: number): SubagentRecord[];
  /** 批投递回调（闭合时触发，缓冲整体移交后清空）。U3 接 notifier.notifyBatch。 */
  flushBatch(members: BgNotifyRecord[]): void;
}

/** route 去向（测试/诊断断言用）。 */
export type CollectRouteResult =
  /** 非 sync record：notifyAsync 直通（现状路径）。 */
  | "async"
  /** gate 未过（toNotifyRecord undefined）：静默跳过，不入缓冲。 */
  | "sync-skipped"
  /** 入缓冲未闭合（仍有非终态 sync 成员）。 */
  | "sync-buffered"
  /** 入缓冲并触发闭合 flush（缓冲已移交 flushBatch 并清空）。 */
  | "sync-flushed";

export class CollectCoordinator {
  /** 批缓冲（内存）：已终态未 flush 的 sync 成员终态快照，跨 route 累积。 */
  private readonly buffer: BgNotifyRecord[] = [];

  constructor(private readonly deps: CollectCoordinatorDeps) {}

  /** notifyComplete 唯一路由入口。返回去向供测试/诊断断言。 */
  route(record: ExecutionRecord): CollectRouteResult {
    if (record.collectMode !== "sync") {
      this.deps.notifyAsync(record);
      return "async";
    }
    const snapshotRecord = this.deps.toNotifyRecord(record);
    if (!snapshotRecord) return "sync-skipped";
    this.buffer.push(snapshotRecord);
    return this.maybeFlush() ? "sync-flushed" : "sync-buffered";
  }

  /** 诊断/测试：当前缓冲成员数（= 已终态未 flush 的 sync 成员数）。 */
  get pendingCount(): number {
    return this.buffer.length;
  }

  /** 诊断/测试：缓冲成员快照（副本，非活引用）。 */
  pendingMembers(): BgNotifyRecord[] {
    return [...this.buffer];
  }

  /** 闭合检测 + flush：缓冲非空 && 无非终态 sync 成员 → 整体移交 flushBatch 并清空。 */
  private maybeFlush(): boolean {
    if (this.buffer.length === 0) return false;
    if (this.hasRunningSync()) return false;
    const members = this.buffer.splice(0, this.buffer.length);
    this.deps.flushBatch(members);
    return true;
  }

  /** 是否存在非终态 sync 成员（collectMode=sync && 无 batchFinalized && status 非 closed）。 */
  private hasRunningSync(): boolean {
    for (const record of this.deps.listRecords(COLLECT_SCAN_LIMIT)) {
      if (
        record.collectMode === "sync" &&
        record.batchFinalized !== true &&
        record.status !== "closed"
      ) {
        return true;
      }
    }
    return false;
  }
}
