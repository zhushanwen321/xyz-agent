// src/execution/sessions-index.ts
//
// [perf L-1] sessions-index.json —— identity 探测结果的磁盘种子。
//
// 背景：RecordStore 冷启动首扫需逐个探测 sessions/*.jsonl 的 identity（头部 64KB →
// 尾部 64KB → 全文 fallback）。session 数量大时该探测是冷扫描的主要成本。本模块把
// 「本目录的探测结论」（per-file identity 或负标记）持久化到 sessionsDir 的兄弟位置
// （<enc> 段内），下次进程/实例首扫直接用索引条目构造缓存条目（零内容读取）。
//
// 语义：
//   - 读侧（loadIndex）永不抛：文件缺失/JSON 损坏/结构不符/版本低 → 空索引（= 今天的
//     全量行为，下轮 dirty 重写自愈）；版本高于自身 → 空索引 + higherVersion 标志
//     （整体忽略不消费，RecordStore 据此抑制本轮及后续落盘，防 v1/v2 last-writer-wins
//     覆盖振荡）。
//   - 写侧（saveIndex）：tmp(pid)+fsync+rename+目录 fsync 原子写（逐环复刻
//     ManifestStore.writeManifest 的生产模式）。失败本身向上抛；fire-and-forget 的
//     .catch 兜底在 RecordStore 侧。
//   - 损坏/降级走 logger.debug（PI_EXT_DEBUG=1 可见，默认 no-op），不 console.error
//     ——索引是纯性能缓存，降级自愈不应告警。
//
// 无状态纯函数模块：不依赖 RecordStore 任何内部状态。

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { getLogger } from "@zhushanwen/pi-extension-logger";

import { bestEffort } from "./best-effort.ts";
import type { ExecutionMode } from "./types.ts";

const logger = getLogger("subagents");

// ============================================================
// 常量（测试锚点 SSOT：RecordStore 与测试从同一来源引用，禁止内联字面量）
// ============================================================

/** 索引文件名（落 sessionsDir 兄弟位置——写索引不改 sessionsDir 目录 mtime，不击穿 L0 快路径）。 */
export const INDEX_FILENAME = "sessions-index.json";

/** 索引格式版本。schema 变更必须递增：低版本文件整体丢弃（空索引，下轮 dirty 重写自愈）；高版本整体忽略（higherVersion，不重写）。 */
export const INDEX_VERSION = 1;

/** 两次成功落盘的最小墙钟间隔（节流：overlay 打开期间的高频扫描不放大磁盘写）。 */
export const INDEX_WRITE_MIN_INTERVAL_MS = 60_000;

// ============================================================
// 类型（DM1 磁盘顶层 + DM2 条目）
// ============================================================

/**
 * 正索引条目：「该文件有 identity」的身份字段 + stat 戳。
 *
 * 不含 sessionFile（加载侧由 sessionsDir + basename 重构，绝对路径因 agentDir 迁移
 * 整体失效）；不含 forkDepth/chatMode（投影源 SubagentRecord 无此二字段，buildRecord
 * 构造 light 时不读——存了也无消费方；未来需要时升 INDEX_VERSION）。
 */
export interface SessionsIndexEntry {
  /** tagged union 判别（负条目为 true）。显式声明 false 供 TS narrowing（与 record-store.ts FileCacheEntry 同款）。 */
  negative?: false;
  /** jsonl stat 戳（mtime+size）——不匹配 = 内容变化，调用方回退重探测。 */
  mtimeMs: number;
  size: number;
  id: string;
  agent: string;
  /** 执行模式。运行时校验宽容历史 "sync" 值（白名单 sync|background，镜像 isIdentityData）；类型层由 ExecutionMode 收窄。 */
  mode: ExecutionMode;
  task: string;
  slug: string;
  startedAt: number;
  /** undefined 表示缺失（旧文件/顶层）。JSON 序列化时被丢弃，往返保持 undefined。 */
  rootSessionId: string | undefined;
  parentRecordId: string | undefined;
  depth: number;
  /** 空串合法：尾部探测（readIdentityTail）拿不到 model 时的合法结果，不当损坏。 */
  model: string;
  thinkingLevel: string | undefined;
}

