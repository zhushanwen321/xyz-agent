// src/session-file-locator.ts
//
// M4 close 兜底扫描器（设计 docs/design/subagent-agent-end-recovery-replay.md
// §3.3 决策 4 + §3.4 错误规格）：sessionFile 全 miss（get_state 握手总失 +
// agent_end 补查又失）场景的最后兜底——close 收尾时按任务 prompt 头部内容扫
// sessionDir 找回 session 文件。匹配键 = prompt 头部（引擎侧 run params 天然持有，
// 零协议改动、零 extension 依赖；identity entry 数据源已结构性消亡，见设计决策 6）。
//
// K3① 落盘形态核验（实装 pi 0.84.4，2026-09-10 探针实测，非推理）：
// dist/core/session-manager.js `appendMessage()` 组 entry
// {type:"message", message:{role:"user",content:[{type:"text",text:<prompt>}]}}，
// `_persist()` 惰性 flush（首条 assistant 落盘全部 entries）后逐行
// `JSON.stringify(entry) + "\n"` 写文件。探针对含引号/换行/反斜杠/制表符的 prompt
// 实测：`raw.includes(promptHead)` = false，`raw.includes(JSON.stringify(promptHead)
// .slice(1,-1))` = true——即 prompt **非逐字落盘**（走 JSON 转义形态）。故匹配键用
// 「原文 + JSON 转义形态」双 includes（转义是确定性逐字符变换，截断头的前缀转义结果
// 与全文序列化前缀一致；命中语义仍是逐字节精确子串，不放松误配防线）。纯中文/无
// 特殊字符的 prompt 两形态相同（构造时去重，只留一份键）。
//
// 安全语义（设计决策 4）：
// - 单命中才采纳，零命中/多命中一律放弃（同模板批量并发的多命中形态结构性安全放弃）；
// - 降级门：mtime 窗口内候选 > MAX_SCAN_CANDIDATES 或单次扫描耗时 > SCAN_TIME_BUDGET_MS
//   → 跳过扫描（放弃）；
// - 整体 try-catch：任何 fs 异常（readdir/stat/读头）降级为放弃 + 结构化原因，
//   不向调用方抛错——调用方（spawn-run-pump close finalizer）的 resolveExit 必达是
//   硬约束（设计 §3.4，先例 spawn-run-pump.ts stderrTee.close 的 best-effort 注释）。
//
// 采纳/放弃的 warn 由调用方（pump，持有 recordId）发出：本模块只返回结构化结果 +
// 审计证据（候选文件名 + mtime + prompt 头哈希，不落 prompt 明文）。

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { toErrorMessage } from "./error-message.ts";

/** prompt 头部截取长度（匹配键 = 任务 prompt 前 ~200 字符）。 */
export const PROMPT_HEAD_CHARS = 200;
/** 候选头读窗口的 KiB 数与每 KiB 字节数（命名常量同 constants.ts 惯例）。 */
const HEADER_READ_KIB = 64;
const BYTES_PER_KIB = 1024;
/** 候选头读窗口（逐候选前向读首 64KiB）。 */
export const HEADER_READ_BYTES = HEADER_READ_KIB * BYTES_PER_KIB;
/** 降级门：mtime 窗口内候选数上限（窗口内并发 run 数的个位量级 × 足量余量）。 */
export const MAX_SCAN_CANDIDATES = 64;
/** 降级门：单次扫描耗时上限（ms；与既有 LC-4 反查同段同量级先例）。 */
export const SCAN_TIME_BUDGET_MS = 100;
/** prompt 头哈希保留的 hex 字符数（16 hex = 64 bit，够事后比对定位）。 */
const PROMPT_HEAD_HASH_CHARS = 16;
/** UTF-16 高代理区间（截断点落此区间 = 劈开非 BMP 字符，见 promptHeadOf）。 */
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

