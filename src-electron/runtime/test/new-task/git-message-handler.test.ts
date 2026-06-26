/**
 * GitMessageHandler git.checkout/git.createBranch 路由单测（#6/#7，T4.1/T6.1 配套）。
 *
 * 覆盖：
 * - handles 清单含 'git.checkout' / 'git.createBranch'
 * - git.checkout → gitService.checkout → reply message.status {status:'switched'}
 * - git.createBranch → gitService.createBranch → reply message.status {status:'branch_created'}
 * - reject(GitError) → error envelope（code 取 GitError.code，sessionId 透传）
 *
 * mock 策略（test-strategy §2.2/§5）：构造注入 mock gitService + ctx.reply/sendError 捕获。
 *
 * 运行：cd src-electron/runtime && npx vitest run test/new-task/git-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { GitMessageHandler } from '../../src/transport/git-message-handler.js'
import { GitError } from '../../src/services/git-service.js'
import type { ClientMessage } from '@xyz-agent/shared'

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
}

function makeHandler(
  checkoutImpl: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
  createBranchImpl: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
) {
  const cap: Captured = { replies: [], errors: [] }
  const gitService = {
    getStatus: vi.fn(),
    stage: vi.fn(),
    unstage: vi.fn(),
    commit: vi.fn(),
    checkout: checkoutImpl,
    createBranch: createBranchImpl,
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
  }
  const handler = new GitMessageHandler(ctx as unknown as ConstructorParameters<typeof GitMessageHandler>[0])
  return { cap, handler, gitService }
}

function checkoutMsg(sessionId: string, name: string, id = 'm1'): ClientMessage {
  return { type: 'git.checkout', id, payload: { sessionId, name } } as unknown as ClientMessage
}

function createBranchMsg(sessionId: string, name: string, id = 'm1'): ClientMessage {
  return { type: 'git.createBranch', id, payload: { sessionId, name } } as unknown as ClientMessage
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
    const { cap, handler } = makeHandler(vi.fn().mockRejectedValue(new GitError('git_failed', 'checkout conflict')))
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
    const { cap, handler } = makeHandler(
      vi.fn(),
      vi.fn().mockRejectedValue(new GitError('git_failed', 'branch exists')),
    )
    await handler.handleGitMessage(createBranchMsg('s1', 'feat/x'), WS)
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1', code: 'git_failed', message: 'branch exists', details: { sessionId: 's1' } })
    expect(cap.replies).toHaveLength(0)
  })
})