/**
 * 负索引条目：「该文件确认无 identity」（junk/异构文件）。与内存负缓存
 * NegativeFileEntry 语义对齐——把「没有」这一事实持久化，跨实例零重探测。
 */
export interface SessionsIndexNegativeEntry {
  negative: true;
  mtimeMs: number;
  size: number;
}

/** 磁盘 JSON 顶层结构（key = jsonl basename 不含路径）。 */
export interface SessionsIndexFile {
  version: 1;
  pid: number;
  entries: Record<string, SessionsIndexEntry | SessionsIndexNegativeEntry>;
}

/** saveIndex 输入（内存形态）。 */
export interface SessionsIndexData {
  entries: Map<string, SessionsIndexEntry | SessionsIndexNegativeEntry>;
}

/** loadIndex 输出。恒返回该形态对象（不抛、不返回 null）。 */
export interface LoadedSessionsIndex {
  entries: Map<string, SessionsIndexEntry | SessionsIndexNegativeEntry>;
  /** true = 磁盘版本高于自身：条目整体不消费，且本进程及后续不得写盘（防 v1/v2 互相覆盖振荡）。 */
  higherVersion: boolean;
}

// ============================================================
// 条目级校验（ES3：单条目损坏仅丢弃该条目，不放大为整体失效）
// ============================================================

/** 正条目类型谓词：镜像 isIdentityData（session-reconstructor.ts:244-253）的字段检查 + 索引特有戳/形态字段。 */
function isPositiveIndexEntry(raw: unknown): raw is SessionsIndexEntry {
  if (typeof raw !== "object" || raw === null) return false;
  const v = raw as Record<string, unknown>;
  return (
    typeof v.mtimeMs === "number" &&
    typeof v.size === "number" &&
    typeof v.id === "string" &&
    typeof v.agent === "string" &&
    // 宽容历史 "sync" 值（ExecutionMode 现值仅 "background"，"sync" 是旧数据合法值，放行不丢弃）
    (v.mode === "sync" || v.mode === "background") &&
    typeof v.task === "string" &&
    typeof v.slug === "string" &&
    typeof v.startedAt === "number" &&
    (v.rootSessionId === undefined || typeof v.rootSessionId === "string") &&
    (v.parentRecordId === undefined || typeof v.parentRecordId === "string") &&
    typeof v.depth === "number" &&
    typeof v.model === "string" && // 空串合法（DS4）
    (v.thinkingLevel === undefined || typeof v.thinkingLevel === "string")
  );
}

/** 负条目类型谓词（tagged union 形态检查）。 */
function isNegativeIndexEntry(raw: unknown): raw is SessionsIndexNegativeEntry {
  if (typeof raw !== "object" || raw === null) return false;
  const v = raw as Record<string, unknown>;
  return v.negative === true && typeof v.mtimeMs === "number" && typeof v.size === "number";
}

/**
 * 校验单条索引条目。返回 undefined = 条目损坏，调用方仅丢弃该条目
 * （该文件本轮回退探测，其余条目正常保留/命中）。
 */
export function validateIndexEntry(
  raw: unknown,
): SessionsIndexEntry | SessionsIndexNegativeEntry | undefined {
  if (!isPositiveIndexEntry(raw) && !isNegativeIndexEntry(raw)) return undefined;
  return raw;
}

// ============================================================
// 读侧（IF1：永不抛）
// ============================================================

/**
 * 读取指定目录（<enc> 段）的 sessions-index.json。永不抛：
 *   - 文件不存在/读失败/JSON.parse 失败/顶层结构不符/版本低于自身
 *     → { entries: 空 Map, higherVersion: false }（空索引 = 今天的全量行为）
 *   - 版本高于自身 → { entries: 空 Map, higherVersion: true }
 *     （整体忽略——即使 entries 合法也不消费，防陈旧 schema 灌入；RecordStore 据此抑制落盘）
 *   - 版本匹配 → 逐条 validateIndexEntry（坏条目丢弃，其余保留）
 *
 * 只读精确路径 INDEX_FILENAME：.tmp. 残留文件不匹配文件名，天然被忽略。
 */
