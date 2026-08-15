/**
 * IGitExecutor 的真实实现 —— `child_process.execFile` 异步执行、数组参数（issues.md #1 / spec-w11 G-R2-05）。
 *
 * [perf W16 / 03-git-state-service D3-1]：execFileSync → execFile 异步化。同步子进程会阻塞 runtime
 * 事件循环（streaming 期间后续 token / 其他 session 消息全部排队）；execFile 保持行为契约不变——
 * 错误形状、超时语义、防注入数组参数均与同步版等价。
 *
 * 安全：
 * - 数组参数形式 `[command, ...args]` 直接交给 execFile，不经 shell，路径/message 中的特殊字符
 *   无法被解释为 shell 元素 → 命令注入防护的根因层。
 * - 子命令由 GitCommand 联合类型限定（白名单），非白名单子命令在编译期不可达。
 *
 * 不抛策略：git 退出码非 0 时（如非 git 仓库、冲突态 commit、路径不存在）**原样返回 exitCode+stderr**，
 * 不抛异常。GitService 按 stderr/exitCode 语义判定失败类型（isRepo / git_conflict / path_not_allowed）。
 * 仅在 git 二进制不可用（ENOENT）或超时时抛 GitExecutorError，由 handler 转 'git_unavailable'。
 */
import { execFile } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'
import { GitExecutorError } from '../services/ports/git-executor.js'
import type { GitCommand, GitExecOptions, GitExecutorResult, IGitExecutor } from '../services/ports/git-executor.js'

/** execFile 默认超时（ms）。大仓库 status/diff 也应在此内有界返回。调用方可经 opts.timeoutMs 收紧。 */
const GIT_TIMEOUT_MS = 8000
/** stdout 最大缓冲（bytes）。超大 status/diff 输出兼底。 */
// eslint-disable-next-line no-magic-numbers -- 10MB = 10 * 1024 * 1024 bytes
const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024

/**
 * Production adapter。数组参数经 execFile 执行，不经 shell。
 *
 * 注：execFile 在子进程非 0 退出时回调收 Error（.code 为数字退出码），此处还原为
 * {exitCode, stderr} 返回，保持「不抛、原样返回」契约。
 */
export class GitExecutor implements IGitExecutor {
  async exec(cwd: string, command: GitCommand, args: string[] = [], opts?: GitExecOptions): Promise<GitExecutorResult> {
    const fullArgs = [command, ...args]
    const timeoutMs = opts?.timeoutMs ?? GIT_TIMEOUT_MS
    return new Promise<GitExecutorResult>((resolve, reject) => {
      execFile(
        'git',
        fullArgs,
        {
          cwd,
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: GIT_MAX_BUFFER_BYTES, // 10MB：超大 status/diff 输出兜底
        },
        (err: ExecFileException | null, stdout: string, stderr: string) => {
          if (!err) {
            resolve({ stdout, stderr, exitCode: 0 })
            return
          }
          // git 二进制不存在（未安装，spawn 失败 code 为 string 错误码）→ 降级 git_unavailable
          if (err.code === 'ENOENT') {
            reject(new GitExecutorError('git_unavailable', 'git CLI 未安装或不在 PATH 中'))
            return
          }
          // 超时（execFile timeout 触发 kill → killed + SIGTERM）
          if (err.killed && err.signal === 'SIGTERM') {
            reject(new GitExecutorError('timeout', `git ${command} 执行超时（${timeoutMs}ms）`))
            return
          }
          // 非零退出（非 git 仓库 / 冲突态 commit / 路径非法 等）→ 原样返回，不抛。
          // execFile 错误的 .code 此时是数字退出码；其余形态（如 maxBuffer 超限的 string 错误码）兜底 1，
          // 与同步版（err.status 非 number → 1）等价。
          const exitCode = typeof err.code === 'number' ? err.code : 1
          const stderrText = typeof err.stderr === 'string' ? err.stderr : (err.message ?? '')
          const stdoutText = typeof err.stdout === 'string' ? err.stdout : ''
          resolve({ stdout: stdoutText, stderr: stderrText, exitCode })
        },
      )
    })
  }
}
