// src/runtime/execution/record-store.ts
//
// Record 的统一容器。内存只留 running record；终态从 session.jsonl 重建。
//
// 职责：
//   - 持有 running record（终态 record 在 archive 时立即从内存移除）
//   - onChange 订阅（TUI widget/list 据此重渲）
//   - collectRecords：内存(running) + 磁盘(sessions/*.jsonl 重建) 合并
//   - 提供 snapshot() 只读视图给 TUI（永不返回可变引用）
//
// [perf] 两级读写设计（修复 /subagents 打开慢）：
//   1. 列表扫描 = light：只读文件头部 identity（readIdentityHeader，64KB）+ sidecar
//      状态矩阵，不解析 message entries。列表/补全/hasRunning 只需身份与状态，
//      586MB 级 sessions 目录的全量 JSON.parse（秒级）从列表路径上消失。
//   2. 详情 = getFullRecord(id) 懒加载：选中/单独查询时才对该文件全量重建
//      （reconstructFromFile），turns/eventLog/result 等重数据仅按需解析。
//   3. per-file 缓存 + stat 戳校验（mtime+size）：register/archive 等内存事件
//      不再整体失效缓存；任何磁盘写入（jsonl append / sidecar 覆盖）只重建对应
//      单文件，其余 N-1 个文件复用缓存（stat 校验毫秒级）。
//   4. [perf L-1] sessions-index.json（sessionsDir 兄弟位置）：identity 探测结果的
//      磁盘种子——冷启动首扫读一次（惰性装载），dirty 扫描后按 60s 节流落盘
//      （fileCache 投影，fire-and-forget）；运行期 L0/L1 语义不变，损坏/低版本
//      静默回退全扫，高版本忽略不重写。见 sessions-index.ts。

import * as fs from "node:fs";
import * as path from "node:path";

import { getLogger } from "@zhushanwen/pi-extension-logger";

import { getCurrentActivity, getDisplayItems, getEventLog, markReconstructedStatus, snapshot as toSnapshot } from "./execution-record.ts";
import { writeFinalized } from "./finalized-marker.ts";
import { toSubagentRecordEntry } from "./record-entry.ts";
import type { ManifestRecord, ManifestStore } from "./manifest-store.ts";
import { INDEX_WRITE_MIN_INTERVAL_MS, loadIndex, saveIndex } from "./sessions-index.ts";
import type { SessionsIndexEntry, SessionsIndexNegativeEntry } from "./sessions-index.ts";
import {
  IDENTITY_HEAD_BYTES,
  type IdentityHeaderRecon,
  type ReconstructedRecord,
  readIdentityAnywhere,
  readIdentityHeader,
  readIdentityTail,
  reconstructFromFile,
} from "./session-reconstructor.ts";
import type {
  AliveMarker,
  ExecutionRecord,
  ExecutionStatus,
  RecordSnapshot,
  SubagentRecord,
} from "./types.ts";
import type { CancelledTombstone } from "./tombstone-store.ts";
import { isProcessAlive, readAliveMarker } from "./alive-store.ts";
import { readCancelledTombstone } from "./tombstone-store.ts";

const logger = getLogger("subagents");

// ============================================================
// 常量
// ============================================================

/** status → 排序优先级（值小排前）：running < closed。
 *  v4 B-1：idle/cancelled 折入 running/closed，两态收敛。closed = 统一终态
 *  （done/failed/crashed/cancelled 合并），按 closedReason 派生对外语义。 */
const STATUS_PRIORITY: Record<ExecutionStatus, number> = {
  running: 0,
  closed: 3,
};

/** .alive sidecar 的 24 小时软超时（超过此时间即使 pid 存活也判 crashed）。 */
const ALIVE_SOFT_TIMEOUT_MS = 3_600_000; // 1h in ms (reduced from 24h to minimize PID reuse window)

/**
 * manifest status → ExecutionStatus 运行时守卫映射。
 *
 * manifest 写 running/closed/cancelled 三态（ManifestRecord.status union），但磁盘
 * 文件可能陈旧（含历史 "completed"/"failed"/"error" 值、被外部篡改）。越界值返回 null——
 * manifestToSubagent 据此返回 null，collectRecords 跳过损坏 record 并 console.warn，不因单个
 * 坏文件崩溃，也不把损坏 record 错误降级为 closed（closed 触发告警，是误报）。
 *
 * 提取为纯函数：同时解决 PR#85 反射问题（三元 + `as ExecutionStatus` cast）。
 * [HISTORICAL] SP-1 重构：旧 "completed" → closed，旧 "failed" → closed（L1 统一终态）。
 */
function mapManifestStatus(s: string): ExecutionStatus | null {
  if (s === "closed") return "closed";
  if (s === "completed") return "closed"; // 向后兼容旧 manifest 数据
  if (s === "failed") return "closed";     // 向后兼容旧 manifest 数据
  if (s === "running") return "running";
  if (s === "cancelled") return "closed"; // v4 B-1: manifest cancelled 折入 closed（closedReason 信息丢失，manifest 仅诊断辅助）
  return null; // 越界=数据损坏（含历史 "error" 值），返回 null 让调用方跳过
}

/** store 变更监听器（返回取消订阅函数）。 */
export type ChangeListener = () => void;

/** status 过滤模式（collectRecords 的核心能力参数）。 */
export type StatusFilter = "running" | "all";

/** 缓存校验戳（mtime+size 双因子——append-only jsonl 必变 size；sidecar 覆盖写必变 mtime）。 */
interface Stamp {
  mtimeMs: number;
  size: number;
}

/** sidecar 状态矩阵输入（buildLightRecord / getFullRecord 共享）。 */
interface SidecarMatrix {
  tomb: CancelledTombstone | undefined;
  finalized: boolean;
  alive: AliveMarker | undefined;
  /** jsonl mtime（light 分支 2 的 endedAt 近似——finalize 后文件不再变化）。 */
  jsonlMtimeMs: number;
  /** 全量重建可得的精确结束时间（最后 entry ts）；light 传 undefined 回落 mtime。 */
  fullEndedAt?: number;
  now: number;
}

