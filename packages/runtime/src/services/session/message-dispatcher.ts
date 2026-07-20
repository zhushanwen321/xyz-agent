/**
 * MessageDispatcher — 从 session-service 巨石拆出的消息派发职责。
 *
 * 负责:sendMessage / sendSubagentMessage / abort / steerMessage /
 * followUpMessage / compact + sendMessageHook 注册。
 *
 * sendMessage 与 sendSubagentMessage 共享 sendPrompt 骨架(hook 拦截 →
 * ensureActive → 标记活跃 → prompt),消除重复;两者仅注入不同的
 * 「实际发给 pi 的文本」构造方式(subagent 注入 base64 marker)。
 *
 * 依赖经构造注入:svc(Facade 内部协议,访问 sessions/共享 helper)、
 * pm(getClient / 进程操作)、broker(broadcast)。
 */
import type { IMessageBroker } from '../../interfaces.js'
import type { ISessionServiceInternal } from './session-internal.js'
import type { IPiEngine, IProcessManager } from '../ports/pi-engine.js'
import type { SendMessageHook } from './types.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import { toErrorMessage } from '../../utils/errors.js'

export class MessageDispatcher {
  private sendMessageHook: SendMessageHook | null = null
  /**
   * [ADR-0035 FR-5] prompt 成功发送后的回调注入点。
   *
   * turn-start 近似覆盖了「prompt 后起算」语义（interpreter 在 turn-start 启动 ping），
   * 但存在盲区：prompt 发出到 pi 推 turn-start 之间若 pi 卡住，turn-start 未到则 ping 不起。
   * 本 hook 让组合根在 prompt resolve 后立即启动 ping（覆盖该盲区）。
   *
   * 当前组合根未接入（turn-start 起算已满足测试覆盖 + 间隔 60s 延迟可接受）。
   * 预留接口供后续如需提前起算时接线，保持 message-dispatcher 与 interpreter 解耦。
   */
  private onPromptSent: ((sessionId: string) => void) | null = null

  constructor(
    private readonly svc: ISessionServiceInternal,
    private readonly pm: IProcessManager,
    private readonly broker: IMessageBroker,
    private readonly workspaceService: WorkspaceService,
  ) {}

  /** 注册消息发送前 hook(PluginService 调用,实现 beforeSend 拦截)。 */
  setSendMessageHook(hook: SendMessageHook): void {
    this.sendMessageHook = hook
  }

  /** [ADR-0035 FR-5] 注册 prompt 发送成功回调（prompt resolve 后触发）。 */
  setOnPromptSent(cb: (sessionId: string) => void): void {
    this.onPromptSent = cb
  }

  /**
   * 返回 { blocked: true } 表示消息被 BeforeSend hook 拦截（已广播 message.error 错误气泡），
   * 调用方（session-message-handler）必须据此走 error envelope（带请求 id）让 renderer
   * pending.reject，不得 reply success（round7 must-fix #3：避免「composer 清空 + 错误气泡」矛盾态）。
   */
  async sendMessage(sessionId: string, content: string): Promise<{ blocked: boolean; rejected?: boolean }> {
    return this.sendPrompt(sessionId, content, () => content)
  }

  /** 构造 subagent 隐藏标记并发送 prompt(hook 审核用户原文,marker 仅发给 pi)。 */
  async sendSubagentMessage(sessionId: string, agent: string, task: string, content?: string): Promise<{ blocked: boolean }> {
    const payload = JSON.stringify({ agent, task })
    const encoded = Buffer.from(payload, 'utf-8').toString('base64')
    const marker = `<!-- xyz-agent-force-subagent:${encoded} -->`
    const promptText = content || `Execute task using agent '${agent}'`
    return this.sendPrompt(sessionId, promptText, () => `${marker}\n${promptText}`)
  }

