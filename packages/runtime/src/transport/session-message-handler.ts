/**
 * Session message handler for session.* and message.* message types.
 * Extracted from RuntimeServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType, ServerMessage } from '@xyz-agent/shared'
import type { ISessionService } from '../interfaces.js'
import type { HandoffService } from '../services/handoff-service.js'
import { toErrorMessage, isEnoent, MODEL_NOT_CONFIGURED } from '../utils/errors.js'
import type { MessageHandlerContext } from './message-context.js'
// MessageBus（wave:runtime-wiring）：session.subscribe/unsubscribe RPC handler 用它注册订阅。
// type-only import（handler 不持有 bus 实例的创建，只调它的方法）。
import type { MessageBus } from '../services/message-bus/message-bus.js'
// BusClient（wave:bus-core）：ws 适配为 bus 订阅者的最小契约 { readyState, send }。
// ws 库的 WebSocket 天然满足，但类型不完全一致，用 as unknown as BusClient 显式标记边界（R2）。
import type { BusClient } from '../services/message-bus/types.js'

/** Interface for server methods needed by this handler */
export interface SessionHandlerContext extends MessageHandlerContext {
  sessionService: ISessionService
  /** fast-handoff 编排层（session.handoff 路由用）。可选：未注入时该 case 报 unsupported。 */
  handoffService?: HandoffService
  /**
   * MessageBus 单例（wave:runtime-wiring）：session.subscribe/unsubscribe RPC 用它注册/取消订阅。
   * 可选：未注入时 subscribe/unsubscribe case 报 unsupported（组合根保证注入）。
   */
  messageBus?: MessageBus
  nextPushId(): string
  broadcastSessionList(): void
  clearExtensionTimeoutsForSession(sessionId: string): void
  /** 广播一条 ServerMessage 给所有连接（FR-12：fork 后广播 session.forkNotice）。 */
  broadcast(msg: ServerMessage): void
}

