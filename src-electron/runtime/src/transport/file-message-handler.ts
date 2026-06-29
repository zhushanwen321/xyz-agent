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
   * file.read 已从 server.ts 内联迁入（W2，解三层违纪 AC-2b）：走 FileService.readFileFromWhitelist
   * （BC-3 三目录白名单：~/.agents/skills、piAgentDir/skills、piAgentDir/npm）。
   */
  readonly handles: ClientMessageType[] = [
    'file.tree',
    'file.tree.expand',
    'file.read',
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
        // file.read payload 只有 path（无 sessionId），走 BC-3 白名单守门（readFileFromWhitelist）。
        // W2 从 server.ts 内联迁入此 handler，白名单目录由装配时传入 FileService。
        const { path } = msg.payload
        try {
          const result = await this.ctx.fileService.readFileFromWhitelist(path)
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
