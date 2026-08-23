/**
 * SessionManagerHandler — 处理 agent-managed session 请求。
 *
 * pi extension 通过 select 通道 + SESSION_MANAGER_MARKER 发送 session 管理请求，
 * runtime event-adapter 检测 marker 后路由到本 handler 的 handle() 方法。
 *
 * 6 个 action：create / send / history / status / list / abort。
 * 响应通过 sendExtensionUiResponse 回写 pi（select value 通道）。
 */
import type { ISessionService } from '../interfaces.js'
import { toErrorMessage } from '../utils/errors.js'
import { SESSION_MANAGER_ACTIONS } from '@xyz-agent/extension-protocol'
import type {
  SessionManagerAction,
  SessionManagerCreateParams,
  SessionManagerSendParams,
  SessionManagerHistoryParams,
  SessionManagerStatusParams,
  SessionManagerListParams,
  SessionManagerAbortParams,
  SessionManagerCreateResult,
  SessionManagerSendResult,
  SessionManagerHistoryResult,
  SessionManagerStatusResult,
  SessionManagerListResult,
  SessionManagerAbortResult,
  SessionManagerErrorResult,
} from '@xyz-agent/extension-protocol'

/** SessionManagerHandler 构造选项 */
export interface SessionManagerHandlerOptions {
  sessionService: ISessionService
  /** 向 pi 发送 extension_ui_response（sessionId = 发起方 session，requestId 只在其 pending 表有效） */
  sendExtensionUiResponse: (sessionId: string, requestId: string, response: unknown, method?: string) => void
  /** 广播 session 列表变更（create 成功后触发） */
  broadcastSessionList: () => void
}

/**
 * SessionManagerHandler — 处理 agent-managed session 的 6 个 action。
 *
 * handle() 是唯一入口，由 EventInterpreter.onSessionManagerRequest 调用。
 * dispatch() 纯分发（各分支只 return 结果），回写统一由 respond() 收口；
 * 错误走同一通道 respond({error})。
 */
export class SessionManagerHandler {
  constructor(private readonly opts: SessionManagerHandlerOptions) {}

  /**
   * 处理 session manager 请求。
   *
   * @param requestId       pi extension_ui_request id（回写 response 用）
   * @param parentSessionId 发起方 session id（response 直发其 pi 进程；create 时注入为父 id）
   * @param action          6 个 action 之一，或 marker 解析失败哨兵 '__malformed__'
   * @param params          action 对应的参数（已由 event-adapter 解析）
   */
  async handle(
    requestId: string,
    parentSessionId: string,
    action: SessionManagerAction | '__malformed__',
    params: Record<string, unknown>,
  ): Promise<void> {
    // 无法识别的 action（'__malformed__' = marker 解析失败；集合外值 = 协议外 action）
    // 统一回 cancelled（select value null），不走正常分发。
    if (action === '__malformed__' || !(SESSION_MANAGER_ACTIONS as readonly string[]).includes(action)) {
      this.opts.sendExtensionUiResponse(parentSessionId, requestId, null, 'select')
      return
    }

    try {
      const result = await this.dispatch(action, parentSessionId, params)
      this.respond(parentSessionId, requestId, result)
    } catch (e) {
      // 错误闭环：respond({error}) 走同一 select value 通道。
      // create 已成功但后续步骤失败时，handleCreate 在错误对象上携带 sessionId
      // → 附 sessionId + hint 恢复路径（设计文档 §5.2 原子性 catch 面）。
      const errorResult: SessionManagerErrorResult = { error: toErrorMessage(e) }
      const createdId = (e as { sessionId?: string }).sessionId
      if (createdId) {
        errorResult.sessionId = createdId
        errorResult.hint = 'use send_to_session to retry'
      }
      this.respond(parentSessionId, requestId, errorResult)
    }
  }

  /** respond 通过 select value 通道回写 pi（发起方 session） */
  private respond(parentSessionId: string, requestId: string, data: unknown): void {
    this.opts.sendExtensionUiResponse(parentSessionId, requestId, JSON.stringify(data), 'select')
  }

  /** action 分发：各分支只 return 结果，回写统一由 handle/respond 收口 */
  private async dispatch(
    action: SessionManagerAction,
    parentSessionId: string,
    params: Record<string, unknown>,
  ): Promise<SessionManagerCreateResult | SessionManagerSendResult | SessionManagerHistoryResult | SessionManagerStatusResult | SessionManagerListResult | SessionManagerAbortResult> {
    switch (action) {
      case 'create':
        return this.handleCreate(parentSessionId, params as unknown as SessionManagerCreateParams)
      case 'send':
        return this.handleSend(params as unknown as SessionManagerSendParams)
      case 'history':
        return this.handleHistory(params as unknown as SessionManagerHistoryParams)
      case 'status':
        return this.handleStatus(params as unknown as SessionManagerStatusParams)
      case 'list':
        return this.handleList(params as unknown as SessionManagerListParams)
      case 'abort':
        return this.handleAbort(params as unknown as SessionManagerAbortParams)
    }
  }

