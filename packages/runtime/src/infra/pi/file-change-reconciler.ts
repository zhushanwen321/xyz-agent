/**
 * # FileChange baseline diff 引擎（ADR-0024 D5 重构：git 作为唯一真值源）
 *
 * 核心机制：turn 开始时快照 git status 作为 baseline，每次写操作后 diff 当前状态
 * vs baseline，得到「本 turn 引入的变更」。git 是唯一真值源，不再从工具参数硬解析行数。
 *
 * 三层能力：
 * 1. snapshotGitStatus — 采集 cwd 的 git status 快照（filePath → status）
 * 2. diffSnapshots — diff 两个快照，返回 baseline 之后新增/变化的文件
 * 3. computeLineCounts — 行数填充：numstat（已跟踪）+ content 回退（untracked）
 *
 * 依赖：git CLI（child_process execSync）。非 git 仓库时返回 null（调用方跳过 baseline diff）。
 */
import { execSync } from 'node:child_process'
import type { FileChange, FileChangeStatus, NumstatEntry } from '@xyz-agent/shared'
import { parseNumstatEntries, xyToGitStatus } from '@xyz-agent/shared'

/** git status --porcelain 的单行解析结果（XY 码 + 路径） */
interface GitStatusEntry {
  /** XY 码两字符（X=staged，Y=working tree），如 ' M'/'??'/'A '/'D ' */
  xy: string
  /** 目标文件路径（重命名取 `->` 后的目标） */
  path: string
}

// git status --porcelain 行格式固定偏移：`XY <path>`（XY 码 2 字符 + 1 空格 + 路径）。
// git numstat 解析已统一到 shared 的 parseNumstatEntries（lossless SSOT，含二进制 - 处理）。
const PORCELAIN_XY_LEN = 2
const PORCELAIN_PATH_START = 3
const RENAME_ARROW = ' -> '
const RENAME_ARROW_LEN = RENAME_ARROW.length

/**
 * 解析 `git status --porcelain` 输出为条目数组。
 * 每行格式：`XY <path>` 或 `XY <src> -> <dst>`（重命名/拷贝）。
 */
export function parseGitStatusPorcelain(output: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    // 前 2 字符是 XY 码，第 3 字符是空格，其后是路径
    const xy = line.slice(0, PORCELAIN_XY_LEN)
    const rest = line.slice(PORCELAIN_PATH_START)
    // 重命名/拷贝格式：`R  src -> dst`，取目标路径 dst
    const arrowIdx = rest.indexOf(RENAME_ARROW)
    const path = arrowIdx >= 0 ? rest.slice(arrowIdx + RENAME_ARROW_LEN).trim() : rest.trim()
    if (path) entries.push({ xy, path })
  }
  return entries
}

/**
 * XY 码 → FileChangeStatus 映射（ADR-0024 D5）。
 *
 * 基于 shared 的 6 态 xyToGitStatus 做降级映射（4 态 FileChangeStatus），
 * 避免与 xyToGitStatus 重复 XY 字符判定逻辑。降级规则集中在 SIX_TO_FOUR 映射表：
 * - untracked → added（未跟踪视为新增）
 * - added → added
 * - deleted → deleted
 * - renamed → modified（目标路径记 modified，src 删除细节留 diff 层）
 * - unmerged → modified（冲突文件视为已修改）
 * - modified → modified
 *
 * 与原手写分支的语义差异：冲突态（DD/AA/U*）原分支因 if 顺序分别落 deleted/added/modified，
 * 现统一降级为 modified。baseline diff 机制不依赖冲突态细分，无影响。
 */
const SIX_TO_FOUR: Record<string, FileChangeStatus> = {
  untracked: 'added',
  added: 'added',
  deleted: 'deleted',
  modified: 'modified',
  renamed: 'modified',
  unmerged: 'modified',
}

export function xyToStatus(xy: string): FileChangeStatus {
  return SIX_TO_FOUR[xyToGitStatus(xy)]
}

/** git status 快照：filePath → status（A/M/D）。null 表示非 git 仓库或采集失败。 */
export type StatusSnapshot = Map<string, FileChangeStatus> | null

/**
 * 采集当前 cwd 的 git status 快照（baseline diff 的基础）。
 *
 * @param cwd pi session 工作目录
 * @returns filePath → status 的 Map；非 git 仓库 / git 不可用 / 超时 → null
 */
