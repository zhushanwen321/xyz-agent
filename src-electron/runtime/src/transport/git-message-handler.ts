/**
 * Git message handler —— 路由 git.* 消息（issues.md #1 / code-architecture §3.6/§4.1/§4.2）。
 *
 * 结构对称 extension-message-handler：handles 清单 + switch 内编译期类型收窄 + 领域逻辑。
 *
 * 路由：
 * - git.status  → gitService.getStatus → reply 'git.status:result'
 * - git.stage   → gitService.stage     → reply 'message.status' {status:'staged'}    （ack 复用 message.status）
 * - git.unstage → gitService.unstage   → reply 'message.status' {status:'unstaged'}
 * - git.commit  → gitService.commit    → reply 'message.status' {status:'committed'}
 *
 * 错误：GitError / GitExecutorError → error envelope（D10/P0-B）。code 取自 GitError.code
 * 或 GitExecutorError.code（'git_unavailable'/'timeout'）；sessionId 透传 details。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@xyz-agent/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { ISessionService } from '../interfaces.js'
import type { GitService } from '../services/git-service.js'
import { GitError } from '../services/git-service.js'
import { GitExecutorError } from '../infra/git-executor.js'
import { toErrorMessage } from '../utils/errors.js'

/** Interface for server methods needed by this handler */
export interface GitHandlerContext extends MessageHandlerContext {
  sessionService: ISessionService
  gitService: GitService
}

export class GitMessageHandler {
  constructor(private ctx: GitHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = ['git.status', 'git.stage', 'git.unstage', 'git.commit']

  async handleGitMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'git.status': {
        const { sessionId } = msg.payload
        try {
          const result = await this.ctx.gitService.getStatus(sessionId)
          return this.ctx.reply(ws, msg.id, 'git.status:result', result as unknown as Record<string, unknown>)
        } catch (e) {
          return this.sendGitError(ws, msg.id, sessionId, e)
        }
      }
      case 'git.stage': {
        const { sessionId, filePaths } = msg.payload
        try {
          await this.ctx.gitService.stage(sessionId, filePaths)
          return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'staged' })
        } catch (e) {
          return this.sendGitError(ws, msg.id, sessionId, e)
        }
      }
      case 'git.unstage': {
        const { sessionId, filePaths } = msg.payload
        try {
          await this.ctx.gitService.unstage(sessionId, filePaths)
          return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'unstaged' })
        } catch (e) {
          return this.sendGitError(ws, msg.id, sessionId, e)
        }
      }
      case 'git.commit': {
        const { sessionId, message } = msg.payload
        try {
          await this.ctx.gitService.commit(sessionId, message)
          return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'committed' })
        } catch (e) {
          return this.sendGitError(ws, msg.id, sessionId, e)
        }
      }
    }
  }

  /**
   * 统一 git 错误回复（D10/P0-B）。
   * - GitError → 取其 code（session_not_found / path_not_allowed / git_conflict / commit_message_required / *_failed）
   * - GitExecutorError → 'git_unavailable'（timeout 归并，前端统一降级）
   * - 其它 → 'git_failed' + toErrorMessage
   */
  private sendGitError(ws: WsType, id: string | undefined, sessionId: string, e: unknown): void {
    if (e instanceof GitError) {
      this.ctx.sendError(ws, e.code, e.message, id, { sessionId })
    } else if (e instanceof GitExecutorError) {
      this.ctx.sendError(ws, 'git_unavailable', e.message, id, { sessionId })
    } else {
      this.ctx.sendError(ws, 'git_failed', toErrorMessage(e), id, { sessionId })
    }
  }
}
