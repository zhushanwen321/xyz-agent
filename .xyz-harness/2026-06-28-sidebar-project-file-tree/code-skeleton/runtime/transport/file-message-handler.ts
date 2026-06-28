/**
 * code-skeleton/runtime/transport/file-message-handler.ts — file.* 路由（⑤code-arch §3，#2/#7/#14）
 *
 * 🔒 三层架构：transport 层路由，委托 FileService（不碰 node:fs，AC-2b）。
 * handleFileRead ►迁自 server.ts:472（解内联 fs 三层违纪，K-3 server.ts delete）。
 *
 * 数据流（§4 功能1/3）：WS file.tree/expand/read/write.* → FileService → result envelope。
 *
 * 接线层级：[L1-接线] 路由 + 委托 FileService。
 */
import type { FileService } from '../services/file-service'

/** WS 消息抽象（骨架验证用，⑥Wave 接真实 ClientMessage）。 */
export interface WsMessage {
  type: string
  id?: string
  payload: Record<string, unknown>
}

/** FileMessageHandler —— file.* 路由。返回 true=认领。 */
export class FileMessageHandler {
  constructor(private fileService: FileService) {}

  async handle(msg: WsMessage): Promise<boolean> {
    switch (msg.type) {
      case 'file.tree':
        await this.handleTree(msg) // L1-接线
        return true
      case 'file.tree.expand':
        await this.handleExpand(msg) // L1-接线
        return true
      case 'file.read':
        await this.handleFileRead(msg) // L1-接线：►迁自 server.ts:472
        return true
      case 'file.write.create':
      case 'file.write.rename':
      case 'file.write.delete':
        await this.handleWrite(msg) // L1-接线：#14 骨架
        return true
      default:
        return false
    }
  }

  private async handleTree(msg: WsMessage): Promise<void> {
    const { sessionId, showIgnored } = msg.payload as { sessionId: string; showIgnored?: boolean }
    await this.fileService.listTree(sessionId, showIgnored) // L1-接线：委托 FileService
  }

  private async handleExpand(msg: WsMessage): Promise<void> {
    const { sessionId, path, showIgnored } = msg.payload as { sessionId: string; path: string; showIgnored?: boolean }
    await this.fileService.expandDir(sessionId, path, showIgnored) // L1-接线
  }

  /** file.read（►迁自 server.ts:472，解内联 fs 三层违纪）。 */
  private async handleFileRead(msg: WsMessage): Promise<void> {
    const { path } = msg.payload as { path: string }
    // sessionId 从消息上下文取（骨架简化，⑥Wave 接真实 sessionId 提取）
    const sessionId = (msg.payload as { sessionId?: string }).sessionId ?? ''
    await this.fileService.readFile(sessionId, path) // L1-接线：委托 FileService.readFile
  }

  /** file.write.* 骨架（#14，G4 延后）。 */
  private async handleWrite(msg: WsMessage): Promise<void> {
    const { sessionId } = msg.payload as { sessionId: string }
    if (msg.type === 'file.write.create') {
      const { path, content } = msg.payload as { path: string; content?: string }
      await this.fileService.createFile(sessionId, path, content) // L1-接线：抛 NotImplementedError（AC-14.4）
    } else if (msg.type === 'file.write.rename') {
      const { from, to } = msg.payload as { from: string; to: string }
      await this.fileService.renameFile(sessionId, from, to) // L1-接线
    } else {
      const { path } = msg.payload as { path: string }
      await this.fileService.deleteFile(sessionId, path) // L1-接线
    }
  }
}
