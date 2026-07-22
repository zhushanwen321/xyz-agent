/**
 * WorkspaceDetector —— bare repo + worktree 结构的 workspace 根检测（W1）。
 *
 * 工作模式：从 currentCwd 向上逐级目录，用 `fs.statSync(join(dir, '.bare'))` 检查是否存在
 * `.bare` 目录。命中（isDirectory()===true）则该 dir 即 workspace 根（wsRoot），barePath 为
 * `<wsRoot>/.bare`，isBareMode=true。statSync 抛 ENOENT 则继续向上一级；到根目录仍找不到
 * 返回 `{ wsRoot: '', barePath: '', isBareMode: false }`（普通 git clone 场景）。
 *
 * 🔒 三层架构：本类属 service 域工具（被 WorktreeService 编排），fs 经构造函数注入。
 * 不直接 import 'node:fs'，而是接受 fs 对象（含 statSync 方法）。production 由 index.ts
 * 传 node:fs，测试用 vi.doMock('node:fs') 后传入 mock fs。
 *
 * .bare 是 bare repo + worktree 约定俗成的目录名（与 create-worktree skill / remove-worktree
 * skill 一致）：workspace 根下放 .bare（bare repo）+ 各 worktree 子目录（feat-x / fix-y ...）。
 *
 * detectBareWorkspaceCached：session 摘要链路（toSummary / scannedToSummary）复用的缓存版本。
 * 缓存模式镜像 GitInfoReader（per-cwd TTL + 最老条目淘汰），避免每次 listPersistedSessions 对
 * 每个 session 重新向上 statSync。失败（statSync 抛非 ENOENT）兜底 false，绝不传播异常——
 * session 摘要生成不能因 workspace 检测失败而中断。
 */
import { statSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** statSync 函数类型（仅本类用到的方法子集，与 node:fs.statSync 兼容）。 */
export interface FsLike {
  statSync: (path: string) => { isDirectory: () => boolean }
}

/** detect 返回。isBareMode=false 时 wsRoot/barePath 均为空串。 */
export interface WorkspaceDetectResult {
  /** workspace 根绝对路径（.bare 的父目录）。未检测到则为空串。 */
  wsRoot: string
  /** .bare 目录绝对路径。未检测到则为空串。 */
  barePath: string
  /** 是否处于 bare repo + worktree 模式。 */
  isBareMode: boolean
}

export class WorkspaceDetector {
  constructor(private fs: FsLike) {}

  /**
   * 从 currentCwd 向上逐级检测 .bare 目录。
   *
   * 边界：
   * - currentCwd 本身就是 workspace 根（.bare 在其下）→ 命中（WD-3）
   * - currentCwd 是 workspace 的深层子目录 → 向上找到（WD-1）
   * - 普通目录（无 .bare）→ 返回 isBareMode=false（WD-2）
   *
   * 终止条件：dirname(dir) === dir（已达文件系统根）。
   */
  detect(currentCwd: string): WorkspaceDetectResult {
    let dir = currentCwd
    // 向上逐级，直到 dirname 不再变化（已达根）
    while (true) {
      const barePath = join(dir, '.bare')
      try {
        const stat = this.fs.statSync(barePath)
        if (stat.isDirectory()) {
          return { wsRoot: dir, barePath, isBareMode: true }
        }
      } catch (e: unknown) {
        // ENOENT 是预期（绝大多数目录无 .bare）；其它错误也当作「不存在」继续向上
        // （避免 statSync 的非预期异常阻断检测——workspace 检测应尽力向上找）。
        const code = (e as NodeJS.ErrnoException | undefined)?.code
        if (code !== 'ENOENT') {
          // 权限错误等：保守跳过当前 dir，继续向上（不抛，调用方按 isBareMode=false 兜底）
        }
      }
      const parent = dirname(dir)
      if (parent === dir) {
        // 已达文件系统根，仍未找到 .bare
        return { wsRoot: '', barePath: '', isBareMode: false }
      }
      dir = parent
    }
  }
}

// ── session 摘要链路用的缓存版本（R1）──────────────────────────────────────
// 镜像 GitInfoReader 的 per-cwd TTL + 最老条目淘汰（oldest-insert）缓存，避免每次列举 session
// 重复向上 statSync。真实 node:fs 直接用（detect 仅 statSync，无需注入——注入模式仅 WorktreeService 单测需要）。
// eslint-disable-next-line no-magic-numbers -- 5 minutes = 5 * 60 * 1000ms, self-documenting with comment
const BARE_CACHE_TTL_MS = 5 * 60 * 1000
const BARE_CACHE_MAX_SIZE = 500

const bareCache = new Map<string, { isBare: boolean; ts: number }>()
const realDetector = new WorkspaceDetector({
  statSync: (p: string) => statSync(p),
})

/**
 * 检测 cwd 是否位于 .bare workspace 下（带 per-cwd TTL + 最老条目淘汰缓存）。
 *
 * 供 SessionService.toSummary / SessionScanner.scannedToSummary 填充 SessionSummary.isBareWorkspace。
 * 绝不抛——任何异常（权限、IO 错误）兜底 false，确保 session 摘要生成不被中断。
 *
 * @returns 是否处于 bare repo + worktree 结构
 */
export function detectBareWorkspaceCached(cwd: string): boolean {
  const now = Date.now()
  const cached = bareCache.get(cwd)
  if (cached && (now - cached.ts) < BARE_CACHE_TTL_MS) return cached.isBare

  // 最老条目淘汰（oldest-insert，非真 LRU——命中不刷新 ts）：超过上限时删 ts 最小的条目
  if (bareCache.size >= BARE_CACHE_MAX_SIZE) {
    let oldestKey: string | null = null
    let oldestTs = Infinity
    for (const [key, val] of bareCache) {
      if (val.ts < oldestTs) { oldestTs = val.ts; oldestKey = key }
    }
    if (oldestKey) bareCache.delete(oldestKey)
  }

  let isBare = false
  try {
    isBare = realDetector.detect(cwd).isBareMode
  } catch {
    // 兜底 false：session 摘要不能因 workspace 检测失败而中断
    isBare = false
  }
  bareCache.set(cwd, { isBare, ts: now })
  return isBare
}

/**
 * 清理 cwd 不再被引用、或 TTL 过期的 bare 缓存项（与 GitInfoReader.pruneStaleCache 对称）。
 * 在每次列举 session 后由 scanner 调用。
 */
export function pruneBareCache(existingCwds: Set<string>): void {
  const now = Date.now()
  for (const key of bareCache.keys()) {
    if (!existingCwds.has(key) || (now - (bareCache.get(key)?.ts ?? 0)) >= BARE_CACHE_TTL_MS) {
      bareCache.delete(key)
    }
  }
}

/** 测试隔离用：重置 bare 缓存（@internal，仅供单测 beforeEach 调）。 */
export function __resetBareCacheForTests(): void {
  bareCache.clear()
}
