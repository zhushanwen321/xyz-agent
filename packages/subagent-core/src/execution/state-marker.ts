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
//
// [UF-1] record 绑定 sidecar（`.record-binding`）同挂本载体族：宿主侧在 record.sessionFile
// 回填点写「record id → session 文件」映射（engine-CLI 化后子 session 文件无身份 entry，
// 旧 PI_SUBAGENT_SELF_RECORD_ID 注入链消失，collectRecords/findLightById 失去 id→file
// 工件——本 sidecar 是该映射的宿主侧落盘权威）。与终态 sidecar 的关系：
//   - 读侧消费（record-store scanFile）：仅当子文件无 identity entry 时用绑定重建身份，
//     status 判定仍走 buildRecord 四分支矩阵——`.state`（终态）优先级天然高于绑定的
//     running 形态，二者并存无冲突（终态后绑定保留：resurrect 回边删 .state 后绑定
//     仍在，再崩溃仍可恢复）；
//   - GC：session-file-gc 的 sidecar 名单暂未含本扩展名（孤儿绑定在 jsonl 被 GC 后
//     残留，量级 = 崩溃 record 数，接受；名单扩展归 GC 领地批次）。

import * as fs from "node:fs";

import { getLogger } from "../core/logger.ts";

import type { RecordOrigin } from "./types.ts";

const logger = getLogger("subagents");

/** 终态 sidecar 扩展名（写侧新名 + 读侧兼容旧名；GC 清理名单与此同源语义）。 */
export const STATE_SIDECAR_EXT = ".state";

/** record 绑定 sidecar 扩展名（UF-1：宿主侧 id→file 映射载体）。 */
export const RECORD_BINDING_SIDECAR_EXT = ".record-binding";
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

// ============================================================
// record 绑定 sidecar（UF-1：宿主侧 id→file 映射的写读）
// ============================================================

/**
 * 绑定 sidecar 载荷（v1）。字段集 = record-store 磁盘重建 light record 所需的
 * 全部身份域（IdentityHeaderRecon 投影源）+ 对话形态域（chatMode/round）。
 * undefined 字段经 JSON.stringify 自然缺省（读侧守卫归一）。
 */
export interface RecordBinding {
  /** schema 版本。消费方按 v 判别解析，不认识的版本跳过而非猜测。 */
  v: 1;
  recordId: string;
  /** 根 Pi session id（session 隔离过滤与归属校验用；initSession 前的异常窗口 undefined）。 */
  rootSessionId?: string;
  /** 直接父 record id（跨层归属校验用；顶层 undefined）。 */
  parentRecordId?: string;
  /** 递归深度（顶层 0）。 */
  depth: number;
  agent: string;
  task: string;
  slug: string;
  /** 执行模式（窄字面量跟随 types.ts ExecutionMode 现值；扩展时随 schema v2）。 */
  mode: "background";
  startedAt: number;
  /** 对话形态标志（message 链恢复语义的分流域）。 */
  chatMode: boolean;
  /** 已完成对话轮数（绑定写时点快照；回填点早于轮终 +1，恢复值可滞后一拍）。 */
  round?: number;
  model: string;
  thinkingLevel?: string;
  /** 创建时启用 worktree 隔离（重建面 hadWorktree 恢复源）。 */
  worktree: boolean;
  /**
   * 来源身份（H2 S3 修复：引擎子文件身份面 origin 透传）。undefined（存量 binding）
   * = "tool" 语义，消费方零迁移——engine-CLI 化后子 session 文件无 identity entry，
   * 本 sidecar 是磁盘重建面 origin 过滤（subagents list / TUI overlay）的唯一承载，
   * 漏本字段则归档/重启后 workflow record 逃过投影过滤（Gate B S3 FAIL 根因）。
   */
  origin?: RecordOrigin;
  /**
   * origin="workflow" 时所属 workflow run id；tool 来源恒缺省。W2/W3 run 视图按
   * collectRecordsByParentRunId 从本字段回查本 run 的 record 集。
   */
  parentRunId?: string;
  /**
   * 终态 usage 快照（[H2 A3]，终态写点 Step3a 随 .state 同步更新 binding）：
   * totalTokens/turns/endedAt 三字段的 record 终值。light 列表面据此恢复 usage
   * （子文件无 identity entry，全量重建面不可用；round 补投影同款先例）。
   * undefined（存量 binding / 非终态写点）= 不投影（读侧守卫归一）。
   */
  totalTokens?: number;
  /** 终态 turn 计数快照（见 totalTokens 注）。 */
  turns?: number;
  /** 终态结束时间快照 ms（精确值，优于 light 路径的 jsonl mtime 近似）。 */
  endedAt?: number;
}

