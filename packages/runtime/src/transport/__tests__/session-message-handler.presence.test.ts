/**
 * SessionMessageHandler P5 presence RPC 测试（session.setActive / presence.list）。
 *
 * 覆盖：
 * - TC4: session.setActive RPC → setActiveSession + reply session.setActive:result
 * - TC5: presence.list RPC → reply presence.list:result{connections}
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/session-message-handler.presence.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WebSocket } from 'ws'
import { SessionMessageHandler } from '../session-message-handler.js'
import type { SessionHandlerContext } from '../session-message-handler.js'
import type { ClientMessage, PresenceConnection } from '@xyz-agent/shared'

const WS = { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket

function makeCtx(overrides?: Partial<SessionHandlerContext>): SessionHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    getClientId: vi.fn(() => 'local'),
    getClient: vi.fn(() => undefined),
    broadcastExcept: vi.fn(),
    sendToClient: vi.fn(),
    sessionService: {} as never,
    nextPushId: vi.fn(() => 'push-1'),
    broadcastSessionList: vi.fn(),
    clearExtensionTimeoutsForSession: vi.fn(),
    broadcast: vi.fn(),
    clearSessionBuffer: vi.fn(),
    getDeviceName: vi.fn(() => ''),
    setActiveSession: vi.fn(),
    buildPresenceList: vi.fn((): PresenceConnection[] => [
      { clientId: 'A', deviceName: 'Mac', activeSessionId: null, isOperating: false },
    ]),
    ...overrides,
  } as unknown as SessionHandlerContext
}

describe('SessionMessageHandler P5 presence RPC（session.setActive / presence.list）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('TC4: session.setActive → setActiveSession(clientId, sessionId) + reply session.setActive:result', async () => {
    const ctx = makeCtx()
    const handler = new SessionMessageHandler(ctx)
    const msg: ClientMessage = { type: 'session.setActive', id: 'r1', payload: { sessionId: 's1' } }

    await handler.handleSessionMessage(msg, WS, 'clientA')

    expect(ctx.setActiveSession).toHaveBeenCalledWith('clientA', 's1')
    expect(ctx.reply).toHaveBeenCalledWith(WS, 'r1', 'session.setActive:result', {})
  })

  it('TC4b: session.setActive{sessionId:null} → setActiveSession(clientId, null)', async () => {
    const ctx = makeCtx()
    const handler = new SessionMessageHandler(ctx)
    const msg: ClientMessage = { type: 'session.setActive', id: 'r2', payload: { sessionId: null } }

    await handler.handleSessionMessage(msg, WS, 'clientA')

    expect(ctx.setActiveSession).toHaveBeenCalledWith('clientA', null)
  })

  it('TC5: presence.list → reply presence.list:result{connections:buildPresenceList()}', async () => {
    const ctx = makeCtx()
    const handler = new SessionMessageHandler(ctx)
    const msg: ClientMessage = { type: 'presence.list', id: 'r3', payload: {} }

    await handler.handleSessionMessage(msg, WS, 'clientB')

    expect(ctx.buildPresenceList).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(WS, 'r3', 'presence.list:result', {
      connections: [{ clientId: 'A', deviceName: 'Mac', activeSessionId: null, isOperating: false }],
    })
  })
})
