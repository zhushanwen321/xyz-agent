/**
 * GitService 并发保护测试（P6 D2 / AC5-AC8）。
 *
 * 验证 per-cwd git mutex 串行化写入命令、keyed 不同 cwd 并发、只读不阻塞、排队超时拒绝。
 * mock IGitExecutor（记录 exec 调用 + 时间戳 + 可控延迟）+ ISessionService（返回固定 cwd）。
 * 注入真实 gitMutex（createKeyedMutex）验证串行化行为。
 */
import { describe, it, expect } from 'vitest'
import { GitService, GitError } from './git-service.js'
import type { IGitExecutor, GitExecutorResult, GitCommand } from './ports/git-executor.js'
import type { ISessionService } from '../interfaces.js'
import { TimeoutError } from '../infra/async-mutex.js'

/** 简单 delay helper。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 构造 mock executor：记录所有 exec 调用（command/args/时间戳），可控延迟。
 * 默认对 commit 命令延迟（模拟 git commit 耗时），status/diff 等立即返回。
 */
function createMockExecutor(opts: { commitDelayMs?: number; statusOk?: boolean } = {}): IGitExecutor & {
  calls: Array<{ command: GitCommand; args: string[]; ts: number }>
} {
  const calls: Array<{ command: GitCommand; args: string[]; ts: number }> = []
  const commitDelay = opts.commitDelayMs ?? 0
  const executor: IGitExecutor = {
    async exec(cwd: string, command: GitCommand, args: string[] = []): Promise<GitExecutorResult> {
      calls.push({ command, args, ts: Date.now() })
      // commit 命令模拟延迟（测试串行/并发时序）
      if (command === 'commit' && commitDelay > 0) {
        await delay(commitDelay)
      }
      // status 默认返回无冲突的干净状态
      if (command === 'status') {
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    },
  }
  return Object.assign(executor, { calls })
}

/** mock sessionService：getSummary 返回固定 cwd 映射。 */
function createMockSessionService(cwdMap: Record<string, string>): Pick<ISessionService, 'getSummary'> {
  return {
    getSummary(sessionId: string) {
      const cwd = cwdMap[sessionId]
      return cwd ? { cwd } as never : undefined
    },
  }
}

describe('GitService per-cwd mutex (P6 D2)', () => {
  it('TC1/AC5: 并发两个 commit 同 cwd 串行化（第二个等第一个完成）', async () => {
    const executor = createMockExecutor({ commitDelayMs: 40 })
    const gitService = new GitService({
      sessionService: createMockSessionService({ s1: '/repo' }) as ISessionService,
      executor,
    })

    const p1 = gitService.commit('s1', 'msg1')
    const p2 = gitService.commit('s1', 'msg2')
    await Promise.allSettled([p1, p2])

    // 两次 commit 各对应一次 status + 一次 commit exec（共 4 次 commit 类）
    const commits = executor.calls.filter((c) => c.command === 'commit')
    expect(commits.length).toBe(2)
    // 串行：第二次 commit exec 的时间戳 - 第一次 commit exec 的时间戳 >= commitDelay（40ms）
    // （第二次的 commit exec 必须在第一次 commit exec 完成后才开始）
    expect(commits[1].ts - commits[0].ts).toBeGreaterThanOrEqual(35)
  })

  it('TC2/AC6: 并发两个 commit 不同 cwd 互不阻塞（keyed 验证）', async () => {
    const executor = createMockExecutor({ commitDelayMs: 40 })
    const gitService = new GitService({
      sessionService: createMockSessionService({ s1: '/repo-a', s2: '/repo-b' }) as ISessionService,
      executor,
    })

    const start = Date.now()
    await Promise.allSettled([
      gitService.commit('s1', 'msg1'),
      gitService.commit('s2', 'msg2'),
    ])
    const elapsed = Date.now() - start

    const commits = executor.calls.filter((c) => c.command === 'commit')
    expect(commits.length).toBe(2)
    // 并发：两次 commit exec 时间戳接近（差 < commitDelay，重叠执行）
    expect(Math.abs(commits[1].ts - commits[0].ts)).toBeLessThan(35)
    // 总耗时 ≈ 单个延迟（40ms），非两倍（串行会 ≈80ms）
    expect(elapsed).toBeLessThan(70)
  })

  it('TC3/AC7: 只读 status 与写入 commit 并发时只读不等 mutex', async () => {
    const executor = createMockExecutor({ commitDelayMs: 50 })
    const gitService = new GitService({
      sessionService: createMockSessionService({ s1: '/repo' }) as ISessionService,
      executor,
    })

    // 先触发 commit（占用 mutex 50ms），紧接触发 getStatus（只读不经 mutex）
    const commitPromise = gitService.commit('s1', 'msg')
    // 让 commit 先进入 mutex（event loop）
    await delay(5)
    const statusPromise = gitService.getStatus('s1')

    // status 应在 commit 完成前就执行（只读不阻塞）
    await statusPromise
    const statusCall = executor.calls.find((c) => c.command === 'status')
    const commitCall = executor.calls.find((c) => c.command === 'commit')
    expect(statusCall).toBeDefined()
    expect(commitCall).toBeDefined()
    // status 的 exec 调用在 commit exec 完成前（commit 延迟 50ms，status 立即返回）
    // commit exec ts 在进入 mutex 后记录，status exec ts 应在 commit exec 完成前
    expect(statusCall!.ts).toBeLessThan(commitCall!.ts + 45)

    await commitPromise
  })

  it('TC4/AC8: git mutex 排队超时拒绝（commit 超时抛 TimeoutError）', async () => {
    const executor = createMockExecutor({ commitDelayMs: 200 })
    const gitService = new GitService({
      sessionService: createMockSessionService({ s1: '/repo' }) as ISessionService,
      executor,
      mutexTimeoutMs: 20, // 排队超时 20ms（远小于 commit 的 200ms）
    })

    // 第一次 commit 慢（占用 mutex 200ms），第二次排队 20ms 超时
    const p1 = gitService.commit('s1', 'msg1')
    const p2 = gitService.commit('s1', 'msg2')

    // 第二次应 reject TimeoutError
    await expect(p2).rejects.toBeInstanceOf(TimeoutError)
    // 第一次正常完成
    await p1
  })

  it('commit TOCTOU 消除：status 查冲突与 commit 在同一锁内', async () => {
    // 验证 commit 方法内 status + commit 都经 mutex（间接：同 cwd 并发不会交错）
    const executor = createMockExecutor({ commitDelayMs: 0 })
    const gitService = new GitService({
      sessionService: createMockSessionService({ s1: '/repo' }) as ISessionService,
      executor,
    })

    await gitService.commit('s1', 'msg')

    // 调用顺序：status（查冲突）在前，commit 在后
    const seq = executor.calls.map((c) => c.command)
    const statusIdx = seq.indexOf('status')
    const commitIdx = seq.indexOf('commit')
    expect(statusIdx).toBeGreaterThanOrEqual(0)
    expect(commitIdx).toBeGreaterThan(statusIdx)
  })

  it('写入命令（stage）也经 mutex 串行化', async () => {
    const executor = createMockExecutor({})
    const gitService = new GitService({
      sessionService: createMockSessionService({ s1: '/repo' }) as ISessionService,
      executor,
    })

    // 用 mock executor 的 add 延迟验证 stage 串行化
    let addCount = 0
    const origExec = executor.exec
    executor.exec = async (cwd, command, args) => {
      if (command === 'add') { addCount++; await delay(30) }
      return origExec(cwd, command, args)
    }

    const p1 = gitService.stage('s1', ['a.ts'])
    const p2 = gitService.stage('s1', ['b.ts'])
    await Promise.allSettled([p1, p2])

    const adds = executor.calls.filter((c) => c.command === 'add')
    expect(adds.length).toBe(2)
    // 串行：第二次 add 在第一次完成后
    expect(adds[1].ts - adds[0].ts).toBeGreaterThanOrEqual(25)
  })

  it('GitError 仍正常抛出（commit_message_required 在 mutex 外前置校验）', async () => {
    const executor = createMockExecutor({})
    const gitService = new GitService({
      sessionService: createMockSessionService({ s1: '/repo' }) as ISessionService,
      executor,
    })

    // 空消息在进 mutex 前就抛（前置校验）
    await expect(gitService.commit('s1', '')).rejects.toThrow(GitError)
    await expect(gitService.commit('s1', '   ')).rejects.toThrow(GitError)
    // 不应有 exec 调用（前置校验拦截）
    expect(executor.calls.length).toBe(0)
  })
})