/**
 * per-file 缓存条目（[perf] 两级设计）。
 *
 *   light：头部 identity + sidecar 状态矩阵（列表扫描产出，详情字段缺省）
 *   full ：懒加载的完整重建（getFullRecord 按需补 turns/eventLog/result）。
 *          full === light 是哨兵（「已尝试但无详情可补」，如无 assistant message
 *          的文件），避免重复全文重读；stat 戳变化时随 light 一起重置重试。
 *
 * 校验：jsonl + 3 sidecar 的 stat 戳对比。任何写操作至少改变一个戳 →
 * 只重建该文件，其余 N-1 个复用缓存（statSync 毫秒级，取代旧的整体失效重扫）。
 */
interface FileCacheEntry {
  /** tagged union 判别（负缓存条目为 true）。显式声明 false 供 TS narrowing。 */
  negative?: false;
  light: SubagentRecord;
  full: SubagentRecord | undefined;
  jsonl: Stamp;
  cancelled: Stamp | null;
  finalized: Stamp | null;
  alive: Stamp | null;
  /** 最近一次重建时读到的 sidecar 原始内容（校验命中路径复用，不重读文件）。 */
  tomb: CancelledTombstone | undefined;
  aliveData: AliveMarker | undefined;
}

/** 负缓存条目：确认无 identity 的文件（损坏/异构）。缓存「没有」这一事实，
 *  避免每轮扫描都全文 fallback 重读（全文读是 fallback 的成本主体）。 */
interface NegativeFileEntry {
  negative: true;
  jsonl: Stamp;
  cancelled: Stamp | null;
  finalized: Stamp | null;
  alive: Stamp | null;
}

/** fileCache 值类型：正常条目或负缓存条目。 */
type FileCacheValue = FileCacheEntry | NegativeFileEntry;

/** 孤儿判定的末行读取窗口：64KB 足以容纳任何单行 entry（identity 含 task 全文上限
 *  ~62KB 已实测），避免全文件读。 */
// eslint-disable-next-line no-magic-numbers -- 64KB = 64 * 1024 bytes 字节换算常数
const LAST_LINE_WINDOW_BYTES = 64 * 1024;

/**
 * 读 JSONL 文件的最后一个非空行（孤儿终态判定用，residual-fixes §5.2）。
 * 只读文件尾部窗口（大文件不全读）。返回 ok=false 表示 IO 错误（open/read 阶段抛出，
 * 含权限/磁盘故障——可能是暂时状态，调用方按保守方向处理）。
 */
function readLastJsonlLine(sessionFile: string): { ok: true; line: string } | { ok: false } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(sessionFile, "r");
    const size = fs.fstatSync(fd).size;
    const windowStart = Math.max(0, size - LAST_LINE_WINDOW_BYTES);
    const buf = Buffer.alloc(size - windowStart);
    fs.readSync(fd, buf, 0, buf.length, windowStart);
    const text = buf.toString("utf-8");
    // 尾窗口可能从行中间开始——丢掉第一段（除非文件整体小于窗口，此时首段即完整首行）。
    const lines = text.split("\n").filter((l) => l.length > 0);
    const candidates = windowStart > 0 && lines.length > 0 ? lines.slice(1) : lines;
    const last = candidates.length > 0 ? candidates[candidates.length - 1] : lines[lines.length - 1];
    if (last === undefined) return { ok: true, line: "" }; // 空文件：视为不可判终态的截断形态由 parse 失败兜住
    return { ok: true, line: last };
  } catch {
    return { ok: false };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_e) {
        void _e; // 关闭失败不影响已读结果（对齐 finalized-marker best-effort 模式）
      }
    }
  }
}

