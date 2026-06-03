import { join } from 'node:path'
import { statSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

export interface GitInfo {
  branch: string
  isWorktree: boolean
}

const GIT_TIMEOUT_MS = 2000

/** Read git branch and worktree status from cwd. Returns undefined if not a git repo. */
export function readGitInfo(cwd: string): GitInfo | undefined {
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
