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
 */
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
    // eslint-disable-next-line no-constant-condition
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
