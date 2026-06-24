/**
 * GitService —— git 全量状态查询 + 写操作编排的深模块（issues.md #1 / code-architecture §3.7/§5.1）。
 *
 * 深度：调用方只传 sessionId（+ 可选路径/message）；cwd 解析、路径越界校验、git CLI 调用、
 * XY 码解析、numstat 聚合、冲突判定全部隐藏。handler 只需 catch → error envelope。
 *
 * 分层：GitService 调 IGitExecutor（port）做 IO，调 git-status-parser（纯函数，§5.1 豁免）做解析，
 * 经 ISessionService 取 cwd。不直接 import infra。
 *
 * 安全：
 * - cwd 取自 sessionService.getSession(sid).cwd（session.create 时确立的受信工作目录）
 * - stage/unstage 的 filePaths：逐个 path.resolve 后必须落在 cwd 之下（isUnderOrEqual），
 *   防止 `../../etc/passwd` 之类的路径穿越 → 越界抛 GitPathError（→ 'path_not_allowed'）
 *
 * cwd 白名单说明（设计决策，见 wave 报告）：cwd 本身不限定在 getConfigDir/getPiAgentDir 之下——
 * git-zone 的语义就是显示「用户当前项目」的 git 状态，用户项目位于 session.cwd（如 ~/Code/foo），
 * 不在 ~/.xyz-agent 下。真正的注入向量是 filePaths，对其做 cwd 下的越界校验是根因防护。
 */
import { resolve as resolvePath } from 'node:path'
import type { GitStatusResult } from '@xyz-agent/shared'
import type { ISessionService } from '../interfaces.js'
import type { IGitExecutor } from './ports/git-executor.js'
import { isUnderOrEqual } from '../utils/path-utils.js'
import { parseGitStatus, deriveCounts, parseNumstat } from '../infra/git-status-parser.js'

/** git 操作失败分类错误。handler 按 code 转 error envelope（D10/P0-B）。 */
export class GitError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'GitError'
    this.code = code
  }
}

export interface GitServiceOptions {
  sessionService: ISessionService
  executor: IGitExecutor
}

/** 非 git 仓库 / git 不可用时的降级结果（GitZone 隐藏）。 */
function notRepoResult(sessionId: string): GitStatusResult {
  return {
    sessionId,
    isRepo: false,
    stagedCount: 0,
    unstagedCount: 0,
    stats: { add: 0, del: 0 },
    hasConflict: false,
    files: [],
  }
}

export class GitService {
  constructor(private opts: GitServiceOptions) {}

  private getCwd(sessionId: string): string {
    const summary = this.opts.sessionService.getSummary(sessionId)
    return summary?.cwd ?? ''
  }

  /**
   * 校验 filePaths 全部落在 cwd 之下（防穿越）。返回相对 cwd 的 posix 路径数组（供 git add -- 使用）。
   * 越界 → 抛 GitError('path_not_allowed')。
   */
  private resolveFilePaths(cwd: string, filePaths?: string[]): string[] {
    if (!filePaths || filePaths.length === 0) return []
    const resolved: string[] = []
    for (const p of filePaths) {
      if (typeof p !== 'string' || p.length === 0) continue
      const abs = resolvePath(cwd, p)
      if (!isUnderOrEqual(cwd, abs)) {
        throw new GitError('path_not_allowed', `路径越界，禁止操作 cwd 之外的文件: ${p}`)
      }
      resolved.push(p)
    }
    return resolved
  }

