/**
 * Worktree message handler —— 路由 worktree.* 消息（W1）。
 *
 * 结构对称 git-message-handler：handles 清单 + switch + 领域逻辑。
 *
 * 路由：
 * - worktree.create → worktreeService.create → reply 'worktree.created' { cwd, branch }
 *
 * 错误：WorktreeService 用 `Object.assign(new Error(...), { code, detail })` 扁平错误模式
 * （非 class，详见 ports/worktree-service.ts 注释）。本 handler 从 error.code 提取业务错误码
 * 透传给前端（NOT_BARE_REPO / WORKTREE_EXISTS / SETUP_FAILED / GIT_FAILED / INVALID_BRANCH）；
 * 无 code 的未知错误归为 'worktree_failed'。
 *
 * 错误码联合类型见 shared WorktreeEnvelopeCode（runtime ↔ renderer 契约 SSOT）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType, WorktreeEnvelopeCode } from '@xyz-agent/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { IWorktreeService } from '../services/ports/worktree-service.js'

/** Worktree handler 依赖的 context（messaging + worktreeService）。 */
export interface WorktreeHandlerContext extends MessageHandlerContext {
  worktreeService: IWorktreeService
}

/** 具有 code 字段的业务错误形状（WorktreeService 抛出的扁平错误）。 */
interface CodedError {
  code?: string
  detail?: unknown
  message: string
}

export class WorktreeMessageHandler {
  constructor(private ctx: WorktreeHandlerContext) {}

  /** 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = ['worktree.create']

  async handleWorktreeMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'worktree.create': {
        const { branch, baseBranch, workspaceHint } = msg.payload
        try {
          const result = await this.ctx.worktreeService.create({ branch, baseBranch, workspaceHint })
          return this.ctx.reply(ws, msg.id, 'worktree.created', result)
        } catch (e) {
          return this.sendWorktreeError(ws, msg.id, e)
        }
      }
    }
  }

  /**
   * 统一 worktree 错误回复。
   *
   * WorktreeService 的错误是 `Object.assign(new Error(msg), { code, detail })` 扁平模式，
   * 没有 class 可供 sendHandlerError 的 instanceof 匹配。这里手动提取 code：
   * - 有 code（NOT_BARE_REPO / WORKTREE_EXISTS / SETUP_FAILED / GIT_FAILED）→ 透传作 error.code
   * - 无 code → 归为 'worktree_failed'
   *
   * detail 透传到 details 字段（前端按 code 分流：WORKTREE_EXISTS 走 exists 态，其余走 error 态）。
   */
  private sendWorktreeError(ws: WsType, id: string | undefined, e: unknown): void {
    const err = e as CodedError & Error
    const code: WorktreeEnvelopeCode = (err && typeof err.code === 'string')
      ? (err.code as WorktreeEnvelopeCode)
      : 'worktree_failed'
    const message = (err && err.message) ? err.message : 'worktree 创建失败'
    const details = (err && err.detail !== undefined) ? { detail: err.detail } : undefined
    this.ctx.sendError(ws, code, message, id, details)
  }
}