/** 扫描输入（close finalizer 组装）。 */
export interface SessionFileScanInput {
  /** 子进程 session 目录（--session-dir）。 */
  sessionDir: string;
  /** mtime 窗口下界：run spawn 起始时刻（ms）。 */
  spawnStartedAtMs: number;
  /** mtime 窗口上界：close 时刻（ms）。 */
  closeAtMs: number;
  /** 任务 prompt 全文（本模块截头部作匹配键，调用方无需自行截断）。 */
  prompt: string;
}

/** 放弃原因（调用方 warn 观测面）。 */
export type SessionFileScanGiveUpReason =
  | "empty_prompt_head"
  | "no_candidates"
  | "no_match"
  | "multiple_matches"
  | "candidate_limit"
  | "time_budget"
  | "fs_error";

/** 扫描结果：sessionFile 为 undefined 即放弃（reason 供 warn；不抛错契约）。 */
export interface SessionFileScanResult {
  /** 单命中文件绝对路径；零/多命中、降级门、fs 异常均为 undefined。 */
  sessionFile: string | undefined;
  /** 放弃原因（采纳命中时 undefined）。 */
  reason: SessionFileScanGiveUpReason | undefined;
  /**
   * 已收集到的 mtime 入窗候选数。
   * - 收集阶段跑完（no_candidates / candidate_limit / 匹配阶段的判定与 time_budget、
   *   收集完成后的 fs 异常）→ = 窗口内候选总数（candidateTotalKnown=true）；
   * - 收集阶段被时间门打断 / readdir 抛错 → 只是到中断点为止的**部分计数**，
   *   窗口总数未知（candidateTotalKnown=false，warn 不得把它呈现为候选总数）。
   */
  candidateCount: number;
  /** candidateCount 是否为窗口内候选总数（false = 收集被中断，总数未知）。 */
  candidateTotalKnown: boolean;
  /** 采纳命中审计证据：候选文件名 + mtime（误配事后定位用）。 */
  matchedFileName: string | undefined;
  matchedMtimeMs: number | undefined;
  /** prompt 头部 sha256 前 16 hex（审计证据；不落 prompt 明文）。 */
  promptHeadHash: string;
  /** fs 异常消息（reason=fs_error 时非空）。 */
  errorMessage: string | undefined;
}

/** 候选条目（mtime 过滤后）。 */
interface ScanCandidate {
  name: string;
  path: string;
  mtimeMs: number;
}

/** 匹配键：prompt 头部（不劈开代理对，见下）。 */
function promptHeadOf(prompt: string): string {
  const head = prompt.slice(0, PROMPT_HEAD_CHARS);
  const lastUnit = head.charCodeAt(head.length - 1);
  // 截断点落在高代理（非 BMP 字符的 UTF-16 前半）时丢弃该半字符：半截代理在
  // JSON.stringify 下成 \udXXX 转义形态，与文件里的合法字符序列两形态均失配
  // （安全但静默失效）——丢弃后头部仍是全文的逐字符前缀，两形态都必然命中。
  return lastUnit >= HIGH_SURROGATE_MIN && lastUnit <= HIGH_SURROGATE_MAX ? head.slice(0, -1) : head;
}

