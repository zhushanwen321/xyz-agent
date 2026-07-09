/**
 * Workspace message handler for workspace.* message types.
 *
 * 结构对称 session-message-handler：handles 清单 + switch 内编译期类型收窄。
 * transport handler 零业务（只 ctx.reply），业务逻辑在 WorkspaceService。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@xyz-agent/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'

/** Workspace handler 的上下文（extends 共享发消息契约 + 领域依赖） */
export interface WorkspaceHandlerContext extends MessageHandlerContext {
  workspaceService: WorkspaceService
}

export class WorkspaceMessageHandler {
  constructor(private ctx: WorkspaceHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = ['workspace.listRecent', 'workspace.record']

  async handleWorkspaceMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'workspace.listRecent':
        return this.ctx.reply(ws, msg.id, 'workspace.recentList', {
          records: this.ctx.workspaceService.list(),
        })
      case 'workspace.record': {
        // 选目录后热更新：record 写入最新工作区，随即返回刷新后的列表，
        // 前端据 reply 直接更新 store（一次往返完成写入+刷新，无 reload 时序竞争）。
        const { cwd } = msg.payload
        this.ctx.workspaceService.record(cwd)
        return this.ctx.reply(ws, msg.id, 'workspace.recentList', {
          records: this.ctx.workspaceService.list(),
        })
      }
    }
  }
}
