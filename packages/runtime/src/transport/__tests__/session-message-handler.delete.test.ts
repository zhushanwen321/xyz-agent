/**
 * SessionMessageHandler session.delete 两步广播单测（P6 D6）。
 *
 * 覆盖：
 * - session.deleting 全量广播（含 byClientId，在 sessionService.delete 之前）
 * - session.deleted broadcastExcept 排除发起方（发起方只收 reply，不收广播）
 * - 现有清理步骤保留（clearExtensionTimeouts/clearSessionBuffer/broadcastSessionList）
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionMessageHandler } from '../session-message-handler.js'
import type { ServerMessage, ClientMessage } from '@xyz-agent/shared'

interface MockCtx {
  reply: ReturnType<typeof vi.fn>
  sendError: ReturnType<typeof vi.fn>
  broadcast: ReturnType<typeof vi.fn>
  broadcastExcept: ReturnType<typeof vi.fn>
  broadcastSessionList: ReturnType<typeof vi.fn>
  clearExtensionTimeoutsForSession: ReturnType<typeof vi.fn>
  clearSessionBuffer: ReturnType<typeof vi.fn>
  sessionService: { delete: ReturnType<typeof vi.fn> }
  nextPushId: ReturnType<typeof vi.fn>
}

function makeHandler(): { handler: SessionMessageHandler; ctx: MockCtx } {
  const ctx: MockCtx = {
    reply: vi.fn(),
    sendError: vi.fn(),
    broadcast: vi.fn(),
    broadcastExcept: vi.fn(),
    broadcastSessionList: vi.fn(),
    clearExtensionTimeoutsForSession: vi.fn(),
    clearSessionBuffer: vi.fn(),
    sessionService: { delete: vi.fn().mockResolvedValue(undefined) },
    nextPushId: vi.fn().mockReturnValue('push_1'),
  }
  const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
  return { handler, ctx }
}

function deleteMsg(sessionId: string, id = 'm1'): ClientMessage {
  return { type: 'session.delete', id, payload: { sessionId } } as unknown as ClientMessage
}

const WS = {} as never

describe('SessionMessageHandler session.delete 两步广播 (P6 D6)', () => {
  it('TC1: 广播 session.deleting（全量，含 byClientId，在 sessionService.delete 之前）', async () => {
    const { handler, ctx } = makeHandler()
    await handler.handleSessionMessage(deleteMsg('s1'), WS, 'clientA')

    const deletingCall = ctx.broadcast.mock.calls.find(
      (c: unknown[]) => (c[0] as ServerMessage).type === 'session.deleting',
    )
    expect(deletingCall).toBeDefined()
    const deletingMsg = deletingCall![0] as ServerMessage
    expect(deletingMsg.payload).toEqual({ sessionId: 's1', byClientId: 'clientA' })

    // deleting 在 sessionService.delete 之前：broadcast 调用序号 < delete 调用序号
    // 用 mock.invocationCallOrder 比较：deleting 的 broadcast 先于 sessionService.delete
    const deletingOrder = ctx.broadcast.mock.invocationCallOrder[0]
    const deleteOrder = ctx.sessionService.delete.mock.invocationCallOrder[0]
    expect(deletingOrder).toBeLessThan(deleteOrder)
  })

  it('TC2: session.deleted broadcastExcept 排除发起方（发起方只收 reply）', async () => {
    const { handler, ctx } = makeHandler()
    await handler.handleSessionMessage(deleteMsg('s1'), WS, 'clientA')

    // reply session.deleted 给发起方（点对点）
    expect(ctx.reply).toHaveBeenCalledWith(WS, 'm1', 'session.deleted', { sessionId: 's1' })
    // broadcastExcept 排除发起方
    expect(ctx.broadcastExcept).toHaveBeenCalledWith('clientA', expect.objectContaining({
      type: 'session.deleted',
      payload: { sessionId: 's1' },
    }))
  })

  it('TC3: 保留现有清理步骤（clearExtensionTimeouts/clearSessionBuffer/broadcastSessionList）', async () => {
    const { handler, ctx } = makeHandler()
    await handler.handleSessionMessage(deleteMsg('s1'), WS, 'clientA')

    expect(ctx.clearExtensionTimeoutsForSession).toHaveBeenCalledWith('s1')
    expect(ctx.sessionService.delete).toHaveBeenCalledWith('s1')
    expect(ctx.clearSessionBuffer).toHaveBeenCalledWith('s1')
    expect(ctx.broadcastSessionList).toHaveBeenCalled()
  })

  it('TC3b: 广播顺序——deleting 在前，deleted(broadcastExcept) 在 reply 之后', async () => {
    const { handler, ctx } = makeHandler()
    await handler.handleSessionMessage(deleteMsg('s1'), WS, 'clientA')

    // 顺序：clearExtensionTimeouts → broadcast(deleting) → delete → clearSessionBuffer → reply → broadcastExcept(deleted) → broadcastSessionList
    const order = {
      deleting: ctx.broadcast.mock.invocationCallOrder[0],
      delete: ctx.sessionService.delete.mock.invocationCallOrder[0],
      reply: ctx.reply.mock.invocationCallOrder[0],
      broadcastExcept: ctx.broadcastExcept.mock.invocationCallOrder[0],
      broadcastSessionList: ctx.broadcastSessionList.mock.invocationCallOrder[0],
    }
    expect(order.deleting).toBeLessThan(order.delete)
    expect(order.delete).toBeLessThan(order.reply)
    expect(order.reply).toBeLessThan(order.broadcastExcept)
    expect(order.broadcastExcept).toBeLessThan(order.broadcastSessionList)
  })
})
