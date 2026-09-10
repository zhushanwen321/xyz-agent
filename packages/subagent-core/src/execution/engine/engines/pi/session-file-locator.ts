// src/execution/engine/engines/pi/session-file-locator.ts
//
// [U1 D2] sessionDir 扫描兜底：第二路 sessionFile 获取通道（设计
// docs/design/subagent-agent-end-recovery.md §3.3 D2）。
//
// 背景：get_state 握手一次性失败后 record.sessionFile 永久缺失（D1 迟到接受修主路径
// ——迟到的应答经管道语义保证必达），本模块是决策点的第二路兜底：不经子进程，直接扫
// spawn 时已知的 sessionDir，按文件内 identity entry 精确匹配 record.id 定位 session
// 文件。命中前提 = **文件已落盘 ∧ identity entry 在文件内**（[Gate B P4 实测勘误] 两者
// 不等价：pi session 文件随首条 assistant 消息才落盘，「session_start hook 已跑但文件
// 未落盘」的极早期 kill 结构性 miss，属正确 crashed 记账）。agent_end 时刻两前提结构上
// 必然成立（完成的定义 = 已有 assistant 输出），该链路命中率结构性接近 100%；close
// 收尾的提前 kill 形态不作此保证，miss 按 crashed 记账（session_start hook 必写
// identity，session-runner.ts buildChildEnv 的 PI_SUBAGENT_SELF_RECORD_ID 注入链）。
//
// IO 契约（设计 D2 IO 量级声明）：
//   - mtime 过滤（statSync）把候选压到「spawn 后新建/修改」的文件，正常个位数；
//   - 候选按 mtime 降序读——agent_end / close 收尾时刻本 record 的文件是最新修改者，
//     首候选即命中，消除并发形态下「兄弟文件全读 miss 链」；降序只决定读取优先级，
//     命中仍以 identity 精确匹配为准（与被否的「按 mtime 猜文件」的本质区别）；
//   - 单文件 = 整文件前向读 + 行扫描命中即停。identity 实测落点不固定（64KB 尾窗
//     覆盖率仅 93.4%，miss 集中在大任务 / fork 大文件形态，见设计被否谱系②）——任何
//     定长窗口读都有规模化 miss 面，整文件读是一切落点模型下正确且期望成本最优的选择；
//   - 值匹配快速路径对齐 session-pending.ts 的 [S-4]：行内含 identity 值字符串才
//     JSON.parse，非目标行只付 includes 扫描，不受 pi 序列化空格习惯影响。
//
// 纯函数 + fs，独立于 runSpawn，可单测（测试目录用 mkdtemp 自建自删）。core 不依赖
// extensions——identity entry 字段形状按 core 侧权威实现运行时守卫提取：
// session-reconstructor.ts 的 SubagentIdentityData / IDENTITY_CUSTOM_TYPE（写入方 =
// session-runner.ts buildChildEnv 注释锚定的子进程 session_start hook）。

import * as fs from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../../../core/logger.ts";
import { toErrorMessage } from "../../../../core/error-message.ts";
import { IDENTITY_CUSTOM_TYPE } from "../../../session-reconstructor.ts";
import type { ExecutionRecord } from "../../../types.ts";

const logger = getLogger("subagents");

/**
 * [S5 测试钩子] 扫描目标目录重定向 env（设计 §4 S5：注入「三路全失败」形态时把扫描
 * 目标重定向到空目录）。生产不设恒 no-op（直接扫入参 sessionDir）；设了值则用该值
 * 替换扫描目录——钩子落点 = locateSessionFileByScan 的 sessionDir 入参来源。
 * 命名对齐 SPAWN_WATCHDOG_ENV（XYZ_SUBAGENT_* 前缀 = 父侧本进程读的配置 env 惯例）。
 */
export const SCAN_DIR_OVERRIDE_ENV = "XYZ_SUBAGENT_TEST_SCAN_DIR_OVERRIDE";

/** 扫描候选（路径 + 排序用 mtime）。 */
interface ScanCandidate {
  path: string;
  mtimeMs: number;
}

/**
 * [U1 D2] 扫 sessionDir 定位 record.id 对应的 session 文件。
 *
 * 匹配判据：文件内存在 identity entry（customType = "subagent-identity"）且其
 * data.id === record.id（record id 全局唯一，精确匹配是拿不错文件的安全前提）。
 *
 * @param record 目标执行记录（只用 id；Pick 保持纯函数的最小依赖面）
 * @param sessionDir 子进程 session 目录（spawn 时已知：getSubagentSessionDir 派生）
 * @param sinceMs mtime 过滤基准（调用方传本轮 spawn 起始时刻——只扫本轮新建/修改的文件）
 * @returns 命中的 session 文件绝对路径；目录不存在 / 无匹配 / 读失败 → undefined
 *   （调用方继续走 D3 重试窗口或最终翻转分支，本函数不抛）
 */
