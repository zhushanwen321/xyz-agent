/**
 * Cross-platform path comparison utilities.
 * Use path.relative() to avoid OS-specific separator issues.
 *
 * [修复] isUnderOrEqual 曾被误迁到 @xyz-agent/shared（W1a），但 shared 是浏览器/runtime 共享层，
 * node:path 在浏览器被 vite externalize 成空对象 → dev 启动崩溃。isUnderOrEqual 所有调用点
 * 都在 runtime（file-service / git-service / extension-service），属 runtime 专用，回归此文件。
 */
import { relative, resolve, isAbsolute } from 'node:path'

/**
 * 判断 child 是否在 parent 目录下或等于 parent（词法判定，不解析 symlink）。
 *
 * 算法：path.relative(parent, child) → 结果为空串/不以 '..' 开头/不以路径分隔符开头 → true。
 * 使用 path.resolve 规范化后再比较，处理 '..' 和多余分隔符。
 *
 * 安全语义：用于文件树越界守门（listTree/expandDir/readFile 入口校验 path 不逃出 cwd）。
 */
export function isUnderOrEqual(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Is `child` strictly under `parent` (not equal)? */
export function isStrictlyUnder(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
