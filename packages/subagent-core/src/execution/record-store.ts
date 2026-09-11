// src/execution/record-store.ts
//
// Record 的统一容器。内存只留 running record；终态从 session.jsonl 重建。
//
// 职责：
//   - 持有 running record（终态 record 在 archive 时立即从内存移除）
//   - onChange 订阅（TUI widget/list 据此重渲）
//   - collectRecords：内存(running) ∪ 磁盘(sessions/*.jsonl 重建) ∪ manifest(sessions-index.json 补充) 三源合并
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

import { getLogger } from "../core/logger.ts";

import { getCurrentActivity, getDisplayItems, getEventLog, markReconstructedStatus, snapshot as toSnapshot } from "./execution-record.ts";
import { readStateMarker, statStateStamp, writeFinalizedState } from "./state-marker.ts";
import type { StateMarker } from "./state-marker.ts";
// [UF-1] record 绑定 sidecar：宿主侧 id→file 映射（engine-CLI 化后子文件无 identity
// entry 时代的身份载体）——scanFile 探测分支在 identity miss 时消费它重建 light record。
import { readRecordBinding, RECORD_BINDING_SIDECAR_EXT } from "./state-marker.ts";
import type { RecordBinding } from "./state-marker.ts";
import { toSubagentRecordEntry, SUBAGENT_RECORD_CUSTOM_TYPE } from "./record-entry.ts";
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
  ClosedReason,
  ExecutionRecord,
  ExecutionStatus,
  RecordSnapshot,
  SubagentRecord,
} from "./types.ts";
import { CLOSED_REASONS as CLOSED_REASON_LIST } from "./types.ts";
import { isProcessAlive, readAliveMarker, ALIVE_SOFT_TIMEOUT_MS } from "./alive-store.ts";

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

// .alive 软超时常量已迁移至 alive-store.ts（v8.5 D 透明重生探针共用同一判据 SSOT）。

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
  /** 终态 sidecar（.state 优先，兼容旧 .finalized/.cancelled 归一）。undefined = 未终态化。 */
  state: StateMarker | undefined;
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
 * 校验：jsonl + 终态 sidecar + alive + record 绑定（[UF-1]）的 stat 戳对比（终态戳为该组文件 .state/.finalized/.cancelled 的合并戳，见 state-marker.statStateStamp）。任何写操作至少改变一个戳 →
 * 只重建该文件，其余 N-1 个复用缓存（statSync 毫秒级，取代旧的整体失效重扫）。
 */
interface FileCacheEntry {
  /** tagged union 判别（负缓存条目为 true）。显式声明 false 供 TS narrowing。 */
  negative?: false;
  light: SubagentRecord;
  full: SubagentRecord | undefined;
  jsonl: Stamp;
  state: Stamp | null;
  alive: Stamp | null;
  /** [UF-1] record 绑定 sidecar 戳（null = 无绑定文件）。 */
  binding: Stamp | null;
  /** 最近一次重建时读到的终态 sidecar 内容（校验命中路径复用，不重读文件）。 */
  stateMarker: StateMarker | undefined;
  aliveData: AliveMarker | undefined;
}

/** 负缓存条目：确认无 identity 的文件（损坏/异构）。缓存「没有」这一事实，
 *  避免每轮扫描都全文 fallback 重读（全文读是 fallback 的成本主体）。 */
interface NegativeFileEntry {
  negative: true;
  jsonl: Stamp;
  state: Stamp | null;
  alive: Stamp | null;
  /** [UF-1] 绑定戳纳入负缓存：绑定文件后到（run 应答回填点落盘）改变戳，
   *  打破负缓存触发重探测——「先扫描后绑定落盘」时序的恢复能力锚点。 */
  binding: Stamp | null;
}

/** fileCache 值类型：正常条目或负缓存条目。 */
type FileCacheValue = FileCacheEntry | NegativeFileEntry;

/** scanFile 单文件本轮 stat 戳集合（jsonl + 终态 sidecar（含旧名合并戳）+ alive + record 绑定）。 */
interface FileStamps {
  jsonl: Stamp;
  state: Stamp | null;
  alive: Stamp | null;
  binding: Stamp | null;
}

/** sidecar payload 读取结果（索引命中与探测重建两分支共享的读点）。 */
interface SidecarPayloads {
  state: StateMarker | undefined;
  aliveData: AliveMarker | undefined;
  /** [UF-1] record 绑定载荷（identity miss 时的身份重建源）。 */
  binding: RecordBinding | undefined;
}

/** 孤儿判定的末行读取初始窗口（常规 entry 远小于此，避免全文件读）。 */
// eslint-disable-next-line no-magic-numbers -- 64KB = 64 * 1024 bytes 字节换算常数
const LAST_LINE_WINDOW_BYTES = 64 * 1024;
/** 末行超出初始窗口时的扩窗倍数（64KB → 256KB → 1MB → …，上限=文件头）。
 *  [HISTORICAL] 曾断言「64KB 足以容纳任何单行 entry（task 上限 ~62KB 实测）」并被
 *  V1 探针推翻：真实库 4822 个子文件中 28 个末行为 65KB-776KB 的完整 entry
 *  （subagent-identity 的 task 内嵌大 payload）——固定尾窗会把超长末行从中间切开
 *  误判截断，孤儿恢复错落 error。 */
const WINDOW_GROWTH_FACTOR = 4;
/** 窗口内 ≥2 个非空段 = 末行之前存在换行边界（首段可能被窗口切开，末段完整到 EOF）。 */
const MIN_SEGMENTS_WITH_BOUNDARY = 2;

/**
 * 读 JSONL 文件的最后一个非空行（孤儿终态判定用，residual-fixes §5.2）。
 * 读文件尾部窗口起步；窗口内只有单个非空段且未到文件头时，该段可能是被窗口切开的
 * 超长末行，按 WINDOW_GROWTH_FACTOR 扩窗直到看见末行前的换行边界或抵达文件头。
 * 返回 ok=false 表示 IO 错误（open/read 阶段抛出，含权限/磁盘故障——可能是暂时
 * 状态，调用方按保守方向处理）。
 */
