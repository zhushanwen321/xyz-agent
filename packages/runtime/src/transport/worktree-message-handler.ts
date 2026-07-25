/**
 * Worktree message handler —— 路由 worktree.* / workspace.detect* 消息（W2 升级）。
 *
 * 结构对称 git-message-handler：handles 清单 + switch + 领域逻辑。
 *
 * 路由：
 * - worktree.create → worktreeService.create → reply 'worktree.created' { cwd, branch }
 * - worktree.listBranches → worktreeService.listBranches → reply 'worktree.branches' { local, remote, defaultBranch }
 * - worktree.list → worktreeService.list → reply 'worktree.list:result' { items }
 * - workspace.detect → worktreeService.detect → reply 'workspace.detected' { mode, wsRoot, barePath, repoRoot, defaultBranch }
 * - workspace.detectBare → 向后兼容别名，等价于 workspace.detect
 *
 * 错误：WorktreeService 用 `Object.assign(new Error(...), { code, detail })` 扁平错误模式
 * （非 class，详见 ports/worktree-service.ts 注释）。本 handler 从 error.code 提取业务错误码
 * 透传给前端（NOT_BARE_REPO / NOT_GIT_REPO / WORKTREE_EXISTS / SETUP_FAILED / GIT_FAILED / INVALID_BRANCH）；
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
  readonly handles: ClientMessageType[] = [
    'worktree.create',
    'worktree.listBranches',
    'worktree.list',
    'workspace.detect',
    'workspace.detectBare',
  ]

  async handleWorktreeMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'worktree.create': {
        const { branch, baseBranch, workspaceHint, locationMode } = msg.payload
        if (typeof branch !== 'string' || !branch) {
          return this.ctx.sendError(ws, 'worktree_failed', 'branch is required and must be a string', msg.id)
        }
        try {
          const result = await this.ctx.worktreeService.create({ branch, baseBranch, locationMode, workspaceHint })
          return this.ctx.reply(ws, msg.id, 'worktree.created', result)
        } catch (e) {
          return this.sendWorktreeError(ws, msg.id, e)
        }
      }

      case 'worktree.listBranches': {
        const { cwd } = msg.payload
        try {
          const result = await this.ctx.worktreeService.listBranches(cwd)
          return this.ctx.reply(ws, msg.id, 'worktree.branches', result)
        } catch (e) {
          return this.sendWorktreeError(ws, msg.id, e)
        }
      }

      case 'worktree.list': {
        const { cwd } = msg.payload
        try {
          const result = await this.ctx.worktreeService.list(cwd)
          return this.ctx.reply(ws, msg.id, 'worktree.list:result', result)
        } catch (e) {
          return this.sendWorktreeError(ws, msg.id, e)
        }
      }

      case 'workspace.detect':
      case 'workspace.detectBare': {
        // workspace.detectBare 是 workspace.detect 的向后兼容别名
        const { cwd } = msg.payload
        try {
          const result = await this.ctx.worktreeService.detect(cwd)
          return this.ctx.reply(ws, msg.id, 'workspace.detected', result)
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
   * - 有 code（NOT_BARE_REPO / NOT_GIT_REPO / WORKTREE_EXISTS / SETUP_FAILED / GIT_FAILED）→ 透传作 error.code
   * - 无 code → 归为 'worktree_failed'
   *
   * detail 透传到 details 字段（前端按 code 分流：WORKTREE_EXISTS 走 exists 态，其余走 error 态）。
   */
  private sendWorktreeError(ws: WsType, id: string | undefined, e: unknown): void {
    const err = e as CodedError & Error
    const code: WorktreeEnvelopeCode = (err && typeof err.code === 'string')
      ? (err.code as WorktreeEnvelopeCode)
      : 'worktree_failed'
    const message = (err && err.message) ? err.message : 'worktree 操作失败'
    const details = (err && err.detail !== undefined) ? { detail: err.detail } : undefined
    this.ctx.sendError(ws, code, message, id, details)
  }
}
