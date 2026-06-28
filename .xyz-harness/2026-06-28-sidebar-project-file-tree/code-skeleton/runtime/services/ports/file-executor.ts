/**
 * code-skeleton/runtime/services/ports/file-executor.ts — IFileExecutor port（⑤code-arch §3，#2 D-008）
 *
 * 🔒 三层架构：services 定义 port，infra/fs-executor.ts 实现（node:fs/promises）。
 * FileService 经此 port 访问 fs，不直接 import node:fs（AC-2 grep 验证）。
 *
 * Port 决策（D-008，Local-substitutable）：fs 有内存替身 → port（2 adapter：FsExecutor 产 + in-memory 测试 = 真 seam）。
 * 范式与 IGitExecutor（services/ports/git-executor.ts）对称。
 *
 * 接线层级：[port] interface 定义（infra 实现）。
 */
import type { FileNodeType } from '@shared/file-tree'

/** infra readdir 返回的薄结构（FileService 编排时映射成 FileNode）。 */
export interface FsEntry {
  name: string
  type: FileNodeType
  size?: number
}

/** stat 结果。 */
export interface FsStat {
  type: FileNodeType
  size: number
}

/**
 * fs 访问 port。
 *
 * 实现约束（infra/fs-executor.ts）：
 * - listDir **单层 readdir**（不递归，depth=1 编排在 FileService）
 * - 超时机制（Promise.race/AbortController，④NFR K-2：node:fs/promises 无内建超时）
 * - symlink 目录标记/拒绝（④NFR K-3：防循环展开 a→b→a）
 */
export interface IFileExecutor {
  /** 单层 readdir（不递归）。 */
  listDir(path: string): Promise<FsEntry[]>
  /** stat 单个路径。 */
  stat(path: string): Promise<FsStat>
  /** 读文件内容（file.read 下沉，#7）。 */
  readFile(path: string): Promise<string>
}
