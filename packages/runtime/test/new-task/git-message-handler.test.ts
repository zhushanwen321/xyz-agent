/**
 * GitMessageHandler git.checkout/git.createBranch/git.commit 及写操作失效路由单测
 * （#6/#7，T4.1/T6.1 配套 + perf W17）。
 *
 * 覆盖：
 * - handles 清单含 'git.checkout' / 'git.createBranch' / 'git.commit'
 * - git.checkout → gitService.checkout → reply message.status {status:'switched'}
 * - git.createBranch → gitService.createBranch → reply message.status {status:'branch_created'}
 * - reject(GitError) → error envelope（code 取 GitError.code，sessionId 透传）
 * - perf W17（03 D4-3 U2）：6 个写操作成功后 → gitService.invalidateStatusCache
 *   （stage/unstage/commit/checkout/createBranch 按 sessionId；checkoutCwd 按 cwd）；
 *   失败路径不失效（状态未变）
 *
 * mock 策略（test-strategy §2.2/§5）：构造注入 mock gitService + ctx.reply/sendError 捕获。
 *
 * 运行：pnpm --filter @xyz-agent/runtime run test -- test/new-task/git-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { GitMessageHandler } from '../../src/transport/git-message-handler.js'
import { GitError } from '../../src/services/git-service.js'
import type { ClientMessage } from '@xyz-agent/shared'

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
}

/** 写操作方法的可编程实现（默认全部 resolve——成功路径）。 */
interface GitImpls {
  checkout?: ReturnType<typeof vi.fn>
  createBranch?: ReturnType<typeof vi.fn>
  commit?: ReturnType<typeof vi.fn>
  stage?: ReturnType<typeof vi.fn>
  unstage?: ReturnType<typeof vi.fn>
  checkoutByCwd?: ReturnType<typeof vi.fn>
}

function makeHandler(impls: GitImpls = {}) {
  const cap: Captured = { replies: [], errors: [] }
  /** 捕获 broadcastChangeSetInvalidated 调用（D5 重构：commit 后广播） */
  const invalidations: { sessionId: string; reason: 'committed' }[] = []
  const gitService = {
    getStatus: vi.fn(),
    stage: impls.stage ?? vi.fn().mockResolvedValue(undefined),
    unstage: impls.unstage ?? vi.fn().mockResolvedValue(undefined),
    commit: impls.commit ?? vi.fn().mockResolvedValue(undefined),
    checkout: impls.checkout ?? vi.fn().mockResolvedValue(undefined),
    checkoutByCwd: impls.checkoutByCwd ?? vi.fn().mockResolvedValue(undefined),
    createBranch: impls.createBranch ?? vi.fn().mockResolvedValue(undefined),
    /** perf W17：写操作成功后的状态缓存失效入口（被测新行为） */
    invalidateStatusCache: vi.fn(),
  }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      cap.replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string, details?: Record<string, unknown>) => {
      cap.errors.push({ id, code, message, details })
    }),
    sessionService: { getSummary: vi.fn() },
    gitService,
    broadcastChangeSetInvalidated: vi.fn((sessionId: string, reason: 'committed') => {
      invalidations.push({ sessionId, reason })
    }),
  }
  const handler = new GitMessageHandler(ctx as unknown as ConstructorParameters<typeof GitMessageHandler>[0])
  return { cap, handler, gitService, invalidations }
}

function checkoutMsg(sessionId: string, name: string, id = 'm1'): ClientMessage {
  return { type: 'git.checkout', id, payload: { sessionId, name } } as unknown as ClientMessage
}

function createBranchMsg(sessionId: string, name: string, id = 'm1'): ClientMessage {
  return { type: 'git.createBranch', id, payload: { sessionId, name } } as unknown as ClientMessage
}

function commitMsg(sessionId: string, message: string, id = 'm1'): ClientMessage {
  return { type: 'git.commit', id, payload: { sessionId, message } } as unknown as ClientMessage
}

const WS = {} as never

describe('GitMessageHandler git.checkout 路由（#6）', () => {
  it("handles 清单含 'git.checkout'", () => {
    const { handler } = makeHandler()
    expect(handler.handles).toContain('git.checkout')
  })

  it('T4.1 checkout 成功→gitService.checkout 调用 + reply message.status switched', async () => {
    const { cap, handler, gitService } = makeHandler()
    await handler.handleGitMessage(checkoutMsg('s1', 'main'), WS)
    expect(gitService.checkout).toHaveBeenCalledWith('s1', 'main')
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'm1',
      type: 'message.status',
      payload: { sessionId: 's1', status: 'switched' },
    })
    expect(cap.errors).toHaveLength(0)
  })

  it('checkout 失败(GitError git_failed)→error envelope，code/sessionId 透传，不 reply success', async () => {
    const { cap, handler } = makeHandler({ checkout: vi.fn().mockRejectedValue(new GitError('git_failed', 'checkout conflict')) })
    await handler.handleGitMessage(checkoutMsg('s1', 'feature'), WS)
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1',
      code: 'git_failed',
      message: 'checkout conflict',
      details: { sessionId: 's1' },
    })
    expect(cap.replies).toHaveLength(0) // 关键：失败不 reply success
  })
})

