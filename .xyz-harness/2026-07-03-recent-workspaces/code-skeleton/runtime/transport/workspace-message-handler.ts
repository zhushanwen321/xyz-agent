/**
 * WorkspaceMessageHandler — RPC 契约入口（#3）。
 *
 * transport 零业务（§2/§3 铁律 + 现有 7 handler 按域隔离惯例）：
 * 只路由 + ctx.reply，业务在 WorkspaceService/RecentWorkspacesStore。
 *
 * handles = ['workspace.listRecent']，server.ts routes map spread 注册。
 *
 * reply 路径（D-004）：ctx.reply 带 msg.id（correlation id）→ routeInbound pending.resolve。
 * reply payload 数据全局（非 session 级），走 pending map 不走 events.ts 订阅通道。
 */
import type { ClientMessage, MessageHandlerContext } from '../../_deps.js'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'

/** Handler context：MessageHandlerContext 共享 send/reply/sendError + workspaceService 依赖。 */
export interface WorkspaceHandlerContext extends MessageHandlerContext {
  workspaceService: WorkspaceService
}

export class WorkspaceMessageHandler {
  /** 本 handler 认领的 ClientMessageType 清单（D-003 方案 A：独立 handler 按域隔离）。 */
  readonly handles = ['workspace.listRecent'] as const

  constructor(private readonly ctx: WorkspaceHandlerContext) {}

  async handleWorkspaceMessage(msg: ClientMessage, ws: unknown): Promise<void> {
    switch (msg.type) {
      case 'workspace.listRecent': {
        // 零业务：读 service（读 store 内存）→ ctx.reply 带 msg.id。
        // INV-4 降级：service.list 返空数组（无记录/文件损坏）→ reply 空数组（AC-3.4）。
        const records = this.ctx.workspaceService.list()
        this.ctx.reply(ws, msg.id, 'workspace.recentList', { records })
        return
      }
    }
  }
}
