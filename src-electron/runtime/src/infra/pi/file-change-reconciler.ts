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
import type { FileChange, FileChangeStatus } from '@xyz-agent/shared'

/** git status --porcelain 的单行解析结果（XY 码 + 路径） */
interface GitStatusEntry {
  /** XY 码两字符（X=staged，Y=working tree），如 ' M'/'??'/'A '/'D ' */
  xy: string
  /** 目标文件路径（重命名取 `->` 后的目标） */
  path: string
}

// git status --porcelain 行格式固定偏移：`XY <path>`（XY 码 2 字符 + 1 空格 + 路径）。
// git numstat 行格式：`<added>\t<deleted>\t<path>`（前 2 段 + 路径，最少 3 段）。
const PORCELAIN_XY_LEN = 2
const PORCELAIN_PATH_START = 3
const RENAME_ARROW = ' -> '
const RENAME_ARROW_LEN = RENAME_ARROW.length
const NUMSTAT_MIN_PARTS = 3
const NUMSTAT_PATH_START = 2

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
 * X=staged，Y=working tree。优先取已标的状态；未跟踪 `??` → added。
 */
export function xyToStatus(xy: string): FileChangeStatus {
  const x = xy[0]
  const y = xy[1]
  // 未跟踪文件
  if (x === '?' && y === '?') return 'added'
  // 删除（staged D 或 working tree D）
  if (x === 'D' || y === 'D') return 'deleted'
  // 新增（staged A）
  if (x === 'A') return 'added'
  // 重命名/拷贝 → 目标路径记 modified（src 删除细节留 diff 层）
  if (x === 'R' || x === 'C') return 'modified'
  // 修改（M，含 staged/working tree）
  if (x === 'M' || y === 'M') return 'modified'
  // 兜底：其它（如 T 类型变更）记 modified
  return 'modified'
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
 * - 两者都有但 status 变化 → status 更新（取 current 的 status）
 * - 两者都有且 status 相同 → 不报告（无变化）
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

  const changes: FileChange[] = []
  for (const [filePath, currentStatus] of current) {
    const baselineStatus = baseline.get(filePath)
    if (baselineStatus === undefined) {
      // baseline 无 → 新增文件
      changes.push({ filePath, status: currentStatus })
    } else if (baselineStatus !== currentStatus) {
      // status 变化（如 modified → deleted）
      changes.push({ filePath, status: currentStatus })
    }
    // status 相同 → 无变化，不报告
  }
  return changes
}

/**
 * numstat 输出的单行解析结果。
 */
interface NumstatEntry {
  add: number | undefined
  del: number | undefined
  path: string
}

/**
 * 解析 `git diff --numstat` 输出。
 * 格式：`<added>\t<deleted>\t<path>`，二进制文件显示 `-`。
 */
export function parseNumstat(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    const parts = line.split('\t')
    if (parts.length < NUMSTAT_MIN_PARTS) continue
    const addRaw = parts[0]
    const delRaw = parts[1]
    const path = parts.slice(NUMSTAT_PATH_START).join('\t')
    const add = addRaw === '-' ? undefined : Number(addRaw)
    const del = delRaw === '-' ? undefined : Number(delRaw)
    entries.push({ add: Number.isNaN(add) ? undefined : add, del: Number.isNaN(del) ? undefined : del, path })
  }
  return entries
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
    numstatMap = new Map(parseNumstat(output).map((e) => [e.path, e]))
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
