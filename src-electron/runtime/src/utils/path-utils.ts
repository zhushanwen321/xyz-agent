/**
 * Cross-platform path comparison utilities.
 * Use path.relative() to avoid OS-specific separator issues.
 */
import { relative, resolve, isAbsolute } from 'node:path'

/** Is `child` strictly under `parent` (not equal)? */
export function isStrictlyUnder(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Is `child` under or equal to `parent`? */
export function isUnderOrEqual(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return !rel.startsWith('..') && !isAbsolute(rel)
}
