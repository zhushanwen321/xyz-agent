/**
 * SessionMessageHandler 单测 — 覆盖 round-7 引入的请求级 error envelope 回归保护。
 *
 * 重点（report #4）：message.send blocked / steer·follow_up 失败 / session.compact 三路 / session.switch ENOENT。
 * 这些路径专为修 pendingMap 永挂泄漏，无测试下次重构极易回退。
 *
 * 运行：pnpm --filter @xyz-agent/runtime run test -- test/session-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionMessageHandler } from '../src/transport/session-message-handler.js'
import type { ClientMessage } from '@xyz-agent/shared'

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
}

function makeHandler(sessionOverrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const cap: Captured = { replies: [], errors: [] }
  const sessionService = {
    sendMessage: vi.fn().mockResolvedValue({ blocked: false }),
    sendSubagentMessage: vi.fn().mockResolvedValue({ blocked: false }),
    steerMessage: vi.fn().mockResolvedValue(undefined),
    followUpMessage: vi.fn().mockResolvedValue(undefined),
    ensureActive: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue([]),
    getSummary: vi.fn().mockReturnValue(undefined),
    restoreSession: vi.fn().mockResolvedValue({ id: 's1' }),
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
const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' })

describe('SessionMessageHandler — error envelope 回归', () => {
  describe('message.send', () => {
    it('blocked (hook拦截/prompt失败) → sendError(message_blocked) + 不 reply success', async () => {
      const { cap, handler } = makeHandler({ sendMessage: vi.fn().mockResolvedValue({ blocked: true }) })
      await handler.handleSessionMessage(msg('message.send', { sessionId: 's1', content: 'hi' }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({ id: 'm1', code: 'message_blocked', details: { sessionId: 's1' } })
      expect(cap.replies).toHaveLength(0) // 关键：不得 reply success，否则 pending.resolve 误判成功
    })

    it('未 blocked → reply message.status sent', async () => {
      const { cap, handler } = makeHandler()
      await handler.handleSessionMessage(msg('message.send', { sessionId: 's1', content: 'hi' }), WS)
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'message.status', payload: { status: 'sent' } })
      expect(cap.errors).toHaveLength(0)
    })
  })

  describe('message.steer', () => {
    it('失败 → sendError(steer_failed)', async () => {
      const { cap, handler } = makeHandler({ steerMessage: vi.fn().mockRejectedValue(new Error('no active pi')) })
      await handler.handleSessionMessage(msg('message.steer', { sessionId: 's1', content: 'x' }), WS)
      expect(cap.errors[0]).toMatchObject({ id: 'm1', code: 'steer_failed', details: { sessionId: 's1' } })
    })
    it('成功 → reply queued... 实为 steered', async () => {
      const { cap, handler } = makeHandler()
      await handler.handleSessionMessage(msg('message.steer', { sessionId: 's1', content: 'x' }), WS)
      expect(cap.replies[0].payload).toMatchObject({ status: 'steered' })
    })
  })

  describe('message.follow_up', () => {
    it('失败 → sendError(follow_up_failed)', async () => {
      const { cap, handler } = makeHandler({ followUpMessage: vi.fn().mockRejectedValue(new Error('boom')) })
      await handler.handleSessionMessage(msg('message.follow_up', { sessionId: 's1', content: 'x' }), WS)
      expect(cap.errors[0]).toMatchObject({ code: 'follow_up_failed', details: { sessionId: 's1' } })
    })
  })

  describe('session.compact', () => {
    it('ensureActive 失败 → sendError(compact_failed)', async () => {
      const { cap, handler } = makeHandler({ ensureActive: vi.fn().mockRejectedValue(new Error('restore fail')) })
      await handler.handleSessionCompact(msg('session.compact', { sessionId: 's1' }) as never, WS)
      expect(cap.errors[0]).toMatchObject({ code: 'compact_failed', id: 'm1' })
      expect(cap.replies).toHaveLength(0)
    })
    it('compact 失败 → sendError(compact_failed)', async () => {
      const { cap, handler } = makeHandler({ compact: vi.fn().mockRejectedValue(new Error('pi error')) })
      await handler.handleSessionCompact(msg('session.compact', { sessionId: 's1' }) as never, WS)
      expect(cap.errors[0]).toMatchObject({ code: 'compact_failed' })
    })
    it('成功 → reply session.compacted (带 ack id)', async () => {
      const { cap, handler } = makeHandler()
      await handler.handleSessionCompact(msg('session.compact', { sessionId: 's1' }) as never, WS)
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'session.compacted', payload: { status: 'compacted' } })
      expect(cap.errors).toHaveLength(0)
    })
  })

  describe('session.switch auto-restore', () => {
    it('ENOENT → sendError(file_not_found)', async () => {
      const { cap, handler } = makeHandler({
        getSummary: vi.fn().mockReturnValue(undefined),
        ensureActive: vi.fn().mockRejectedValue(enoent),
      })
      await handler.handleSessionMessage(msg('session.switch', { sessionId: 's1' }), WS)
      expect(cap.errors[0]).toMatchObject({ code: 'file_not_found', id: 'm1' })
    })
    it('普通失败 → sendError(not_found)', async () => {
      const { cap, handler } = makeHandler({
        getSummary: vi.fn().mockReturnValue(undefined),
        ensureActive: vi.fn().mockRejectedValue(new Error('other')),
      })
      await handler.handleSessionMessage(msg('session.switch', { sessionId: 's1' }), WS)
      expect(cap.errors[0].code).toBe('not_found')
    })
  })

  describe('session.workflowAction + session.subagentAction（扩展 slash command 转发）', () => {
    it('workflowAction 成功 → reply session.workflowActionDone', async () => {
      const { cap, handler } = makeHandler({ workflowAction: vi.fn().mockResolvedValue(undefined) })
      await handler.handleSessionMessage(msg('session.workflowAction', { sessionId: 's1', action: 'abort', runId: 'wf-1' }), WS)
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'session.workflowActionDone', payload: { sessionId: 's1', action: 'abort', runId: 'wf-1' } })
      expect(cap.errors).toHaveLength(0)
    })

    it('subagentAction 成功 → reply session.subagentActionDone', async () => {
      const { cap, handler } = makeHandler({ subagentAction: vi.fn().mockResolvedValue(undefined) })
      await handler.handleSessionMessage(msg('session.subagentAction', { sessionId: 's1', action: 'cancel', subagentId: 'bg-1' }), WS)
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'session.subagentActionDone', payload: { sessionId: 's1', action: 'cancel', subagentId: 'bg-1' } })
      expect(cap.errors).toHaveLength(0)
    })

    it('subagentAction 失败 → 抛出（由 server.ts 外层 catch 转 sendError，handler 内不包裹）', async () => {
      const { cap, handler } = makeHandler({ subagentAction: vi.fn().mockRejectedValue(new Error('session not active')) })
      await expect(handler.handleSessionMessage(msg('session.subagentAction', { sessionId: 's1', action: 'cancel', subagentId: 'bg-1' }), WS)).rejects.toThrow('session not active')
      // handler 内不 sendError 也不 reply（由 server.ts 外层 catch 处理）
      expect(cap.replies).toHaveLength(0)
    })
  })
})