function readLastJsonlLine(sessionFile: string): { ok: true; line: string } | { ok: false } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(sessionFile, "r");
    const size = fs.fstatSync(fd).size;
    let windowBytes = LAST_LINE_WINDOW_BYTES;
    let windowStart = Math.max(0, size - windowBytes);
    let lines: string[] = [];
    while (true) {
      const buf = Buffer.alloc(size - windowStart);
      fs.readSync(fd, buf, 0, buf.length, windowStart);
      lines = buf.toString("utf-8").split("\n").filter((l) => l.length > 0);
      // 末行完整可提取 = 窗口内末行之前还有换行（≥2 个非空段）或已覆盖到文件头。
      if (windowStart === 0 || lines.length >= MIN_SEGMENTS_WITH_BOUNDARY) break;
      windowBytes *= WINDOW_GROWTH_FACTOR;
      const nextStart = Math.max(0, size - windowBytes);
      if (nextStart === windowStart) break;
      windowStart = nextStart;
    }
    // 窗口仍可能从行中间开始（首段被切开）——丢掉第一段；到文件头则首段是完整首行。
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
        void _e; // 关闭失败不影响已读结果（对齐 state-marker best-effort 模式）
      }
    }
  }
}

/** unknown → subagent-record entry 的运行时守卫（taste/no-unsafe-cast：断言前收窄）。 */
function asSubagentRecordEntry(o: unknown): { id: string; data: Record<string, unknown> } | null {
  if (typeof o !== "object" || o === null) return null;
  const obj = o as Record<string, unknown>;
  if (obj.type !== "custom" || obj.customType !== SUBAGENT_RECORD_CUSTOM_TYPE) return null;
  if (typeof obj.data !== "object" || obj.data === null) return null;
  const data = obj.data as Record<string, unknown>;
  return typeof data.id === "string" ? { id: data.id, data } : null;
}

