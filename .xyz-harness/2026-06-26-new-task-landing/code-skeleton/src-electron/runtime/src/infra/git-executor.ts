/**
 * IGitExecutor 的真实实现 —— `child_process.execFileSync` 数组参数（issues.md #1 / spec-w11 G-R2-05）。
 *
 * 安全：
 * - 数组参数形式 `[command, ...args]` 直接交给 execFileSync，不经 shell，路径/message 中的特殊字符
 *   无法被解释为 shell 元素 → 命令注入防护的根因层。
 * - 子命令由 GitCommand 联合类型限定（白名单），非白名单子命令在编译期不可达。
 *
 * 不抛策略：git 退出码非 0 时（如非 git 仓库、冲突态 commit、路径不存在）**原样返回 exitCode+stderr**，
 * 不抛异常。GitService 按 stderr/exitCode 语义判定失败类型（isRepo / git_conflict / path_not_allowed）。
 * 仅在 git 二进制不可用（ENOENT）或超时时抛 GitExecutorError，由 handler 转 'git_unavailable'。
 */
import { execFileSync } from 'node:child_process'
import { GitExecutorError } from '../services/ports/git-executor.js'
import type { GitCommand, GitExecutorResult, IGitExecutor } from '../services/ports/git-executor.js'

/** execFileSync 默认超时（ms）。大仓库 status/diff 也应在此内有界返回。 */
const GIT_TIMEOUT_MS = 8000
/** stdout 最大缓冲（bytes）。超大 status/diff 输出兼底。 */
const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024 // 10MB

/**
 * Production adapter。数组参数经 execFileSync 执行，不经 shell。
 *
 * 注：execFileSync 在子进程非 0 退出时会 throw（含 .status 字段），此处捕获后还原为
 * {exitCode, stderr} 返回，保持「不抛、原样返回」契约。
 */
export class GitExecutor implements IGitExecutor {
  async exec(cwd: string, command: GitCommand, args: string[] = []): Promise<GitExecutorResult> {
    const fullArgs = [command, ...args]
    try {
      const stdout = execFileSync('git', fullArgs, {
        cwd,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: GIT_MAX_BUFFER_BYTES, // 10MB：超大 status/diff 输出兜底
      })
      return { stdout, stderr: '', exitCode: 0 }
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { status?: number; stdout?: string; stderr?: string; signal?: string }
      // git 二进制不存在（未安装）→ 降级 git_unavailable
      if (err.code === 'ENOENT') {
        throw new GitExecutorError('git_unavailable', 'git CLI 未安装或不在 PATH 中')
      }
      // 超时（execFileSync signal = 'SIGTERM' 且 message 含 timeout）
      if (err.signal === 'SIGTERM' && /timeout/i.test(err.message ?? '')) {
        throw new GitExecutorError('timeout', `git ${command} 执行超时（${GIT_TIMEOUT_MS}ms）`)
      }
      // 非零退出（非 git 仓库 / 冲突态 commit / 路径非法 等）→ 原样返回，不抛
      const exitCode = typeof err.status === 'number' ? err.status : 1
      const stderr = typeof err.stderr === 'string' ? err.stderr : (err.message ?? '')
      const stdout = typeof err.stdout === 'string' ? err.stdout : ''
      return { stdout, stderr, exitCode }
    }
  }
}
