/**
 * git-message-handler TimeoutError→git_busy 测试（P6 D10/D11 / AC8）。
 *
 * 验证 handler 捕获 gitService 抛出的 TimeoutError，转 reply error code git_busy。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/git-message-handler-timeout.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { WebSocket } from 'ws'
import { GitMessageHandler } from '../git-message-handler.js'
import type { GitHandlerContext } from '../git-message-handler.js'
import { GitError } from '../../services/git-service.js'
import { TimeoutError } from '../../infra/async-mutex.js'
import type { ClientMessage } from '@xyz-agent/shared'

const WS = { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket

function makeCtx(overrides?: Partial<GitHandlerContext>): GitHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    getClientId: () => 'local',
    getClient: () => undefined,
    broadcastExcept: vi.fn(),
    sendToClient: vi.fn(),
    sessionService: {} as never,
    gitService: {} as never,
    broadcastChangeSetInvalidated: vi.fn(),
    ...overrides,
  } as unknown as GitHandlerContext
}

describe('GitMessageHandler TimeoutError → git_busy (P6 D11)', () => {
  it('TC5/AC8: git.commit 超时抛 TimeoutError 时 reply error code git_busy', async () => {
    const sendError = vi.fn()
    const reply = vi.fn()
    const gitService = {
      commit: vi.fn().mockRejectedValue(new TimeoutError('mutex run timed out after 10000ms')),
    }
    const handler = new GitMessageHandler(makeCtx({
      sendError,
      reply,
      gitService: gitService as never,
    }))

    const msg: ClientMessage = { type: 'git.commit', id: 'req-1', payload: { sessionId: 's1', message: 'msg' } }
    await handler.handleGitMessage(msg, WS)

    expect(gitService.commit).toHaveBeenCalledWith('s1', 'msg')
    // TimeoutError → git_busy（非 git_failed）
    expect(sendError).toHaveBeenCalledTimes(1)
    const callArgs = sendError.mock.calls[0]
    expect(callArgs[1]).toBe('git_busy') // code
    expect(callArgs[2]).toContain('timed out') // message
    expect(callArgs[3]).toBe('req-1') // id
    expect(callArgs[4]).toEqual({ sessionId: 's1' }) // details
    // 不应 reply success
    expect(reply).not.toHaveBeenCalled()
  })

  it('普通 GitError 仍走原 git_failed/原 code 路径（不受 TimeoutError 影响）', async () => {
    const sendError = vi.fn()
    const gitService = {
      commit: vi.fn().mockRejectedValue(new GitError('commit_failed', 'commit 失败')),
    }
    const handler = new GitMessageHandler(makeCtx({
      sendError,
      gitService: gitService as never,
    }))

    const msg: ClientMessage = { type: 'git.commit', id: 'req-2', payload: { sessionId: 's1', message: 'msg' } }
    await handler.handleGitMessage(msg, WS)

    expect(sendError).toHaveBeenCalledTimes(1)
    // 普通 GitError 取其 code（commit_failed），不是 git_busy
    expect(sendError.mock.calls[0][1]).toBe('commit_failed')
  })
})
