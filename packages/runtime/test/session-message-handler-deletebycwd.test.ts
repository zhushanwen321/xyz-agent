/**
 * W1: SessionMessageHandler case 'session.deleteByCwd' 单测。
 *
 * 背景：handler 调 service.deleteByCwd → reply 'session.deletedByCwd' result →
 * broadcastSessionList。
 *
 * D6a（integrity-hardening §3.6）后契约变更：handler 不再对 result.deleted 逐个直接调
 * clearExtensionTimeoutsForSession——挂起 UI 请求清理已汇聚到 onSessionDestroyed 回调
 *（server.ts setServices 注册，removeSessionEntry 触发，覆盖主动删 / 进程退出 / restore
 * 清场全部销毁路径；见 test/server-destroyed-converged-cleanup.test.ts）。本文件锁定
 * 路由行为（deleteByCwd 调用 / reply / broadcast / invalid_payload 守卫）。
 *
 * Mock 策略：参考 session-message-handler.test.ts 的 ctx mock（vi.fn for reply/
 * broadcastSessionList），构造 ClientMessage，实例化 SessionMessageHandler 调
 * handleSessionMessage(msg, ws)。
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
  }
  const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
  return { ctx, handler }
}

describe('W1: SessionMessageHandler — session.deleteByCwd', () => {
  beforeEach(() => vi.clearAllMocks())

  it('W1TC4 正常 deleteByCwd + reply + broadcastSessionList（清理经 onSessionDestroyed 汇聚点，不经 handler）', async () => {
    const { ctx, handler } = makeHandler(async () => ({
      cwd: '/p', deleted: ['s1', 's3'], failed: [],
    }))
    const msg = {
      type: 'session.deleteByCwd', id: 'm1', payload: { cwd: '/p' },
    } as unknown as ClientMessage

    await handler.handleSessionMessage(msg, WS)

    // deleteByCwd 调用参数透传
    expect(ctx.sessionService.deleteByCwd).toHaveBeenCalledWith('/p')
    // reply 1 次，payload 透传 BatchDeleteResult
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(WS, 'm1', 'session.deletedByCwd', {
      cwd: '/p', deleted: ['s1', 's3'], failed: [],
    })
    // broadcastSessionList 1 次
    expect(ctx.broadcastSessionList).toHaveBeenCalledTimes(1)
  })

  it('W1TC5 部分失败 → reply 含 failed 数组（清理语义同上，经汇聚点）', async () => {
    const { ctx, handler } = makeHandler(async () => ({
      cwd: '/p',
      deleted: ['s1'],
      failed: [{ sessionId: 's2', error: 'EPERM' }],
    }))
    const msg = {
      type: 'session.deleteByCwd', id: 'm1', payload: { cwd: '/p' },
    } as unknown as ClientMessage

    await handler.handleSessionMessage(msg, WS)

    // reply payload 含 failed 数组
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(WS, 'm1', 'session.deletedByCwd', {
      cwd: '/p',
      deleted: ['s1'],
      failed: [{ sessionId: 's2', error: 'EPERM' }],
    })
    expect(ctx.broadcastSessionList).toHaveBeenCalledTimes(1)
  })

  it('W1TC6 空 cwd → sendError invalid_payload（不调 deleteByCwd）', async () => {
    const { ctx, handler } = makeHandler(async () => ({ cwd: '', deleted: [], failed: [] }))
    const msg = {
      type: 'session.deleteByCwd', id: 'm1', payload: { cwd: '' },
    } as unknown as ClientMessage

    await handler.handleSessionMessage(msg, WS)

    expect(ctx.sessionService.deleteByCwd).not.toHaveBeenCalled()
    expect(ctx.sendError).toHaveBeenCalledWith(
      WS, 'invalid_payload', 'session.deleteByCwd requires a non-empty "cwd" string', 'm1',
    )
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