export function snapshotGitStatus(cwd: string): StatusSnapshot {
  try {
    const output = execSync('git status --porcelain', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    })
    const entries = parseGitStatusPorcelain(output)
    const snapshot = new Map<string, FileChangeStatus>()
    for (const { xy, path } of entries) {
      snapshot.set(path, xyToStatus(xy))
    }
    return snapshot
  } catch (e) {
    // 非 git 仓库 / git 未安装 / 超时 → null（调用方跳过 baseline diff）。降级路径，记 debug 不阻断。
    console.debug(`[file-change-reconciler] git status failed: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/**
 * diff 两个快照，返回 baseline 之后新增/变化的文件清单。
 *
 * 规则：
 * - current 有 baseline 无 → 新变更文件（用 current 的 status）
 * - 两者都有 → 报告（取 current 的 status）。不区分 status 是否变化——
 *   [HISTORICAL] 原实现要求 status 不同才报告，但 turn 开始前工作区已有 dirty 文件时
 *   （开发场景极常见：worktree 普遍有未提交改动），pi 改了这些文件后 git status 仍是 modified，
 *   status 相同 → 漏报 → fileChanges 为空 → 变更集卡不显示（"全程几乎看不到"事故）。
 *   改为只要 current 中存在就报告，代价是 turn 开始前已 dirty 但 turn 内未碰的文件会误报，
 *   但误报（多列几个文件）的危害远低于漏报（整个变更集卡消失）。误报文件在 ready 帧一致报告，
 *   不会产生状态跳变。
 * - baseline 有 current 无 → 已 commit/revert，不报告
 * - baseline 为 null（非仓库）→ 返回 current 全集（首次进入仓库等场景）
 *
 * @param baseline turn 开始时的快照（可能 null）
 * @param current 当前快照
 */
export function diffSnapshots(baseline: StatusSnapshot, current: StatusSnapshot): FileChange[] {
  if (!current) return []
  // baseline 为 null（非仓库）→ current 全集作为变更
  if (!baseline) {
    return Array.from(current.entries()).map(([filePath, status]) => ({ filePath, status }))
  }

  // current 全集即变更清单（baseline 仅用于排除「baseline 有 current 无」的已 commit/revert 文件）。
  const changes: FileChange[] = []
  for (const [filePath, currentStatus] of current) {
    changes.push({ filePath, status: currentStatus })
  }
  return changes
}

/**
 * 为 FileChange[] 填充行数（addLines/delLines）。
 *
 * 两路行数来源（ADR-0024 重构）：
 * 1. 已跟踪文件：`git diff --numstat HEAD`（git 真值，含 staged + unstaged）
 * 2. untracked 文件（numstat 不报告）：从 writeContents 回退（write 工具的 content 分行计）
 *
 * numstat 不报告 untracked 文件是已知限制。bash 创建的 untracked 文件无行数来源——
 * 卡片显示文件名但不显示 +N（与现状一致，接受此限制）。
 *
 * @param cwd pi session 工作目录
 * @param changes 待填充行数的 FileChange[]（原地修改）
 * @param writeContents 本 turn write 工具写入的 content（filePath → content），untracked 行数回退
 */
export function computeLineCounts(
  cwd: string,
  changes: FileChange[],
  writeContents?: Map<string, string>,
): void {
  if (changes.length === 0) return

  // 已跟踪文件行数：numstat（git 真值）
  let numstatMap = new Map<string, NumstatEntry>()
  try {
    const output = execSync('git diff --numstat HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    })
    numstatMap = new Map(parseNumstatEntries(output).map((e) => [e.path, e]))
    // eslint-disable-next-line taste/no-silent-catch -- 降级路径：numstat 失败不能中断 changeSet 推送，行数靠 content 回退
  } catch (e) {
    console.debug(`[file-change-reconciler] git diff --numstat failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  for (const change of changes) {
    const ns = numstatMap.get(change.filePath)
    if (ns) {
      if (ns.add !== undefined) change.addLines = ns.add
      if (ns.del !== undefined) change.delLines = ns.del
    } else if (writeContents) {
      // untracked 文件：numstat 不报告，从 write content 回退
      const content = writeContents.get(change.filePath)
      if (typeof content === 'string' && content !== '') {
        change.addLines = content.split('\n').length
      }
    }
  }
}