describe('GitMessageHandler git.createBranch 路由（#7）', () => {
  it("handles 清单含 'git.createBranch'", () => {
    const { handler } = makeHandler()
    expect(handler.handles).toContain('git.createBranch')
  })

  it('T6.1 createBranch 成功→gitService.createBranch 调用 + reply message.status branch_created', async () => {
    const { cap, handler, gitService } = makeHandler()
    await handler.handleGitMessage(createBranchMsg('s1', 'feat/x'), WS)
    expect(gitService.createBranch).toHaveBeenCalledWith('s1', 'feat/x')
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'm1',
      type: 'message.status',
      payload: { sessionId: 's1', status: 'branch_created' },
    })
    expect(cap.errors).toHaveLength(0)
  })

  it('createBranch 失败(GitError git_failed)→error envelope，不 reply success', async () => {
    const { cap, handler } = makeHandler({
      createBranch: vi.fn().mockRejectedValue(new GitError('git_failed', 'branch exists')),
    })
    await handler.handleGitMessage(createBranchMsg('s1', 'feat/x'), WS)
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1', code: 'git_failed', message: 'branch exists', details: { sessionId: 's1' } })
    expect(cap.replies).toHaveLength(0)
  })
})

describe('GitMessageHandler git.commit 路由（D5 重构：commit 后广播 changeSetInvalidated）', () => {
  it("handles 清单含 'git.commit'", () => {
    const { handler } = makeHandler()
    expect(handler.handles).toContain('git.commit')
  })

  it('commit 成功→gitService.commit 调用 + 广播 changeSetInvalidated + reply committed', async () => {
    const { cap, handler, gitService, invalidations } = makeHandler()
    await handler.handleGitMessage(commitMsg('s1', 'fix: changeSet baseline diff'), WS)
    expect(gitService.commit).toHaveBeenCalledWith('s1', 'fix: changeSet baseline diff')
    // 广播必须在 reply 之前（避免前端短暂停留在 ready 态）
    expect(invalidations).toEqual([{ sessionId: 's1', reason: 'committed' }])
    expect(cap.replies[0]).toMatchObject({
      id: 'm1',
      type: 'message.status',
      payload: { sessionId: 's1', status: 'committed' },
    })
    expect(cap.errors).toHaveLength(0)
  })

  it('commit 失败(GitError nothing_to_commit)→error envelope，不广播不 reply', async () => {
    const { cap, handler, invalidations } = makeHandler({
      commit: vi.fn().mockRejectedValue(new GitError('nothing_to_commit', 'no changes')),
    })
    await handler.handleGitMessage(commitMsg('s1', 'msg'), WS)
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1', code: 'nothing_to_commit', message: 'no changes', details: { sessionId: 's1' } })
    // commit 失败时不应广播失效（工作区未变）
    expect(invalidations).toHaveLength(0)
    expect(cap.replies).toHaveLength(0)
  })
})

describe('GitMessageHandler 写操作失效（perf W17，03 D4-3 U2）', () => {
  /** 生成一条 ClientMessage（类型字面量 + payload 原样透传）。 */
  function msg<T extends string>(type: T, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
    return { type, id, payload } as unknown as ClientMessage
  }

  it('git.stage 成功→invalidateStatusCache({sessionId})，在 reply 前', async () => {
    const { handler, gitService, cap } = makeHandler()
    await handler.handleGitMessage(msg('git.stage', { sessionId: 's1', filePaths: ['a.ts'] }), WS)
    expect(gitService.stage).toHaveBeenCalledWith('s1', ['a.ts'])
    expect(gitService.invalidateStatusCache).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(cap.replies).toHaveLength(1) // ack 照常
  })

  it('git.unstage 成功→invalidateStatusCache({sessionId})', async () => {
    const { handler, gitService } = makeHandler()
    await handler.handleGitMessage(msg('git.unstage', { sessionId: 's1' }), WS)
    expect(gitService.invalidateStatusCache).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('git.commit 成功→invalidateStatusCache({sessionId})（广播 changeSetInvalidated 之后）', async () => {
    const { handler, gitService, invalidations } = makeHandler()
    await handler.handleGitMessage(commitMsg('s1', 'msg'), WS)
    expect(gitService.invalidateStatusCache).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(invalidations).toEqual([{ sessionId: 's1', reason: 'committed' }])
  })

  it('git.checkout 成功→invalidateStatusCache({sessionId})', async () => {
    const { handler, gitService } = makeHandler()
    await handler.handleGitMessage(checkoutMsg('s1', 'main'), WS)
    expect(gitService.invalidateStatusCache).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('git.checkoutCwd 成功→invalidateStatusCache({cwd})（session-less，按 cwd 失效）', async () => {
    const { handler, gitService, cap } = makeHandler()
    await handler.handleGitMessage(msg('git.checkoutCwd', { cwd: '/repo', name: 'main' }), WS)
    expect(gitService.checkoutByCwd).toHaveBeenCalledWith('/repo', 'main')
    expect(gitService.invalidateStatusCache).toHaveBeenCalledWith({ cwd: '/repo' })
    expect(cap.replies[0]).toMatchObject({ payload: { status: 'switched' } })
  })

  it('git.createBranch 成功→invalidateStatusCache({sessionId})', async () => {
    const { handler, gitService } = makeHandler()
    await handler.handleGitMessage(createBranchMsg('s1', 'feat/x'), WS)
    expect(gitService.invalidateStatusCache).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('写操作失败→不失效（状态未变，缓存仍有效）', async () => {
    const { handler, gitService, cap } = makeHandler({
      stage: vi.fn().mockRejectedValue(new GitError('stage_failed', 'boom')),
    })
    await handler.handleGitMessage(msg('git.stage', { sessionId: 's1' }), WS)
    expect(gitService.invalidateStatusCache).not.toHaveBeenCalled()
    expect(cap.errors).toHaveLength(1)
  })
})