export function loadIndex(encDir: string): LoadedSessionsIndex {
  const empty: LoadedSessionsIndex = { entries: new Map(), higherVersion: false };
  const indexPath = path.join(encDir, INDEX_FILENAME);

  let raw: string;
  try {
    raw = fs.readFileSync(indexPath, "utf-8");
  } catch {
    return empty; // 文件不存在（正常首跑）/读失败
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // 损坏（截断/外部编辑）走 debug：可降级自愈场景，不 console.error
    logger.debug("[subagents] sessions-index corrupted JSON, fallback to empty", {
      detail: { path: indexPath, error: err instanceof Error ? err.message : String(err) },
    });
    return empty;
  }

  if (typeof parsed !== "object" || parsed === null) {
    logger.debug("[subagents] sessions-index invalid top-level shape, fallback to empty", {
      detail: { path: indexPath },
    });
    return empty;
  }
  const top = parsed as Record<string, unknown>;
  if (
    typeof top.version !== "number" ||
    typeof top.entries !== "object" ||
    top.entries === null ||
    Array.isArray(top.entries)
  ) {
    logger.debug("[subagents] sessions-index invalid header fields, fallback to empty", {
      detail: { path: indexPath },
    });
    return empty;
  }

  if (top.version > INDEX_VERSION) {
    // 高版本：整体忽略（entries 即使合法也不消费）；调用方据 higherVersion 抑制写盘
    return { entries: new Map(), higherVersion: true };
  }
  if (top.version < INDEX_VERSION) {
    // 低版本：整体丢弃 → 空索引；本轮全扫 dirty 后重写自愈
    logger.debug("[subagents] sessions-index stale version, discarded", {
      detail: { path: indexPath, version: top.version, expected: INDEX_VERSION },
    });
    return empty;
  }

  const entries = new Map<string, SessionsIndexEntry | SessionsIndexNegativeEntry>();
  for (const [key, value] of Object.entries(top.entries)) {
    const entry = validateIndexEntry(value);
    if (entry !== undefined) entries.set(key, entry);
  }
  return { entries, higherVersion: false };
}

// ============================================================
// 写侧（IF2：原子写；失败向上抛——fire-and-forget 的 .catch 兜底在调用方）
// ============================================================

/**
 * 原子写索引（tmp(pid) → fsync → rename → fsync 目录；逐环复刻
 * ManifestStore.writeManifest 的生产模式）。tmp 带 pid 后缀防两进程共用同一 tmp；
 * rename 原子性保证读侧看到旧版或完整新版，绝无半成品。
 *
 * 失败向上抛——RecordStore 的 flushIndexAfterScan 以 fire-and-forget .catch 消费
 * （写失败不影响任何扫描结果，恢复 dirty 待下轮过窗重试）。
 */
export async function saveIndex(encDir: string, data: SessionsIndexData): Promise<void> {
  const filePath = path.join(encDir, INDEX_FILENAME);
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  const file: SessionsIndexFile = {
    version: INDEX_VERSION,
    pid: process.pid,
    entries: Object.fromEntries(data.entries),
  };
  const content = JSON.stringify(file);

  let renamed = false;
  try {
    // 1. 写 tmp → fsync 文件
    const fh = await fsPromises.open(tmpPath, "w");
    try {
      await fh.writeFile(content, "utf-8");
      await fh.sync();
    } finally {
      await fh.close();
    }

    // 2. rename tmp → final（放在 try 内：失败时 catch 清理 tmp）
    await fsPromises.rename(tmpPath, filePath);
    renamed = true;

    // 3. fsync 目录（best-effort：POSIX 不要求，失败不否定已成功的 rename）
    try {
      const dirFh = await fsPromises.open(encDir, "r");
      try {
        await dirFh.sync();
      } finally {
        await dirFh.close();
      }
    } catch (dirSyncErr) {
      bestEffort(dirSyncErr, "fsync dir (saveIndex)");
    }
  } catch (err) {
    // rename 未成功 → 清理残留 tmp（best-effort，不掩盖原错误）
    if (!renamed) {
      try {
        await fsPromises.unlink(tmpPath);
      } catch (cleanupErr) {
        bestEffort(cleanupErr, "unlink tmp (saveIndex)");
      }
    }
    throw err;
  }
}