/**
 * 写 record 绑定 sidecar（原子写：独占创建 tmp → rename 覆盖目标）。
 *
 * best-effort 记账面：任何 I/O 失败只 warn 不抛——绑定写发生在派发/应答主路径上，
 * 绑定缺失只影响跨重启恢复能力，不得影响当前进程的派发推进。
 *
 * @param sessionFile 子 session.jsonl 绝对路径（绑定目标 = `<sessionFile>.record-binding`）
 */
export function writeRecordBinding(sessionFile: string, binding: RecordBinding): void {
  const target = `${sessionFile}${RECORD_BINDING_SIDECAR_EXT}`;
  // tmp 名带 pid：多进程共享 sessionsDir 时互不覆盖；wx 独占创建防同进程残留碰撞。
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(binding), { encoding: "utf-8", flag: "wx" });
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_e) {
      void _e; // tmp 清理失败不追加处理（同为目标目录 IO 故障域）
    }
    logger.warn("[subagents] record binding write failed (best-effort bookkeeping; dispatch unaffected)", {
      detail: {
        sessionFile,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

/**
 * 读 record 绑定 sidecar。
 *
 * 返回 undefined：文件缺失 / JSON 损坏 / 版本不识别 / 关键身份域缺失或类型非法
 * （recordId/agent/task/mode/startedAt 是重建 light record 的最低要求，残缺载荷
 * 拒绝重建——与 rebuildEntryRecord 的损坏 entry 跳过语义同向，不把损坏残留误判成
 * 可恢复身份）。可选域（rootSessionId/parentRecordId/round/thinkingLevel）类型非法
 * 时归一 undefined，不影响整体判读。
 */
export function readRecordBinding(sessionFile: string): RecordBinding | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(`${sessionFile}${RECORD_BINDING_SIDECAR_EXT}`, "utf-8");
  } catch {
    return undefined; // sidecar 不存在（正常——未回填 sessionFile 的 record 无绑定）
  }
  let parsed: Partial<RecordBinding>;
  try {
    parsed = JSON.parse(raw) as Partial<RecordBinding>;
  } catch {
    return undefined;
  }
  if (
    parsed.v !== 1 ||
    typeof parsed.recordId !== "string" ||
    parsed.recordId === "" ||
    typeof parsed.agent !== "string" ||
    typeof parsed.task !== "string" ||
    (parsed.mode !== "background") ||
    typeof parsed.startedAt !== "number"
  ) {
    return undefined;
  }
  return {
    v: 1,
    recordId: parsed.recordId,
    rootSessionId: typeof parsed.rootSessionId === "string" ? parsed.rootSessionId : undefined,
    parentRecordId: typeof parsed.parentRecordId === "string" ? parsed.parentRecordId : undefined,
    depth: typeof parsed.depth === "number" ? parsed.depth : 0,
    agent: parsed.agent,
    task: parsed.task,
    slug: typeof parsed.slug === "string" ? parsed.slug : "",
    mode: parsed.mode,
    startedAt: parsed.startedAt,
    chatMode: parsed.chatMode === true,
    round: typeof parsed.round === "number" ? parsed.round : undefined,
    model: typeof parsed.model === "string" ? parsed.model : "",
    thinkingLevel: typeof parsed.thinkingLevel === "string" ? parsed.thinkingLevel : undefined,
    worktree: parsed.worktree === true,
    // 来源身份两字段（H2 S3）：字面量守卫归一（非法/缺省 → undefined = "tool" 语义），
    // 对齐 record-store.readEntryOriginFields 主 entry 重建侧的同名守卫。
    origin:
      parsed.origin === "workflow" || parsed.origin === "tool" ? parsed.origin : undefined,
    parentRunId: typeof parsed.parentRunId === "string" ? parsed.parentRunId : undefined,
    // 终态 usage 快照三字段（H2 A3）：number 守卫（非法/缺省 → undefined = 不投影）。
    totalTokens: typeof parsed.totalTokens === "number" ? parsed.totalTokens : undefined,
    turns: typeof parsed.turns === "number" ? parsed.turns : undefined,
    endedAt: typeof parsed.endedAt === "number" ? parsed.endedAt : undefined,
  };
}

/**
 * merge 更新 record 绑定 sidecar（[H2 A3] 终态写点专用）：读现有 binding → 合并
 * patch → 原子重写。现有 binding 缺失/损坏时**跳过不造新**（updateRecordBinding 不
 * 承担身份创建职责——binding 缺失 = 回填点也未跑过的异常窗口，用部分字段造 binding
 * 会产出残缺身份；writeRecordBinding 才是创建入口）。best-effort 语义同写侧。
 */
export function updateRecordBinding(sessionFile: string, patch: Partial<RecordBinding>): void {
  const existing = readRecordBinding(sessionFile);
  if (existing === undefined) return;
  writeRecordBinding(sessionFile, { ...existing, ...patch });
}
