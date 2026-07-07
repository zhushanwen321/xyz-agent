/**
 * IGitInfoReader 的真实实现 —— execSync 跑 rev-parse + node:fs 读 .git 文件判 worktree。
 *
 * 三层架构：infra 实现（services 定义 port），从 services/git-info.ts 迁入（design §「services 需去 infra 直连」）。
 * 原文件放在 services/ 是分层违规——它查 git 外部系统，本属 infra。现归位到 infra/system/（与 trash.ts 同目录）。
 *
 * 缓存（TTL + LRU）跟随实现迁入：缓存是 IO 关注点（避免重复 spawn），不属于 services 编排。
 */
import { join } from 'node:path'
import { statSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import type { GitInfo, IGitInfoReader } from '../../services/ports/git-info.js'

const GIT_TIMEOUT_MS = 2000
// eslint-disable-next-line no-magic-numbers -- 5 minutes = 5 * 60 * 1000ms, self-documenting with comment
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const CACHE_MAX_SIZE = 500

const gitInfoCache = new Map<string, { info: GitInfo | undefined; ts: number }>()

export class GitInfoReader implements IGitInfoReader {
  readGitInfo(cwd: string): GitInfo | undefined {
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

  pruneStaleCache(existingCwds: Set<string>): void {
    const now = Date.now()
    for (const key of gitInfoCache.keys()) {
      if (!existingCwds.has(key) || (now - (gitInfoCache.get(key)?.ts ?? 0)) >= CACHE_TTL_MS) {
        gitInfoCache.delete(key)
      }
    }
  }
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
