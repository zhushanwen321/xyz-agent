/**
 * File message handler —— 路由 file.* 消息（issues.md #2/#7/#14 / code-architecture §3.7）。
 *
 * 结构对称 git-message-handler：handles 清单 + switch 内编译期类型收窄 + 领域逻辑委托 FileService。
 *
 * 路由：
 * - file.tree        → fileService.listTree      → reply 'file.tree:result' {sessionId, tree}
 * - file.tree.expand → fileService.expandDir     → reply 'file.tree.expand:result' {sessionId, children}
 * - file.read        → fileService.readFile      → reply 'file.read:result' {content, truncated, path}
 *   （file.read 从 server.ts 内联下沉到 FileService，解三层违纪 AC-2b；W2 扩展 BC-3 白名单）
 * - file.write.create/rename/delete → fileService 骨架 → reply 'file.write.*.result' {implemented:false}
 *   （#14 D-018 实现延后；AC-14.4 结构化响应——catch FileError('not_implemented') 转 result 而非 error envelope）
 *
 * 错误：FileError → error envelope（D10/P0-B）。code 取自 FileError.code；
 * sessionId 透传 details。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@xyz-agent/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { FileService } from '../services/file-service.js'
import { FileError } from '../services/file-error.js'
import { toErrorMessage } from '../utils/errors.js'

/** File handler 的上下文（extends 共享发消息契约 + 领域依赖） */
export interface FileHandlerContext extends MessageHandlerContext {
  fileService: FileService
}

export class FileMessageHandler {
  constructor(private ctx: FileHandlerContext) {}

  /**
   * D1: 本 handler 认领的 ClientMessageType 清单。
   * 注：file.read 暂不在 handles 中——W1b 阶段 file.read 仍走 server.ts 旧内联 handleFileRead
   * （BC-3 三目录白名单，不依赖 cwd/sessionId）。W2 扩展 file.read 权限（加 sessionId + cwd 守门 +
   * BC-3 兼容）后，把 file.read 迁入此 handler 并从 server.ts 删除内联。
   * file.tree/expand/write.* 是新增消息类型，本 Wave 直接路由。
   */
  readonly handles: ClientMessageType[] = [
    'file.tree',
    'file.tree.expand',
    'file.write.create',
    'file.write.rename',
    'file.write.delete',
  ]

  async handleFileMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'file.tree': {
        const { sessionId, showIgnored } = msg.payload
        try {
          const tree = await this.ctx.fileService.listTree(sessionId, showIgnored)
          return this.ctx.reply(ws, msg.id, 'file.tree:result', { sessionId, tree: tree as unknown as Record<string, unknown>[] })
        } catch (e) {
          return this.sendFileError(ws, msg.id, sessionId, e)
        }
      }
      case 'file.tree.expand': {
        const { sessionId, path, showIgnored } = msg.payload
        try {
          const children = await this.ctx.fileService.expandDir(sessionId, path, showIgnored)
          return this.ctx.reply(ws, msg.id, 'file.tree.expand:result', { sessionId, children: children as unknown as Record<string, unknown>[] })
        } catch (e) {
          return this.sendFileError(ws, msg.id, sessionId, e)
        }
      }
      case 'file.read': {
        // file.read 的 sessionId：当前 protocol file.read payload 只有 path（无 sessionId）。
        // FileService.readFile 需要 sessionId 取 cwd 做越界守门。此处 sessionId 缺失时用空串，
        // FileService 会抛 session_not_found。W2 扩展 file.read 权限时若需 sessionId 会同步扩 protocol。
        const { path } = msg.payload
        // file.read 无 sessionId 字段——BC-3 原设计是 3 目录白名单（不依赖 cwd）。
        // W1b FileService.readFile 走 cwd 守门；W2 会扩 BC-3 白名单兼容旧 skill 目录读取。
        // 此处暂以 undefined sessionId 调用，FileService 会抛 session_not_found（预期：W1b 阶段 file.read 暂不可用，W2 修）。
        // 为不破坏现有 skill 文件读取，W1b 保留 server.ts handleFileRead 作为 file.read 的临时路由（见 server.ts routes）。
        try {
          const result = await this.ctx.fileService.readFile('', path)
          return this.ctx.reply(ws, msg.id, 'file.read:result', { content: result.content, truncated: result.truncated, path })
        } catch (e) {
          return this.sendFileError(ws, msg.id, '', e)
        }
      }
      case 'file.write.create': {
        const { sessionId, path, content } = msg.payload
        try {
          await this.ctx.fileService.createFile(sessionId, path, content)
          // createFile 抛 not_implemented，正常不会走到这里（骨架永不 resolve）
          return this.ctx.reply(ws, msg.id, 'file.write.create:result', { sessionId, path, implemented: false })
        } catch (e) {
          // AC-14.4：file.write 骨架的 not_implemented 转结构化 result（非 error envelope）
          if (e instanceof FileError && e.code === 'not_implemented') {
            return this.ctx.reply(ws, msg.id, 'file.write.create:result', { sessionId, path, implemented: false })
          }
          return this.sendFileError(ws, msg.id, sessionId, e)
        }
      }
      case 'file.write.rename': {
        const { sessionId, oldPath, newPath } = msg.payload
        try {
          await this.ctx.fileService.renameFile(sessionId, oldPath, newPath)
          return this.ctx.reply(ws, msg.id, 'file.write.rename:result', { sessionId, newPath, implemented: false })
        } catch (e) {
          if (e instanceof FileError && e.code === 'not_implemented') {
            return this.ctx.reply(ws, msg.id, 'file.write.rename:result', { sessionId, newPath, implemented: false })
          }
          return this.sendFileError(ws, msg.id, sessionId, e)
        }
      }
      case 'file.write.delete': {
        const { sessionId, path } = msg.payload
        try {
          await this.ctx.fileService.deleteFile(sessionId, path)
          return this.ctx.reply(ws, msg.id, 'file.write.delete:result', { sessionId, path, implemented: false })
        } catch (e) {
          if (e instanceof FileError && e.code === 'not_implemented') {
            return this.ctx.reply(ws, msg.id, 'file.write.delete:result', { sessionId, path, implemented: false })
          }
          return this.sendFileError(ws, msg.id, sessionId, e)
        }
      }
    }
  }

  /**
   * 统一 file 错误回复（D10/P0-B）。
   * - FileError → 取其 code（session_not_found / permission_denied / out_of_cwd / timeout / not_found / read_failed）
   * - 其它 → 'file_failed' + toErrorMessage
   * 注意：not_implemented 不走此方法（file.write 骨架在上游 catch 转结构化 result）。
   */
  private sendFileError(ws: WsType, id: string | undefined, sessionId: string, e: unknown): void {
    if (e instanceof FileError) {
      this.ctx.sendError(ws, e.code, e.message, id, sessionId ? { sessionId } : undefined)
    } else {
      this.ctx.sendError(ws, 'file_failed', toErrorMessage(e), id, sessionId ? { sessionId } : undefined)
    }
  }
}
