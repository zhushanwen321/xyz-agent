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
 * - git.checkout → gitService.checkout → reply 'message.status' {status:'switched'}  （#6 选分支 popover）
 * - git.createBranch → gitService.createBranch → reply 'message.status' {status:'branch_created'} （#7 创建分支 modal）
 *
 * 错误：GitError → error envelope（D10/P0-B）。code 取自 GitError.code；
 * sessionId 透传 details。GitExecutorError 已在 GitService.execSafe 中转为 GitError。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@xyz-agent/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { ISessionService, IGitService } from '../interfaces.js'
import { GitError } from '../services/git-service.js'
import { sendHandlerError } from './handler-utils.js'

/** Interface for server methods needed by this handler */
export interface GitHandlerContext extends MessageHandlerContext {
  sessionService: ISessionService
  gitService: IGitService
  /**
   * 广播 changeSet 失效通知（ADR-0024 D5 重构）。commit 成功后工作区 diff 已重置，
   * 旧的 changeSet 卡片成为过期数据。server 注入此方法向所有订阅该 session 的前端广播。
   */
  broadcastChangeSetInvalidated: (sessionId: string, reason: 'committed') => void
}

export class GitMessageHandler {
  constructor(private ctx: GitHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = ['git.status', 'git.diff', 'git.stage', 'git.unstage', 'git.commit', 'git.checkout', 'git.createBranch']

  async handleGitMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'git.status': {
        const { sessionId } = msg.payload
        try {
          const result = await this.ctx.gitService.getStatus(sessionId)
          return this.ctx.reply(ws, msg.id, 'git.status:result', result)
        } catch (e) {
          return this.sendGitError(ws, msg.id, sessionId, e)
        }
      }
      case 'git.diff': {
        const { sessionId, path } = msg.payload
        try {
          const result = await this.ctx.gitService.getFileDiff(sessionId, path)
          return this.ctx.reply(ws, msg.id, 'git.diff:result', { sessionId, patch: result.patch, binary: result.binary })
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
          // commit 成功后工作区 diff 已重置，通知前端旧 changeSet 失效（ADR-0024 D5 重构）。
          // 必须在 reply 之前广播——前端收到 status:'committed' 后可能立即刷新 git zone，
          // changeSetInvalidated 先到可避免卡片短暂停留在 ready 态。
          this.ctx.broadcastChangeSetInvalidated(sessionId, 'committed')
          return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'committed' })
        } catch (e) {
          return this.sendGitError(ws, msg.id, sessionId, e)
        }
      }
      case 'git.checkout': {
        const { sessionId, name } = msg.payload
        try {
          await this.ctx.gitService.checkout(sessionId, name)
          return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'switched' })
        } catch (e) {
          return this.sendGitError(ws, msg.id, sessionId, e)
        }
      }
      case 'git.createBranch': {
        const { sessionId, name } = msg.payload
        try {
          await this.ctx.gitService.createBranch(sessionId, name)
          return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'branch_created' })
        } catch (e) {
          return this.sendGitError(ws, msg.id, sessionId, e)
        }
      }
    }
  }

  /**
   * 统一 git 错误回复（D10/P0-B）。
   * - GitError → 取其 code（session_not_found / path_not_allowed / git_conflict / commit_message_required / *_failed / invalid_branch_name / git_unavailable / git_failed）
   * - 其它 → 'git_failed' + toErrorMessage
   * sessionId 透传 details（matched 与 fallback 两分支都带）。
   */
  private sendGitError(ws: WsType, id: string | undefined, sessionId: string, e: unknown): void {
    sendHandlerError(this.ctx, ws, GitError, 'git_failed', e, id, { sessionId })
  }
}
