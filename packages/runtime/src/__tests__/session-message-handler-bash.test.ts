/**
 * SessionMessageHandler bash 请求路由测试（composer-bash-execute W1）。
 *
 * 锁定 message.bash / message.abortBash 的 ack 路由：
 * - T11: message.bash 正常 → 调 sendBash(sid, cmd, excludeFromContext) → reply message.status{sent}
 * - T12: sendBash 返回 {blocked:true}（非 rejected）→ sendError('message_blocked') 非 reply status{sent}
 * - T13: message.bash 被预检拒绝（result.rejected）→ reply message.status{rejected}
 * - T14: message.abortBash → 调 abortBash(sid) → reply message.status{aborted}
 *
 * mock 模式参考 test/session-message-handler.test.ts（makeHandler + Captured reply/error）。
 *
 * 运行：npx vitest run src/__tests__/session-message-handler-bash.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionMessageHandler } from '../transport/session-message-handler.js'
import type { ClientMessage } from '@xyz-agent/shared'

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
}

function makeHandler(sessionOverrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const cap: Captured = { replies: [], errors: [] }
  const sessionService = {
    sendBash: vi.fn().mockResolvedValue({ blocked: false }),
    abortBash: vi.fn().mockResolvedValue(undefined),
    // 其他方法 stub（handler 构造可能引用，保留最小实现避免 NPE）
    sendMessage: vi.fn().mockResolvedValue({ blocked: false }),
    ensureActive: vi.fn().mockResolvedValue(undefined),
    ...sessionOverrides,
  }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      cap.replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string, details?: Record<string, unknown>) => {
      cap.errors.push({ id, code, message, details })
    }),
    sessionService,
    nextPushId: vi.fn().mockReturnValue('p1'),
    broadcastSessionList: vi.fn(),
    clearExtensionTimeoutsForSession: vi.fn(),
  }
  const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
  return { ctx, cap, handler }
}

function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}

const WS = {} as never

describe('SessionMessageHandler —— message.bash 路由', () => {
  // T11: 正常路径 → sendBash 调用 + reply status{sent}
  it('T11: message.bash → 调 sendBash(sid, cmd, excludeFromContext) + reply message.status{sent}', async () => {
    const { ctx, cap, handler } = makeHandler()
    await handler.handleSessionMessage(
      msg('message.bash', { sessionId: 's1', command: 'ls', excludeFromContext: false }),
      WS,
      'local',
    )

    // sendBash 被调，参数透传
    expect(ctx.sessionService.sendBash).toHaveBeenCalledWith('s1', 'ls', false)
    // reply status{sent}
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'm1',
      type: 'message.status',
      payload: { sessionId: 's1', status: 'sent' },
    })
    // 无 error
    expect(cap.errors).toHaveLength(0)
  })

  // T12: blocked（执行失败，非 rejected）→ sendError('message_blocked')
  it('T12: sendBash 返回 {blocked:true}（非 rejected）→ sendError(message_blocked) 非 reply status{sent}', async () => {
    const { ctx, cap, handler } = makeHandler({
      sendBash: vi.fn().mockResolvedValue({ blocked: true }),
    })
    await handler.handleSessionMessage(
      msg('message.bash', { sessionId: 's1', command: 'git status' }),
      WS,
      'local',
    )

    // sendError 而非 reply status
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1',
      code: 'message_blocked',
      details: { sessionId: 's1' },
    })
    // 不得 reply status{sent}
    const sentReply = cap.replies.find((r) => r.payload.status === 'sent')
    expect(sentReply).toBeUndefined()
  })

  // T13: rejected（预检拒绝）→ reply status{rejected}
  it('T13: sendBash 返回 {blocked:true, rejected:true} → reply message.status{rejected}', async () => {
    const { cap, handler } = makeHandler({
      sendBash: vi.fn().mockResolvedValue({ blocked: true, rejected: true }),
    })
    await handler.handleSessionMessage(
      msg('message.bash', { sessionId: 's1', command: 'ls' }),
      WS,
      'local',
    )

    expect(cap.replies[0]).toMatchObject({
      type: 'message.status',
      payload: { sessionId: 's1', status: 'rejected' },
    })
    expect(cap.errors).toHaveLength(0)
  })

  // T11b: excludeFromContext 透传给 sendBash（undefined 时走 pi 默认）
  it('T11b: message.bash 不带 excludeFromContext → sendBash 第三参为 undefined', async () => {
    const { ctx, handler } = makeHandler()
    await handler.handleSessionMessage(
      msg('message.bash', { sessionId: 's1', command: 'pwd' }),
      WS,
      'local',
    )
    expect(ctx.sessionService.sendBash).toHaveBeenCalledWith('s1', 'pwd', undefined)
  })
})

describe('SessionMessageHandler —— message.abortBash 路由', () => {
  // T14: abortBash → 调 dispatcher.abortBash + reply status{aborted}
  it('T14: message.abortBash → 调 abortBash(sid) + reply message.status{aborted}', async () => {
    const { ctx, cap, handler } = makeHandler()
    await handler.handleSessionMessage(
      msg('message.abortBash', { sessionId: 's1' }),
      WS,
      'local',
    )

    // abortBash 被调
    expect(ctx.sessionService.abortBash).toHaveBeenCalledWith('s1')
    // reply status{aborted}
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'm1',
      type: 'message.status',
      payload: { sessionId: 's1', status: 'aborted' },
    })
    expect(cap.errors).toHaveLength(0)
  })
})
