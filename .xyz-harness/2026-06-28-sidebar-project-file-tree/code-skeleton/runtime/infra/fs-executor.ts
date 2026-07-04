/**
 * code-skeleton/runtime/infra/fs-executor.ts — FsExecutor 实现 IFileExecutor（⑤code-arch §3，#2）
 *
 * 🔒 三层架构：infra 层实现 services/ports/file-executor.ts 的 IFileExecutor port。
 * 真引 node:fs/promises（Tier 2 证伪：编译器对依赖声明验签，SDK 没装/没方法/签名变 → tsc 报错）。
 *
 * ⚠️ 超时机制（④NFR K-2）：node:fs/promises 无内建超时，git-executor 的 execFileSync timeout 不可复用。
 *    ⑤骨架约束：Promise.race + setTimeout 或 AbortController（⑥Wave 实现具体超时值）。
 * ⚠️ symlink 目录标记（④NFR K-3）：listDir 对 symlink 目录标记或拒绝（防循环展开 a→b→a）。
 *
 * 接线层级：[adapter] 真引 SDK，不 throw 占位。
 */
import { readdir, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IFileExecutor, FsEntry, FsStat } from '../services/ports/file-executor'
import type { FileNodeType } from '@shared/file-tree'

export class FsExecutor implements IFileExecutor {
  /**
   * 单层 readdir（不递归）。
   * 数据流：readdir(path) → 每项 stat → FsEntry[]（FileService 编排映射成 FileNode）。
   * 超时（K-2）/symlink 标记（K-3）由 ⑥Wave 实现，骨架只接 SDK 调用 + 透传。
   */
  async listDir(path: string): Promise<FsEntry[]> {
    const names = await readdir(path) // L1-接线：真引 node:fs/promises
    const entries: FsEntry[] = []
    for (const name of names) {
      const s = await stat(join(path, name)) // L1-接线：真引
      entries.push({ name, type: s.isDirectory() ? 'dir' : 'file', size: s.isFile() ? s.size : undefined })
    }
    return entries
  }

  async stat(path: string): Promise<FsStat> {
    const s = await stat(path) // L1-接线：真引
    return { type: (s.isDirectory() ? 'dir' : 'file') as FileNodeType, size: s.size }
  }

  async readFile(path: string): Promise<string> {
    return readFile(path, 'utf8') // L1-接线：真引（file.read 下沉，#7）
  }
}
