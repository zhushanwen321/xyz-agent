/**
 * W1: SessionMessageHandler case 'session.deleteByCwd' 单测。
 *
 * 背景：handler 调 service.deleteByCwd → 循环 result.deleted 调 clearExtensionTimeoutsForSession →
 * reply 'session.deletedByCwd' result → broadcastSessionList。
 *
 * Mock 策略：参考 session-message-handler.test.ts 的 ctx mock（vi.fn for reply/
 * broadcastSessionList/clearExtensionTimeoutsForSession），构造 ClientMessage，
 * 实例化 SessionMessageHandler 调 handleSessionMessage(msg, ws)。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-message-handler-deletebycwd.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionMessageHandler } from '../src/transport/session-message-handler.js'
import type { ClientMessage, BatchDeleteResult } from '@xyz-agent/shared'

const WS = {} as never

function makeHandler(deleteByCwdImpl: () => Promise<BatchDeleteResult>) {
  const sessionService = {
    deleteByCwd: vi.fn(deleteByCwdImpl),
  }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn(),
    sendError: vi.fn(),
    sessionService,
    nextPushId: vi.fn().mockReturnValue('p1'),
    broadcastSessionList: vi.fn(),
    clearExtensionTimeoutsForSession: vi.fn(),
  }
  const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
  return { ctx, handler }
}

describe('W1: SessionMessageHandler — session.deleteByCwd', () => {
  beforeEach(() => vi.clearAllMocks())

  it('W1TC4 正常 reply+broadcast+循环 clearTimeouts（每个 deleted 各一次）', async () => {
    const { ctx, handler } = makeHandler(async () => ({
      cwd: '/p', deleted: ['s1', 's3'], failed: [],
    }))
    const msg = {
      type: 'session.deleteByCwd', id: 'm1', payload: { cwd: '/p' },
    } as unknown as ClientMessage

    await handler.handleSessionMessage(msg, WS, 'local')

    // 循环 clearExtensionTimeoutsForSession：对 deleted 中每个 id 调一次
    expect(ctx.clearExtensionTimeoutsForSession).toHaveBeenCalledTimes(2)
    expect(ctx.clearExtensionTimeoutsForSession).toHaveBeenCalledWith('s1')
    expect(ctx.clearExtensionTimeoutsForSession).toHaveBeenCalledWith('s3')
    // reply 1 次，payload 透传 BatchDeleteResult
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(WS, 'm1', 'session.deletedByCwd', {
      cwd: '/p', deleted: ['s1', 's3'], failed: [],
    })
    // broadcastSessionList 1 次
    expect(ctx.broadcastSessionList).toHaveBeenCalledTimes(1)
  })

  it('W1TC5 部分失败 → clearTimeouts 仅对 deleted 调用，reply 含 failed 数组', async () => {
    const { ctx, handler } = makeHandler(async () => ({
      cwd: '/p',
      deleted: ['s1'],
      failed: [{ sessionId: 's2', error: 'EPERM' }],
    }))
    const msg = {
      type: 'session.deleteByCwd', id: 'm1', payload: { cwd: '/p' },
    } as unknown as ClientMessage

    await handler.handleSessionMessage(msg, WS, 'local')

    // 失败的 s2 不应触发 clearExtensionTimeoutsForSession，只调 1 次（s1）
    expect(ctx.clearExtensionTimeoutsForSession).toHaveBeenCalledTimes(1)
    expect(ctx.clearExtensionTimeoutsForSession).toHaveBeenCalledWith('s1')
    expect(ctx.clearExtensionTimeoutsForSession).not.toHaveBeenCalledWith('s2')
    // reply payload 含 failed 数组
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(WS, 'm1', 'session.deletedByCwd', {
      cwd: '/p',
      deleted: ['s1'],
      failed: [{ sessionId: 's2', error: 'EPERM' }],
    })
    expect(ctx.broadcastSessionList).toHaveBeenCalledTimes(1)
  })
})
