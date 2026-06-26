/**
 * path-utils 桩（git-service.ts resolveFilePaths 引用 isUnderOrEqual）。
 * [leaf] 纯计算：判定 abs 是否落在 cwd 之下（含 cwd 本身）。完整实现在 src-electron/runtime/src/utils/path-utils.ts（未改动）。
 */
import { resolve as resolvePath, relative } from 'node:path'

export function isUnderOrEqual(cwd: string, abs: string): boolean {
  const rel = relative(resolvePath(cwd), resolvePath(abs))
  return rel === '' || (!rel.startsWith('..') && !resolvePath(abs).startsWith('..'))
}
