/**
 * Session tree message handler for session.tree-* message types.
 * Extracted from SidecarServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import type { ISessionService } from './interfaces.js'
import type { TreeService } from './services/tree-service.js'

export interface TreeHandlerContext {
  sessionService: ISessionService
  treeService: TreeService
  send(ws: unknown, msg: ServerMessage): void
  broadcastSessionList(): void
}

export class TreeMessageHandler {
  constructor(private ctx: TreeHandlerContext) {}

  async handleTreeMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    const payload = msg.payload as { sessionId: string; targetEntryId?: string; entryId?: string }
    const sid = payload.sessionId
    switch (msg.type) {
      case 'session.tree-data': {
        try {
          const treeData = await this.ctx.treeService.getTree(sid)
          return this.ctx.send(ws, { type: 'session.tree-data', id: msg.id, payload: { ...treeData } })
        } catch (e) {
          if ((e instanceof Error && e.message.includes('not found')) || !this.ctx.sessionService.getSummary(sid)) {
            try {
              await this.ctx.sessionService.restoreSession(sid)
              const treeData = await this.ctx.treeService.getTree(sid)
              return this.ctx.send(ws, { type: 'session.tree-data', id: msg.id, payload: { ...treeData } })
            } catch (restoreErr) {
              console.error('[tree-data] auto-restore failed:', restoreErr)
              return this.ctx.send(ws, { type: 'session.tree-data', id: msg.id, payload: { sessionId: sid, tree: [], leafId: null, branchCount: 0, navigateCapable: false, error: 'Session not available' } })
            }
          }
          throw e
        }
      }
      case 'session.tree-navigate': {
        const targetEntryId = payload.targetEntryId as string
        try {
          const result = await this.ctx.treeService.navigateTree(sid, targetEntryId)
          return this.ctx.send(ws, { type: 'session.tree-navigate-result', id: msg.id, payload: { sessionId: sid, ...result } })
        } catch (e) {
          if (e instanceof Error && e.message.includes('not found')) {
            return this.ctx.send(ws, { type: 'session.tree-navigate-result', id: msg.id, payload: { sessionId: sid, success: false, error: 'Session not active' } })
          }
          throw e
        }
      }
      case 'session.tree-fork': {
        const entryId = payload.entryId as string
        try {
          const originalLabel = this.ctx.sessionService.getSummary(sid)?.label ?? 'session'
          const newLabel = originalLabel + '-fork'
          const result = await this.ctx.treeService.forkFromEntry(sid, entryId, '-fork')
          if (result.success && result.newSessionId) {
            await this.ctx.sessionService.rebindAfterFork(sid, result.newSessionId, newLabel, result.sessionFile)
            this.ctx.broadcastSessionList()
          }
          return this.ctx.send(ws, { type: 'session.tree-fork-result', id: msg.id, payload: { sessionId: sid, ...result } })
        } catch (e) {
          if (e instanceof Error && e.message.includes('not found')) {
            return this.ctx.send(ws, { type: 'session.tree-fork-result', id: msg.id, payload: { sessionId: sid, success: false, error: 'Session not active' } })
          }
          throw e
        }
      }
      case 'session.tree-capability': {
        try {
          return this.ctx.send(ws, { type: 'session.tree-capability', id: msg.id, payload: { sessionId: sid, navigateCapable: this.ctx.treeService.isNavigateCapable(sid) } })
        } catch (e) {
          if (e instanceof Error && e.message.includes('not found')) {
            return this.ctx.send(ws, { type: 'session.tree-capability', id: msg.id, payload: { sessionId: sid, navigateCapable: false } })
          }
          throw e
        }
      }
      case 'session.tree-clone': {
        try {
          const originalLabel = this.ctx.sessionService.getSummary(sid)?.label ?? 'session'
          const result = await this.ctx.treeService.cloneSession(sid, '-clone')
          if (result.success && result.newSessionId) {
            await this.ctx.sessionService.renameSession(result.newSessionId, originalLabel + '-clone')
            this.ctx.broadcastSessionList()
          }
          return this.ctx.send(ws, { type: 'session.tree-clone-result', id: msg.id, payload: { sessionId: sid, ...result } })
        } catch (e) {
          if (e instanceof Error && e.message.includes('not found')) {
            return this.ctx.send(ws, { type: 'session.tree-clone-result', id: msg.id, payload: { sessionId: sid, success: false, error: 'Session not active' } })
          }
          throw e
        }
      }
    }
  }
}
