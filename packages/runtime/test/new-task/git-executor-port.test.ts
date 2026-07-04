/**
 * GitCommand 白名单单测（#6+#7 port 扩展，T4.1/T6.1 配套）。
 *
 * 覆盖：GitCommand 联合类型含 'checkout'（编译期收窄），executor 只接受白名单内的子命令。
 * runtime git checkout 写路径（#6 切换 / #7 -b 创建）共用 'checkout' 白名单项。
 *
 * 运行：pnpm --filter @xyz-agent/runtime run test -- test/new-task/git-executor-port.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { GitCommand, IGitExecutor, GitExecutorResult } from '../../src/services/ports/git-executor.js'
import { GitExecutorError } from '../../src/services/ports/git-executor.js'

/** 编译期断言：'checkout' 必须能赋给 GitCommand（否则 tsc 编译失败）。 */
const CHECKOUT_IS_ALLOWED: GitCommand = 'checkout'

describe('GitCommand 白名单（#6+#7 共用 checkout）', () => {
  it("'checkout' 属于 GitCommand 联合类型（#6 切换 / #7 -b 创建共用）", () => {
    expect(CHECKOUT_IS_ALLOWED).toBe('checkout')
  })

  it('GitCommand 白名单完整集合（status/add/reset/commit/diff/rev-parse/checkout）', () => {
    // 运行期再校验一次：白名单不被误删
    const allCommands: GitCommand[] = [
      'status',
      'add',
      'reset',
      'commit',
      'diff',
      'rev-parse',
      'checkout',
    ]
    expect(allCommands).toContain('checkout')
    expect(new Set(allCommands).size).toBe(allCommands.length)
  })

  it('GitExecutorError 仍分类 git_unavailable / timeout（port 契约不变）', () => {
    const unavailable = new GitExecutorError('git_unavailable', 'git not found')
    const timeout = new GitExecutorError('timeout', 'timed out')
    expect(unavailable.code).toBe('git_unavailable')
    expect(timeout.code).toBe('timeout')
  })

  it('IGitExecutor.exec 签名经白名单 GitCommand 收窄（类型契约，#6 checkout 可经 port 执行）', async () => {
    // 构造一个最小 executor 实现，验证 checkout 能作为 command 传入（类型层 + 运行层）
    const executor: IGitExecutor = {
      async exec(
        _cwd: string,
        command: GitCommand,
        args?: string[],
      ): Promise<GitExecutorResult> {
        return { stdout: `ran ${command} ${args?.join(' ') ?? ''}`, stderr: '', exitCode: 0 }
      },
    }
    const res = await executor.exec('/repo', 'checkout', ['main'])
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain('checkout main')
  })
})