export class SessionMessageHandler {
  constructor(private ctx: SessionHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单（session.compact 单独路由，故不在此列）。 */
  readonly handles: ClientMessageType[] = [
    'session.create', 'session.delete', 'session.deleteByCwd', 'config.sessions', 'session.switch', 'session.history', 'session.getFullHistory', 'session.rename', 'session.getCommands', 'session.getContext', 'session.fork',
    'session.handoff', 'session.abortHandoff',
    // wave:runtime-wiring：session.subscribe/unsubscribe RPC（IF6/IF7）。
    'session.subscribe', 'session.unsubscribe',
    'session.getSubagents', 'session.getSubagentHistory',
    'session.getWorkflows', 'session.getAgentCallHistory', 'session.getAgentCallFilePath',
    'session.workflowAction', 'session.subagentAction',
    'message.send', 'message.abort', 'message.steer', 'message.follow_up',
    'message.bash', 'message.abortBash',
  ]

  async handleSessionMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'session.create': {
        try {
          // B3：透传 modelOverride / thinkingOverride（Landing Chip 覆盖值，设计文档 §5.2）。
          // 优先级：Landing Chip override > preset.modelOverride/thinkingLevel > 全局默认。
          // 之前只透传了 hidden/presetId，覆盖值在 transport 层被丢弃，导致 Landing Chip 选型不生效。
          const session = await this.ctx.sessionService.create(msg.payload.cwd, msg.payload.label, {
            hidden: msg.payload.hidden,
            presetId: msg.payload.presetId,
            modelOverride: msg.payload.modelOverride,
            thinkingOverride: msg.payload.thinkingOverride,
          })
          this.ctx.reply(ws, msg.id, 'session.created', { session })
          return this.ctx.broadcastSessionList()
        } catch (e) {
          // L4: model 未配置时返回差异化 error code，前端据此引导去 Settings 配置。
          const code = (e as Error & { code?: string }).code
          if (code === MODEL_NOT_CONFIGURED) {
            this.ctx.sendError(ws, MODEL_NOT_CONFIGURED, toErrorMessage(e), msg.id)
            return
          }
          throw e
        }
      }
      case 'session.fork': {
        // fork：runtime 读源 JSONL 截断 → 新进程 switch_session。reply session.created（复用类型）。
        const { srcSessionId, fromPiEntryId, fromMessageTimestamp, fromMessageRole, includeFrom, label } = msg.payload
        try {
          const session = await this.ctx.sessionService.forkSession(
            srcSessionId, fromPiEntryId, includeFrom ?? true, label,
            { fromMessageTimestamp, fromMessageRole },
          )
          this.ctx.reply(ws, msg.id, 'session.created', { session })
          // [W2 FR-12] fork 成功后广播 session.forkNotice：通知 srcSession 所在 panel
          // 在对话流插一条 ForkNotice 反馈行（spec §3）。广播在 reply + broadcastSessionList 之后，
          // 确保新 session 已入列表 + reply 已发出（前端可据 newSessionId 跳转）。
          this.ctx.broadcast({
            type: 'session.forkNotice',
            id: this.ctx.nextPushId(),
            payload: { srcSessionId, newSessionId: session.id, branchName: label },
          })
          return this.ctx.broadcastSessionList()
        } catch (e) {
          // L4: model 未配置时返回差异化 error code（与 session.create 同模式）。
          const code = (e as Error & { code?: string }).code
          if (code === MODEL_NOT_CONFIGURED) {
            this.ctx.sendError(ws, MODEL_NOT_CONFIGURED, toErrorMessage(e), msg.id)
            return
          }
          throw e
        }
      }
      case 'session.handoff': {
        // handoff：runtime 直接从对话历史组装文档（同步编排）。
        // 流程：getHistory → assembleHandoffDoc → create 新 session → 注入文档 → 广播。
        // 不再调用 pi skill，不需要 agent_end / onTurnEnd 回调。
        const { sessionId, reply } = msg.payload
        const hs = this.ctx.handoffService
        if (!hs) {
          // handoffService 未注入（理论不可达——组合根必传），防御性报错。
          return this.ctx.sendError(ws, 'handoff_unsupported', 'handoff service not available', msg.id, { sessionId })
        }
        try {
          await hs.runHandoff(sessionId, reply)
          return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'sent' })
        } catch (e) {
          // L4: model 未配置时返回差异化 error code（与 session.create / session.fork 同模式），
          // 前端据此引导去 Settings 配置，而非泛化的 handoff_failed 气泡。
          const code = (e as Error & { code?: string }).code
          if (code === MODEL_NOT_CONFIGURED) {
            return this.ctx.sendError(ws, MODEL_NOT_CONFIGURED, toErrorMessage(e), msg.id, { sessionId })
          }
          // runHandoff 失败（历史为空 / session 不存在 / 已有进行中 handoff）走 error envelope。
          // 所有错误路径统一走此处的 sendError，不再有 onTurnEnd 内部广播路径。
          const errMsg = toErrorMessage(e)
          console.error('[runtime] session.handoff failed:', errMsg)
          return this.ctx.sendError(ws, 'handoff_failed', errMsg, msg.id, { sessionId })
        }
      }
      case 'session.abortHandoff': {
        // abortHandoff：中断进行中的 handoff turn（调 handoffService.abortHandoff → 内部 client.abort + 清 inflight）。
        // W1：abortHandoff 返回 boolean——只有 inflight 真存在（真正 abort）才广播 session.handoffAborted
        // 让前端复位 isHandingOff；inflight 无（no-op，如用户重复点取消、或 handoff 已完成）不广播，
        // 避免前端先收 aborted 再收 complete 的 UX 抖动。reply message.status{aborted} 始终发（RPC ack）。
        const { sessionId } = msg.payload
        const hs = this.ctx.handoffService
        if (!hs) {
          return this.ctx.sendError(ws, 'handoff_unsupported', 'handoff service not available', msg.id, { sessionId })
        }
        try {
          const aborted = await hs.abortHandoff(sessionId)
          if (aborted) {
            // 真正中断了 → 广播 handoffAborted（参照 forkNotice L75-79 broadcast 范式）
            this.ctx.broadcast({
              type: 'session.handoffAborted',
              id: this.ctx.nextPushId(),
              payload: { sessionId },
            })
          }
          // 无论 aborted 与否都 reply ack（RPC ack 让 renderer pending resolve）
          return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'aborted' })
        } catch (e) {
          const errMsg = toErrorMessage(e)
          console.error('[runtime] session.abortHandoff failed:', errMsg)
          return this.ctx.sendError(ws, 'handoff_failed', errMsg, msg.id, { sessionId })
        }
      }
      case 'session.delete': {
        const delSid = msg.payload.sessionId
        this.ctx.clearExtensionTimeoutsForSession(delSid)
        await this.ctx.sessionService.delete(delSid)
        this.ctx.reply(ws, msg.id, 'session.deleted', { sessionId: delSid })
        return this.ctx.broadcastSessionList()
      }
      case 'session.deleteByCwd': {
        // deleteByCwd 是 best-effort 聚合（永远 resolve），clearExtensionTimeoutsForSession
        // 只对 result.deleted 调用（失败的 session 未真正删除，不需清 timeout）。
        // 与 session.delete 的「先清 timeout 再 delete」顺序相反——批量需先拿到聚合结果才知道清谁。
        const cwd = msg.payload?.cwd
        // cwd 非空字符串校验：与 extension-message-handler 的 invalid_payload 范式对齐。
        // 不走「reply 空 BatchDeleteResult 成功」——那会让前端误判删除成功，掩盖参数错误。
        if (!cwd || typeof cwd !== 'string') {
          return this.ctx.sendError(ws, 'invalid_payload', 'session.deleteByCwd requires a non-empty "cwd" string', msg.id)
        }
        const result = await this.ctx.sessionService.deleteByCwd(cwd)
        for (const id of result.deleted) {
          this.ctx.clearExtensionTimeoutsForSession(id)
        }
        this.ctx.reply(ws, msg.id, 'session.deletedByCwd', result)
        return this.ctx.broadcastSessionList()
      }
      case 'config.sessions':
        return this.ctx.reply(ws, msg.id, 'config.sessions', { groups: this.ctx.sessionService.listPersistedSessions() })
      case 'session.switch': {
        const switchId = msg.payload.sessionId
        const summary = this.ctx.sessionService.getSummary(switchId)
        if (summary) {
          try {
            const { messages, truncated } = await this.ctx.sessionService.getHistory(switchId)
            this.ctx.reply(ws, msg.id, 'session.history', { sessionId: switchId, session: summary, messages, historyTruncated: truncated })
          } catch (e) {
            // W5：历史加载失败时绝不能 reply messages:[] + historyTruncated:false——
            // 前端会误判「全部历史已加载且未截断」并把空列表当真。改走 sendError（统一 error
            // envelope），与项目「错误作为 assistant 消息/可见告警插入」模式一致，前端据此渲染失败态。
            const errMsg = toErrorMessage(e)
            console.error('[runtime] failed to load history for switch:', errMsg)
            this.ctx.sendError(ws, 'history_load_failed', errMsg, msg.id, { sessionId: switchId })
          }
        } else {
          try {
            await this.ctx.sessionService.ensureActive(switchId)
            const restored = this.ctx.sessionService.getSummary(switchId)
            if (!restored) {
              throw new Error(`Session ${switchId} restored but summary unavailable`)
            }
            const { messages, truncated } = await this.ctx.sessionService.getHistory(switchId)
            this.ctx.reply(ws, msg.id, 'session.history', { sessionId: switchId, session: restored, messages, historyTruncated: truncated })
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
        const { messages, truncated } = await this.ctx.sessionService.getHistory(msg.payload.sessionId)
        return this.ctx.reply(ws, msg.id, 'session.history', { sessionId: msg.payload.sessionId, messages, historyTruncated: truncated })
      }
      case 'session.getFullHistory': {
        const messages = await this.ctx.sessionService.getFullHistory(msg.payload.sessionId)
        return this.ctx.reply(ws, msg.id, 'session.fullHistory', { sessionId: msg.payload.sessionId, messages })
      }
      case 'session.getSubagents': {
        const subagents = await this.ctx.sessionService.getSubagents(msg.payload.sessionId)
        return this.ctx.reply(ws, msg.id, 'session.subagents', { sessionId: msg.payload.sessionId, subagents })
      }
      case 'session.getSubagentHistory': {
        const messages = await this.ctx.sessionService.getSubagentHistory(msg.payload.sessionId, msg.payload.subagentId)
        return this.ctx.reply(ws, msg.id, 'session.subagentHistory', { sessionId: msg.payload.sessionId, subagentId: msg.payload.subagentId, messages })
      }
      case 'session.getWorkflows': {
        const workflows = await this.ctx.sessionService.getWorkflows(msg.payload.sessionId)
        return this.ctx.reply(ws, msg.id, 'session.workflows', { sessionId: msg.payload.sessionId, workflows })
      }
      case 'session.getAgentCallHistory': {
        const messages = await this.ctx.sessionService.getAgentCallHistory(msg.payload.sessionId, msg.payload.agentCallSessionId)
        return this.ctx.reply(ws, msg.id, 'session.agentCallHistory', { sessionId: msg.payload.sessionId, agentCallSessionId: msg.payload.agentCallSessionId, messages })
      }
      case 'session.getAgentCallFilePath': {
        const filePath = await this.ctx.sessionService.getAgentCallFilePath(msg.payload.sessionId, msg.payload.agentCallSessionId)
        return this.ctx.reply(ws, msg.id, 'session.agentCallFilePath', { sessionId: msg.payload.sessionId, agentCallSessionId: msg.payload.agentCallSessionId, filePath })
      }
      case 'session.workflowAction': {
        await this.ctx.sessionService.workflowAction(msg.payload.sessionId, msg.payload.action, msg.payload.runId)
        return this.ctx.reply(ws, msg.id, 'session.workflowActionDone', { sessionId: msg.payload.sessionId, action: msg.payload.action, runId: msg.payload.runId })
      }
      case 'session.subagentAction': {
        await this.ctx.sessionService.subagentAction(msg.payload.sessionId, msg.payload.action, msg.payload.subagentId)
        return this.ctx.reply(ws, msg.id, 'session.subagentActionDone', { sessionId: msg.payload.sessionId, action: msg.payload.action, subagentId: msg.payload.subagentId })
      }
      case 'session.subscribe': {
        // wave:runtime-wiring（IF6）：订阅某 session 的 live 事件流。
        // 调 bus.subscribe 注册当前 ws 为订阅者 + 拉 ring 全量 snapshot + stateSnapshot + 最新 seq。
        // fromSeq 可选（重连场景）：若提供且 < ring 最旧 seq（旧消息已被 FIFO 淘汰）→ gap=true
        // 返全量 snapshot；否则过滤 snapshot 只返 seq > fromSeq 的（增量 backfill）。
        // stateSnapshot（wave:remove-bandaids）是 4 个 state topic 的 last-value，不受 fromSeq
        // 增量过滤影响（last-value 语义无历史概念），renderer 始终拿到最新状态 reconcile。
        const { sessionId, fromSeq } = msg.payload
        const bus = this.ctx.messageBus
        if (!bus) {
          // messageBus 未注入（理论不可达——组合根保证），防御性报错。
          return this.ctx.sendError(ws, 'subscribe_unsupported', 'message bus not available', msg.id, { sessionId })
        }
        const result = bus.subscribe(sessionId, ws as unknown as BusClient)
        let gap = false
        let snapshot = result.snapshot
        if (fromSeq !== undefined) {
          const oldestSeq = snapshot[0]?.seq ?? 0
          // ES2/gap 检测：fromSeq 早于 ring 最旧 seq → 旧消息已被淘汰，本次存在缺口。
          if (fromSeq < oldestSeq) {
            gap = true
          } else {
            // 增量模式：过滤掉 seq <= fromSeq 的（已处理过的），只返 seq > fromSeq。
            snapshot = snapshot.filter(m => (m.seq ?? 0) > fromSeq)
          }
        }
        return this.ctx.reply(ws, msg.id, 'session.subscribe', {
          snapshot,
          stateSnapshot: result.stateSnapshot,
          lastSeq: result.lastSeq,
          gap,
        })
      }
      case 'session.unsubscribe': {
        // wave:runtime-wiring（IF7）：取消订阅某 session 的 live 事件流。
        // 调 bus.unsubscribe 移除当前 ws 的订阅（减少不活跃 session 的 live push 开销）。
        // 不调也安全——ws 断开时 ConnectionManager.onClose → bus.unsubscribeAll 兜底。
        // reply 'message.status' { status: 'unsubscribed' }（ack 型，ReplyPayloadMap 已定 void//
        // reply message.status，与 message.abort/session.handoff 同模式——renderer register<void>
        // 不读 payload，取消订阅的副作用由后续 live 事件停发体现）。
        const { sessionId } = msg.payload
        const bus = this.ctx.messageBus
        if (!bus) {
          return this.ctx.sendError(ws, 'subscribe_unsupported', 'message bus not available', msg.id, { sessionId })
        }
        bus.unsubscribe(sessionId, ws as unknown as BusClient)
        return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'unsubscribed' })
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
        const { sessionId, content, subagent, images } = msg.payload
        const result = subagent
          ? await this.ctx.sessionService.sendSubagentMessage(sessionId, subagent.agent, subagent.task, content)
          : await this.ctx.sessionService.sendMessage(sessionId, content, images)
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
      case 'message.bash': {
        // 与 message.send 对称：调 dispatcher.sendBash → 按 result.rejected/blocked 走 ack 路径。
        // rejected（预检拒绝）：send.rejected 已广播，reply message.status{rejected} 让 pending 干净 resolve。
        // blocked（执行失败）：message.error 已广播（错误气泡），走 error envelope 让 pending.reject。
        // 正常：reply message.status{sent}。实际 bash 结果经 message.bashStart/bashResult 广播通道推回（fire-and-forget）。
        const { sessionId, command, excludeFromContext } = msg.payload
        const result = await this.ctx.sessionService.sendBash(sessionId, command, excludeFromContext)
        if (result.rejected) {
          return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'rejected' })
        }
        if (result.blocked) {
          return this.ctx.sendError(ws, 'message_blocked', 'Bash execution failed', msg.id, { sessionId })
        }
        return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'sent' })
      }
      case 'message.abortBash': {
        // 与 message.abort 对称：调 dispatcher.abortBash，reply message.status{aborted}。
        // 终态经 message.bashResult{cancelled:true} 广播推回（dispatcher.abortBash 兑底），不依赖 reply。
        const abortBashSid = msg.payload.sessionId
        await this.ctx.sessionService.abortBash(abortBashSid)
        return this.ctx.reply(ws, msg.id, 'message.status', { sessionId: abortBashSid, status: 'aborted' })
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