  /**
   * sendMessage / sendSubagentMessage 共享骨架。
   * @param sessionId   会话 id
   * @param hookContent hook 审核的文本(用户原文,不含 marker)
   * @param buildPrompt 返回实际发给 pi 的文本(subagent 时含 marker 前缀)
   */
  private async sendPrompt(
    sessionId: string,
    hookContent: string,
    buildPrompt: () => string,
  ): Promise<{ blocked: boolean; rejected?: boolean }> {
    // ── BeforeSend hook ──
    // blocked: 已广播 message.error（错误气泡），此处返回 {blocked:true} 让 handler 改发 error envelope。
    if ((await this.runBeforeSendHook(sessionId, hookContent)).blocked) {
      return { blocked: true }
    }

    // ── ensureActive(必要时 restore)──
    let client: IPiEngine
    try {
      client = await this.svc.ensureActive(sessionId)
    } catch (e) {
      const errMsg = `Failed to restore session: ${toErrorMessage(e)}`
      console.error(`[message-dispatcher] ${errMsg}`)
      // 补广播 message.error：让已订阅 session 通道的前端能在聊天流看到错误气泡。
      // 之前只靠 server.ts 外层 handler_error envelope（走 pending.reject，不进聊天流），
      // 导致 ensureActive 失败（如 pi 进程已死、restore 再 spawn 再 exit）时用户在对话流看不到错误。
      this.broker.broadcast({
        type: 'message.error',
        payload: { sessionId, message: errMsg },
      })
      throw e
    }

    // ── 标记活跃 + 生成中 ──
    const activeSession = this.svc.getSessionByClient(client)
    if (activeSession) {
      // [D-009 预检] busy 时拒绝（send.rejected 广播，不调 pi.prompt）
      // [W3, U6] 加 isCompacting：compact 进行中时 prompt 会与压缩竞态，同样必须拒。
      if (activeSession.isGenerating || activeSession.isCompacting) {
        console.warn(`[message-dispatcher] preemptive reject (busy), sid=${sessionId}`)
        this.broker.broadcast({
          type: 'send.rejected',
          payload: { sessionId, reason: 'busy', message: 'Agent 正在处理' },
        })
        return { blocked: true, rejected: true }
      }
      activeSession.lastActiveAt = Date.now()
      activeSession.isGenerating = true
      // [W6] record 是非用户阻塞的副作用（记最近工作区），不应阻断发消息主流程。
      // 当前 record 同步链路（WorkspaceService.record → store.record → cache.set/trim）几乎不抛，
      // 但作为防御：未来 store 实现变更（如引入 sync flush）或 lazy partition 加载异常都不该让
      // session 卡在「生成中」。包 try/catch：失败仅 warn，isGenerating 已置 true 不回退，pi.prompt 照常执行。
      try {
        this.workspaceService.record(activeSession.cwd)
      } catch (e) {
        // best-effort 降级：record 是非用户阻塞的副作用，失败仅 warn 不传播——
        // isGenerating 已置 true 不回退，pi.prompt 照常执行（见上方 W6 说明）。
        console.warn('[message-dispatcher] workspace.record failed (non-blocking), sid=',
          sessionId, e instanceof Error ? e.message : e)
      }
    }
    // ── 发送 prompt + 错误广播 ──
    const promptText = buildPrompt()
    try {
      await client.prompt(promptText)
    } catch (e) {
      const errMsg = toErrorMessage(e)
      console.error(`[message-dispatcher] prompt failed: sessionId=${sessionId}`, errMsg)
      if (activeSession) activeSession.isGenerating = false
      this.broker.broadcast({ type: 'message.error', payload: { sessionId, message: errMsg } })
      // 与 hook 拦截同等对待：已广播 message.error 气泡，返回 blocked 让 handler 走 error envelope（sendError），
      // renderer pending.reject 触发 Composer 恢复草稿。否则 handler reply success → pending.resolve 误判发送成功。
      return { blocked: true }
    }
    // [ADR-0035 FR-5] prompt 成功发送后触发注入点（当前组合根未接线；turn-start 起算已覆盖语义）。
    // 故意不接管 interpreter：message-dispatcher 与 interpreter 解耦，接线责任在组合根。
    if (this.onPromptSent) {
      try {
        this.onPromptSent(sessionId)
      } catch (e) {
        console.warn('[message-dispatcher] onPromptSent callback failed (non-blocking), sid=',
          sessionId, e instanceof Error ? e.message : e)
      }
    }
    return { blocked: false }
  }

