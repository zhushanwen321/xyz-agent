import { join } from 'node:path'
import { statSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

export interface GitInfo {
  branch: string
  isWorktree: boolean
}

const GIT_TIMEOUT_MS = 2000
// eslint-disable-next-line no-magic-numbers -- 5 minutes = 5 * 60 * 1000ms, self-documenting with comment
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const CACHE_MAX_SIZE = 500

const gitInfoCache = new Map<string, { info: GitInfo | undefined; ts: number }>()

/**
 * Invalidate cache entries whose cwd no longer exists on disk,
 * and evict expired entries (TTL exceeded).
 */
export function pruneGitInfoCache(existingCwds: Set<string>): void {
  const now = Date.now()
  for (const key of gitInfoCache.keys()) {
    if (!existingCwds.has(key) || (now - (gitInfoCache.get(key)?.ts ?? 0)) >= CACHE_TTL_MS) {
      gitInfoCache.delete(key)
    }
  }
}

/**
 * Read git branch and worktree status from cwd. Results are cached per-cwd for CACHE_TTL_MS.
 *
 * Rationale: `toSummary()` is called for every session on every `listPersistedSessions()` call
 * (WS connect, create, delete, rename, process exit). Without caching, 10 sessions = 10 `execSync`
 * spawns each time. A session's cwd branch doesn't change within its lifetime.
 */
export function readGitInfo(cwd: string): GitInfo | undefined {
  const now = Date.now()
  const cached = gitInfoCache.get(cwd)
  if (cached && (now - cached.ts) < CACHE_TTL_MS) return cached.info

  // Evict oldest entries if cache is at capacity
  if (gitInfoCache.size >= CACHE_MAX_SIZE) {
    let oldestKey: string | null = null
    let oldestTs = Infinity
    for (const [key, val] of gitInfoCache) {
      if (val.ts < oldestTs) { oldestTs = val.ts; oldestKey = key }
    }
    if (oldestKey) gitInfoCache.delete(oldestKey)
  }

  const info = readGitInfoUncached(cwd)
  gitInfoCache.set(cwd, { info, ts: now })
  return info
}

function readGitInfoUncached(cwd: string): GitInfo | undefined {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (!branch) return undefined
    // Detect worktree: .git is a file (not dir) containing 'gitdir:'
    let isWorktree = false
    try {
      const gitPath = join(cwd, '.git')
      const st = statSync(gitPath)
      if (st.isFile()) {
        const content = readFileSync(gitPath, 'utf-8')
        isWorktree = content.startsWith('gitdir:')
      }
      // eslint-disable-next-line taste/no-silent-catch -- not a worktree, expected path
    } catch {
      /* not a worktree */
    }
    return { branch, isWorktree }
  } catch {
    return undefined
  }
}
