/**
 * Session message handler for session.* and message.* message types.
 * Extracted from RuntimeServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@xyz-agent/shared'
import type { ISessionService } from '../interfaces.js'
import { toErrorMessage, isEnoent } from '../utils/errors.js'
import type { MessageHandlerContext } from './message-context.js'

/** Interface for server methods needed by this handler */
export interface SessionHandlerContext extends MessageHandlerContext {
  sessionService: ISessionService
  nextPushId(): string
  broadcastSessionList(): void
  clearExtensionTimeoutsForSession(sessionId: string): void
}

export class SessionMessageHandler {
  constructor(private ctx: SessionHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单（session.compact 单独路由，故不在此列）。 */
  readonly handles: ClientMessageType[] = [
    'session.create', 'session.delete', 'session.list', 'session.switch', 'session.history', 'session.rename', 'session.getCommands', 'session.getContext', 'session.fork',
    'session.getSubagents', 'session.getSubagentHistory',
    'message.send', 'message.abort', 'message.steer', 'message.follow_up',
  ]

  async handleSessionMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'session.create': {
        const session = await this.ctx.sessionService.create(msg.payload.cwd, msg.payload.label, { hidden: msg.payload.hidden })
        this.ctx.reply(ws, msg.id, 'session.created', { session })
        return this.ctx.broadcastSessionList()
      }
      case 'session.fork': {
        // fork：runtime 读源 JSONL 截断 → 新进程 switch_session。reply session.created（复用类型）。
        const { srcSessionId, fromPiEntryId, includeFrom, label } = msg.payload
        const session = await this.ctx.sessionService.forkSession(srcSessionId, fromPiEntryId, includeFrom ?? true, label)
        this.ctx.reply(ws, msg.id, 'session.created', { session })
        return this.ctx.broadcastSessionList()
      }
      case 'session.delete': {
        const delSid = msg.payload.sessionId
        this.ctx.clearExtensionTimeoutsForSession(delSid)
        await this.ctx.sessionService.delete(delSid)
        this.ctx.reply(ws, msg.id, 'session.deleted', { sessionId: delSid })
        return this.ctx.broadcastSessionList()
      }
      case 'session.list':
        return this.ctx.reply(ws, msg.id, 'session.list', { groups: this.ctx.sessionService.listPersistedSessions() })
      case 'session.switch': {
        const switchId = msg.payload.sessionId
        const summary = this.ctx.sessionService.getSummary(switchId)
        if (summary) {
          try {
            const messages = await this.ctx.sessionService.getHistory(switchId)
            this.ctx.reply(ws, msg.id, 'session.history', { sessionId: switchId, session: summary, messages })
          } catch (e) {
            console.error('[runtime] failed to load history for switch:', e)
            this.ctx.reply(ws, msg.id, 'session.history', { sessionId: switchId, session: summary, messages: [] })
          }
        } else {
          try {
            await this.ctx.sessionService.ensureActive(switchId)
            const restored = this.ctx.sessionService.getSummary(switchId)
            if (!restored) {
              throw new Error(`Session ${switchId} restored but summary unavailable`)
            }
            const messages = await this.ctx.sessionService.getHistory(switchId)
            this.ctx.reply(ws, msg.id, 'session.history', { sessionId: switchId, session: restored, messages })
          } catch (e) {
            const errMsg = toErrorMessage(e)
            const isENOENT = isEnoent(e)
            const userMsg = isENOENT
              ? `Session file missing — the session was not saved properly. Error: ${errMsg}`
              : `Session ${switchId} not found or restore failed`
            console.error('[runtime] session.switch auto-restore failed:', errMsg)
            this.ctx.sendError(ws, isENOENT ? 'file_not_found' : 'not_found', userMsg, msg.id, { sessionId: switchId })
          }
        }
        return
      }
      case 'session.history': {
        const messages = await this.ctx.sessionService.getHistory(msg.payload.sessionId)
        return this.ctx.reply(ws, msg.id, 'session.history', { sessionId: msg.payload.sessionId, messages })
      }
      case 'session.getSubagents': {
        const subagents = await this.ctx.sessionService.getSubagents(msg.payload.sessionId)
        return this.ctx.reply(ws, msg.id, 'session.subagents', { sessionId: msg.payload.sessionId, subagents })
      }
      case 'session.getSubagentHistory': {
        const messages = await this.ctx.sessionService.getSubagentHistory(msg.payload.sessionId, msg.payload.subagentId)
        return this.ctx.reply(ws, msg.id, 'session.subagentHistory', { sessionId: msg.payload.sessionId, subagentId: msg.payload.subagentId, messages })
      }
      case 'session.getCommands': {
        // renderer 切 session 后主动拉取命令（修复 broadcast 与订阅时序竞争）。
        // reply session.commands payload，renderer 收到后 events.dispatchSession 本地投递给 CommandPopover。
        const { sessionId } = msg.payload
        const commands = await this.ctx.sessionService.getCommands(sessionId)
        return this.ctx.reply(ws, msg.id, 'session.commands', { sessionId, commands })
      }
      case 'session.getContext': {
        // renderer 切 session 后主动拉取上下文用量（修复 broadcast 与订阅时序竞争）。
        // reply context.update payload，renderer 收到后 events.dispatchSession 本地投递给 ContextCapacityPopover。
        // fetchContext 返回 null（pi 算不出，如 compaction 后未跑新 turn）时 reply 空对象，前端按无数据处理。
        const { sessionId } = msg.payload
        const payload = await this.ctx.sessionService.fetchContext(sessionId)
        return this.ctx.reply(ws, msg.id, 'context.update', { sessionId, ...(payload ?? { inputTokens: 0, contextLimit: 0, usagePercent: 0 }) })
      }
      case 'session.rename': {
        await this.ctx.sessionService.renameSession(msg.payload.sessionId, msg.payload.name)
        this.ctx.reply(ws, msg.id, 'session.renamed', { sessionId: msg.payload.sessionId, name: msg.payload.name })
        return this.ctx.broadcastSessionList()
      }
      case 'message.send': {
        const { sessionId, content, subagent } = msg.payload
        const result = subagent
          ? await this.ctx.sessionService.sendSubagentMessage(sessionId, subagent.agent, subagent.task, content)
          : await this.ctx.sessionService.sendMessage(sessionId, content)
        // D(round7-must-fix-3): hook 拦截时 dispatcher 已广播 message.error（错误气泡），
        // 此处必须走 error envelope（带 msg.id）让 renderer pending.reject，不得 reply success。
        // 否则 renderer 见 msg.id 且非 error → pending.resolve → composer 清空，与错误气泡矛盾。
        // [D-009] rejected（预检拒绝）：send.rejected 已广播，reply success 让 pending 干净 resolve（不双 toast）
        if (result.rejected) {
          return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'rejected' })
        }
        if (result.blocked) {
          return this.ctx.sendError(ws, 'message_blocked', 'Message blocked by plugin hook', msg.id, { sessionId })
        }
        return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'sent' })
      }
      case 'message.steer': {
        const steerSid = msg.payload.sessionId
        try {
          await this.ctx.sessionService.steerMessage(steerSid, msg.payload.content)
          return this.ctx.reply(ws, msg.id, 'message.status', { sessionId: steerSid, status: 'steered' })
        } catch (e) {
          // D10/P0-B: 请求级失败走统一 error envelope（区别于 message-dispatcher 的流式 message.error 广播）。
          const errMsg = toErrorMessage(e)
          console.error('[runtime] message.steer failed:', errMsg)
          return this.ctx.sendError(ws, 'steer_failed', errMsg, msg.id, { sessionId: steerSid })
        }
      }
      case 'message.follow_up': {
        const followSid = msg.payload.sessionId
        try {
          await this.ctx.sessionService.followUpMessage(followSid, msg.payload.content)
          return this.ctx.reply(ws, msg.id, 'message.status', { sessionId: followSid, status: 'queued' })
        } catch (e) {
          // D10/P0-B: 请求级失败走统一 error envelope（区别于 message-dispatcher 的流式 message.error 广播）。
          const errMsg = toErrorMessage(e)
          console.error('[runtime] message.follow_up failed:', errMsg)
          return this.ctx.sendError(ws, 'follow_up_failed', errMsg, msg.id, { sessionId: followSid })
        }
      }
      case 'message.abort': {
        // D(round5-must-fix-1): 必须回复 ack，否则 renderer pending.register(id) 的 Promise 永挂，pendingMap 泄漏无上限。
        // 与 message.send/steer/follow_up 对称，走 message.status 回复。
        const abortSid = msg.payload.sessionId
        await this.ctx.sessionService.abort(abortSid)
        return this.ctx.reply(ws, msg.id, 'message.status', { sessionId: abortSid, status: 'aborted' })
      }
    }
  }

  async handleSessionCompact(msg: Extract<ClientMessage, { type: 'session.compact' }>, ws: WsType): Promise<void> {
    const compactId = msg.payload.sessionId
    // D11: 耗时/启动/完成遥测由 message-dispatcher.compact 统一负责（含 session.compacting/compacted 广播）。
    // D(round7-must-fix-4): 成功 / 失败 / ensureActive 失败 三条路径都必须携带 msg.id 回复，
    // 否则 renderer pending.register(msg.id) 的 Promise 永挂、pendingMap 无上限泄漏（与 message.abort 同类 bug）。
    // dispatcher.compact 的 session.compacted 广播走流式通道（无 id），不能替代请求级 ack。
    try {
      await this.ctx.sessionService.ensureActive(compactId)
    } catch (e) {
      return this.ctx.sendError(ws, 'compact_failed', 'Failed to restore session for compact: ' + (toErrorMessage(e)), msg.id, { sessionId: compactId })
    }
    try {
      await this.ctx.sessionService.compact(compactId, msg.payload.customInstructions)
    } catch (e) {
      // compact 失败：dispatcher.compact 已广播 session.compacted(error)（流式通知），此处补请求级 error envelope。
      return this.ctx.sendError(ws, 'compact_failed', toErrorMessage(e), msg.id, { sessionId: compactId })
    }
    // compact 成功：dispatcher.compact 已广播 session.compacted（流式通知，无 id），此处补请求级 ack。
    return this.ctx.reply(ws, msg.id, 'session.compacted', { sessionId: compactId, status: 'compacted' })
  }
}
