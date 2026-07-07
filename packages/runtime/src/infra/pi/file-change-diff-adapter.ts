/**
 * FileChangeDiffAdapter — IFileChangeDiff port 的 infra 实现。
 *
 * 薄包装 file-change-reconciler 的三个纯函数，适配 port 接口签名（FileChangeSnapshot=unknown）。
 * 组合根注入 EventInterpreter，使 service 层不直接 import infra（[runtime-three-layer-design.md] 铁律）。
 */
import type { FileChange } from '@xyz-agent/shared'
import type { IFileChangeDiff, FileChangeSnapshot } from '../../services/ports/file-change-diff.js'
import {
  snapshotGitStatus,
  diffSnapshots,
  computeLineCounts,
} from './file-change-reconciler.js'
import type { StatusSnapshot } from './file-change-reconciler.js'

export class FileChangeDiffAdapter implements IFileChangeDiff {
  snapshotGitStatus(cwd: string): FileChangeSnapshot {
    return snapshotGitStatus(cwd)
  }

  diffSnapshots(baseline: FileChangeSnapshot, current: FileChangeSnapshot): FileChange[] {
    return diffSnapshots(baseline as StatusSnapshot, current as StatusSnapshot)
  }

  computeLineCounts(cwd: string, changes: FileChange[], writeContents?: Map<string, string>): void {
    computeLineCounts(cwd, changes, writeContents)
  }
}
