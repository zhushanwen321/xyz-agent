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
    // 与 port 的 TreeRawEntry 结构同构，RawBuildTreeResult 可直接赋值给 port 的 BuildTreeResult。
    // （原 `as unknown as BuildTreeResult` 把 Promise<T> 误断言为 T，仅因外层 async 隐式 await 才正常工作，
    // 属语义错误的类型谎言 —— 删除后 tsc 通过。）
    return buildTreeFromFileRaw(filePath)
  }

  countBranches(rootNodes: TreeNode[]): number {
    return countBranchesRaw(rootNodes)
  }

  extractFullText(entry: TreeRawEntry): string | undefined {
    return extractFullTextRaw(entry as unknown as Parameters<typeof extractFullTextRaw>[0])
  }
}
