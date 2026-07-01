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
import type { GitCommand, GitExecutorResult, IGitExecutor } from './ports/git-executor.js'
import { GitExecutorError } from './ports/git-executor.js'
import { isUnderOrEqual } from '../utils/path-utils.js'
import { toErrorMessage } from '../utils/errors.js'
import { parseGitStatus, deriveCounts, parseNumstat, parseNumstatByFile } from '../infra/git-status-parser.js'

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

/**
 * 合法分支名规则（前端 + runtime 二次校验一致，AC-7.8/T6.8）。
 * v1 用保守正则：字母/数字开头，允许 `.`/`_`/`/`/`-`。git CLI 自身规则更细（禁 `..`/空格/`~^:` 等），
 * 此正则拦住明显非法名；真正边界交 git checkout -b 的非 0 退出码转 GitError。
 */
const VALID_BRANCH_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/

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

    try {
      // status --porcelain=v1 -z -b：-z NUL 分隔（路径安全），-b 带 branch 头
      const statusRes = await this.execSafe(cwd, 'status', ['--porcelain=v1', '-z', '-b'])
      if (statusRes.exitCode !== 0) {
        // 非 git 仓库（git status 在非仓库返回 128 + "not a git repository"）
        return notRepoResult(sessionId)
      }

      const { branch, files } = parseGitStatus(statusRes.stdout)
      const { stagedCount, unstagedCount, hasConflict } = deriveCounts(files)

      // stats：tracked 改动行数（staged+unstaged vs HEAD）。无 HEAD（空仓库）时 diff 失败 → 0。
      let stats = { add: 0, del: 0 }
      const diffRes = await this.execSafe(cwd, 'diff', ['--numstat', 'HEAD'])
      if (diffRes.exitCode === 0) {
        stats = parseNumstat(diffRes.stdout)
        // W1 文件树 +N −M 角标：per-file 行数填充 files[]。numstat 不含 untracked/unmerged/二进制
        // → 这些文件 numstatMap 无匹配，additions/deletions 保持 undefined（前端降级展示）。
        // rename 文件 numstat 输出新路径（与 porcelain path 一致），正常匹配。
        const numstatMap = parseNumstatByFile(diffRes.stdout)
        for (const file of files) {
          const ns = numstatMap.get(file.path)
          if (ns) {
            file.additions = ns.add
            file.deletions = ns.del
          }
        }
      }

      // 本地分支列表（#6 选分支 popover 数据源，架构 §4.3 GitStatusResult 含分支列表）。
      // --format=%(refname:short) 输出干净的短分支名（无 `*` 当前标记、无缩进），每行一个；
      // unborn HEAD（无 commit）/ 列举失败 → []。currentBranch 由上方 parseBranchHeader 给出。
      let branches: string[] = []
      const branchRes = await this.execSafe(cwd, 'branch', ['--list', '--format=%(refname:short)'])
      if (branchRes.exitCode === 0) {
        branches = branchRes.stdout
          .split('\n')
          .map((b) => b.trim())
          .filter((b) => b.length > 0)
      }

      return {
        sessionId,
        isRepo: true,
        branch,
        branches,
        stagedCount,
        unstagedCount,
        stats,
        hasConflict,
        files,
      }
    } catch (e) {
      // git 不可用 / 超时（git_unavailable）或未知底层错误（git_failed）→ 降级 isRepo:false（spec G-R2-05）。
      // session_not_found 在上方已提前抛出，不会进到此 catch；写操作不走 getStatus，仍交 handler 发 error envelope。
      if (e instanceof GitError && (e.code === 'git_unavailable' || e.code === 'git_failed')) {
        return notRepoResult(sessionId)
      }
      throw e
    }
  }

  /**
   * 取单文件 diff（#5，UC-6 点文件预览的后端）。
   *
   * 数据流：getCwd → 新写越界校验（K-6，仿 resolveFilePaths 但 diff 路径无先例）→
   *   executor.exec(cwd, 'diff', ['--', path])（NFR-AC-S3 经 port 数组形式）。
   *
   * 边界（AC-5.1~5.5）：
   * - session 不存在 → GitError('session_not_found')
   * - 路径越界 cwd → GitError('path_not_allowed')（NFR-AC-S5，K-6 新增非复用）
   * - 非 git 仓库 / 路径无效 → git diff 退出码非 0，返回空 patch（AC-5.3，T6.14）
   * - 二进制文件 → stdout 含 "Binary files differ"，binary=true（AC-5.5，T6.6）
   * - 超时 → execSafe 抛 GitExecutorError → 转 GitError('git_failed')（AC-5.4，T6.13）
   */
  async getFileDiff(sessionId: string, path: string): Promise<{ patch: string; binary: boolean }> {
    const cwd = this.requireCwd(sessionId)
    // K-6：新写越界校验（diff 路径无先例，不复用 resolveFilePaths——那个只处理写操作的批量路径）
    const absPath = resolvePath(cwd, path)
    if (!isUnderOrEqual(cwd, absPath)) {
      throw new GitError('path_not_allowed', `路径越界，禁止读取 cwd 之外的文件: ${path}`)
    }
    const result = await this.execSafe(cwd, 'diff', ['--', path])
    // 二进制文件：git diff 输出 "Binary files a/x and b/x differ"
    const binary = result.stdout.includes('Binary files') && result.stdout.includes('differ')
    // 非 git 仓库 / 路径无效 → exitCode 非 0 + 空 stdout → 返回空 patch（T6.14 cwd 非 repo）
    return { patch: result.stdout, binary }
  }

  /**
   * 暂存文件（git add）。空 filePaths → git add -A（全量暂存）。
   * 路径越界 → GitError('path_not_allowed')。
   */
  async stage(sessionId: string, filePaths?: string[]): Promise<void> {
    const cwd = this.requireCwd(sessionId)
    const paths = this.resolveFilePaths(cwd, filePaths)
    const args = paths.length > 0 ? ['--', ...paths] : ['-A']
    const res = await this.execSafe(cwd, 'add', args)
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
    const res = await this.execSafe(cwd, 'reset', args)
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
    const statusRes = await this.execSafe(cwd, 'status', ['--porcelain=v1', '-z'])
    if (statusRes.exitCode === 0) {
      const { hasConflict } = deriveCounts(parseGitStatus(statusRes.stdout).files)
      if (hasConflict) {
        throw new GitError('git_conflict', '存在未解决的冲突文件，请先解决冲突再提交')
      }
    }

    const res = await this.execSafe(cwd, 'commit', ['-m', msg])
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

  /**
   * 切换分支（#6 选分支 popover）。
   *
   * 数据流：handler → checkout(sessionId,name) → execSafe(cwd,'checkout',[name]) →
   * git CLI → exit 0 成功 / 非0 失败转 GitError。ack 走 'message.status'（status='switched'）。
   *
   * 失败路径（§4.3 E8）：
   * - session 不存在 → GitError('session_not_found')
   * - 分支不存在 / dirty 冲突 → exitCode 非0、stderr 含 fatal/error → GitError('git_failed')
   * - 超时 → port GitExecutorError(timeout) → execSafe 转 GitError('git_unavailable')（§3.8 NFR 约束，port 继承 8000ms）
   *
   * SDK 契约：经 IGitExecutor port（白名单含 'checkout'），数组参数 ['checkout', name] 不经 shell。
   * 分支名不需越界校验（非路径），runtime 依赖 git CLI 自身拒绝非法分支名。
   */
  async checkout(sessionId: string, name: string): Promise<void> {
    const cwd = this.requireCwd(sessionId)
    const res = await this.execSafe(cwd, 'checkout', [name])
    if (res.exitCode !== 0) {
      throw new GitError('git_failed', res.stderr.trim() || `git checkout ${name} 失败`)
    }
  }

  /**
   * 创建并检出分支（#7 创建分支 modal，§4.4）。
   *
   * 数据流：handler → createBranch(sessionId,name) → execSafe(cwd,'checkout',['-b',name]) →
   * git CLI → exit 0 成功 / 非0 失败转 GitError。ack 走 'message.status'（status='branch_created'）。
   *
   * 安全（T6.8 NFR）：分支名 runtime 二次校验——防前端绕过直调 createBranch 传非法名（空格/`..` 等）。
   * 非法名在 exec 前被拒（不触达 git CLI），抛 GitError('invalid_branch_name')。
   *
   * 失败路径（§4.4）:
   * - session 不存在 → GitError('session_not_found')
   * - 分支名非法 → GitError('invalid_branch_name')（exec 未调）
   * - 已存在 / 其它 git 错误 → execSafe 非0 → GitError('git_failed')（E10）
   * - 超时 → port GitExecutorError(timeout) → execSafe 转 GitError('git_unavailable')（E11，port 继承 8000ms）
   *
   * 复用 GitCommand 'checkout' 白名单（Wave 2 已扩），`checkout -b` 与 `checkout` 共用白名单项。
   */
  async createBranch(sessionId: string, name: string): Promise<void> {
    const cwd = this.requireCwd(sessionId)
    const trimmed = name.trim()
    if (!VALID_BRANCH_NAME.test(trimmed) || trimmed.includes('..')) {
      throw new GitError('invalid_branch_name', `非法分支名: ${name}`)
    }
    const res = await this.execSafe(cwd, 'checkout', ['-b', trimmed])
    if (res.exitCode !== 0) {
      throw new GitError('git_failed', res.stderr.trim() || `git checkout -b ${trimmed} 失败`)
    }
  }

  private async execSafe(cwd: string, command: GitCommand, args: string[] = []): Promise<GitExecutorResult> {
    try {
      return await this.opts.executor.exec(cwd, command, args)
    } catch (e) {
      if (e instanceof GitExecutorError) {
        throw new GitError('git_unavailable', e.message)
      }
      throw new GitError('git_failed', toErrorMessage(e))
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