  /** create 分支：四步串行时序 */
  private async handleCreate(parentSessionId: string, params: SessionManagerCreateParams): Promise<SessionManagerCreateResult> {
    const { cwd, label, prompt, model, thinkingLevel } = params

    // 1. SessionService.create —— spawnSource/parentAgentSessionId 服务端注入：
    // 父 session 由路由上下文（interpreter sessionId）决定，不信任 extension 请求参数（防伪造父 id）
    const session = await this.opts.sessionService.create(cwd, label, {
      spawnSource: 'agent',
      parentAgentSessionId: parentSessionId,
      modelOverride: model,
      thinkingOverride: thinkingLevel,
    })

    // 2. broadcastSessionList（先于 sendMessage，opts 注入回调）
    // broadcast 失败不阻断 create 结果（解耦：已广播的侧栏可见性不受 sendMessage 影响）
    try {
      this.opts.broadcastSessionList()
    } catch (e) {
      // broadcast 失败只 warn，不阻断 create 的 respond
      console.warn('[session-manager] broadcastSessionList failed:', toErrorMessage(e))
    }

    // 3. sendMessage：初始 prompt 同一 handler 调用内注入（设计文档 §5.2——
    // create+send 原子完成，避免"已创建无内容"中间态；broadcast 先于此步，
    // prompt 注入失败时错误对象携带 sessionId，走外层 catch 的恢复路径）
    if (prompt !== undefined && prompt !== '') {
      try {
        await this.opts.sessionService.sendMessage(session.id, prompt)
      } catch (e) {
        throw Object.assign(new Error(toErrorMessage(e)), { sessionId: session.id })
      }
    }

    // 4. respond
    return {
      sessionId: session.id,
      status: 'created',
      modelId: session.modelId || undefined,
    }
  }

  /** send 分支 */
  private async handleSend(params: SessionManagerSendParams): Promise<SessionManagerSendResult> {
    const { sessionId, prompt } = params
    const result = await this.opts.sessionService.sendMessage(sessionId, prompt)
    // sd-u5-send-queue: 替换旧的 {blocked, rejected} 为 {queued: true}
    // busy 时 delivery.sendChecked 会排队，成功后返回 queued: true
    return { queued: true }
  }

  /** history 分支：含 tailTurns 截断 */
  private async handleHistory(params: SessionManagerHistoryParams): Promise<SessionManagerHistoryResult> {
    const { sessionId, tailTurns } = params
    const { messages, truncated } = await this.opts.sessionService.getHistory(sessionId)

    // tailTurns 截断：从末尾保留指定 turn 数
    if (tailTurns && tailTurns > 0 && messages.length > 0) {
      // 找到倒数第 tailTurns 个 user message 的位置
      let userCount = 0
      let cutIndex = messages.length
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          userCount++
          if (userCount >= tailTurns) {
            cutIndex = i
            break
          }
        }
      }
      return {
        messages: messages.slice(cutIndex),
        truncated: cutIndex > 0 || truncated,
      }
    }

    return { messages, truncated }
  }

  /** status 分支：从 getSummary 组装（session 不存在时 status='not_found'） */
  private async handleStatus(params: SessionManagerStatusParams): Promise<SessionManagerStatusResult> {
    const { sessionId } = params
    const summary = this.opts.sessionService.getSummary(sessionId)

    if (!summary) {
      return { status: 'not_found' }
    }

    return {
      status: summary.status,
      modelId: summary.modelId || undefined,
    }
  }

  /** list 分支：过滤 spawnSource + parentAgentSessionId */
  private async handleList(params: SessionManagerListParams): Promise<SessionManagerListResult> {
    const { spawnSource, parentAgentSessionId } = params
    const groups = this.opts.sessionService.listPersistedSessions()

    // 展平 groups 为 sessions 数组
    const allSessions = groups.flatMap((g) => g.sessions)

    // 过滤
    const filtered = allSessions.filter((s) => {
      if (spawnSource && s.spawnSource !== spawnSource) return false
      if (parentAgentSessionId && s.parentAgentSessionId !== parentAgentSessionId) return false
      return true
    })

    return {
      sessions: filtered.map((s) => ({
        id: s.id,
        label: s.label,
        cwd: s.cwd,
        status: s.status,
        spawnSource: s.spawnSource,
        parentAgentSessionId: s.parentAgentSessionId,
      })),
    }
  }

  /** abort 分支 */
  private async handleAbort(params: SessionManagerAbortParams): Promise<SessionManagerAbortResult> {
    const { sessionId } = params
    await this.opts.sessionService.abort(sessionId)
    return { success: true }
  }
}
