/**
 * Session tree message handler for session.tree-* message types.
 * Extracted from RuntimeServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@xyz-agent/shared'
import type { ISessionService } from '../interfaces.js'
import type { TreeService } from '../services/tree-service.js'
import type { MessageHandlerContext } from './message-context.js'

/** D9: TreeHandlerContext 现在正确 extends MessageHandlerContext（此前自声明 send、未继承基接口）。 */
export interface TreeHandlerContext extends MessageHandlerContext {
  sessionService: ISessionService
  treeService: TreeService
  broadcastSessionList(): void
}

export class TreeMessageHandler {
  constructor(private ctx: TreeHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = [
    'session.tree-data', 'session.tree-navigate', 'session.tree-fork', 'session.tree-capability', 'session.tree-clone',
  ]

  async handleTreeMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    const payload = msg.payload as { sessionId?: string; targetEntryId?: string; entryId?: string }
    const sid = payload.sessionId
    // Fail-fast on missing sessionId — surface a structured error to the client
    // rather than letting downstream code throw a TypeError on undefined.
    if (!sid) {
      // Return error matching the request message type
      const errorType = msg.type === 'session.tree-data' ? 'session.tree-data'
        : msg.type === 'session.tree-navigate' ? 'session.tree-navigate-result'
          : msg.type === 'session.tree-fork' ? 'session.tree-fork-result'
            : msg.type === 'session.tree-clone' ? 'session.tree-clone-result'
              : 'session.tree-capability'
      return this.ctx.reply(ws, msg.id, errorType, { success: false, error: 'sessionId required' })
    }
    switch (msg.type) {
      case 'session.tree-data': {
        try {
          const treeData = await this.ctx.treeService.getTree(sid)
          return this.ctx.reply(ws, msg.id, 'session.tree-data', { ...treeData })
        } catch (e) {
          if ((e instanceof Error && e.message.includes('not found')) || !this.ctx.sessionService.getSummary(sid)) {
            try {
              await this.ctx.sessionService.restoreSession(sid)
              const treeData = await this.ctx.treeService.getTree(sid)
              return this.ctx.reply(ws, msg.id, 'session.tree-data', { ...treeData })
            } catch (restoreErr) {
              console.error('[tree-data] auto-restore failed:', restoreErr)
              return this.ctx.reply(ws, msg.id, 'session.tree-data', { sessionId: sid, tree: [], leafId: null, branchCount: 0, navigateCapable: false, error: 'Session not available' })
            }
          }
          throw e
        }
      }
      case 'session.tree-navigate': {
        const targetEntryId = payload.targetEntryId
        if (!targetEntryId) {
          return this.ctx.reply(ws, msg.id, 'session.tree-navigate-result', { sessionId: sid, success: false, error: 'targetEntryId required' })
        }
        try {
          const result = await this.ctx.treeService.navigateTree(sid, targetEntryId)
          return this.ctx.reply(ws, msg.id, 'session.tree-navigate-result', { sessionId: sid, ...result })
        } catch (e) {
          if (e instanceof Error && e.message.includes('not found')) {
            return this.ctx.reply(ws, msg.id, 'session.tree-navigate-result', { sessionId: sid, success: false, error: 'Session not active' })
          }
          throw e
        }
      }
      case 'session.tree-fork': {
        const entryId = payload.entryId
        if (!entryId) {
          return this.ctx.reply(ws, msg.id, 'session.tree-fork-result', { sessionId: sid, success: false, error: 'entryId required' })
        }
        try {
          const originalLabel = this.ctx.sessionService.getSummary(sid)?.label ?? 'session'
          const newLabel = originalLabel + '-fork'
          const result = await this.ctx.treeService.forkFromEntry(sid, entryId)
          if (result.success && result.newSessionId) {
            await this.ctx.sessionService.rebindAfterFork(sid, result.newSessionId, newLabel, result.sessionFile)
            this.ctx.broadcastSessionList()
          }
          return this.ctx.reply(ws, msg.id, 'session.tree-fork-result', { sessionId: sid, ...result })
        } catch (e) {
          if (e instanceof Error && e.message.includes('not found')) {
            return this.ctx.reply(ws, msg.id, 'session.tree-fork-result', { sessionId: sid, success: false, error: 'Session not active' })
          }
          throw e
        }
      }
      case 'session.tree-capability': {
        try {
          return this.ctx.reply(ws, msg.id, 'session.tree-capability', { sessionId: sid, navigateCapable: this.ctx.treeService.isNavigateCapable(sid) })
        } catch (e) {
          if (e instanceof Error && e.message.includes('not found')) {
            return this.ctx.reply(ws, msg.id, 'session.tree-capability', { sessionId: sid, navigateCapable: false })
          }
          throw e
        }
      }
      case 'session.tree-clone': {
        try {
          const originalLabel = this.ctx.sessionService.getSummary(sid)?.label ?? 'session'
          const newLabel = originalLabel + '-clone'
          const result = await this.ctx.treeService.cloneSession(sid)
          if (result.success && result.newSessionId) {
            await this.ctx.sessionService.rebindAfterFork(sid, result.newSessionId, newLabel, result.sessionFile)
            this.ctx.broadcastSessionList()
          }
          return this.ctx.reply(ws, msg.id, 'session.tree-clone-result', { sessionId: sid, ...result })
        } catch (e) {
          if (e instanceof Error && e.message.includes('not found')) {
            return this.ctx.reply(ws, msg.id, 'session.tree-clone-result', { sessionId: sid, success: false, error: 'Session not active' })
          }
          throw e
        }
      }
    }
  }
}