export function locateSessionFileByScan(
  record: Pick<ExecutionRecord, "id">,
  sessionDir: string,
  sinceMs: number,
): string | undefined {
  // [S5 测试钩子] 生产不设恒 no-op；设了值替换扫描目录（warn 文案报实际扫描目录）。
  const overrideDir = process.env[SCAN_DIR_OVERRIDE_ENV];
  const dir = overrideDir !== undefined && overrideDir.length > 0 ? overrideDir : sessionDir;

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    logger.warn(
      `[session-file-locator] sessionDir scan found no match for ${record.id}; will retry in window / fall back to disposition flip (sessionDir unreadable: ${dir}: ${toErrorMessage(err)})`,
    );
    return undefined;
  }

  // mtime 过滤 + 降序排序（见文件头 IO 契约：首候选 = 最新修改 = 最可能是本 record 的文件）。
  const candidates: ScanCandidate[] = [];
  for (const name of names) {
    // 只认 .jsonl（pi session 文件命名；alive marker / finalize sidecar 等非 jsonl 排除）
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    let mtimeMs: number;
    try {
      const st = fs.statSync(path);
      if (!st.isFile()) continue; // 目录名撞 .jsonl 后缀等非普通文件形态不作为候选
      mtimeMs = st.mtimeMs;
    } catch {
      // stat 失败（扫描进行中文件被并发删除的竞态）→ 跳过该候选，不放弃整轮扫描
      continue;
    }
    if (mtimeMs > sinceMs) candidates.push({ path, mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const hits: string[] = [];
  for (const candidate of candidates) {
    if (fileContainsIdentityFor(candidate.path, record.id)) hits.push(candidate.path);
  }
  if (hits.length === 0) {
    logger.warn(
      `[session-file-locator] sessionDir scan found no match for ${record.id}; will retry in window / fall back to disposition flip (sessionDir: ${dir}, candidates after mtime filter: ${candidates.length})`,
    );
    return undefined;
  }
  // 多匹配理论不可达（record.id 全局唯一）；可达形态 = 文件被外力复制 / GC 恢复残留。
  // 按 mtime 降序取第一个（最新修改者即本 record 当前写者的概率最高），warn 留痕。
  if (hits.length > 1) {
    logger.warn(
      `[session-file-locator] sessionDir scan matched ${hits.length} files for ${record.id} (expected 1 — record id is globally unique); taking newest by mtime: ${hits[0]}`,
    );
  }
  return hits[0];
}

/**
 * 单候选文件判定：整文件前向读 + 行扫描，存在 data.id === recordId 的 identity entry
 * 即命中。值匹配快速路径跳过非目标行的 JSON.parse（对齐 session-pending.ts [S-4]）；
 * 坏行（append 中途崩溃的截断行 / 非 JSON 调试行）跳过不中断。
 */
function fileContainsIdentityFor(path: string, recordId: string): boolean {
  let content: string;
  try {
    content = fs.readFileSync(path, "utf-8");
  } catch (err) {
    // 单候选读失败 → 该文件按 miss 处理 + warn 留痕（其他候选仍可能命中），不抛
    logger.warn(
      `[session-file-locator] sessionDir scan candidate unreadable: ${path} (scanning for ${recordId}): ${toErrorMessage(err)}`,
    );
    return false;
  }
  for (const line of content.split("\n")) {
    if (!line.includes(`"${IDENTITY_CUSTOM_TYPE}"`)) continue;
    if (extractIdentityId(line) === recordId) return true; // 命中即停（本文件内不再扫）
  }
  return false;
}

/**
 * identity entry 的 data.id 运行时守卫提取（[taste/no-unsafe-cast] 字段访问前校验，
 * 形状对齐 session-reconstructor.ts 的 JsonlEntry + SubagentIdentityData）。非 identity
 * 行 / 坏行 / 缺 data.id 的畸形行一律返回 undefined（调用方按未命中继续扫）。
 */
function extractIdentityId(line: string): string | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined; // 坏行跳过（罕见：append 中途崩溃的截断行）
  }
  if (typeof entry !== "object" || entry === null) return undefined;
  const e = entry as { customType?: unknown; data?: unknown };
  if (e.customType !== IDENTITY_CUSTOM_TYPE) return undefined;
  if (typeof e.data !== "object" || e.data === null) return undefined;
  const id: unknown = (e.data as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}
