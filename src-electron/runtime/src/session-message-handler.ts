/**
 * Session message handler for session.* and message.* message types.
 * Extracted from SidecarServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import type { ISessionService } from './interfaces.js'

/** Interface for server methods needed by this handler */
export interface SessionHandlerContext {
  sessionService: ISessionService
  nextPushId(): string
  send(ws: unknown, msg: ServerMessage): void
  sendError(ws: unknown, code: string, message: string, id?: string, sessionId?: string): void
  broadcastSessionList(): void
  clearExtensionTimeoutsForSession(sessionId: string): void
}

export class SessionMessageHandler {
  constructor(private ctx: SessionHandlerContext) {}

  async handleSessionMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'session.create': {
        const session = await this.ctx.sessionService.create(msg.payload.cwd, msg.payload.label)
        this.ctx.send(ws, { type: 'session.created', id: msg.id, payload: { session } })
        return this.ctx.broadcastSessionList()
      }
      case 'session.delete': {
        const delSid = msg.payload.sessionId
        this.ctx.clearExtensionTimeoutsForSession(delSid)
        await this.ctx.sessionService.delete(delSid)
        this.ctx.send(ws, { type: 'session.deleted', id: msg.id, payload: { sessionId: delSid } })
        return this.ctx.broadcastSessionList()
      }
      case 'session.list':
        return this.ctx.send(ws, { type: 'session.list', id: msg.id, payload: { groups: this.ctx.sessionService.listPersistedSessions() } })
      case 'session.switch': {
        const switchId = msg.payload.sessionId
        const summary = this.ctx.sessionService.getSummary(switchId)
        if (summary) {
          try {
            const messages = await this.ctx.sessionService.getHistory(switchId)
            this.ctx.send(ws, { type: 'session.history', id: msg.id, payload: { sessionId: switchId, session: summary, messages } })
          } catch (e) {
            console.error('[runtime] failed to load history for switch:', e)
            this.ctx.send(ws, { type: 'session.history', id: msg.id, payload: { sessionId: switchId, session: summary, messages: [] } })
          }
        } else {
          try {
            const restored = await this.ctx.sessionService.restoreSession(switchId)
            const messages = await this.ctx.sessionService.getHistory(switchId)
            this.ctx.send(ws, { type: 'session.history', id: msg.id, payload: { sessionId: switchId, session: restored, messages } })
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e)
            const isENOENT = errMsg.includes('ENOENT')
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
        return this.ctx.send(ws, { type: 'session.history', id: msg.id, payload: { sessionId: msg.payload.sessionId, messages } })
      }
      case 'session.clear': {
        await this.ctx.sessionService.clear(msg.payload.sessionId)
        return this.ctx.send(ws, { type: 'session.deleted', id: msg.id, payload: { sessionId: msg.payload.sessionId } })
      }
      case 'session.restore': {
        const session = await this.ctx.sessionService.restoreSession(msg.payload.sessionId)
        this.ctx.send(ws, { type: 'session.restored', id: msg.id, payload: { session } })
        return this.ctx.broadcastSessionList()
      }
      case 'session.rename': {
        await this.ctx.sessionService.renameSession(msg.payload.sessionId, msg.payload.name)
        this.ctx.send(ws, { type: 'session.renamed', id: msg.id, payload: { sessionId: msg.payload.sessionId, name: msg.payload.name } })
        return this.ctx.broadcastSessionList()
      }
      case 'message.send': {
        const { sessionId, content, subagent } = msg.payload
        if (subagent) {
          await this.ctx.sessionService.sendSubagentMessage(sessionId, subagent.agent, subagent.task, content)
        } else {
          await this.ctx.sessionService.sendMessage(sessionId, content)
        }
        return this.ctx.send(ws, { type: 'message.status', id: msg.id, payload: { sessionId, status: 'sent' } })
      }
      case 'message.steer': {
        const steerSid = msg.payload.sessionId
        try {
          await this.ctx.sessionService.steerMessage(steerSid, msg.payload.content)
          return this.ctx.send(ws, { type: 'message.status', id: msg.id, payload: { sessionId: steerSid, status: 'steered' } })
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          console.error('[runtime] message.steer failed:', errMsg)
          return this.ctx.send(ws, { type: 'message.error', id: msg.id, payload: { sessionId: steerSid, message: errMsg } })
        }
      }
      case 'message.follow_up': {
        const followSid = msg.payload.sessionId
        try {
          await this.ctx.sessionService.followUpMessage(followSid, msg.payload.content)
          return this.ctx.send(ws, { type: 'message.status', id: msg.id, payload: { sessionId: followSid, status: 'queued' } })
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          console.error('[runtime] message.follow_up failed:', errMsg)
          return this.ctx.send(ws, { type: 'message.error', id: msg.id, payload: { sessionId: followSid, message: errMsg } })
        }
      }
      case 'message.abort':
        return await this.ctx.sessionService.abort(msg.payload.sessionId)
    }
  }

  handleSessionCompact(msg: Extract<ClientMessage, { type: 'session.compact' }>, ws: WsType): void {
    const compactId = msg.payload.sessionId
    const startTime = Date.now()
    console.log('[server] session.compact: sessionId=' + compactId)
    const runCompact = async () => {
      // eslint-disable-next-line taste/no-silent-catch -- compact: error already logged, caller informed via broadcast
      try { await this.ctx.sessionService.compact(compactId) } catch (e) {
        console.error('[server] session.compact: failed, sessionId=' + compactId + ', error=' + (e instanceof Error ? e.message : String(e)))
      }
      console.log('[server] session.compact: completed, sessionId=' + compactId + ', elapsed=' + (Date.now() - startTime) + 'ms')
    }
    if (!this.ctx.sessionService.hasActiveSession(compactId)) {
      this.ctx.sessionService.restoreSession(compactId).then(() => {
        console.log('[server] session.compact: auto-restored, sessionId=' + compactId)
        runCompact()
      }).catch((e) => {
        console.error('[server] session.compact: auto-restore failed, sessionId=' + compactId)
        this.ctx.sendError(ws, 'session.compact_failed', 'Failed to restore session for compact: ' + (e instanceof Error ? e.message : String(e)), msg.id, compactId)
      })
    } else { runCompact() }
  }
}
