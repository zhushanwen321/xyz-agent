/**
 * Git 域 port —— git CLI 执行的唯一 seam（issues.md #1 / code-architecture §3.8）。
 *
 * 🔒 三层架构：services 定义 port，infra/git-executor.ts 实现（execFileSync 数组参数）。
 * GitService 经此 port 执行 git 子命令，不直接 spawn/exec。
 *
 * **白名单 = GitCommand 联合类型本身**。exec 只接受这 6 个 git 子命令；
 * 其余参数（路径/message）由 GitService 以数组元素传入，经 execFileSync 数组形式执行，
 * 不经 shell，杜绝命令注入（spec-w11 G-R2-05）。
 */
import type { GitFileStatus } from '@xyz-agent/shared'

/**
 * 允许执行的 git 子命令（白名单）。
 * - status / diff / rev-parse：只读查询（status 用于全量状态、diff --numstat 取行数、rev-parse 验仓库）
 * - add / reset：暂存/取消暂存
 * - commit：提交
 *
 * 路径/message 作为 args 数组元素传入（如 ['--', 'src/a.ts']、['-m', 'msg']），
 * 由 GitService 保证语义正确，executor 只负责以数组形式交给 execFileSync。
 */
export type GitCommand = 'status' | 'add' | 'reset' | 'commit' | 'diff' | 'rev-parse' | 'checkout'

/** IGitExecutor.exec 的返回。exitCode 非 0 时 GitService 按 stderr 判定失败类型。 */
export interface GitExecutorResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * git CLI 执行 port。
 *
 * 实现约束（infra/git-executor.ts）：
 * - 必须用 `child_process.execFileSync('git', [command, ...(args ?? [])], { cwd, encoding:'utf8' })`
 * - 禁止 exec/spawn 拼接 shell 字符串（§6.4 grep 防注入）
 * - 设 timeout 防大仓库卡死（spec-w11 G-R2-05）
 * - exitCode 非 0 时**不抛**，原样返回 {exitCode, stderr}，由 GitService 按语义判定（如非 git 仓库 vs 冲突）
 */
export interface IGitExecutor {
  exec(cwd: string, command: GitCommand, args?: string[]): Promise<GitExecutorResult>
}

/**
 * git 不可用 / 超时时抛出。属 port 契约的一部分（executor 的失败分类），
 * 由 infra/git-executor.ts 在实现中 throw，GitService 捕获后按语义判定（getStatus 降级 / 写操作转 GitError）。
 * 定义在 port 层，避免 services 直接 import infra 造成分层泄漏（D1）。
 */
export class GitExecutorError extends Error {
  readonly code: 'git_unavailable' | 'timeout'
  constructor(code: 'git_unavailable' | 'timeout', message: string) {
    super(message)
    this.name = 'GitExecutorError'
    this.code = code
  }
}

// ── 复用 shared 类型，供 GitService / parser 之间传递 ───────────────
export type { GitFileStatus }