/** stat 戳（不存在 → null）。 */
function statStamp(p: string): Stamp | null {
  try {
    const s = fs.statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

function sameStamp(a: Stamp, b: Stamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function sameNullableStamp(a: Stamp | null, b: Stamp | null): boolean {
  if (a === null || b === null) return a === b;
  return sameStamp(a, b);
}

/** Pi ExtensionAPI 的最小子集（仅 collectRecords 跳过损坏 manifest 时上报用）。
 *  解构为局部类型，避免与 subagent-service 的 PiLike 循环依赖。 */
export type RecordStorePi = {
    appendEntry?: (customType: string, data: unknown) => void;
} | null | undefined;

// ============================================================
// RecordStore
// ============================================================

/**
 * Record 容器。进程单例（随 SubagentService 重建）。
 *
 * 内存只留 running record——终态 record 在 archive 时立即移除，collectRecords
 * 读时从 sessions/*.jsonl 重建（[perf] light 头部扫描 + per-file 缓存）。
 *
 * 任何 mutate → notifyChange()（仅通知监听器；磁盘缓存靠 stat 戳自校验，不清空）。
 */
export class RecordStore {
  private readonly records = new Map<string, ExecutionRecord>();
  private readonly listeners = new Set<ChangeListener>();
  private _disposed = false;
  /** 孤儿终态恢复的已判定缓存（residual-fixes）：resumable 形态无 sidecar 锚，同进程重复调用跳过。 */
  private orphanJudged = new Set<string>();
  /** Pi handle（用于 appendEntry 上报损坏 manifest）。构造时可空，setPi() 后续注入。
   *  显式存为字段而非构造参数 readonly：setPi 需要写权限。 */
  private pi: RecordStorePi = null;

  /** [perf] per-file 缓存（key = sessionFile 绝对路径）。不再整体失效——stat 戳精准校验。
   *  值含负缓存（确认无 identity 的文件），防每轮全文 fallback 重读。 */
  private readonly fileCache = new Map<string, FileCacheValue>();
  /** record id → sessionFile 索引（getFullRecord 按 id 定位文件）。随 fileCache 同步维护。 */
  private readonly idToFile = new Map<string, string>();
  /** [perf] sessionsDir 最近一次全量扫描的 mtime（快路径判变，见 reconstructAll）。
   *  null = 未扫过 / 已 dispose。 */
  private dirStamp: { mtimeMs: number } | null = null;

  /** [perf L-1] 首扫惰性装载的磁盘索引只读映像（key = jsonl basename）。
   *  扫描尾（flushIndexAfterScan）与 readdir 失败路径释放——运行期索引不再被读（L1 接管）。 */
  private indexEntries: Map<string, SessionsIndexEntry | SessionsIndexNegativeEntry> | null = null;
  /** [perf L-1] 本轮起未落盘的探测标志：scanFile 走过探测分支即置位。发起写时消费
   *  （置 false）、写失败恢复；未写路径不清位——未落盘的探测成果跨轮携带直至真正写入。 */
  private indexDirty = false;
  /** [perf L-1] 上次成功落盘墙钟（节流基准）。0 = 从未写过 → 首扫 dirty 必写；
   *  仅成功分支推进（写失败不推进节流窗，下轮过窗重试）。 */
  private lastIndexWriteAt = 0;
  /** [perf L-1] loadIndex 高版本标志的进程级持久态：true 时本进程所有后续扫描均不
   *  落盘（防 v1/v2 last-writer-wins 覆盖振荡），直至下次 loadIndex 重新评估。 */
  private indexHigherVersion = false;

  constructor(
    private readonly sessionsDir: string,
    private readonly manifestStore?: ManifestStore,
    /** Pi 入口（注入 appendEntry 用于上报损坏 manifest）。
     *  SubagentService 构造时 this.pi 尚未注入（session_start 之前），传 undefined 兜底；
     *  后续通过 setPi() 注入（见下）。允许 null = 兼容 PiLike 字段类型。 */
    pi?: RecordStorePi,
  ) {
    this.pi = pi ?? null;
  }

  /** session_start 后由 SubagentService.initSession 调，注入真实 Pi handle。
   *  设计为独立方法而非要求构造时必传——RecordStore 在 SubagentService 构造时即建
   *  （与 sessionsDir/manifestStore 一同初始化），但 this.pi 此时尚未注入。
   *  后续构造期外的 appendEntry 上报才有意义。 */
  setPi(pi: RecordStorePi): void {
    this.pi = pi ?? null;
  }

  /** 注册新 record。触发 onChange。
   *  W16 [D4]：record 诞生（→ running）即 append 自描述快照 entry——pi 文件是
   *  扩展数据持久化权威，custom entry 不进 LLM context。 */
  register(record: ExecutionRecord): void {
    this.records.set(record.id, record);
    this.pi?.appendEntry?.("subagent-record", toSubagentRecordEntry(RecordStore.recordToSubagent(record)));
    this.notifyChange();
  }

  /**
   * 归档：record 已被 completeRecord 设置了终态 status。
   * 立即从内存移除（终态 record 下次读时从 session.jsonl 重建）。
   * cancelled record 由调用方先写 tombstone（cancel 路径），此处只负责移除。
   *
   * W16 [D4]：终态冻结字段（result/endedAt/closedReason）在 completeRecord 已就绪，
   * 此处 append 的快照即完整终态记录（所有终态路径的必经锚点）。
   */
  archive(record: ExecutionRecord): void {
    this.records.delete(record.id);
    this.pi?.appendEntry?.("subagent-record", toSubagentRecordEntry(RecordStore.recordToSubagent(record)));
    this.notifyChange();
  }

  /**
   * W16 [D4]：类外状态写点上报（record-store 内的迁移点 register/archive 已内置）。
   *
   * 供 service 层直接改 record.status 的恢复写点调用（chatMode 续轮 idle→running
   * 冷路径 resumeRound、轮终 finalizeRoundToIdle 回 running-resumable）——这些
   * 写点绕过 register/archive，若不显式上报，pi 文件缺失该次迁移、重建源滞后。
   * pi 未注入（session_start 前）时可选链静默降级，不阻断主流程。
   */
  reportRecordTransition(record: ExecutionRecord): void {
    this.pi?.appendEntry?.("subagent-record", toSubagentRecordEntry(RecordStore.recordToSubagent(record)));
  }

  /** 按 id 查找。返回可变 record（仅 runtime 内部用）。 */
  getMutable(id: string): ExecutionRecord | undefined {
    return this.records.get(id);
  }

  /**
   * abort 所有 running record 的 controller（background 子进程 SIGTERM）。
   *
   * 仅在 SubagentService.dispose（进程退出路径）调用。不做 CAS/tombstone——dispose
   * 是终局，状态机收尾无意义；目的是让 background 子进程的 AbortSignal 触发 →
   * runSpawn 的 signal listener → child.kill("SIGTERM")，防止主进程退出后子进程成孤儿。
   *
   * sync record 无 controller（undefined），跳过——sync 是阻塞调用，主进程不会先于
   * sync subagent 退出（除非 SIGKILL/崩溃，此时任何清理都无效）。
   *
   * 返回被 abort 的 record 数（诊断用）。
   */
  abortRunningControllers(): number {
    let n = 0;
    for (const r of this.records.values()) {
      if (r.status === "running" && r.controller) {
        r.controller.abort();
        n++;
      }
    }
    return n;
  }

  /** 列出所有 running record 的只读快照（widget 计数、诊断用）。 */
  listRunning(): RecordSnapshot[] {
    return [...this.records.values()]
      .filter((r) => r.status === "running")
      .map((r) => toSnapshot(r));
  }

  /** SP-4: 列出所有活跃 record（running + idle）的可变引用。
   *  供 SubagentService.disposeAllRecords 做级联关闭。 */
  listAllActive(): ExecutionRecord[] {
    return [...this.records.values()]
      .filter((r) => r.status === "running");
  }

  /**
   * 合并内存(running) + 磁盘(sessions/*.jsonl 重建) → SubagentRecord[]。
   *
   *   ╔══════════════════════════════════════════════════════════════════╗
   *   ║  1. 磁盘源：扫 sessionsDir 的 .jsonl，逐个 scanFile（[perf] 头部    ║
   *   ║     identity 轻量重建 + stat 戳缓存命中零读取）。cancelled          ║
   *   ║     tombstone override status。详情字段（eventLog/result/turns）    ║
   *   ║     缺省，由 getFullRecord(id) 懒加载                              ║
   *   ║  2. 内存源覆盖（同 id 内存优先——running record 更新鲜）          ║
   *   ║  3. session 过滤：只留 rootSessionId === rootSessionFilter 的       ║
   *   ║     record。rootSessionId 缺失（旧文件）的 record 一律排除        ║
   *   ║     （无法判定归属，隔离优先）。rootSessionFilter 为 undefined       ║
   *   ║     时不过滤（向后兼容）。                                          ║
   *   ║  4. statusFilter："running" → 只留 running（内存源）；            ║
   *   ║                   "all"（默认）→ 内存 + 磁盘                       ║
   *   ║  5. 排序：STATUS_PRIORITY + startedAt desc                        ║
   *   ║  6. slice(limit)                                                  ║
   *   ╚══════════════════════════════════════════════════════════════════╝
   *
   * statusFilter="running" 时仍先取够多再过滤（防 limit 截断把 running 滤没），
   * 与旧 listHandler 的防截断逻辑一致，下沉到此。
   *
   * session 隔离：同一 cwd 下多个 Pi session 共享 sessionsDir，靠 rootSessionId
   * 区分。内存与磁盘源都按 rootSessionFilter 过滤后再 merge/sort/slice。
   */
  collectRecords(
    limit: number,
    statusFilter: StatusFilter = "all",
    rootSessionFilter?: string,
  ): SubagentRecord[] {
    const byId = new Map<string, SubagentRecord>();

    // 1. 磁盘源（重建终态 record）。 reconstructAll 已按 rootSessionFilter 过滤。
    for (const rec of this.reconstructAll(rootSessionFilter)) {
      byId.set(rec.id, rec);
    }

    // 1.5 FR-8: manifest 源补充 orphan 记录。
    // 优先级：内存 > 磁盘重建 > manifest。manifest 仅补充 session.jsonl 重建失败的记录。
    if (this.manifestStore) {
      for (const manifest of this.readManifestsSync()) {
        if (byId.has(manifest.id)) continue; // 已被磁盘/内存源覆盖
        if (rootSessionFilter !== undefined && manifest.rootSessionId !== rootSessionFilter) continue;
        const rec = RecordStore.manifestToSubagent(manifest);
        if (!rec) {
          // manifest status 越界=数据损坏（含历史 "error"、意外 crashed 值）：跳过而非降级 failed，
          // 避免损坏 record 被误显示为 failed（触发错误重试/告警）。
          // 双通道上报：logger.warn 给开发者（事后排查，appendEntry 持久化，不显 TUI）；
          // pi.appendEntry 给用户（session 内可见，即使退出后也能从 session.jsonl 复盘事故原因）。
          // SubagentService 构造时 pi 未注入（session_start 之前），appendEntry 走可选链安全降级。
          logger.warn("[subagents] skip manifest with invalid status", {
            detail: { id: manifest.id, status: manifest.status },
          });
          this.pi?.appendEntry?.("subagent:manifest-invalid-status", {
            id: manifest.id,
            status: manifest.status,
            rootSessionId: manifest.rootSessionId,
            agentName: manifest.agentName,
          });
          continue;
        }
        byId.set(rec.id, rec);
      }
    }

    // 2. 内存源覆盖（running record 优先——它是活态，比磁盘重建更新鲜）。同样按 session 过滤。
    for (const r of this.records.values()) {
      if (rootSessionFilter !== undefined && r.rootSessionId !== rootSessionFilter) continue;
      byId.set(r.id, RecordStore.recordToSubagent(r));
    }

    // 3. statusFilter。
    let result = [...byId.values()];
    if (statusFilter === "running") {
      result = result.filter((r) => r.status === "running");
    }

    // 4-5. 排序 + slice。
    return result
      .sort(RecordStore.compareRecords)
      .slice(0, limit);
  }

  // ── 孤儿终态恢复（residual-fixes 设计 §6.1.2）──────────────────

  /**
   * 重建 SubagentRecord 的自描述 entry 落盘入口（签名适配：reportRecordTransition 收
   * ExecutionRecord，重建孤儿的数据源是 SubagentRecord——直接经 toSubagentRecordEntry
   * 投影 appendEntry，绕过 recordToSubagent）。pi 未注入时可选链静默。
   */
  reportSubagentRecord(record: SubagentRecord): void {
    this.pi?.appendEntry?.("subagent-record", toSubagentRecordEntry(record));
  }

  /**
   * 孤儿终态恢复：对重建矩阵分支 4 兜底（running 且无 externalInstance）的 record
   * 判定真实终态并落 entry，消除「父扩展死后再无人写终态 → 侧栏永久 running」。
   *
   * 判定（residual-fixes §5.2 三判据 + chat 分流）：
   * - chatMode = true → 不终态化（跨重启可续聊是产品语义，v4 B-1），落 resumable
   *   entry 供侧栏 waiting 细分；
   * - 子 JSONL 末行完整 JSON.parse → closed（closedReason=gc，与分支 2 重建映射一致；
   *   done/failed 细分由 error 字段经 deriveClosedDisplay 派生）+ 写 .finalized sidecar
   *   （防重锚——下次重建走分支 2 不再进判定）；
   * - 末行截断 → closed + error（保守，错误方向安全）+ sidecar；
   * - 文件不可读（IO 错误，可能暂时）→ 不判终态，落 resumable entry（防御性路径，
   *   IO 恢复后重开可重判）。
   *
   * 防重：orphanJudged 实例级缓存（resumable 形态无 sidecar 锚，同进程重复调用跳过；
   * 终态形态双重防护 = sidecar + 缓存）。调用方：index.ts session_start 恢复段（一次）。
   */
  recoverOrphanRecords(rootSessionFilter?: string): void {
    for (const rec of this.reconstructAll(rootSessionFilter)) {
      // 分支 4 命中集 = running 且无活进程实例（分支 3 带 externalInstance，分支 1/2 已 closed）。
      if (rec.status !== "running" || rec.externalInstance !== undefined) continue;
      if (this.orphanJudged.has(rec.id)) continue;
      this.orphanJudged.add(rec.id);

      if (rec.chatMode === true) {
        // chat 会话跨重启等续聊：保留 running（可续聊），仅落执行态信号。
        this.reportSubagentRecord({ ...rec, resumable: true });
        continue;
      }
      const sessionFile = rec.sessionFile;
      if (sessionFile === undefined) continue; // 无子文件锚，无从判定（防御）
      const lastLine = readLastJsonlLine(sessionFile);
      if (!lastLine.ok) {
        // IO 错误可能暂时——判终态不可逆，保守落 resumable 等重开重判。
        this.reportSubagentRecord({ ...rec, resumable: true });
        continue;
      }
      let parseOk = false;
      try {
        JSON.parse(lastLine.line);
        parseOk = true;
      } catch {
        parseOk = false;
      }
      // .finalized sidecar：防重锚（同 doFinalizeRecord 终态路径的收尾标记）。
      writeFinalized(sessionFile);
      this.reportSubagentRecord({
        ...rec,
        status: "closed",
        closedReason: "gc",
        endedAt: Date.now(),
        ...(parseOk ? {} : { error: "orphan recovery: subagent session ended abnormally (truncated last line)" }),
      });
    }
  }

  /** 订阅变更。返回取消订阅函数。 */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 触发所有监听器（TUI widget/list requestRender）。dispose 后短路。
   *  [perf] 不清空磁盘缓存：per-file stat 戳自校验（任何磁盘写入改变戳 → 单文件重建），
   *  内存事件（register/archive）不改变磁盘文件——旧实现整体失效是全量重扫的根因。 */
  notifyChange(): void {
    if (this._disposed) return;
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** session 结束清理。 */
  dispose(): void {
    this._disposed = true;
    this.listeners.clear();
    this.fileCache.clear();
    this.idToFile.clear();
    this.dirStamp = null;
    this.orphanJudged.clear();
    // [perf L-1] 索引状态重置为初始值（「清内存」语义完备）。不取消挂起的 fire-and-forget
    // 写——in-flight 写的丢失显式接受（revive 后 dirStamp===null 重扫会重新装载/重写）。
    this.indexEntries = null;
    this.indexDirty = false;
    this.lastIndexWriteAt = 0;
    this.indexHigherVersion = false;
  }

  /** /resume /fork /new 后复活（dispose 的逆操作）。 */
  revive(): void {
    this._disposed = false;
  }

  // ── 内部 ──────────────────────────────────────────────────

  /**
   * 四分支 sidecar 矩阵重建（[perf] light 版）。
   *
   * 优先级：
   *   1. .cancelled → closed（closedReason=cancelled）
   *   2. .finalized → closed（closedReason=gc）
   *   3. .alive + pid 存活 + 未超软超时 → running, externalInstance=true
   *   4. 兜底（无 marker、pid 死、超时）→ running（v4 B-1 可续聊语义）
   *
   * [perf]：逐文件 scanFile（stat 戳校验 + 头部 identity 轻量重建）。命中缓存的
   * 文件零文件读取；变化的文件只重建自身，其余 N-1 个复用缓存。
   *
   * session 隔离：rootSessionFilter 非空时，只保留 rootSessionId 匹配的 record。
   * rootSessionId 缺失（旧文件，未带身份字段）一律排除（无法判定归属）。
   */
  private reconstructAll(rootSessionFilter?: string): SubagentRecord[] {
    // [perf] 目录 mtime 快路径：sessionsDir mtime 未变 ⇒ 文件集合与 sidecar 集合都未变
    //（任何文件新建/删除/重命名都改目录 mtime），且 jsonl append 不影响 light 态
    //（identity/status 由首行与 sidecar 决定，进度重数据走 getFullRecord 的独立 stat
    //校验）→ 跳过 readdir + N×4 statSync，直接复用缓存 light。/subagents overlay 打开
    //期间 250ms 动画 timer + 120ms debounce 双驱动高频扫描，快路径把 ~N×4 stat 降到
    // 1 次（目录本身）+ 少量 pid 探活（refreshAlive，内存无 IO）。
    // 已知局限（与 mtime 缓存同族）：目录 mtime 粒度粗糙的文件系统（NFS/2s FAT）
    // 可能漏判——APFS 微秒级可靠。invalidate 语义由文件写入侧保证，但**仅限 sidecar
    // 新建/删除/重命名**（这些操作必改目录 mtime）；覆盖写已存在的 sidecar 不改目录
    // mtime——`.alive` 覆盖写（resume spawn 后 pid 变化重写 marker）后快路径会复用旧
    // aliveData（旧 pid/旧 startedAt），refreshAlive 探活与 1h 软超时判定可能滞后一拍
    //（status 判定不受影响：分支 3 探活失败只清 externalInstance，不改 status）。
    let dirMtimeMs: number;
    try {
      dirMtimeMs = fs.statSync(this.sessionsDir).mtimeMs;
    } catch {
      return [];
    }
    // [perf L-1] 首扫（dirStamp===null）惰性装载磁盘索引。必须位于 statSync 之后：
    // sessionsDir 不存在的 early-return 不装载映像（防解析产物滞留内存）；首扫时
    // 下方快路径条件必不成立，插在快路径 if 前后等价。
    if (this.dirStamp === null) {
      const loaded = loadIndex(path.dirname(this.sessionsDir));
      this.indexEntries = loaded.entries;
      this.indexHigherVersion = loaded.higherVersion;
    }
    if (this.dirStamp !== null && this.dirStamp.mtimeMs === dirMtimeMs) {
      const now = Date.now();
      const out: SubagentRecord[] = [];
      for (const entry of this.fileCache.values()) {
        if (entry.negative) continue;
        RecordStore.refreshAlive(entry, now);
        out.push(entry.light);
      }
      return rootSessionFilter === undefined
        ? out
        : out.filter((r) => r.rootSessionId === rootSessionFilter);
    }

    let files: string[];
    try {
      files = fs.readdirSync(this.sessionsDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => path.join(this.sessionsDir, f));
    } catch {
      this.indexEntries = null; // [perf L-1] 该 early-return 路径同样释放映像（内存卫生）
      return [];
    }

    // 修剪：磁盘上已消失的文件（GC/手动删）同步移出缓存与索引。删了条目必须置
    // indexDirty——否则纯修剪轮（无其他探测）flush 第一道门 !dirty return，磁盘索引的
    // 陈旧条目永不清除（fileCache 已删仅影响内存投影，落盘快照不会自发跟随）。
    const disk = new Set(files);
    for (const [file, entry] of this.fileCache) {
      if (!disk.has(file)) {
        this.fileCache.delete(file);
        if (!entry.negative) this.idToFile.delete(entry.light.id);
        this.indexDirty = true;
      }
    }

    const now = Date.now();
    const out: SubagentRecord[] = [];
    for (const file of files) {
      const entry = this.scanFile(file, now);
      if (entry) out.push(entry.light);
    }
    this.dirStamp = { mtimeMs: dirMtimeMs };
    this.flushIndexAfterScan();
    if (rootSessionFilter === undefined) return out;
    return out.filter((r) => r.rootSessionId === rootSessionFilter);
  }

  /**
   * 扫描单文件：stat 戳（jsonl + 3 sidecar）校验，全同 → 复用缓存（零文件读取，
   * 含负缓存直接返回 null）；否则重建 light。
   * identity 定位两级：头部 64KB（首轮会话）→ 全文 fallback（续聊场景 identity
   * append 在尾部）；两级都找不到 → 写负缓存（防每轮全文重读）。
   * 返回 null：文件消失/读失败/无 identity → 跳过。
   */
  private scanFile(file: string, now: number): FileCacheEntry | null {
    const jsonl = statStamp(file);
    if (!jsonl) {
      this.fileCache.delete(file);
      return null;
    }
    const cancelled = statStamp(`${file}.cancelled`);
    const finalized = statStamp(`${file}.finalized`);
    const alive = statStamp(`${file}.alive`);

    const cached = this.fileCache.get(file);
    if (
      cached !== undefined &&
      sameStamp(cached.jsonl, jsonl) &&
      sameNullableStamp(cached.cancelled, cancelled) &&
      sameNullableStamp(cached.finalized, finalized) &&
      sameNullableStamp(cached.alive, alive)
    ) {
      if (cached.negative) return null; // 负缓存命中：确认无 identity，零读取跳过
      // pid 探活结果不落盘（进程死亡无 IO）——分支 3 的 running 项每扫重查，
      // 保留原语义（旧实现每次 collectRecords 都重新 isProcessAlive）。
      RecordStore.refreshAlive(cached, now);
      return cached;
    }

    // [perf L-1] 磁盘索引查询（首扫惰性装载，miss/空索引时 get 恒 undefined = 无索引）。
    // 条目戳匹配 jsonl 当前 stat → 零内容读取构造缓存条目。sidecar payload（tombstone/
    // alive）是活态数据，沿用探测分支的每轮重读语义。
    if (this.indexEntries !== null) {
      const hit = this.indexEntries.get(path.basename(file));
      if (hit !== undefined && hit.mtimeMs === jsonl.mtimeMs && hit.size === jsonl.size) {
        if (hit.negative === true) {
          // 负条目命中：「确认无 identity」跨实例持久，零探测跳过（与下方负缓存同款形态）。
          this.fileCache.set(file, { negative: true, jsonl, cancelled, finalized, alive });
          return null;
        }
        const tomb = cancelled !== null ? readCancelledTombstone(file) : undefined;
        const aliveData = alive !== null ? readAliveMarker(file) : undefined;
        const entry: FileCacheEntry = {
          light: RecordStore.buildRecord(
            { ...hit, forkDepth: undefined, sessionFile: file },
            { tomb, finalized: finalized !== null, alive: aliveData, jsonlMtimeMs: jsonl.mtimeMs, now },
          ),
          full: undefined,
          jsonl,
          cancelled,
          finalized,
          alive,
          tomb,
          aliveData,
        };
        this.fileCache.set(file, entry);
        this.idToFile.set(hit.id, file);
        return entry;
      }
    }

    // [perf L-1] 索引 miss/戳不匹配落到原三级探测：本轮探测结果必须进索引（含负探测）。
    // 覆盖两种形态：首扫（映像已装载但 miss/不匹配）与后续轮次（映像已释放，凡进重建分支必是戳变化）。
    this.indexDirty = true;

    // 重建：identity 三级定位——头部 64KB（首轮会话，~34%）→ 尾部 64KB（续聊场景
    // 最后一轮 session_start 追加，~65%）→ 全文 fallback（~0.2%）。均不解析 message entries。
    // size ≤ 头部读取上限时 head 读到的即全文，tail/anywhere 只会重复读同一份内容——
    // 直接判负（head miss = 全文无 identity），省去同内容两连读。
    const header =
      jsonl.size <= IDENTITY_HEAD_BYTES
        ? readIdentityHeader(file)
        : readIdentityHeader(file) ?? readIdentityTail(file) ?? readIdentityAnywhere(file);
    if (!header) {
      // 负缓存：确认无 identity。后续扫描 stat 命中直接跳过；戳变化（文件补写）自动重试。
      this.fileCache.set(file, { negative: true, jsonl, cancelled, finalized, alive });
      return null;
    }
    const tomb = cancelled !== null ? readCancelledTombstone(file) : undefined;
    const aliveData = alive !== null ? readAliveMarker(file) : undefined;
    const entry: FileCacheEntry = {
      light: RecordStore.buildRecord(header, {
        tomb,
        finalized: finalized !== null,
        alive: aliveData,
        jsonlMtimeMs: jsonl.mtimeMs,
        now,
      }),
      full: undefined,
      jsonl,
      cancelled,
      finalized,
      alive,
      tomb,
      aliveData,
    };
    this.fileCache.set(file, entry);
    this.idToFile.set(header.id, file);
    return entry;
  }

  /**
   * [perf L-1] 扫描尾索引落盘（节流）：释放映像 → dirty/高版本/60s 节流窗三重门 →
   * fire-and-forget saveIndex（fileCache 全量投影）。写决策与发起在同步栈（collectRecords
   * 返回后不会再有本轮写）；仅写完成的回调（推进节流窗）是异步的。所有 return 路径均
   * 不清 dirty——未落盘的探测成果跨轮携带，直至真正写入。
   *
   * 并发安全：节流基准只在写成功后推进，W1 在途时新一轮过窗扫描可再 dispatch W2（不做
   * 进程内排队——fire-and-forget 语义保持）。安全性由 saveIndex 的 tmp 唯一性
   * （pid+单调序号）保证：交错 rename 的终态必为某一次的完整快照（last-writer-wins，
   * 陈旧快照胜出时下轮戳不匹配自愈），不依赖本方法串行化。
   */
  private flushIndexAfterScan(): void {
    this.indexEntries = null; // 释放映像：运行期索引不再被读（L1 接管）
    if (!this.indexDirty) return; // 纯命中轮零探测，不写
    if (this.indexHigherVersion) return; // 磁盘是更高版本：只忽略不重写（防 v1/v2 互相覆盖）
    if (Date.now() - this.lastIndexWriteAt < INDEX_WRITE_MIN_INTERVAL_MS) return; // 60s 节流窗内
    const entries = this.projectIndexEntries();
    this.indexDirty = false; // 发起时消费（写失败在 .catch 恢复）
    const encDir = path.dirname(this.sessionsDir);
    saveIndex(encDir, { entries })
      .then(() => {
        this.lastIndexWriteAt = Date.now(); // 仅成功分支推进节流窗
      })
      .catch((err: unknown) => {
        this.indexDirty = true; // 失败恢复 dirty，下轮过窗重试
        logger.debug("[subagents] sessions-index write failed", {
          detail: { dir: encDir, error: err instanceof Error ? err.message : String(err) },
        });
      });
  }

  /**
   * [perf L-1] fileCache 全量投影 → 索引快照（basename → 正/负条目）。
   * 投影式单一 SSOT：不维护第二份可变索引映像（防双轨漂移）；fileCache 已被
   * reconstructAll 修剪掉消失文件（修剪时置 indexDirty），下次过窗写时快照清除
   * 磁盘上的陈旧条目。
   */
  private projectIndexEntries(): Map<string, SessionsIndexEntry | SessionsIndexNegativeEntry> {
    const entries = new Map<string, SessionsIndexEntry | SessionsIndexNegativeEntry>();
    for (const [file, cached] of this.fileCache) {
      const base = path.basename(file);
      if (cached.negative) {
        entries.set(base, { negative: true, mtimeMs: cached.jsonl.mtimeMs, size: cached.jsonl.size });
      } else {
        entries.set(base, {
          mtimeMs: cached.jsonl.mtimeMs,
          size: cached.jsonl.size,
          id: cached.light.id,
          agent: cached.light.agent,
          mode: cached.light.mode,
          task: cached.light.task,
          slug: cached.light.slug,
          startedAt: cached.light.startedAt,
          rootSessionId: cached.light.rootSessionId,
          parentRecordId: cached.light.parentRecordId,
          depth: cached.light.depth,
          model: cached.light.model,
          thinkingLevel: cached.light.thinkingLevel,
        });
      }
    }
    return entries;
  }

  /**
   * [perf] byId 索引直查 light record（单文件 stat 校验，不触发 getFullRecord 的
   * 全量重建）。idToFile 未热（进程重启后尚未扫描过）时返回 undefined，调用方
   * 自行兜底全目录扫描——用于把「跨重启后每条 message 一次 collectRecords 全扫」
   * 降为 O(1) 索引命中。
   */
  findLightById(id: string): SubagentRecord | undefined {
    const file = this.idToFile.get(id);
    if (!file) return undefined;
    return this.scanFile(file, Date.now())?.light;
  }

  /**
   * [perf] 单 record 详情懒加载：内存 running record 投影全量；磁盘 record 全量重建
   * （reconstructFromFile）并套用同一 sidecar 状态矩阵。结果缓存在 FileCacheEntry.full，
   * stat 戳变化时随 light 一起失效。列表 collectRecords 返回 light（无 eventLog/
   * result/turns 等重数据），详情面板/工具 list 按需调本方法补齐。
   *
   * 返回 undefined：id 不存在（内存与磁盘均无）。reconstructFromFile 失败（无
   * assistant message 等）→ 返回 light（无详情可补，缓存哨兵防重复全文重读）。
   */
  getFullRecord(id: string): SubagentRecord | undefined {
    // 内存 running record 天然全量（recordToSubagent 投影完整活态数据）。
    const mem = this.records.get(id);
    if (mem) return RecordStore.recordToSubagent(mem);

    const file = this.idToFile.get(id);
    if (!file) return undefined;
    const entry = this.scanFile(file, Date.now());
    if (!entry) return undefined;
    if (entry.full === undefined) {
      const recon = reconstructFromFile(file);
      if (recon) {
        entry.full = RecordStore.buildRecord(recon, {
          tomb: entry.tomb,
          finalized: entry.finalized !== null,
          alive: entry.aliveData,
          jsonlMtimeMs: entry.jsonl.mtimeMs,
          fullEndedAt: recon.endedAt,
          now: Date.now(),
        });
      } else {
        entry.full = entry.light; // 哨兵：无详情可补，后续直取 light（戳变化时重置重试）
      }
    }
    return entry.full;
  }

  /** alive 探活刷新（scanFile 缓存命中与 reconstructAll 快路径共用）：
   *  分支 3 的 running + alive 条目每扫重查 pid（结果不落盘，进程死亡无 IO），
   *  保留旧实现「每次 collectRecords 重新 isProcessAlive」的语义。 */
  private static refreshAlive(entry: FileCacheEntry, now: number): void {
    if (entry.alive === null || entry.light.status !== "running") return;
    const marker = entry.aliveData;
    if (!marker) return;
    const live = isProcessAlive(marker.pid) && now - marker.startedAt < ALIVE_SOFT_TIMEOUT_MS;
    entry.light.externalInstance = live ? marker : undefined;
  }

  /** identity 基底（头部 light 或全量 recon）+ 四分支 sidecar 状态矩阵 → SubagentRecord。 */
  private static buildRecord(
    base: IdentityHeaderRecon | ReconstructedRecord,
    m: SidecarMatrix,
  ): SubagentRecord {
    let rec: SubagentRecord;
    if ("turns" in base) {
      // 全量：turnCount/totalTokens/model/eventLog/displayItems/result/error 齐全。
      rec = {
        id: base.id,
        agent: base.agent,
        slug: base.slug,
        status: "running", // 占位，下方矩阵覆盖
        mode: base.mode,
        startedAt: base.startedAt,
        rootSessionId: base.rootSessionId,
        parentRecordId: base.parentRecordId,
        depth: base.depth,
        endedAt: undefined,
        turns: base.turnCount,
        totalTokens: base.totalTokens,
        model: base.model,
        thinkingLevel: base.thinkingLevel,
        task: base.task,
        currentActivity: undefined,
        eventLog: base.eventLog,
        displayItems: getDisplayItems(base),
        result: base.result,
        error: base.error,
        sessionFile: base.sessionFile,
        chatMode: base.chatMode,
        worktree: base.worktree,
      };
    } else {
      // light：详情字段缺省（turns=0/eventLog=[]/result=undefined），getFullRecord 懒补。
      rec = {
        id: base.id,
        agent: base.agent,
        slug: base.slug,
        status: "running", // 占位，下方矩阵覆盖
        mode: base.mode,
        startedAt: base.startedAt,
        rootSessionId: base.rootSessionId,
        parentRecordId: base.parentRecordId,
        depth: base.depth,
        endedAt: undefined,
        turns: 0,
        totalTokens: 0,
        model: base.model,
        thinkingLevel: base.thinkingLevel,
        task: base.task,
        currentActivity: undefined,
        eventLog: [],
        displayItems: [],
        result: undefined,
        error: undefined,
        sessionFile: base.sessionFile,
        chatMode: base.chatMode,
        worktree: base.worktree,
      };
    }

    // ── 分支 1: .cancelled ──
    // v4 B-1: cancelled 折入 closed（closedReason='cancelled' 保留 L2 区分）。
    if (m.tomb) {
      markReconstructedStatus(rec, "closed");
      rec.closedReason = "cancelled";
      rec.error = "cancelled by user";
      rec.endedAt = m.tomb.endedAt;
    }
    // ── 分支 2: .finalized ──
    else if (m.finalized) {
      // closed 统一终态：done/failed/crashed 合并为 closed + closedReason=gc。
      markReconstructedStatus(rec, "closed");
      rec.closedReason = "gc";
      // 全量路径用最后 entry ts（精确）；light 路径用 jsonl mtime 近似（finalize 后
      // 文件不再变化，误差 <1s），避免重建后耗时随墙钟无限增长。
      rec.endedAt = m.fullEndedAt ?? m.jsonlMtimeMs;
    }
    // ── 分支 3: .alive + pid 存活 + 未超软超时 ──
    else if (
      m.alive !== undefined &&
      isProcessAlive(m.alive.pid) &&
      m.now - m.alive.startedAt < ALIVE_SOFT_TIMEOUT_MS
    ) {
      markReconstructedStatus(rec, "running");
      rec.externalInstance = m.alive;
    }
    // ── 分支 4: 兜底（都无 / .alive 但 pid 死 / 超时）──
    // v4 B-1：跨重启可续聊态落点 = running。endedAt 保持 undefined（非终态）。
    else {
      markReconstructedStatus(rec, "running");
    }
    return rec;
  }

  /** 从缓存与索引移除某文件（文件删除时；负缓存条目无 id，仅删缓存项）。 */
  private dropFileCache(file: string): void {
    const entry = this.fileCache.get(file);
    if (entry) {
      if (!entry.negative) this.idToFile.delete(entry.light.id);
      this.fileCache.delete(file);
    }
  }

  /** 排序比较器：status priority（running<failed<cancelled<done）+ startedAt desc。 */
  private static compareRecords(a: SubagentRecord, b: SubagentRecord): number {
    const pdiff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (pdiff !== 0) return pdiff;
    return b.startedAt - a.startedAt; // 新→旧
  }

  /** FR-8: 同步读取所有 manifest 记录（封装 ManifestStore.listAllSync，消除反射访问）。 */
  private readManifestsSync(): readonly ManifestRecord[] {
    return this.manifestStore?.listAllSync() ?? [];
  }

  /** FR-8: ManifestRecord → SubagentRecord（manifest 源投影）。
   *  task/slug/model 从 manifest 真实值投影（配合 writeManifest 补字段），缺失兜底空串。
   *  status 越界（mapManifestStatus 返回 null）时返回 null，由 collectRecords 跳过。 */
  private static manifestToSubagent(m: ManifestRecord): SubagentRecord | null {
    const status = mapManifestStatus(m.status);
    if (status === null) return null;
    return {
      id: m.id,
      agent: m.agentName,
      task: m.task ?? "",
      slug: m.slug ?? "",
      status,
      mode: "background" as const,
      startedAt: m.createdAt,
      rootSessionId: m.rootSessionId || undefined,
      parentRecordId: undefined,
      depth: 0,
      endedAt: m.completedAt,
      turns: 0,
      totalTokens: 0,
      model: m.model ?? "",
      thinkingLevel: undefined,
      eventLog: [],
      displayItems: [],
      result: undefined,
      error: undefined, // closed 统一终态，不再按 status 区分 error 字段
      sessionFile: m.sessionFile,
    };
  }

  /** ExecutionRecord → SubagentRecord（内存源投影）。 */
  private static recordToSubagent(r: ExecutionRecord): SubagentRecord {
    return {
      id: r.id,
      agent: r.agent,
      status: r.status,
      closedReason: r.closedReason,
      mode: r.mode,
      slug: r.slug,
      startedAt: r.startedAt,
      rootSessionId: r.rootSessionId,
      parentRecordId: r.parentRecordId,
      depth: r.depth,
      endedAt: r.endedAt,
      turns: r.turnCount,
      totalTokens: r.totalTokens,
      model: r.model,
      thinkingLevel: r.thinkingLevel,
      task: r.task,
      currentActivity: getCurrentActivity(r),
      eventLog: getEventLog(r),
      displayItems: getDisplayItems(r),
      result: r.result,
      error: r.error,
      sessionFile: r.sessionFile,
      round: r.round,
      // [review round2] worktree 隔离标志：内存源有 handle 或跨重启重建带 hadWorktree 均为 true。
      worktree: r.worktreeHandle !== undefined || r.hadWorktree === true,
    };
  }
}
