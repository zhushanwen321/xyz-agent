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

  /**
   * P5 lease：注入 LeaseManager（SessionService.setLeaseManager 转发调用）。
   * w2 阶段仅持有引用，w3 改造 sendPrompt/abort 时消费（acquire/release）。
   * 未注入时 sendPrompt 仍走旧的 isGenerating 预检路径（向后兼容）。
   */
  private leaseManager: import('./lease-manager.js').LeaseManager | null = null
  setLeaseManager(lm: import('./lease-manager.js').LeaseManager): void {
    this.leaseManager = lm
  }
  /**
   * P5 presence：lease 状态变化时触发 presence 重推（spec D9 触发点 4：isOperating 变化）。
   * 组合根注入 conn.broadcastPresence（经 SessionService.setPresenceRefreshCallback 转发）。
   * acquire 成功（新 owner isOperating=true）+ release（owner 释放 isOperating=false）后调。
   */
  private presenceRefresh: (() => void) | null = null
  setPresenceRefreshCallback(cb: () => void): void {
    this.presenceRefresh = cb
  }
  /**
   * P5 lease：按 clientId 反查连接的 deviceName（组合根注入 conn.clients.get(clientId)?.deviceName）。
   * busy 拒绝时需要 owner 的设备名（spec D6：session.busy/send.rejected 的 deviceName 应是 owner A 的，
   * 而非发起方 B）。dispatcher 自身无连接池上下文（acquire 只回 owner clientId），故经此回调反查。
   * 未注入时兜底 ''（向后兼容 lease-core slice 测试）。
   */
  private deviceNameLookup: ((clientId: string) => string | undefined) | null = null
  setDeviceNameLookup(cb: (clientId: string) => string | undefined): void {
    this.deviceNameLookup = cb
  }

  /**
   * 返回 { blocked: true } 表示消息被 BeforeSend hook 拦截（已广播 message.error 错误气泡），
   * 调用方（session-message-handler）必须据此走 error envelope（带请求 id）让 renderer
   * pending.reject，不得 reply success（round7 must-fix #3：避免「composer 清空 + 错误气泡」矛盾态）。
   *
   * P5 lease：clientId/deviceName 用于 lease acquire + busy 定向投递（reply send.rejected 给发起方 +
   * broadcast session.busy 给所有客户端，含发起方）。缺省（leaseManager 未注入或旧调用方）走旧 isGenerating 预检。
   */
  async sendMessage(sessionId: string, content: string, clientId?: string, deviceName?: string): Promise<{ blocked: boolean; rejected?: boolean }> {
    return this.sendPrompt(sessionId, content, () => content, clientId, deviceName)
  }

  /** 构造 subagent 隐藏标记并发送 prompt(hook 审核用户原文,marker 仅发给 pi)。 */
  async sendSubagentMessage(sessionId: string, agent: string, task: string, content?: string, clientId?: string, deviceName?: string): Promise<{ blocked: boolean }> {
    const payload = JSON.stringify({ agent, task })
    const encoded = Buffer.from(payload, 'utf-8').toString('base64')
    const marker = `<!-- xyz-agent-force-subagent:${encoded} -->`
    const promptText = content || `Execute task using agent '${agent}'`
    return this.sendPrompt(sessionId, promptText, () => `${marker}\n${promptText}`, clientId, deviceName)
  }

  /**
   * sendMessage / sendSubagentMessage 共享骨架。
   * @param sessionId   会话 id
   * @param hookContent hook 审核的文本(用户原文,不含 marker)
   * @param buildPrompt 返回实际发给 pi 的文本(subagent 时含 marker 前缀)
   * @param clientId    P5 lease：发起方 clientId（busy 定向投递）。缺省走旧 isGenerating 预检。
   * @param deviceName  P5 lease：发起方设备名（session.busy 广播用）
   */
  private async sendPrompt(
    sessionId: string,
    hookContent: string,
    buildPrompt: () => string,
    clientId?: string,
    deviceName?: string,
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

    // ── 标记活跃 + lease 预检 + 生成中 ──
    const activeSession = this.svc.getSessionByClient(client)
    if (activeSession) {
      // [W3, U6] isCompacting 预检保留：compact 进行中时 prompt 会与压缩竞态，必须拒。
      // compact 与 lease 正交（compact 不开 lease），故单独预检。
      if (activeSession.isCompacting) {
        console.warn(`[message-dispatcher] preemptive reject (compacting), sid=${sessionId}`)
        this.rejectBusy(sessionId, clientId, 'compacting', activeSession)
        return { blocked: true, rejected: true }
      }
      // P5 lease：leaseManager 已注入且 clientId 提供时走 lease acquire（隐式 acquire + 定向 busy 拒绝）。
      // 否则降级走旧 isGenerating 预检（向后兼容 leaseManager 未注入的旧调用/测试）。
      if (this.leaseManager && clientId) {
        const lease = this.leaseManager.acquire(sessionId, clientId, deviceName ?? '')
        // not_found 防御：session 不存在于 sessions Map（竞态/调用方 bug）。
        // ensureActive 理论上已保证存在，此处兜底拒绝，避免误以为已持锁继续 sendPrompt。
        if (lease.kind === 'not_found') {
          console.warn(`[message-dispatcher] lease acquire rejected (session not found), sid=${sessionId}`)
          const errMsg = 'Session not found'
          this.broker.broadcast({
            type: 'message.error',
            payload: { sessionId, message: errMsg },
          })
          return { blocked: true, rejected: true }
        }
        if (lease.kind === 'busy') {
          console.warn(`[message-dispatcher] preemptive reject (lease busy), sid=${sessionId}, owner=${lease.owner}`)
          // D6：只对发起方 reply send.rejected（判别联合 busy 分支，含 owner/device/expiresAt）。
          // 审查 C4：投递语义从 broadcast 改为 sendToClient（发起方专属点对点）。
          // 审查 Major1：deviceName 必须是 owner（lease.owner=A）的设备名，而非发起方 B 的。
          // dispatcher 无 owner deviceName 上下文（acquire 只回 owner clientId），故经
          // deviceNameLookup 回调按 lease.owner 反查连接池 owner 的 deviceName。未注入/owner 离线兜底 ''。
          const ownerDeviceName = this.deviceNameLookup?.(lease.owner) ?? ''
          this.broker.sendToClient(clientId, {
            type: 'send.rejected',
            payload: {
              sessionId,
              reason: 'busy',
              message: lease.owner === clientId ? '本设备正在处理' : '其他设备正在处理',
              busyOwnerId: lease.owner,
              busyOwnerDevice: ownerDeviceName,
              leaseExpiresAt: lease.expiresAt,
            },
          })
          // D6：广播 session.busy 让其他客户端更新 presence/占用指示器。
          // 审查 Major2：spec §五要求 lease 消息（busy/idle）必须可靠——走 broker.broadcast（打 seq + 入
          // session 桶），而非 broadcastExcept（不入桶）。短断线 resume 的客户端才能从 ring buffer 回放
          // 收到 session.busy，否则 session 视图 busy 状态不完整。
          // 发起方 B 也会收到 session.busy 广播，但 B 已先收到 send.rejected（点对点），session.busy 对 B
          // 是冗余但无害（B 的 store 会 setSessionBusy，与 send.rejected 的 toast 不冲突）。
          this.broker.broadcast({
            type: 'session.busy',
            payload: { sessionId, clientId: lease.owner, deviceName: ownerDeviceName, expiresAt: lease.expiresAt },
          })
          return { blocked: true, rejected: true }
        }
        // lease acquired/renewed → 继续 sendPrompt
        // P5 presence：acquire 成功 isOperating 变化，触发 presence 重推。
        this.presenceRefresh?.()
      } else if (activeSession.isGenerating) {
        // 降级路径：leaseManager 未注入或无 clientId，走旧 isGenerating 预检（向后兼容）。
        console.warn(`[message-dispatcher] preemptive reject (busy, legacy), sid=${sessionId}`)
        this.rejectBusy(sessionId, clientId, 'busy', activeSession)
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
      // 【审查 M3】acquire 后 sendPrompt 失败立即释放 lease，避免 lease 持有 30s 锁死 session
      // （失败后 isGenerating 已复位，但 lease 不释放会让其他客户端被 busy 拒绝 30s）。
      this.leaseManager?.release(sessionId, 'send_failed')
      this.presenceRefresh?.()
      this.broker.broadcast({ type: 'message.error', payload: { sessionId, message: errMsg } })
      // 与 hook 拦截同等对待：已广播 message.error 气泡，返回 blocked 让 handler 走 error envelope（sendError），
      // renderer pending.reject 触发 Composer 恢复草稿。否则 handler reply success → pending.resolve 误判发送成功。
      return { blocked: true }
    }
    return { blocked: false }
  }

  /**
   * P5 busy 拒绝 helper：compacting 或 legacy（无 leaseManager）路径的拒绝投递。
   * leaseManager 已注入且 clientId 提供时定向 sendToClient；否则降级 broadcast（向后兼容）。
   * lease 路径（leaseManager.acquire 返回 busy）在 sendPrompt 内单独处理（含 owner/device/expiresAt）。
   */
  private rejectBusy(sessionId: string, clientId: string | undefined, reason: 'busy' | 'compacting', activeSession: { busyOwnerId?: string; leaseExpiresAt?: number }): void {
    const payload = {
      sessionId,
      reason: 'busy' as const,
      message: reason === 'compacting' ? 'Agent 正在压缩上下文' : 'Agent 正在处理',
      busyOwnerId: activeSession.busyOwnerId ?? 'unknown',
      busyOwnerDevice: '',
      leaseExpiresAt: activeSession.leaseExpiresAt ?? Date.now(),
    }
    if (clientId) {
      this.broker.sendToClient(clientId, { type: 'send.rejected', payload })
    } else {
      // 降级：无 clientId（旧调用）走 broadcast（与 w1 前行为一致）。
      this.broker.broadcast({ type: 'send.rejected', payload })
    }
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
      // P5 lease：abort 路径释放 lease（失败也释放，避免锁死）。
      this.leaseManager?.release(sessionId, 'aborted')
      this.presenceRefresh?.()
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
    // P5 lease：abort 成功释放 lease（审查 C2：abort 复用 message.abort，补 release 'aborted'）。
    this.leaseManager?.release(sessionId, 'aborted')
    this.presenceRefresh?.()
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
