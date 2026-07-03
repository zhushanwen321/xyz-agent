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
   * 返回 { blocked: true } 表示消息被 BeforeSend hook 拦截（已广播 message.error 错误气泡），
   * 调用方（session-message-handler）必须据此走 error envelope（带请求 id）让 renderer
   * pending.reject，不得 reply success（round7 must-fix #3：避免「composer 清空 + 错误气泡」矛盾态）。
   */
  async sendMessage(sessionId: string, content: string): Promise<{ blocked: boolean }> {
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
  ): Promise<{ blocked: boolean }> {
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
      // 不在这里广播 message.error,让 server.ts 的外层 catch 统一发送 handler_error
      throw e
    }

    // ── 标记活跃 + 生成中 ──
    const activeSession = this.svc.getSessionByClient(client)
    if (activeSession) {
      activeSession.lastActiveAt = Date.now()
      activeSession.isGenerating = true
      this.workspaceService.record(activeSession.cwd)
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
    await client.abort()
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

  async compact(sessionId: string): Promise<void> {
    const startTime = Date.now()
    const client = this.pm.getClient(sessionId)
    if (!client) {
      console.error('[message-dispatcher] compact: session not found, sessionId=' + sessionId)
      throw new Error(`Session ${sessionId} not found`)
    }

    console.log('[message-dispatcher] compact: start, sessionId=' + sessionId)
    this.broker.broadcast({
      type: 'session.compacting',
      payload: { sessionId, status: 'compacting' },
    })
    try {
      await client.compact()
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
    this.broker.broadcast({
      type: 'session.compacted',
      payload: { sessionId, status: 'compacted' },
    })
  }
}
