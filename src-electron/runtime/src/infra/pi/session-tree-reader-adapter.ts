/**
 * ITreeReader 的 infra 实现 —— 封装 session-tree-reader 的自由函数。
 *
 * 🔒 归属（R3e2，三层架构）：infra/pi/，实现 services/ports.ts 的 ITreeReader。
 * TreeService 经此 port 解析 pi JSONL 树，不直接 import session-tree-reader。
 * RawEntry 内部类型（pi JSONL 结构）只在此处出现；service 见 TreeRawEntry（port 视图）。
 */
import type { ITreeReader, BuildTreeResult, TreeRawEntry } from '../../services/ports/tree.js'
import type { TreeNode } from '../../types.js'
import { buildTreeFromFile as buildTreeFromFileRaw, countBranches as countBranchesRaw, extractFullText as extractFullTextRaw } from './session-tree-reader.js'

export class SessionTreeReaderAdapter implements ITreeReader {
  async buildTreeFromFile(filePath: string): Promise<BuildTreeResult> {
    // session-tree-reader 的 BuildTreeResult.rawEntries 是内部 RawEntry 类型，
    // 与 port 的 TreeRawEntry 结构同构，as 转换即可（字段一致）。
    return buildTreeFromFileRaw(filePath) as unknown as BuildTreeResult
  }

  countBranches(rootNodes: TreeNode[]): number {
    return countBranchesRaw(rootNodes)
  }

  extractFullText(entry: TreeRawEntry): string | undefined {
    return extractFullTextRaw(entry as unknown as Parameters<typeof extractFullTextRaw>[0])
  }
}
