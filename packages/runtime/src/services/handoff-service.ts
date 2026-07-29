/**
 * HandoffService —— fast-handoff 功能的 runtime 编排层。
 *
 * 职责：用户在源 session 点 handoff → runtime 直接从对话历史组装 handoff 文档 →
 * 新建空白 session → 注入文档首条 → 广播跳转。
 *
 * 镜像 fork 的 runtime 链路（session-lifecycle.ts forkSession），但 handoff 是
 * "打包交接到新线程"而非"从某点分叉"——不继承历史，只注入 handoff 文档。
 *
 * 完成判定：runHandoff 是同步编排，无需等待 pi turn 结束。文档直接从
 * sessionService.getHistory 获取，由 assembleHandoffDoc 组装。
 *
 * 失败经 message.error 通道广播到源 session 对话流。
 */
import type { IMessageBroker } from '../interfaces.js'
import type { SessionService } from './session/session-service.js'
import type { Message } from '@xyz-agent/shared'
import { normalizeContent } from '@xyz-agent/shared'

interface HandoffServiceOpts {
  sessionService: SessionService
  broker: IMessageBroker
  /**
   * 广播 session 列表（与 session-message-handler 的 create/fork/delete/rename 一致）。
   *
   * BLOCKER 2：runHandoff 创建新 session 后只广播 session.handoffComplete，若 WS 在该
   * 完成窗口断开重连，session.handoffComplete 推送丢失 → 侧栏永远收不到新 session。
   * broadcastSessionList 是标准恢复机制（renderer 重连时 sendInitialState 也用它）。
   */
  broadcastSessionList: () => void
  /**
   * push id 生成器（与 broker 其他广播点一致，避免 Date.now() 碰撞）。
   */
  nextPushId: () => string
}

/** reply 截断阈值（来自客户端 payload，trust boundary 外）。 */
export const REPLY_MAX_LENGTH = 5000
/** 组装文档时保留的最大消息条数。 */
export const MAX_MESSAGES = 20
/** 单条消息内容截断阈值。 */
export const MSG_TRUNCATE_LENGTH = 2000

export class HandoffService {
  /** per-session 进行中状态。同一 session 不可并发 handoff。 */
  private readonly inflight = new Set<string>()
  private readonly opts: HandoffServiceOpts

  constructor(opts: HandoffServiceOpts) {
    this.opts = opts
  }

  /**
   * 触发 handoff：runtime 直接从对话历史组装文档，新建 session，注入文档，广播完成。
   *
   * @param srcSessionId 源 session id
   * @param reply 可选的用户回复/备注（截断后附在文档末尾）
   * @throws 已有进行中 handoff / 历史为空 / session 信息不可用
   */
  async runHandoff(srcSessionId: string, reply?: string): Promise<void> {
    // 并发守卫：同一 session 不可并发 handoff
    if (this.inflight.has(srcSessionId)) {
      throw new Error(`handoff already in progress for session ${srcSessionId}`)
    }
    this.inflight.add(srcSessionId)

    try {
      // 1. 获取对话历史（兼容离线 session，走文件尾读）
      const { messages } = await this.opts.sessionService.getHistory(srcSessionId)
      if (!messages || messages.length === 0) {
        throw new Error('handoff: no history to handoff')
      }

      // 2. 取源 session 信息
      const srcSession = this.opts.sessionService.getSession(srcSessionId)
      if (!srcSession) {
        throw new Error('handoff: source session not found')
      }
      const srcLabel = srcSession.label || srcSessionId

      // 3. 组装 handoff 文档
      const doc = this.assembleHandoffDoc(messages, srcLabel)

      // 4. 新建空白 session（复用源 cwd）
      const newSession = await this.opts.sessionService.create(srcSession.cwd, `handoff from ${srcLabel}`)
      const newId = newSession.id

      // 5. 标记源 session 已交接
      this.opts.sessionService.markHandedOff(srcSessionId, newId)

      // 6. 广播（先 sessionList 再 handoffComplete，保证重连恢复）
      this.opts.broadcastSessionList()
      this.opts.broker.broadcast({
        type: 'session.handoffComplete',
        id: this.opts.nextPushId(),
        payload: {
          sessionId: srcSessionId,
          srcSessionId,
          newSessionId: newId,
          doc,
          reply: reply ? sanitizeReply(reply) : undefined,
          sourceLabel: srcLabel,
        },
      })
    } finally {
      this.inflight.delete(srcSessionId)
    }
  }

  /**
   * 从对话历史组装 handoff 文档。
   * 取最近 N 条消息，格式化为可读文本，包含 role 标签和内容截断。
   */
  private assembleHandoffDoc(messages: Message[], sourceLabel: string): string {
    const recent = messages.slice(-MAX_MESSAGES)
    const lines: string[] = []

    lines.push(`# Handoff from ${sourceLabel}`)
    lines.push('')
    lines.push(`Generated at ${new Date().toISOString()}`)
    lines.push('')

    for (const msg of recent) {
      const roleLabel = mapRoleLabel(msg.role)
      const content = normalizeContent(msg.content)
      if (!content) continue
      const truncated = content.length > MSG_TRUNCATE_LENGTH
        ? content.slice(0, MSG_TRUNCATE_LENGTH) + '...[truncated]'
        : content
      lines.push(`**${roleLabel}:**`)
      lines.push(truncated)
      lines.push('')
    }

    return lines.join('\n')
  }
}

/**
 * 角色标签显式映射：覆盖 pi 协议已知 role，未知 role 降级为 'Other'。
 */
function mapRoleLabel(role: string): string {
  const map: Record<string, string> = {
    user: 'User',
    assistant: 'Assistant',
    toolResult: 'Tool Result',
    compactionSummary: 'Compacted',
  }
  return map[role] ?? 'Other'
}

/**
 * sanitize 客户端传入的 reply（trust boundary 外）。
 * 去换行（CR/LF → 空格）+ 截断 + trim。
 */
function sanitizeReply(reply: string): string {
  return reply.replace(/[\r\n]/g, ' ').trim().slice(0, REPLY_MAX_LENGTH)
}
