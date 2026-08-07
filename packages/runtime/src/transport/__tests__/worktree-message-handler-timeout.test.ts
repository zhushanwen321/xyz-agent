/**
 * worktree-message-handler TimeoutError→worktree_busy 测试（P6 D10/D11 / AC15）。
 *
 * 验证 handler 捕获 worktreeService 抛出的 TimeoutError，转 reply error code worktree_busy。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/worktree-message-handler-timeout.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { WebSocket } from 'ws'
import { WorktreeMessageHandler } from '../worktree-message-handler.js'
import type { WorktreeHandlerContext } from '../worktree-message-handler.js'
import { TimeoutError } from '../../infra/async-mutex.js'
import type { ClientMessage } from '@xyz-agent/shared'

const WS = { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket

function makeCtx(overrides?: Partial<WorktreeHandlerContext>): WorktreeHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    getClientId: () => 'local',
    getClient: () => undefined,
    broadcastExcept: vi.fn(),
    sendToClient: vi.fn(),
    worktreeService: {} as never,
    ...overrides,
  } as unknown as WorktreeHandlerContext
}

describe('WorktreeMessageHandler TimeoutError → worktree_busy (P6 D11)', () => {
  it('TC4/AC15: worktree.create 超时抛 TimeoutError 时 reply error code worktree_busy', async () => {
    const sendError = vi.fn()
    const reply = vi.fn()
    const worktreeService = {
      create: vi.fn().mockRejectedValue(new TimeoutError('mutex run timed out after 10000ms')),
    }
    const handler = new WorktreeMessageHandler(makeCtx({
      sendError,
      reply,
      worktreeService: worktreeService as never,
    }))

    const msg: ClientMessage = {
      type: 'worktree.create',
      id: 'req-1',
      payload: { branch: 'feat-x', workspaceHint: '/project' },
    }
    await handler.handleWorktreeMessage(msg, WS)

    expect(worktreeService.create).toHaveBeenCalled()
    // TimeoutError → worktree_busy
    expect(sendError).toHaveBeenCalledTimes(1)
    const callArgs = sendError.mock.calls[0]
    expect(callArgs[1]).toBe('worktree_busy') // code
    expect(callArgs[2]).toContain('timed out') // message
    expect(callArgs[3]).toBe('req-1') // id
    expect(reply).not.toHaveBeenCalled()
  })

  it('普通扁平错误仍走原 code 提取路径（WORKTREE_EXISTS 不受影响）', async () => {
    const sendError = vi.fn()
    const worktreeService = {
      create: vi.fn().mockRejectedValue(
        Object.assign(new Error('worktree 目录已存在'), { code: 'WORKTREE_EXISTS', detail: '/project/feat' }),
      ),
    }
    const handler = new WorktreeMessageHandler(makeCtx({
      sendError,
      worktreeService: worktreeService as never,
    }))

    const msg: ClientMessage = {
      type: 'worktree.create',
      id: 'req-2',
      payload: { branch: 'feat', workspaceHint: '/project' },
    }
    await handler.handleWorktreeMessage(msg, WS)

    expect(sendError).toHaveBeenCalledTimes(1)
    // 普通扁平错误取 code（WORKTREE_EXISTS），不是 worktree_busy
    expect(sendError.mock.calls[0][1]).toBe('WORKTREE_EXISTS')
  })
})