/** 候选头读（前向首 HEADER_READ_BYTES；非法 UTF8 字节由 toString 替换为 U+FFFD 不抛）。 */
function readHead(filePath: string): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(HEADER_READ_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, HEADER_READ_BYTES, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 按 prompt 头部内容扫描 sessionDir 找回 session 文件（M4，设计决策 4）。
 *
 * 流程：readdir 取 `.jsonl` 候选 → stat mtime 过滤（∈ [spawnStartedAtMs, closeAtMs]）
 * → 降级门（候选数/耗时）→ 逐候选前向头读 + 双形态 includes → 单命中采纳。
 * 同步实现（close finalizer 清理链内联执行；IO 量级 = 窗口候选 × 64KB 头读）。
 *
 * @param opts.now 时钟注入（耗时降级门的确定性测试 seam；缺省 Date.now）。
 */
export function locateSessionFileByPromptHead(
  input: SessionFileScanInput,
  opts: { now?: () => number } = {},
): SessionFileScanResult {
  const now = opts.now ?? Date.now;
  const startMs = now();
  const promptHead = promptHeadOf(input.prompt);
  // 审计哈希：sha256 前 16 hex（误配事后定位；不落 prompt 明文进日志）
  const promptHeadHash = createHash("sha256").update(promptHead).digest("hex").slice(0, PROMPT_HEAD_HASH_CHARS);

  const candidates: ScanCandidate[] = [];
  /** 收集阶段是否跑完（决定 candidateTotalKnown：被打断时计数只是部分值）。 */
  let collectionComplete = false;
  const giveUp = (
    reason: SessionFileScanGiveUpReason,
    candidateTotalKnown = true,
  ): SessionFileScanResult => ({
    sessionFile: undefined,
    reason,
    candidateCount: candidates.length,
    candidateTotalKnown,
    matchedFileName: undefined,
    matchedMtimeMs: undefined,
    promptHeadHash,
    errorMessage: undefined,
  });
  const adopt = (matched: ScanCandidate): SessionFileScanResult => ({
    sessionFile: matched.path,
    reason: undefined,
    candidateCount: candidates.length,
    candidateTotalKnown: true,
    matchedFileName: matched.name,
    matchedMtimeMs: matched.mtimeMs,
    promptHeadHash,
    errorMessage: undefined,
  });

  try {
    if (promptHead.length === 0) return giveUp("empty_prompt_head");
    // 匹配键双形态：原文 + JSON 序列化转义形态（pi 落盘形态，见头注 K3①）
    const escapedHead = JSON.stringify(promptHead).slice(1, -1);
    const keys = escapedHead === promptHead ? [promptHead] : [promptHead, escapedHead];

    const entries = fs.readdirSync(input.sessionDir, { withFileTypes: true });
    // mtime 过滤（窗口 [spawnStartedAtMs, closeAtMs] 含边界）；任一 fs 异常向上抛
    // → 整体 catch 放弃（设计 §3.4：stat 抛错不做候选级吞，保守安全）
    for (const entry of entries) {
      // 时间门早退在收集循环内：此时 candidates 只是部分计数，窗口总数未知——
      // 显式标 candidateTotalKnown=false（warn 须写明「so far」，不得让诊断方
      // 误以为窗口内候选只有这么少）
      if (now() - startMs > SCAN_TIME_BUDGET_MS) return giveUp("time_budget", false);
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = join(input.sessionDir, entry.name);
      const mtimeMs = fs.statSync(filePath).mtimeMs;
      if (mtimeMs >= input.spawnStartedAtMs && mtimeMs <= input.closeAtMs) {
        candidates.push({ name: entry.name, path: filePath, mtimeMs });
      }
    }
    collectionComplete = true;

    if (candidates.length === 0) return giveUp("no_candidates");
    if (candidates.length > MAX_SCAN_CANDIDATES) return giveUp("candidate_limit");

    // 逐候选头读匹配：单命中才采纳（发现第二命中即安全放弃，省剩余 IO）
    let matched: ScanCandidate | undefined;
    for (const candidate of candidates) {
      if (now() - startMs > SCAN_TIME_BUDGET_MS) return giveUp("time_budget");
      if (keys.some((k) => readHead(candidate.path).includes(k))) {
        if (matched !== undefined) return giveUp("multiple_matches");
        matched = candidate;
      }
    }
    if (matched === undefined) return giveUp("no_match");
    return adopt(matched);
  } catch (err) {
    // 收集阶段中断（readdir 抛 / stat 抛）→ 计数非总数；匹配阶段抛（头读）→ 收集已完
    return { ...giveUp("fs_error", collectionComplete), errorMessage: toErrorMessage(err) };
  }
}