/** recoverEntryOnlyOrphans 用的 entry 扫描：主 session 全文 → 每 id 末条 record data。 */
function collectLastRecordEntries(content: string): Map<string, Record<string, unknown>> {
  const lastById = new Map<string, Record<string, unknown>>();
  for (const line of content.split("\n")) {
    if (!line.includes(SUBAGENT_RECORD_CUSTOM_TYPE)) continue; // 快过滤：绝大多数行不是本类型
    let entry: { id: string; data: Record<string, unknown> } | null = null;
    try {
      entry = asSubagentRecordEntry(JSON.parse(line));
    } catch (err) {
      // 截断/异构行跳过（主文件末行可能正被写入）——行级 best-effort，debug 留痕
      logger.debug("[subagents] entry-only orphan scan: skip unparsable line", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    if (entry !== null) lastById.set(entry.id, entry.data);
  }
  return lastById;
}

/** entry data 字段的安全 string 读取（非 string → undefined）。 */
function entryStr(d: Record<string, unknown>, k: string): string | undefined {
  return typeof d[k] === "string" ? (d[k] as string) : undefined;
}

/** entry data 字段的安全 number 读取（非 number → undefined）。 */
function entryNum(d: Record<string, unknown>, k: string): number | undefined {
  return typeof d[k] === "number" ? (d[k] as number) : undefined;
}

/**
 * 来源域投影（H2 W1，设计 subagent-workflow-record-unification §3.3 D1）：origin 经
 * 字面量守卫（非法值/缺省 → undefined = "tool" 语义，存量 entry 零迁移）；parentRunId
 * 经安全 string 读取。缺省语义对齐 ExecutionRecord.origin 注释——消费面按
 * `=== "workflow"` 负向判定，缺省（undefined）恒视为手动 tool 派发。
 */
function readEntryOriginFields(d: Record<string, unknown>): Pick<SubagentRecord, "origin" | "parentRunId"> {
  return {
    origin: d.origin === "workflow" || d.origin === "tool" ? d.origin : undefined,
    parentRunId: entryStr(d, "parentRunId"),
  };
}

/** 终态域投影：status 只认 "closed" 字面量（其余含缺省 → "running"，旧调用方行为不变）；
 *  closedReason 经枚举守卫（非法/缺省 → undefined）。 */
function readEntryTerminalFields(
  d: Record<string, unknown>,
): Pick<SubagentRecord, "status" | "closedReason"> {
  const closedReason = entryStr(d, "closedReason");
  return {
    status: d.status === "closed" ? "closed" : "running",
    closedReason: isValidClosedReason(closedReason) ? closedReason : undefined,
  };
}

/** 批收集域投影（U5 E1）：仅显式字面量收敛，缺省 undefined（JSON 序列化自然缺省）。 */
function readEntryBatchFields(
  d: Record<string, unknown>,
): Pick<SubagentRecord, "collectMode" | "batchFinalized" | "resumable"> {
  return {
    collectMode: d.collectMode === "sync" ? "sync" : undefined,
    batchFinalized: d.batchFinalized === true ? true : undefined,
    resumable: d.resumable === true ? true : undefined,
  };
}

/** engine 域投影：engineFallback/engineHandle 经运行时 guard（未知 JSON 不裸收）。 */
function readEntryEngineFields(
  d: Record<string, unknown>,
): Pick<SubagentRecord, "engine" | "engineFallback" | "engineHandle"> {
  return {
    engine: entryStr(d, "engine"),
    engineFallback: isEngineFallbackShape(d.engineFallback) ? d.engineFallback : undefined,
    engineHandle: isEngineHandleShape(d.engineHandle) ? d.engineHandle : undefined,
  };
}

/** entry data 即 SubagentRecord v1 快照——带运行时 guard 重建（taste/no-unsafe-cast）。
 *  损坏 entry（agent/task/startedAt 任一缺失）返回 null，由调用方跳过。
 *  [U5 E1] 投影白名单扩展（设计 §3.1.3「标记读取通路」）：collectMode/batchFinalized
 *  + 终态五字段 status/endedAt/closedReason/result/error——原实现硬编码
 *  status:"running" 且不投影终态，E1 重建成员恒被视为 running，「全员终态→补发」
 *  判定永假、补发内容缺失，整条补发路径成死代码。status 守卫只认 "closed" 字面量
 *  （其余含缺省 → "running"，旧调用方 recoverEntryOnlyOrphans 行为不变——其候选
 *  守卫已滤非 running 末条）；closedReason 经 isValidClosedReason 枚举守卫。
 *  [v2 D3] 再补 resumable/sessionFile 两投影：成功成员崩溃时末条恒为轮终
 *  running+resumable entry（SP-5 有意语义），不投影 resumable 则 E1 无法与协调器
 *  hasRunningSync 同构豁免（§2.3 断链 3）；sessionFile 原硬编码 undefined，导致
 *  E1 落标路径重建快照丢失反查索引锚（断链 1 前置依赖）。recoverEntryOnlyOrphans
 *  的候选判定（isEntryOrphanCandidate）只认 status==="running"，两新字段不参与
 *  判定（P-rebuild 探针守卫面）。
 *  [E1 恢复批语义修复] 再补 patchFile 投影：entry data 携带该字段
 *  （toSubagentRecordEntry 落盘含 patchFile）但原投影丢弃 → E1 补发记录丢失
 *  worktree patch 的 git-apply 回收指针（正常 flush 路径经 toNotifyRecord 特意
 *  携带，notify-host.ts patchFile 透传）。undefined 经 JSON.stringify 自然缺省，
 *  无 patchFile 的存量 entry 序列化字节不变（落标出口经 toSubagentRecordEntry
 *  按名重投影，重建对象字段顺序不影响序列化字节形态）。
 *  字段顺序 = 对象字面量原序（终态/批收集/engine 域以 spread 在原位置展开），
 *  entry 序列化字节形态不变。 */
function rebuildEntryRecord(id: string, d: Record<string, unknown>): SubagentRecord | null {
  const agent = entryStr(d, "agent");
  const task = entryStr(d, "task");
  const startedAt = entryNum(d, "startedAt");
  if (agent === undefined || task === undefined || startedAt === undefined) return null; // 损坏 entry：跳过
  return {
    id,
    agent,
    task,
    slug: entryStr(d, "slug") ?? "",
    ...readEntryTerminalFields(d),
    mode: "background",
    startedAt,
    rootSessionId: entryStr(d, "rootSessionId"),
    parentRecordId: entryStr(d, "parentRecordId"),
    depth: entryNum(d, "depth") ?? 0,
    // [H2 W1] 来源域透传（origin/parentRunId）：漏本行则主 session entry 重建路径
    // 丢 origin，重启后 workflow record 逃过投影过滤（D1 ①-④ 全失效）。
    ...readEntryOriginFields(d),
    endedAt: entryNum(d, "endedAt"),
    turns: entryNum(d, "turns") ?? 0,
    totalTokens: entryNum(d, "totalTokens") ?? 0,
    model: entryStr(d, "model") ?? "",
    thinkingLevel: entryStr(d, "thinkingLevel"),
    eventLog: [],
    displayItems: [],
    result: entryStr(d, "result"),
    error: entryStr(d, "error"),
    sessionFile: entryStr(d, "sessionFile"),
    patchFile: entryStr(d, "patchFile"),
    chatMode: d.chatMode === true,
    round: entryNum(d, "round"),
    ...readEntryEngineFields(d),
    ...readEntryBatchFields(d),
  };
}

/** engineFallback entry 值的运行时 guard（未知 JSON 不裸收）。 */
function isEngineFallbackShape(v: unknown): v is { from: string; reason: string } {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.from === "string" && typeof r.reason === "string";
}

/** engineHandle entry 值的运行时 guard（未知 JSON 不裸收；形状与 runtime 读侧
 *  subagent-engine-history 的 extractRecordEngineHandle 守卫语义对齐：poolKey
 *  必有非空 string + sessionRef 值全 string 才收，journalPath 可选 string）。 */
function isEngineHandleShape(
  v: unknown,
): v is { sessionRef: Record<string, string>; journalPath?: string; poolKey: string } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const h = v as Record<string, unknown>;
  if (typeof h.poolKey !== "string" || h.poolKey.length === 0) return false;
  if (typeof h.sessionRef !== "object" || h.sessionRef === null || Array.isArray(h.sessionRef)) {
    return false;
  }
  for (const value of Object.values(h.sessionRef as Record<string, unknown>)) {
    if (typeof value !== "string") return false;
  }
  if (h.journalPath !== undefined && typeof h.journalPath !== "string") return false;
  return true;
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

/** ClosedReason 合法值集合（sidecar 内容校验用：外部损坏/手写垃圾内容 → disconnected）。
 * SSOT = types.ts CLOSED_REASONS 全枚举，此处仅建 Set 索引（避免第二份字面量清单漂移）。 */
const CLOSED_REASONS: ReadonlySet<string> = new Set(CLOSED_REASON_LIST);

/** sidecar 内容是否为合法的 ClosedReason 字面量（disconnected 只作兜底产出，不接受写入）。 */
function isValidClosedReason(value: string | undefined): value is ClosedReason {
  return value !== undefined && CLOSED_REASONS.has(value);
}

function sameNullableStamp(a: Stamp | null, b: Stamp | null): boolean {
  if (a === null || b === null) return a === b;
  return sameStamp(a, b);
}

/** 缓存条目与本轮 stat 戳全同（jsonl + 终态 sidecar + alive + record 绑定，null 语义对齐）→ 零读取复用。 */
function isFreshCache(cached: FileCacheValue, stamps: FileStamps): boolean {
  return (
    sameStamp(cached.jsonl, stamps.jsonl) &&
    sameNullableStamp(cached.state, stamps.state) &&
    sameNullableStamp(cached.alive, stamps.alive) &&
    sameNullableStamp(cached.binding, stamps.binding)
  );
}

/**
 * identity 三级定位——头部 64KB（首轮会话，~34%）→ 尾部 64KB（续聊场景最后一轮
 * session_start 追加，~65%）→ 全文 fallback（~0.2%）。均不解析 message entries。
 * size ≤ 头部读取上限时 head 读到的即全文，tail/anywhere 只会重复读同一份内容——
 * 直接判负（head miss = 全文无 identity），省去同内容两连读。
 */
function detectIdentity(file: string, size: number): IdentityHeaderRecon | undefined {
  return size <= IDENTITY_HEAD_BYTES
    ? readIdentityHeader(file)
    : readIdentityHeader(file) ?? readIdentityTail(file) ?? readIdentityAnywhere(file);
}

/**
 * sidecar payload 读取（读顺序：终态 marker → alive marker → record 绑定）。
 * 三者都是活态数据，调用方沿用每轮重读语义；终态 marker 静态数据仅在戳非空时读
 * （文件小，成本可忽略）。
 */
function readSidecarPayloads(file: string, stamps: FileStamps): SidecarPayloads {
  return {
    state: stamps.state !== null ? readStateMarker(file) : undefined,
    aliveData: stamps.alive !== null ? readAliveMarker(file) : undefined,
    binding: stamps.binding !== null ? readRecordBinding(file) : undefined,
  };
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
 *
 * record 状态查询面（U10① D6）：按状态枚举 listRunning/collectRecords(statusFilter)、
 * 按 id 查询 getMutable/findLightById/getFullRecord——方法签名即导出形态，本类零改动。
 *
 * @experimental execution 运行时面（设计 docs/design/subagent-core-sink-design.md §3.3 D6）：
 * 一个 minor 周期内允许签名微调，稳定后转常规 semver 承诺。
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
   * cancelled record 由调用方先写终态 sidecar（cancel 路径），此处只负责移除。
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
   * 仅在 SubagentService.dispose（进程退出路径）调用。不做 CAS/终态标记——dispose
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
   *   ║     终态 sidecar override status。详情字段（eventLog/result/turns）    ║
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
   *
   * [H2 W1] includeWorkflow（设计 subagent-workflow-record-unification §3.3 D1）：
   * 缺省 false = 过滤 origin==="workflow" 的 record（subagents tool list / TUI
   * /subagents 等消费面默认不展示 workflow 派发的 record）；true = 全量（排查通道）。
   * 过滤只在查询消费面——治理路径（recoverOrphanRecords / recoverEntryOnlyOrphans /
   * revive）与本参数无关，永远全量可见（D1 ⑥ 负向规格）。
   */
  collectRecords(
    limit: number,
    statusFilter: StatusFilter = "all",
    rootSessionFilter?: string,
    includeWorkflow: boolean = false,
  ): SubagentRecord[] {
    let result = [...this.mergedRecords(rootSessionFilter).values()];

    // 3. statusFilter。
    if (statusFilter === "running") {
      result = result.filter((r) => r.status === "running");
    }

    // 3.5 [H2 W1] origin 过滤（缺省排除 workflow 来源）。负向判定：origin 缺省
    // （undefined = "tool" 语义）与显式 "tool" 均保留。
    if (!includeWorkflow) {
      result = result.filter((r) => r.origin !== "workflow");
    }

    // 4-5. 排序 + slice。
    return result
      .sort(RecordStore.compareRecords)
      .slice(0, limit);
  }

  /**
   * [H2 W1] 按 workflow run id 列 record（parentRunId 查询入口，W2 run 视图进度 /
   * W3 下钻消费）。查询域 = collectRecords 现状口径（内存 ∪ 磁盘重建 ∪ manifest 补充，
   * 设计 D2「查询域显式」）。不过滤 origin——按 parentRunId 显式查询即下钻/治理语义
   * （tool 来源 record parentRunId 恒 undefined，不会被误中）。
   *
   * 返回排序与 slice 口径同 collectRecords（STATUS_PRIORITY + startedAt desc + limit）。
   */
  collectRecordsByParentRunId(
    parentRunId: string,
    limit: number,
    rootSessionFilter?: string,
  ): SubagentRecord[] {
    return [...this.mergedRecords(rootSessionFilter).values()]
      .filter((r) => r.parentRunId === parentRunId)
      .sort(RecordStore.compareRecords)
      .slice(0, limit);
  }

  /**
   * collectRecords / collectRecordsByParentRunId 共用的三源合并（磁盘重建 ∪ manifest
   * 补充 ∪ 内存覆盖）。返回 byId Map（内存优先——running record 是活态比磁盘重建新）。
   * [D1 ⑤] 磁盘重建投影本身不做任何 origin 过滤——record 全量重建，过滤只在上层
   * 查询消费面按参数生效。
   */
  private mergedRecords(rootSessionFilter?: string): Map<string, SubagentRecord> {
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

    return byId;
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
   *   done/failed 细分由 error 字段经 deriveClosedDisplay 派生）+ 写 .state sidecar
   *   （防重锚——下次重建走分支 2 不再进判定）；
   * - 末行截断 → closed + error（保守，错误方向安全）+ sidecar；
   * - 文件不可读（IO 错误，可能暂时）→ 不判终态，落 resumable entry（防御性路径，
   *   IO 恢复后重开可重判）。
   *
   * [v2 D3] mainSessionFile = 覆写 merge 数据源（主 session 每 id 末条 entry，与 E1
   * 的 scanLastRecordEntries 同款通路）：崩溃前的批域标记（collectMode/batchFinalized）
   * 与轮终 result/model 只活在主文件 entry——重建矩阵（buildRecord）的数据源
   * （sidecar/子文件 identity）不含它们，覆写前不 merge 就会被抹掉（v2 §2.2 断链 2：
   * E1 候选集恒空的真根因）。缺省（undefined）时 merge 无源，行为与旧版一致。
   * 参数为追加式第二参（rootSessionFilter 保持首参）：既有调用面只传过滤参。
   *
   * 防重：orphanJudged 实例级缓存（resumable 形态无 sidecar 锚，同进程重复调用跳过；
   * 终态形态双重防护 = sidecar + 缓存）。调用方：index.ts session_start 恢复段（一次）。
   */
  recoverOrphanRecords(rootSessionFilter?: string, mainSessionFile?: string): void {
    const lastById = new Map(this.scanLastRecordEntries(mainSessionFile).map((r) => [r.id, r]));
    for (const rec of this.reconstructAll(rootSessionFilter)) {
      // 分支 4 命中集 = running 且无活进程实例（分支 3 带 externalInstance，分支 1/2 已 closed）。
      if (rec.status !== "running" || rec.externalInstance !== undefined) continue;
      if (this.orphanJudged.has(rec.id)) continue;
      this.orphanJudged.add(rec.id);
      this.finalizeOrphanRecord(rec, lastById.get(rec.id));
    }
  }

  /**
   * 单孤儿 record 的终态判定与落 entry（residual-fixes §5.2 三判据 + chat 分流）。
   * 防重锚（orphanJudged 标记）已由调用方完成。
   *
   * [v2 D3] 覆写前 merge（lastEntry = 主 session 同 id 末条 entry 重建，调用方构建）：
   * 覆写是状态迁移不是信息重建，迁移不应丢末条既有信息。三个落 entry 分支（chatMode
   * 分流 / IO 保守 / 终态覆写）统一基于 merge 后的 rec，同款口径。
   */
  private finalizeOrphanRecord(rec: SubagentRecord, lastEntry?: SubagentRecord): void {
    // 仅补 undefined/空值字段、不覆盖已有值——覆写自带的 status/closedReason/endedAt/
    // error 不在 merge 字段集，天然不受影响。批域字段（collectMode/batchFinalized）对
    // 非 sync 成员恒 no-op（末条 entry collectMode undefined → 无值可补）；result/model
    // 的修补对 async/chat 成员同样生效——拉齐 light 重建丢 result/model 与 full 重建的
    // 既有形态不一致（v2 D3 影响面诚实口径），不触碰任何通知文案（golden 不锁 entry 字节）。
    const rec0 = lastEntry === undefined ? rec : RecordStore.mergeOrphanLastEntry(rec, lastEntry);
    // [W4 boot 分区 · 裁决表行 3] 重认领保留分支的判据 = resumable 且**无完成产出**：
    // 非 chatMode 的 resumable=true 且 result 有值是 SP-5 one-shot 完成态（任务已完成，
    // 直断 closed/gc 无损）；resumable=true 且 result 缺失是「监督器死亡纳管态」（W4：
    // 引擎死亡接管后宿主重启）——保留 running 交 round-supervisor boot 重认领继续
    // 管辖（注册存续 process 档），误判 closed 会制造「指向已终态 record 的残留注册」
    // 并损失 resume 可能。
    if (rec0.chatMode === true || (rec0.resumable === true && rec0.result === undefined)) {
      // chat 会话跨重启等续聊：保留 running（可续聊），仅落执行态信号。
      this.reportSubagentRecord({ ...rec0, resumable: true });
      return;
    }
    const sessionFile = rec0.sessionFile;
    if (sessionFile === undefined) return; // 无子文件锚（目录扫描源不可达，防御）
    const lastLine = readLastJsonlLine(sessionFile);
    if (!lastLine.ok) {
      // IO 错误可能暂时——判终态不可逆，保守落 resumable 等重开重判。
      this.reportSubagentRecord({ ...rec0, resumable: true });
      return;
    }
    let parseOk = false;
    try {
      JSON.parse(lastLine.line);
      parseOk = true;
    } catch {
      parseOk = false;
    }
    // .state sidecar：防重锚（同 doFinalizeRecord 终态路径的收尾标记）。
    // 显式携 reason="gc"：孤儿判定「末行完整 = 自然完成」，与 doFinalizeRecord 写入的
    // 真实 reason 同层——否则无 reason sidecar 在磁盘重建时被兜底为 disconnected，
    // 把正常完成的记录误标成断联。
    writeFinalizedState(sessionFile, "gc");
    // [F3 boot 直断语义，设计表 3 行 2] 走到本分支的 record 分两类：
    //  - resumable=true（上方分流保证此时 result 有值）= SP-5 one-shot 完成态——任务
    //    真实完成，直断 closed/gc 无 error，投影 completed 不变；
    //  - 其余 = in-flight（重启前在途、无 resumable 信号）——宿主重启中断了在途任务，
    //    投影不得是 completed（事故环 3：异常中断被谎报完成，违反 G3）。error 载体经
    //    deriveOutcome("gc", error) = "failed"（execution-record.ts 唯一权威派生）
    //    投影 failed，文案供 GUI/主 agent 明确「任务因宿主重启中断」；ClosedReason
    //    枚举不扩展（sidecar/entry 面最小改动，"gc" 由 error 载体补足失败语义）。
    const inFlightAbortedError =
      rec0.resumable === true
        ? undefined
        : "orphan recovery: task aborted by host restart (in-flight at shutdown; session context lost" +
          (parseOk ? "" : "; truncated last line") + ")";
    this.reportSubagentRecord({
      ...rec0,
      status: "closed",
      closedReason: "gc",
      endedAt: Date.now(),
      ...(inFlightAbortedError !== undefined
        ? { error: inFlightAbortedError }
        : parseOk
          ? {}
          : { error: "orphan recovery: subagent session ended abnormally (truncated last line)" }),
    });
  }

  /** [v2 D3] 孤儿覆写 merge 字段集：末条 entry 的批域标记 + 轮终正文/模型，仅补 rec 侧
   *  undefined/空值（model 的空值形态是 ""——light 重建无 model_change entry 时起步
   *  空串），不覆盖已有值。merge 后写 entry 经 reportSubagentRecord →
   *  toSubagentRecordEntry 序列化，undefined 字段自然缺省（不引入显式 null）。 */
  private static mergeOrphanLastEntry(rec: SubagentRecord, last: SubagentRecord): SubagentRecord {
    const pickStr = (cur: string | undefined, src: string | undefined): string | undefined =>
      cur !== undefined && cur !== "" ? cur : src;
    return {
      ...rec,
      collectMode: rec.collectMode ?? last.collectMode,
      batchFinalized: rec.batchFinalized ?? last.batchFinalized,
      result: pickStr(rec.result, last.result),
      // 类型收尾：两侧实参恒 string（rec.model 类型非可选；last.model 重建投影自带
      // `?? ""`），pickStr 签名宽返回 string|undefined —— `?? ""` 运行时不可达，
      // 仅满足 model 非可选类型，空串回退语义不变（cur 空 → src，src 也空 → ""）。
      model: pickStr(rec.model, last.model) ?? "",
      // [W4 boot 分区] 轮终执行态信号（resumable）随末条 entry 保留：子文件侧重建
      // （reconstructAll）不带该信号，boot 分区的「already-resumable-idle 重认领 vs
      // in-flight 直断」分流（finalizeOrphanRecord）只能从主 session 末条 entry 取证。
      resumable: rec.resumable ?? last.resumable,
    };
  }

  /**
   * [E2E 实测缺口] entry-born 孤儿恢复：register entry 已落主 session、但子 session 文件
   * 从未创建（父进程死在 spawn 窗口期——register 写点与子进程首笔写入之间的窗口；外部
   * 删除子文件的已知边界同形）。目录扫描（reconstructAll）看不见这类 record（无文件即
   * 无扫描集），recoverOrphanRecords 判不到，侧栏（runtime entry 扫描源）永久 spinner。
   *
   * 判定：读主 session 的 subagent-record entry，取每 id 末条；末条 status=running 且
   * 无子文件锚（不在 reconstructAll 结果中）且不在内存活 record（防误杀刚 register 的
   * 在途 spawn）→ 按无文件判据收敛：chatMode=true → resumable（分流语义一致）；否则
   * closed+gc+error（子文件由子进程创建，无文件 = 子进程从未开跑，error 方向安全）。
   * 调用点：initSession 的 recoverOrphanRecords 之后（session_start，内存恒空）。
   */
  recoverEntryOnlyOrphans(mainSessionFile: string | undefined, rootSessionFilter?: string): void {
    if (mainSessionFile === undefined) return;
    let content: string;
    try {
      content = fs.readFileSync(mainSessionFile, "utf-8");
    } catch {
      return; // 主文件不可读（含新 session 未 flush 的 ENOENT）：静默跳过（best-effort 恢复）
    }
    const lastById = collectLastRecordEntries(content);
    if (lastById.size === 0) return;
    const anchoredIds = new Set(this.reconstructAll(rootSessionFilter).map((r) => r.id));
    for (const [id, d] of lastById) {
      if (!this.isEntryOrphanCandidate(id, d, rootSessionFilter, anchoredIds)) continue;
      this.orphanJudged.add(id);
      const rec = rebuildEntryRecord(id, d);
      if (rec === null) continue; // 损坏 entry：跳过（orphanJudged 已标记，不重判）
      this.finalizeEntryOnlyOrphan(rec, d.chatMode === true);
    }
  }

  /**
   * entry-born 孤儿候选判定（recoverEntryOnlyOrphans 的守卫链拆出）：末条 running、
   * root session 匹配、无子文件锚、不在内存活 record（防误杀在途 spawn）、未判过。
   */
  private isEntryOrphanCandidate(
    id: string,
    d: Record<string, unknown>,
    rootSessionFilter: string | undefined,
    anchoredIds: Set<string>,
  ): boolean {
    if (d.status !== "running") return false; // 末条已终态/轮终：entry 自洽，无需恢复
    if (rootSessionFilter !== undefined && d.rootSessionId !== rootSessionFilter) return false;
    if (anchoredIds.has(id)) return false; // 有子文件锚：主循环已判（或 sidecar 已终态）
    if (this.records.has(id)) return false; // 内存活 record：在途 spawn，不得误杀
    return !this.orphanJudged.has(id);
  }

  /** entry-born 孤儿按无文件判据收敛落 entry：chatMode → resumable（分流语义一致）；
   *  否则 closed+gc+error（子文件由子进程创建，无文件 = 子进程从未开跑，error 方向安全）。 */
  private finalizeEntryOnlyOrphan(rec: SubagentRecord, chatMode: boolean): void {
    this.reportSubagentRecord({
      ...rec,
      ...(chatMode
        ? { resumable: true }
        : {
          status: "closed" as const,
          closedReason: "gc" as const,
          endedAt: Date.now(),
          error: "orphan recovery: no child session file (spawn interrupted or file removed externally)",
        }),
    });
  }

  /**
   * [E1/U5] sync 批崩溃恢复扫描：主 session 文件「每 id 末条 subagent-record entry」
   * （collectLastRecordEntries + rebuildEntryRecord 组合通路，设计 §3.1.3「标记读取
   * 通路」——batchFinalized 落标 entry 写主 session 文件，本扫描同文件域才可见；禁走
   * collectRecords light 路径，它只读子文件 identity 头+sidecar，主 session 落标
   * entry 不可见）。返回每 id 末条重建的完整 record（含 collectMode/batchFinalized /
   * 终态五字段，损坏 entry 跳过）；调用方（service.recoverSyncCollectBatch 的 E1 过滤、
   * recoverOrphanRecords 的覆写 merge）自行取舍。主文件不可读（含新 session 未 flush
   * 的 ENOENT）→ 空数组静默。
   */
  scanLastRecordEntries(mainSessionFile: string | undefined): SubagentRecord[] {
    if (mainSessionFile === undefined) return [];
    let content: string;
    try {
      content = fs.readFileSync(mainSessionFile, "utf-8");
    } catch {
      return []; // 与 recoverEntryOnlyOrphans 同判：best-effort 恢复，不可读静默跳过
    }
    const out: SubagentRecord[] = [];
    for (const [id, d] of collectLastRecordEntries(content)) {
      const rec = rebuildEntryRecord(id, d);
      if (rec !== null) out.push(rec);
    }
    return out;
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

  /**
   * /resume /fork /new 后复活（dispose 的逆操作）。
   *
   * [PS-10/T6④] 同步复位 orphanJudged 防重缓存：resumable 形态（IO-error 保守分支 /
   * chatMode 分流）没有 .state sidecar 锚，重判资格完全由本缓存承载——dispose 时
   * 有 clear（session 结束），但 revive 此前不复位，导致「同进程内曾经的 IO 失败记录
   * 永久停留 resumable」，与本文件 recoverOrphanRecords 注释承诺的「IO 恢复后重开可重判」
   * 不符。/new 复活正是「重开」语义：IO 已恢复的记录下次 recoverOrphanRecords 重新判定
   * 收敛终态；仍不可读的记录重判再落一次 resumable entry（幂等，末条语义不变）。
   */
  revive(): void {
    this._disposed = false;
    this.orphanJudged.clear();
  }

  // ── 内部 ──────────────────────────────────────────────────

  /**
   * 四分支状态矩阵重建（终态 marker / alive / 兜底；[perf] light 版）。
   *
   * 优先级：
   *   1. 终态 sidecar status=cancelled → closed（closedReason=cancelled）
   *   2. 终态 sidecar status=finalized → closed（closedReason=内容 reason；空/旧格式 → disconnected）
   *   （旧名 .finalized/.cancelled 由 readStateMarker 归一，判定分支不区分来源）
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
   * 扫描单文件：stat 戳（jsonl + 终态 sidecar + alive + record 绑定）校验，全同 →
   * 复用缓存（零文件读取，含负缓存直接返回 null）；否则重建 light。
   * identity 定位两级：头部 64KB（首轮会话）→ 全文 fallback（续聊场景 identity
   * append 在尾部）；两级都找不到 → [UF-1] record 绑定 sidecar 回退（宿主侧身份
   * 载荷重建 light）→ 仍无 → 写负缓存（防每轮全文重读）。
   * 返回 null：文件消失/读失败/无 identity 且无绑定 → 跳过。
   */
  private scanFile(file: string, now: number): FileCacheEntry | null {
    const jsonl = statStamp(file);
    if (!jsonl) {
      this.fileCache.delete(file);
      return null;
    }
    const stamps: FileStamps = {
      jsonl,
      state: statStateStamp(file),
      alive: statStamp(`${file}.alive`),
      binding: statStamp(`${file}${RECORD_BINDING_SIDECAR_EXT}`),
    };

    const cached = this.fileCache.get(file);
    if (cached !== undefined && isFreshCache(cached, stamps)) {
      if (cached.negative) return null; // 负缓存命中：确认无 identity，零读取跳过
      // pid 探活结果不落盘（进程死亡无 IO）——分支 3 的 running 项每扫重查，
      // 保留原语义（旧实现每次 collectRecords 都重新 isProcessAlive）。
      RecordStore.refreshAlive(cached, now);
      return cached;
    }

    // [perf L-1] 磁盘索引查询（首扫惰性装载，miss/空索引时 get 恒 undefined = 无索引）。
    // 条目戳匹配 jsonl 当前 stat → 零内容读取构造缓存条目。undefined = 未命中
    // （落到下方探测），null = 负条目命中（零探测跳过）。
    // [UF-1] 绑定 sidecar 存在的文件跳过索引投影：SessionsIndexEntry 不含
    // chatMode/round（身份域子集），索引命中会把绑定承载的对话形态域抹成 undefined。
    if (stamps.binding === null) {
      const fromIndex = this.buildEntryFromIndex(file, stamps, now);
      if (fromIndex !== undefined) return fromIndex;
    }

    // [perf L-1] 索引 miss/戳不匹配落到原三级探测：本轮探测结果必须进索引（含负探测）。
    // 覆盖两种形态：首扫（映像已装载但 miss/不匹配）与后续轮次（映像已释放，凡进重建分支必是戳变化）。
    this.indexDirty = true;

    const payloads = readSidecarPayloads(file, stamps);
    const header = detectIdentity(file, jsonl.size);
    // [UF-1] 身份源两级：子文件 identity entry（历史权威，命中时绑定不参与）→
    // record 绑定 sidecar（engine-CLI 化后子文件无身份 entry，宿主在 sessionFile
    // 回填点落盘的 id→file 映射承担恢复能力）。两者皆缺 → 负缓存。
    const base = header ?? RecordStore.identityFromBinding(payloads.binding, file);
    if (!base) {
      // 负缓存：确认无 identity。后续扫描 stat 命中直接跳过；戳变化（文件补写 /
      // 绑定后到落盘）自动重试。
      this.fileCache.set(file, { negative: true, ...stamps });
      return null;
    }
    const entry = RecordStore.buildFileCacheEntry(base, file, stamps, payloads, now);
    // [UF-1] 绑定承载的对话形态域补投影：IdentityHeaderRecon 无 round 槽位
    //（既有语义：identity entry 磁盘重建不恢复 round），绑定路径在其上恢复——
    // 续聊轮数随绑定快照可滞后一拍（state-marker.RecordBinding.round 契约）。
    if (header === undefined && payloads.binding?.round !== undefined) {
      entry.light.round = payloads.binding.round;
    }
    this.fileCache.set(file, entry);
    this.idToFile.set(base.id, file);
    return entry;
  }

  /**
   * [UF-1] record 绑定载荷 → light 身份基底（IdentityHeaderRecon 同形投影）。
   * 绑定缺失/损坏返回 undefined（调用方落负缓存，不把损坏残留误判成身份）。
   * forkDepth/model_change/thinking_level_change 等头部途经信息绑定期不存在：
   * forkDepth 恒 undefined、model/thinkingLevel 取绑定快照值。
   */
  private static identityFromBinding(binding: RecordBinding | undefined, file: string): IdentityHeaderRecon | undefined {
    if (binding === undefined) return undefined;
    return {
      id: binding.recordId,
      agent: binding.agent,
      mode: binding.mode,
      task: binding.task,
      slug: binding.slug,
      startedAt: binding.startedAt,
      rootSessionId: binding.rootSessionId,
      parentRecordId: binding.parentRecordId,
      depth: binding.depth,
      forkDepth: undefined,
      chatMode: binding.chatMode,
      worktree: binding.worktree,
      model: binding.model,
      thinkingLevel: binding.thinkingLevel,
      sessionFile: file,
    };
  }

  /**
   * [perf L-1] 磁盘索引查询（首扫惰性装载，miss/空索引时 get 恒 undefined = 无索引）。
   * 条目戳匹配 jsonl 当前 stat → 零内容读取构造缓存条目。sidecar payload（终态 marker /
   * alive）是活态数据，沿用探测分支的每轮重读语义；终态 reason 静态数据仅在
   * sidecar 存在时读一次（文件小，成本可忽略）。
   *
   * 返回 undefined = 索引未命中/戳不匹配（调用方落到原三级探测）；null = 负条目命中
   * （「确认无 identity」跨实例持久，零探测跳过，与内存负缓存同款形态）。
   */
  private buildEntryFromIndex(file: string, stamps: FileStamps, now: number): FileCacheEntry | null | undefined {
    if (this.indexEntries === null) return undefined;
    const hit = this.indexEntries.get(path.basename(file));
    if (hit === undefined || hit.mtimeMs !== stamps.jsonl.mtimeMs || hit.size !== stamps.jsonl.size) {
      return undefined;
    }
    if (hit.negative === true) {
      this.fileCache.set(file, { negative: true, ...stamps });
      return null;
    }
    const payloads = readSidecarPayloads(file, stamps);
    const entry = RecordStore.buildFileCacheEntry({ ...hit, forkDepth: undefined, sessionFile: file }, file, stamps, payloads, now);
    this.fileCache.set(file, entry);
    this.idToFile.set(hit.id, file);
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
        // [PS-14/T7③] 升 warn：索引反复写失败（权限/磁盘满）曾仅 debug 级，排障时
        // 无线索。失败会跨轮重试（dirty 恢复），warn 每次过窗写失败都会出现——
        // 正是「反复写失败需要可见」的信号面。
        logger.warn("[subagents] sessions-index write failed", {
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
          state: entry.stateMarker,
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

  /** identity 基底 + sidecar 状态矩阵 → 缓存条目（索引命中与探测重建两分支的公共装配点）。 */
  private static buildFileCacheEntry(
    base: IdentityHeaderRecon,
    file: string,
    stamps: FileStamps,
    payloads: SidecarPayloads,
    now: number,
  ): FileCacheEntry {
    return {
      light: RecordStore.buildRecord(base, {
        state: payloads.state,
        alive: payloads.aliveData,
        jsonlMtimeMs: stamps.jsonl.mtimeMs,
        now,
      }),
      full: undefined,
      jsonl: stamps.jsonl,
      state: stamps.state,
      alive: stamps.alive,
      binding: stamps.binding,
      stateMarker: payloads.state,
      aliveData: payloads.aliveData,
    };
  }

  /** identity 基底（头部 light 或全量 recon）+ 四分支状态矩阵（终态 marker / alive / 兜底）→ SubagentRecord。 */
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

    // ── 分支 1: 终态 sidecar（.state 优先，旧 .finalized/.cancelled 兼容归一）──
    if (m.state !== undefined && m.state.status === "cancelled") {
      // v4 B-1: cancelled 折入 closed（closedReason='cancelled' 保留 L2 区分）。
      markReconstructedStatus(rec, "closed");
      rec.closedReason = "cancelled";
      rec.error = "cancelled by user";
      // endedAt 用 sidecar 携带的精确值（原 tombstone.endedAt）；缺失（新写侧恒携带，
      // 兼容手写残留）回落全量末 entry ts / light mtime。
      rec.endedAt = m.state.endedAt ?? m.fullEndedAt ?? m.jsonlMtimeMs;
    }
    // ── 分支 2: finalized（同 sidecar，status=finalized）──
    else if (m.state !== undefined) {
      // closed 统一终态：done/failed/crashed 合并为 closed。closedReason 优先用
      // sidecar 内容携带的真实原因（[v8.5 A2] doFinalizeRecord Step3 写入）。
      // 空内容（旧格式空文件 / 未携 reason 的外部写入）→ disconnected 兜底：死因
      // 不可考，但「正常结束过」信号仍在——替代旧的误导性 gc 兜底（自然完成 vs
      // 断联不分）。非枚举值（外部损坏/手写垃圾内容）同 treated as unknown → disconnected。
      markReconstructedStatus(rec, "closed");
      const reason = m.state.reason?.trim();
      rec.closedReason = isValidClosedReason(reason) ? (reason as ClosedReason) : "disconnected";
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

  // [PS-15/T7⑤] 「从缓存与索引移除单文件」的旧私有方法已整体删除：全仓无调用方
  // 的死代码（设计 §4.3 PS-15 实锤，顺手清理，无行为影响）。「文件删除时移除缓存」
  // 的职责实际由 reconstructAll 的消失文件修剪路径承担。

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
   *  status 越界（mapManifestStatus 返回 null）时返回 null，由 collectRecords 跳过。
   *  [M2 Gate B] closedReason 投影（枚举守卫，同 mapManifestStatus 的越界容错口径）：
   *  旧 manifest 无此字段 / 损坏值 → undefined。缺失曾让 manifest 源快照在
   *  endedMessageGuard 丢失三分流依据（user-close/cancelled 误入 reconnectable 分支）。 */
  private static manifestToSubagent(m: ManifestRecord): SubagentRecord | null {
    const status = mapManifestStatus(m.status);
    if (status === null) return null;
    return {
      id: m.id,
      agent: m.agentName,
      task: m.task ?? "",
      slug: m.slug ?? "",
      status,
      closedReason: isValidClosedReason(m.closedReason) ? m.closedReason : undefined,
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
      // [E2E 实测抓漏] 缺这两行时 chatMode/resumable 在 recordToSubagent 处被丢弃，
      // entry 序列化后无此字段 → renderer isDone（需显式 chatMode===false）恒不成立，
      // 完成态 one-shot 永远显示 waiting。单测 schema 断言曾因内存对象保留 undefined
      // 键名而未拦截（真实 JSONL 丢 undefined 值），故 schema 测试改为序列化后断言。
      chatMode: r.chatMode,
      resumable: r.resumable,
      // [review round2] worktree 隔离标志：内存源有 handle 或跨重启重建带 hadWorktree 均为 true。
      worktree: r.worktreeHandle !== undefined || r.hadWorktree === true,
      engine: r.engine,
      engineFallback: r.engineFallback,
      // U2：engineHandle 经 entry 持久化（register/archive 双写点均经本投影），无则 undefined 自然省略
      engineHandle: r.engineHandle,
      // [U5 修复 U2 披露的投影缺口] 同步收集两字段随本投影持久化（register entry /
      // archive entry 双写点均经本投影），原缺失时闭合判定 flushBatch 重建、E1 重建扫描等
      // 消费方读不到原始值。undefined 经 JSON.stringify 自然缺省，旧 entry 零迁移。
      collectMode: r.collectMode,
      batchFinalized: r.batchFinalized,
      // [H2 W1] 来源身份两字段随本投影持久化（register/archive/reportRecordTransition
      // 全部写点均经本投影 → toSubagentRecordEntry）。漏投影则 entry 无 origin，重启后
      // 重建链拿不到来源、D1 投影过滤全失效（同型先例：H1 U5 缺字段事故）。
      // undefined 经 JSON.stringify 自然缺省，存量 record 序列化字节不变（零迁移）。
      origin: r.origin,
      parentRunId: r.parentRunId,
    };
  }
}
