/**
 * git status --porcelain 解析纯函数（issues.md #1 / code-architecture §5.1 豁免）。
 *
 * 纯函数、无 IO。GitService 调 IGitExecutor.exec('status') 拿 raw stdout 后，经此函数解析。
 * IO 边界仍在 IGitExecutor port 处闭合，解析逻辑独立可测。
 *
 * 输入约定：`git status --porcelain=v1 -z -b` 的 stdout（NUL 分隔，首条为 branch 头）。
 * 不用换行分隔：带空格/特殊字符的路径在 -z 模式下以 NUL 安全分隔，换行模式会被路径中的换行击穿。
 *
 * 输出：GitFileStatus[]（status 枚举含 untracked/unmerged，比 file-change-reconciler 的
 * FileChangeStatus 更细，服务于 GitZone 四态 + 冲突判定）。
 */
import type { GitFileStatus } from '@xyz-agent/shared'

/** 解析结果：branch（detached 时 undefined）+ 文件列表。 */
export interface ParsedGitStatus {
  branch?: string
  files: GitFileStatus[]
}

/**
 * 从 `## <branch>` 头解析当前分支名。
 * - `## main...origin/main [ahead 2]` → 'main'
 * - `## main` → 'main'
 * - `## HEAD (no branch)` → undefined（detached HEAD）
 */
function parseBranchHeader(header: string): string | undefined {
  // 去掉 '## ' 前缀
  const rest = header.slice(3)
  if (rest.startsWith('HEAD (no branch)') || rest.startsWith('No commits yet')) return undefined
  // 分支名截止于 ' ...'（upstream 跟踪）或行尾
  const dotIdx = rest.indexOf('...')
  const branch = (dotIdx >= 0 ? rest.slice(0, dotIdx) : rest).trim()
  return branch || undefined
}

/**
 * XY 双列码 → GitFileStatus['status']（比 file-change-reconciler.xyToStatus 更细）。
 * X=staged，Y=working tree。
 *
 * - U* / DD / AA → unmerged（冲突）
 * - ?? → untracked
 * - A → added（staged 新增）
 * - D → deleted
 * - R / C → renamed（目标路径）
 * - M（含 T 类型变更）/ 兜底 → modified
 */
export function xyToGitStatus(xy: string): GitFileStatus['status'] {
  const x = xy[0] ?? ' '
  const y = xy[1] ?? ' '
  // 冲突：任一列为 U，或双方都 D（both deleted）/ 都 A（both added）
  if (x === 'U' || y === 'U' || (x === 'D' && y === 'D') || (x === 'A' && y === 'A')) {
    return 'unmerged'
  }
  if (x === '?' && y === '?') return 'untracked'
  if (x === 'A') return 'added'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'R' || x === 'C') return 'renamed'
  return 'modified'
}

/**
 * 解析 `git status --porcelain=v1 -z -b` stdout。
 *
 * -z 模式：记录以 NUL 分隔。首条 `## ...` 为 branch 头；其后每条为 `XY <path>`。
 * 重命名/拷贝（X=R/C）：`XY <dst>\0<src>`，dst 为目标路径，src 紧随其后作为独立 NUL 记录。
 */
export function parseGitStatus(output: string): ParsedGitStatus {
  if (!output) return { files: [] }
  const records = output.split('\0')
  let branch: string | undefined
  let i = 0

  // 首条 branch 头（## ...）
  if (records[0]?.startsWith('## ')) {
    branch = parseBranchHeader(records[0])
    i = 1
  }

  const files: GitFileStatus[] = []
  for (; i < records.length; i++) {
    const rec = records[i]
    if (!rec) continue
    // XY 码占前 2 字符，第 3 字符是空格，其后是路径
    const xy = rec.slice(0, 2)
    const pathField = rec.slice(3)
    // 重命名/拷贝：下一条 NUL 记录是源路径，目标路径已在本条 → 跳过源路径记录
    if (xy[0] === 'R' || xy[0] === 'C') {
      i++
    }
    const path = pathField.trim()
    if (path) {
      files.push({ path, xyCode: xy, status: xyToGitStatus(xy) })
    }
  }

  return { branch, files }
}

/**
 * 从文件列表派生 staged/unstaged 计数 + 冲突标记（GitStatusResult 字段）。
 *
 * 计数规则（xyCode 双列：X=staged，Y=working tree）：
 * - stagedCount：X 列有变化（非 ' ' 且非 '?'）的文件数
 * - unstagedCount：Y 列有变化（非 ' ' 且非 '?'）的文件数；未跟踪 '??' 计入 unstaged
 * - hasConflict：任一文件为 unmerged
 */
export function deriveCounts(files: GitFileStatus[]): {
  stagedCount: number
  unstagedCount: number
  hasConflict: boolean
} {
  let staged = 0
  let unstaged = 0
  let hasConflict = false
  for (const f of files) {
    const x = f.xyCode[0] ?? ' '
    const y = f.xyCode[1] ?? ' '
    if (f.status === 'unmerged') hasConflict = true
    if (x !== ' ' && x !== '?') staged++
    if (y !== ' ' && y !== '?') {
      unstaged++
    } else if (x === '?' && y === '?') {
      // 未跟踪文件（??）Y 列是 '?'，单独计入 unstaged，不与上一分支重复
      unstaged++
    }
  }
  return { stagedCount: staged, unstagedCount: unstaged, hasConflict }
}

/**
 * 解析 `git diff --numstat [...]` stdout → {add, del} 聚合行数。
 * 每行格式：`<added>\t<deleted>\t<path>`；二进制文件计数为 `-`，跳过。
 *
 * 调用方负责选择 diff 范围（HEAD / --cached / 无参 working tree）；本函数纯聚合。
 */
export function parseNumstat(output: string): { add: number; del: number } {
  let add = 0
  let del = 0
  if (!output) return { add, del }
  for (const line of output.split('\n')) {
    if (!line) continue
    const cols = line.split('\t')
    if (cols.length < 2) continue
    const a = Number.parseInt(cols[0], 10)
    const d = Number.parseInt(cols[1], 10)
    if (Number.isFinite(a)) add += a
    if (Number.isFinite(d)) del += d
  }
  return { add, del }
}

/**
 * 解析 `git diff --numstat [...]` stdout → per-file {add, del} Map（W1 文件树 +N −M 角标数据源）。
 * 每行格式：`<added>\t<deleted>\t<path>`；path 用 tab 分隔取第 3 列（路径可含空格，numstat 用 tab 分隔故安全）。
 *
 * 二进制文件计数为 `-`（add 或 del 非数字）→ 跳过，不进 Map（与 parseNumstat 聚合逻辑一致）。
 * rename 文件：numstat 输出新路径，与 porcelain 的 path 一致，正常匹配。
 *
 * 调用方负责选择 diff 范围（HEAD / --cached / 无参 working tree）；本函数不聚合，只拆解 per-file。
 */
export function parseNumstatByFile(output: string): Map<string, { add: number; del: number }> {
  const map = new Map<string, { add: number; del: number }>()
  if (!output) return map
  for (const line of output.split('\n')) {
    if (!line) continue
    const cols = line.split('\t')
    if (cols.length < 3) continue
    const a = Number.parseInt(cols[0], 10)
    const d = Number.parseInt(cols[1], 10)
    // 二进制（add 或 del 为 `-`）跳过
    if (!Number.isFinite(a) || !Number.isFinite(d)) continue
    const path = cols[2]
    if (path) map.set(path, { add: a, del: d })
  }
  return map
}
