/**
 * Session message handler for session.* and message.* message types.
 * Extracted from RuntimeServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@xyz-agent/shared'
import type { ISessionService } from '../interfaces.js'
import { toErrorMessage, isEnoent } from '../utils/errors.js'
import type { MessageHandlerContext } from './message-context.js'

/** Interface for server methods needed by this handler */
export interface SessionHandlerContext extends MessageHandlerContext {
  sessionService: ISessionService
  nextPushId(): string
  broadcastSessionList(): void
  clearExtensionTimeoutsForSession(sessionId: string): void
}

export class SessionMessageHandler {
  constructor(private ctx: SessionHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单（session.compact 单独路由，故不在此列）。 */
  readonly handles: ClientMessageType[] = [
    'session.create', 'session.delete', 'session.list', 'session.switch', 'session.history', 'session.rename',
    'message.send', 'message.abort', 'message.steer', 'message.follow_up',
  ]

  async handleSessionMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'session.create': {
        const session = await this.ctx.sessionService.create(msg.payload.cwd, msg.payload.label)
        this.ctx.reply(ws, msg.id, 'session.created', { session })
        return this.ctx.broadcastSessionList()
      }
      case 'session.delete': {
        const delSid = msg.payload.sessionId
        this.ctx.clearExtensionTimeoutsForSession(delSid)
        await this.ctx.sessionService.delete(delSid)
        this.ctx.reply(ws, msg.id, 'session.deleted', { sessionId: delSid })
        return this.ctx.broadcastSessionList()
      }
      case 'session.list':
        return this.ctx.reply(ws, msg.id, 'session.list', { groups: this.ctx.sessionService.listPersistedSessions() })
      case 'session.switch': {
        const switchId = msg.payload.sessionId
        const summary = this.ctx.sessionService.getSummary(switchId)
        if (summary) {
          try {
            const messages = await this.ctx.sessionService.getHistory(switchId)
            this.ctx.reply(ws, msg.id, 'session.history', { sessionId: switchId, session: summary, messages })
          } catch (e) {
            console.error('[runtime] failed to load history for switch:', e)
            this.ctx.reply(ws, msg.id, 'session.history', { sessionId: switchId, session: summary, messages: [] })
          }
        } else {
          try {
            await this.ctx.sessionService.ensureActive(switchId)
            const restored = this.ctx.sessionService.getSummary(switchId)
            if (!restored) {
              throw new Error(`Session ${switchId} restored but summary unavailable`)
            }
            const messages = await this.ctx.sessionService.getHistory(switchId)
            this.ctx.reply(ws, msg.id, 'session.history', { sessionId: switchId, session: restored, messages })
          } catch (e) {
            const errMsg = toErrorMessage(e)
            const isENOENT = isEnoent(e)
            const userMsg = isENOENT
              ? `Session file missing — the session was not saved properly. Error: ${errMsg}`
              : `Session ${switchId} not found or restore failed`
            console.error('[runtime] session.switch auto-restore failed:', errMsg)
            this.ctx.sendError(ws, isENOENT ? 'file_not_found' : 'not_found', userMsg, msg.id, switchId)
          }
        }
        return
      }
      case 'session.history': {
        const messages = await this.ctx.sessionService.getHistory(msg.payload.sessionId)
        return this.ctx.reply(ws, msg.id, 'session.history', { sessionId: msg.payload.sessionId, messages })
      }
      case 'session.rename': {
        await this.ctx.sessionService.renameSession(msg.payload.sessionId, msg.payload.name)
        this.ctx.reply(ws, msg.id, 'session.renamed', { sessionId: msg.payload.sessionId, name: msg.payload.name })
        return this.ctx.broadcastSessionList()
      }
      case 'message.send': {
        const { sessionId, content, subagent } = msg.payload
        if (subagent) {
          await this.ctx.sessionService.sendSubagentMessage(sessionId, subagent.agent, subagent.task, content)
        } else {
          await this.ctx.sessionService.sendMessage(sessionId, content)
        }
        return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'sent' })
      }
      case 'message.steer': {
        const steerSid = msg.payload.sessionId
        try {
          await this.ctx.sessionService.steerMessage(steerSid, msg.payload.content)
          return this.ctx.reply(ws, msg.id, 'message.status', { sessionId: steerSid, status: 'steered' })
        } catch (e) {
          const errMsg = toErrorMessage(e)
          console.error('[runtime] message.steer failed:', errMsg)
          return this.ctx.reply(ws, msg.id, 'message.error', { sessionId: steerSid, message: errMsg })
        }
      }
      case 'message.follow_up': {
        const followSid = msg.payload.sessionId
        try {
          await this.ctx.sessionService.followUpMessage(followSid, msg.payload.content)
          return this.ctx.reply(ws, msg.id, 'message.status', { sessionId: followSid, status: 'queued' })
        } catch (e) {
          const errMsg = toErrorMessage(e)
          console.error('[runtime] message.follow_up failed:', errMsg)
          return this.ctx.reply(ws, msg.id, 'message.error', { sessionId: followSid, message: errMsg })
        }
      }
      case 'message.abort':
        return await this.ctx.sessionService.abort(msg.payload.sessionId)
    }
  }

  async handleSessionCompact(msg: Extract<ClientMessage, { type: 'session.compact' }>, ws: WsType): Promise<void> {
    const compactId = msg.payload.sessionId
    const startTime = Date.now()
    console.log('[server] session.compact: sessionId=' + compactId)
    try {
      await this.ctx.sessionService.ensureActive(compactId)
      console.log('[server] session.compact: session ensured active, sessionId=' + compactId)
      try {
        await this.ctx.sessionService.compact(compactId)
      // eslint-disable-next-line taste/no-silent-catch -- compact: error logged + caller informed via broadcast
      } catch (e) {
        console.error('[server] session.compact: failed, sessionId=' + compactId + ', error=' + (toErrorMessage(e)))
      }
      console.log('[server] session.compact: completed, sessionId=' + compactId + ', elapsed=' + (Date.now() - startTime) + 'ms')
    } catch (e) {
      console.error('[server] session.compact: ensureActive failed, sessionId=' + compactId)
      this.ctx.sendError(ws, 'session.compact_failed', 'Failed to restore session for compact: ' + (toErrorMessage(e)), msg.id, compactId)
    }
  }
}
