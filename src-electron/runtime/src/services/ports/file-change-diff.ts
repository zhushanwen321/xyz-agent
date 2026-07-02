/**
 * FileChange baseline diff 能力 port（ADR-0024 D5：git 作为唯一真值源）。
 *
 * service 层（EventInterpreter）需在 turn 内做 file_changes baseline diff，但
 * [runtime-three-layer-design.md] 铁律：services 不直接 import infra。故抽出此 port，
 * 由组合根注入 infra 实现（infra/pi/file-change-reconciler.ts）。
 *
 * 接口签名只用 shared 类型（FileChange / FileChangeStatus），不出现 infra 内部类型。
 */
import type { FileChange, FileChangeStatus } from '@xyz-agent/shared'

/** git status 快照的不透明句柄（baseline diff 基准）。interpreter 只持有/透传，不解构。 */
export type FileChangeSnapshot = unknown

/**
 * file_changes baseline diff 引擎（组合根注入 infra 实现）。
 *
 * 三项能力（与 infra/pi/file-change-reconciler.ts 一一对应）：
 * - snapshotGitStatus：turn 开始时快照 git status 作为 baseline
 * - diffSnapshots：diff 当前 vs baseline，得本 turn 变更清单
 * - computeLineCounts：行数填充（numstat 已跟踪 + content 回退 untracked）
 */
export interface IFileChangeDiff {
  /** 采集 cwd 的 git status 快照。非 git 仓库 / 不可用 → null（调用方跳过 diff）。 */
  snapshotGitStatus(cwd: string): FileChangeSnapshot
  /** diff 两个快照，返回 baseline 之后新增/变化的文件清单。 */
  diffSnapshots(baseline: FileChangeSnapshot, current: FileChangeSnapshot): FileChange[]
  /** 为 FileChange[] 填充行数（原地修改）。writeContents 供 untracked 回退。 */
  computeLineCounts(cwd: string, changes: FileChange[], writeContents?: Map<string, string>): void
}

/** 重新导出 FileChangeStatus 便于 port 消费者（避免到处从 shared 取）。 */
export type { FileChangeStatus }
