/**
 * git-status-parser 桩（git-service.ts getStatus/commit 引用 parseGitStatus/deriveCounts/parseNumstat）。
 * [leaf] 纯解析：git --porcelain 输出 → 结构化。完整实现在 src-electron/runtime/src/infra/git-status-parser.ts（未改动）。
 * 骨架返回零值占位；解析逻辑属⑥Wave 实现（非 NewTaskFlow 链路新增，本期 getStatus 仅接线）。
 */
import type { GitFileStatus } from '@xyz-agent/shared'

export function parseGitStatus(_stdout: string): { branch?: string; files: GitFileStatus[] } {
  return { branch: undefined, files: [] }
}

export function deriveCounts(_files: GitFileStatus[]): {
  stagedCount: number
  unstagedCount: number
  hasConflict: boolean
} {
  return { stagedCount: 0, unstagedCount: 0, hasConflict: false }
}

export function parseNumstat(_stdout: string): { add: number; del: number } {
  return { add: 0, del: 0 }
}