  /**
   * 查询 cwd 的全量 git 状态（FR-12）。
   * - session 不存在 → 抛 GitError('session_not_found')（handler 转 error envelope）
   * - cwd 为空 / 非 git 仓库 / git 不可用 → 返回 isRepo=false 降级结果
   */
  async getStatus(sessionId: string): Promise<GitStatusResult> {
    const cwd = this.getCwd(sessionId)
    if (!cwd) {
      throw new GitError('session_not_found', `Session 不存在或无 cwd: ${sessionId}`)
    }

    // status --porcelain=v1 -z -b：-z NUL 分隔（路径安全），-b 带 branch 头
    const statusRes = await this.opts.executor.exec(cwd, 'status', ['--porcelain=v1', '-z', '-b'])
    if (statusRes.exitCode !== 0) {
      // 非 git 仓库（git status 在非仓库返回 128 + "not a git repository"）
      return notRepoResult(sessionId)
    }

    const { branch, files } = parseGitStatus(statusRes.stdout)
    const { stagedCount, unstagedCount, hasConflict } = deriveCounts(files)

    // stats：tracked 改动行数（staged+unstaged vs HEAD）。无 HEAD（空仓库）时 diff 失败 → 0。
    let stats = { add: 0, del: 0 }
    const diffRes = await this.opts.executor.exec(cwd, 'diff', ['--numstat', 'HEAD'])
    if (diffRes.exitCode === 0) {
      stats = parseNumstat(diffRes.stdout)
    }

    return {
      sessionId,
      isRepo: true,
      branch,
      stagedCount,
      unstagedCount,
      stats,
      hasConflict,
      files,
    }
  }

  /**
   * 暂存文件（git add）。空 filePaths → git add -A（全量暂存）。
   * 路径越界 → GitError('path_not_allowed')。
   */
  async stage(sessionId: string, filePaths?: string[]): Promise<void> {
    const cwd = this.requireCwd(sessionId)
    const paths = this.resolveFilePaths(cwd, filePaths)
    const args = paths.length > 0 ? ['--', ...paths] : ['-A']
    const res = await this.opts.executor.exec(cwd, 'add', args)
    if (res.exitCode !== 0) {
      throw new GitError('stage_failed', res.stderr.trim() || 'git add 失败')
    }
  }

  /**
   * 取消暂存（git reset HEAD --）。空 filePaths → git reset HEAD（全量取消暂存）。
   */
  async unstage(sessionId: string, filePaths?: string[]): Promise<void> {
    const cwd = this.requireCwd(sessionId)
    const paths = this.resolveFilePaths(cwd, filePaths)
    const args = paths.length > 0 ? ['HEAD', '--', ...paths] : ['HEAD']
    const res = await this.opts.executor.exec(cwd, 'reset', args)
    if (res.exitCode !== 0) {
      throw new GitError('unstage_failed', res.stderr.trim() || 'git reset 失败')
    }
  }

  /**
   * 提交（git commit -m）。冲突态必失败 → GitError('git_conflict')。
   *
   * message 必填（非空）：git 默认会打开编辑器，在子进程 execFileSync 下会永久挂起。
   * GitZone UI 在 message 为空时禁用提交按钮，此约束与 UI 一致。
   */
  async commit(sessionId: string, message?: string): Promise<void> {
    const cwd = this.requireCwd(sessionId)
    const msg = message?.trim()
    if (!msg) {
      throw new GitError('commit_message_required', '提交需要非空 commit message')
    }

    // 先查冲突态：冲突时 git commit 会拒绝（exitCode 1），但显式判定给更清晰的错误码
    const statusRes = await this.opts.executor.exec(cwd, 'status', ['--porcelain=v1', '-z'])
    if (statusRes.exitCode === 0) {
      const { hasConflict } = deriveCounts(parseGitStatus(statusRes.stdout).files)
      if (hasConflict) {
        throw new GitError('git_conflict', '存在未解决的冲突文件，请先解决冲突再提交')
      }
    }

    const res = await this.opts.executor.exec(cwd, 'commit', ['-m', msg])
    if (res.exitCode !== 0) {
      const stderr = res.stderr.trim()
      // 兜底：commit 时刚产生冲突（race）或 nothing to commit
      if (/nothing to commit|no changes/i.test(stderr)) {
        throw new GitError('nothing_to_commit', stderr || '没有可提交的改动')
      }
      if (/conflict|unmerged|merge/i.test(stderr)) {
        throw new GitError('git_conflict', stderr || '存在冲突，提交失败')
      }
      throw new GitError('commit_failed', stderr || 'git commit 失败')
    }
  }

  /** 取 cwd；空 → session_not_found（写操作不允许在无 cwd 的 session 上执行）。 */
  private requireCwd(sessionId: string): string {
    const cwd = this.getCwd(sessionId)
    if (!cwd) {
      throw new GitError('session_not_found', `Session 不存在或无 cwd: ${sessionId}`)
    }
    return cwd
  }
}