  /**
   * 运行 BeforeSend hook：返回 { blocked: true } 时调用方应中止发送。
   * 统一处理 hook 拦截（blocked）与 hook 自身异常（广播 message.error 后视作 blocked）。
   */
  private async runBeforeSendHook(
    sessionId: string,
    hookContent: string,
  ): Promise<{ blocked: boolean }> {
    if (!this.sendMessageHook) return { blocked: false }
    try {
      const hookResult = await this.sendMessageHook(sessionId, hookContent)
      if (hookResult?.blocked) {
        this.broker.broadcast({
          type: 'message.error',
          payload: { sessionId, message: hookResult.reason ?? 'Message blocked by plugin hook' },
        })
        return { blocked: true }
      }
      return { blocked: false }
    } catch (e) {
      console.error('[message-dispatcher] sendMessage hook error:', e)
      this.broker.broadcast({
        type: 'message.error',
        payload: { sessionId, message: 'Plugin hook error: ' + (toErrorMessage(e)) },
      })
      return { blocked: true }
    }
  }

  async abort(sessionId: string): Promise<void> {
    const client = this.getClientOrThrow(sessionId, 'abort')
    try {
      await client.abort()
    } catch (e) {
      // [HISTORICAL] abort 失败也必须广播终态（规则 #3）：否则前端 isStreaming / runtime
      // isGenerating 永不复位，UI 卡在「思考中」。pi 卡死时 client.abort() 无响应，靠这条兜底。
      const errMsg = toErrorMessage(e)
      console.error(`[message-dispatcher] abort failed: sessionId=${sessionId}`, errMsg)
      const active = this.svc.getSessionByClient(client)
      if (active) active.isGenerating = false
      // W4：abort 失败（异常退出）写 stopped 终态
      this.svc.persistSessionOutcome(sessionId, 'stopped', `Abort failed: ${errMsg}`)
      this.broker.broadcast({
        type: 'message.error',
        payload: { sessionId, message: `Abort failed: ${errMsg}` },
      })
      return
    }
    // [HISTORICAL] abort 成功后必须主动广播 message.complete{stopReason:'aborted'} + 重置
    // isGenerating。不能依赖 pi 自发 agent_end——pi 卡死（静默不退出）时永远不会发。
    // session-message-handler 的 message.status{status:'aborted'} reply 走 pending 通道，
    // 只让 renderer 的 abort() Promise resolve，不触发 chat store 的 message.complete 收口
    // 逻辑（chat-message-effects 只认 'message.complete' type），isStreaming 仍为 true。
    // 广播流式 message.complete 让前端正常收口（与 sendPrompt 错误路径广播 message.error 对称）。
    const active = this.svc.getSessionByClient(client)
    if (active) active.isGenerating = false
    // W4：用户主动 abort 写 stopped 终态
    this.svc.persistSessionOutcome(sessionId, 'stopped', 'User aborted')
    this.broker.broadcast({
      type: 'message.complete',
      payload: { sessionId, stopReason: 'aborted' },
    })
  }

  async steerMessage(sessionId: string, content: string): Promise<void> {
    const client = this.getClientOrThrow(sessionId, 'steer')
    await client.steer(content)
  }

  async followUpMessage(sessionId: string, content: string): Promise<void> {
    const client = this.getClientOrThrow(sessionId, 'followUp')
    await client.followUp(content)
  }

