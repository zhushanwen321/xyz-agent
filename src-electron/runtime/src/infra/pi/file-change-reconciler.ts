/**
 * # FileChange 对账器（ADR-0024 D5）
 *
 * 在 agent_end（回合边界）于 pi session 工作目录执行 `git status --porcelain`，
 * 把 git 视角的 A/M/D 文件集与本回合增量提取的 FileChange[] 做并集校正：
 *
 * - 增量提取漏的（bash 改的、edit retry 覆盖的）→ 补入
 * - 增量提取错标的（write 标 modified 实为 git `??` 未跟踪新文件）→ 校正为 added
 * - 已删除文件（git `D`）→ 补 deleted（增量提取永远捕不到 delete）
 *
 * XY 码映射：`A`/`??`→added，`M`→modified，`D`→deleted，`R`/`C`→modified（重命名记目标路径）。
 *
 * 依赖：git CLI（child_process execSync）。非 git 仓库时返回 null（调用方只信增量提取，
 * 变更集卡标注降级态）。
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

/**
 * 解析 `git status --porcelain` 输出为条目数组。
 * 每行格式：`XY <path>` 或 `XY <src> -> <dst>`（重命名/拷贝）。
 */
export function parseGitStatusPorcelain(output: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    // 前 2 字符是 XY 码，第 3 字符是空格，其后是路径
    const xy = line.slice(0, 2)
    const rest = line.slice(3)
    // 重命名/拷贝格式：`R  src -> dst`，取目标路径 dst
    const arrowIdx = rest.indexOf(' -> ')
    const path = arrowIdx >= 0 ? rest.slice(arrowIdx + 4).trim() : rest.trim()
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

/**
 * 在 cwd 执行 git 对账，返回该目录下的完整 FileChange[]（全集，ready 帧）。
 *
 * @param cwd pi session 工作目录（非 runtime 进程 cwd）
 * @returns 全集 FileChange[]；非 git 仓库或 git 不可用时返回 null（降级）
 */
export function reconcileFileChanges(cwd: string): FileChange[] | null {
  try {
    const output = execSync('git status --porcelain', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    })
    const entries = parseGitStatusPorcelain(output)
    return entries.map(({ xy, path }) => ({
      filePath: path,
      status: xyToStatus(xy),
    }))
  } catch {
    // 非 git 仓库 / git 未安装 / 超时 → 降级，调用方只信增量提取
    return null
  }
}

/**
 * 把 git 对账全集与增量提取的 FileChange[] 合并（并集校正）。
 *
 * 合并规则（ADR-0024 D5）：
 * - git 视角优先：同 filePath 以 git 对账的 status 为准（真值收口）
 * - 增量提取独有的（git 未追踪，如 .gitignore 内或非 git 仓库残留）→ 保留
 * - 行数信息：git 对账无行数，保留增量提取的 addLines/delLines（仅 git 全集新增的文件无行数）
 *
 * @param gitSet git 对账全集（reconcileFileChanges 返回，可能为 null）
 * @param incremental 本回合增量提取的 FileChange[]
 */
export function mergeWithIncremental(
  gitSet: FileChange[] | null,
  incremental: FileChange[],
): FileChange[] {
  if (!gitSet) return [...incremental]
  const byPath = new Map<string, FileChange>()
  // 先放 git 全集（真值），保留增量提取的行数信息
  const incrementalByPath = new Map(incremental.map((c) => [c.filePath, c]))
  for (const g of gitSet) {
    const inc = incrementalByPath.get(g.filePath)
    byPath.set(g.filePath, {
      filePath: g.filePath,
      status: g.status,
      // 行数取增量提取的（git status 无行数）
      ...(inc?.addLines !== undefined ? { addLines: inc.addLines } : {}),
      ...(inc?.delLines !== undefined ? { delLines: inc.delLines } : {}),
    })
  }
  // 补增量提取独有（git 未追踪的）
  for (const inc of incremental) {
    if (!byPath.has(inc.filePath)) byPath.set(inc.filePath, { ...inc })
  }
  return Array.from(byPath.values())
}
