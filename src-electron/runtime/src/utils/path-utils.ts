/**
 * Cross-platform path comparison utilities.
 * Use path.relative() to avoid OS-specific separator issues.
 *
 * isUnderOrEqual 已迁移至 @xyz-agent/shared/path-guard（#1 F2：从 utils 提升到 shared，
 * file-service + git-service + extension-service 三者共用）。此处 re-export 兜底，
 * 保持现有 `import { isUnderOrEqual } from '../utils/path-utils'` 不破坏（►迁出）。
 */
import { relative, resolve, isAbsolute } from 'node:path'

// re-export 兜底：isUnderOrEqual 真身在 @xyz-agent/shared/path-guard
export { isUnderOrEqual } from '@xyz-agent/shared'

/** Is `child` strictly under `parent` (not equal)? */
export function isStrictlyUnder(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