  /**
   * D8: abort/steer/followUp 共享的「getClient → 空抛」骨架（此前 3 处逐行平行，只差方法名）。
   * @param op 调用方方法名，仅用于构造诊断串。
   */
  private getClientOrThrow(sessionId: string, op: 'abort' | 'steer' | 'followUp'): IPiEngine {
    const client = this.pm.getClient(sessionId)
    if (!client) {
      // abort 的历史报错串是 "Session X not found"（无前缀），steer/followUp 带 [message-dispatcher] 前缀。
      // 保持原样以免破坏依赖报错文本的测试。
      throw op === 'abort'
        ? new Error(`Session ${sessionId} not found`)
        : new Error(`[message-dispatcher] ${op}: session ${sessionId} not active`)
    }
    return client
  }

  async compact(sessionId: string, customInstructions?: string): Promise<void> {
    const startTime = Date.now()
    const client = this.pm.getClient(sessionId)
    if (!client) {
      console.error('[message-dispatcher] compact: session not found, sessionId=' + sessionId)
      throw new Error(`Session ${sessionId} not found`)
    }

    console.log('[message-dispatcher] compact: start, sessionId=' + sessionId + ', customInstructions=' + (customInstructions ? `"${customInstructions}"` : '(none)'))
    this.broker.broadcast({
      type: 'session.compacting',
      payload: { sessionId, status: 'compacting' },
    })
    // [W3, U6] compact 期间用 isCompacting 互斥 sendPrompt（pi 在压缩上下文，
    // 此时 prompt 会与压缩竞态导致卡死）。与 isGenerating 不同：compact 不开 isGenerating，
    // 否则前端会把 session 误显示为 active（实际在压缩）。finally 兜底确保异常/成功都复位。
    const active = this.svc.getSessionByClient(client)
    if (active) active.isCompacting = true
    try {
      let result
      try {
        result = await client.compact(customInstructions)
        console.log('[message-dispatcher] compact: complete, sessionId=' + sessionId + ', elapsed=' + (Date.now() - startTime) + 'ms')
      } catch (e) {
        const errMsg = toErrorMessage(e)
        console.error('[message-dispatcher] compact: failed, sessionId=' + sessionId + ', error=' + errMsg + ', elapsed=' + (Date.now() - startTime) + 'ms')
        this.broker.broadcast({
          type: 'session.compacted',
          payload: { sessionId, status: 'compacted', error: errMsg },
        })
        throw e
      }
      // 压缩成功：广播 summary 进对话流（SystemNotice）+ 刷新 context 用量。
      // 两件事都在 dispatcher 编排——compact 是主动命令，副作用归位命令编排层（非 event-adapter）。
      // AGENTS.md 规则 7.5：对话流状态必须实时可见 + 可重开恢复（持久化由 pi 写入 JSONL，重开经 converter 还原）。
      if (result?.summary) {
        this.broker.broadcast({
          type: 'message.compactionSummary',
          payload: {
            sessionId,
            summary: result.summary,
            tokensBefore: result.tokensBefore,
            timestamp: Date.now(),
          },
        })
      }
      if (result?.estimatedTokensAfter != null && result.estimatedTokensAfter > 0) {
        // compact 后无 turn_end，context 用量不会自动刷新。用 pi 返回的估算值触发 applyContextUpdate。
        // 注意 estimatedTokensAfter 可能很小（压缩后），applyContextUpdate 对 0 会跳过，故判 > 0。
        this.svc.applyContextUpdate(sessionId, result.estimatedTokensAfter)
      }
      this.broker.broadcast({
        type: 'session.compacted',
        payload: { sessionId, status: 'compacted' },
      })
    } finally {
      // [W3, U6] 无论成功/失败/抛错都复位，避免 session 永远卡在 isCompacting（之后所有消息被拒）
      if (active) active.isCompacting = false
    }
  }
}
