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
import type { MessageBus } from '../message-bus/message-bus.js'
import { toErrorMessage } from '../../utils/errors.js'

/** 生成代次 token 用的进制（base-36：数字 + 小写字母，紧凑且无符号字符）。 */
const RANDOM_TOKEN_RADIX = 36
/** Math.random().toString(N) 返回形如 "0.xxxx"，跳过前导 "0." 取随机段。 */
const RANDOM_TOKEN_SLICE_START = 2

/**
 * 生成短随机字符串，用作 sendBash / abortBash 的代次令牌后缀。
 * 与 `Date.now()` 拼接保证唯一性，比对即可判定是否被抢收口。
 */
function randomTokenSuffix(): string {
  return Math.random().toString(RANDOM_TOKEN_RADIX).slice(RANDOM_TOKEN_SLICE_START)
}

export class MessageDispatcher {
  private sendMessageHook: SendMessageHook | null = null

  constructor(
    private readonly svc: ISessionServiceInternal,
    private readonly pm: IProcessManager,
    private readonly broker: IMessageBroker,
    private readonly workspaceService: WorkspaceService,
    private readonly messageBus?: MessageBus,
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
  async sendMessage(sessionId: string, content: string, images?: Array<{ data: string; mimeType: string }>): Promise<{ blocked: boolean; rejected?: boolean }> {
    return this.sendPrompt(sessionId, content, () => content, images)
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
   * @param images      shared 形状图片附件（{data;mimeType}），透传给 client.prompt。
   *                    仅 sendMessage 主路径传入；sendSubagentMessage 不传（范围外）。
   */
  private async sendPrompt(
    sessionId: string,
    hookContent: string,
    buildPrompt: () => string,
    images?: Array<{ data: string; mimeType: string }>,
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
      const msg = { type: 'message.error' as const, payload: { sessionId, message: errMsg } }
      this.broker.broadcast(msg)
      this.messageBus?.publish(sessionId, msg)
      throw e
    }

    // ── 标记活跃 + 生成中 ──
    const activeSession = this.svc.getSessionByClient(client)
    if (activeSession) {
      // [D-009 预检] busy 时拒绝（send.rejected 广播，不调 pi.prompt）
      // [W3, U6] 加 isCompacting：compact 进行中时 prompt 会与压缩竞态，同样必须拒。
      // [composer-bash-execute W1] 加 isBashRunning：bash 执行中 prompt 会与 bash 竞态，双向互斥。
      if (activeSession.isGenerating || activeSession.isCompacting || activeSession.isBashRunning) {
        console.warn(`[message-dispatcher] preemptive reject (busy), sid=${sessionId}`)
        const msg = { type: 'send.rejected' as const, payload: { sessionId, reason: 'busy' as const, message: 'Agent 正在处理' } }
        this.broker.broadcast(msg)
        this.messageBus?.publish(sessionId, msg)
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
      await client.prompt(promptText, images)
    } catch (e) {
      const errMsg = toErrorMessage(e)
      console.error(`[message-dispatcher] prompt failed: sessionId=${sessionId}`, errMsg)
      if (activeSession) activeSession.isGenerating = false
      const errMsgMsg = { type: 'message.error' as const, payload: { sessionId, message: errMsg } }
      this.broker.broadcast(errMsgMsg)
      this.messageBus?.publish(sessionId, errMsgMsg)
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
        const msg = { type: 'message.error' as const, payload: { sessionId, message: hookResult.reason ?? 'Message blocked by plugin hook' } }
        this.broker.broadcast(msg)
        this.messageBus?.publish(sessionId, msg)
        return { blocked: true }
      }
      return { blocked: false }
    } catch (e) {
      console.error('[message-dispatcher] sendMessage hook error:', e)
      const msg = { type: 'message.error' as const, payload: { sessionId, message: 'Plugin hook error: ' + (toErrorMessage(e)) } }
      this.broker.broadcast(msg)
      this.messageBus?.publish(sessionId, msg)
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
      const abortErrMsg = { type: 'message.error' as const, payload: { sessionId, message: `Abort failed: ${errMsg}` } }
      this.broker.broadcast(abortErrMsg)
      this.messageBus?.publish(sessionId, abortErrMsg)
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
    const completeMsg = { type: 'message.complete' as const, payload: { sessionId, stopReason: 'aborted' as const } }
    this.broker.broadcast(completeMsg)
    this.messageBus?.publish(sessionId, completeMsg)
  }

  /**
   * 直接执行 bash 命令（pi bash RPC，不经 LLM turn）。
   *
   * 与 sendMessage 共享 ensureActive 骨架，但 busy 预检语义不同（W2 起）：
   * sendBash 仅 bash↔bash / bash↔compacting 互斥，允许 AI streaming（isGenerating）期间执行 bash，
   * 对齐 pi-tui——pi 把 bash RPC 排入 _pendingBashMessages 待当前 turn 结束后按 JSONL 顺序回放，
   * 对 RPC 透明。sendMessage 仍保留 isGenerating 三者互斥（spec OQ-1：本期不放宽 prompt 路径）。
   *
   * 不走 sendPrompt（bash 不调 client.prompt，不需 BeforeSend hook、不需图片附件、不触发 isGenerating 流式态）。
   *
   * 生命周期：bashStart 广播（开始）→ pi bash RPC → bashResult 广播（终态）。
   * 返回 { blocked: true } 表示被预检拒绝（send.rejected 已广播）或执行失败（message.error 已广播），
   * 调用方（session-message-handler）据此走对应 ack 路径，与 sendMessage 的返回语义对称。
   */
  async sendBash(
    sessionId: string,
    command: string,
    excludeFromContext?: boolean,
  ): Promise<{ blocked: boolean; rejected?: boolean }> {
    // ── ensureActive(必要时 restore)──
    let client: IPiEngine
    try {
      client = await this.svc.ensureActive(sessionId)
    } catch (e) {
      const errMsg = `Failed to restore session: ${toErrorMessage(e)}`
      console.error(`[message-dispatcher] sendBash: ${errMsg}`)
      const errMsgObj = { type: 'message.error' as const, payload: { sessionId, message: errMsg } }
      this.broker.broadcast(errMsgObj)
      this.messageBus?.publish(sessionId, errMsgObj)
      throw e
    }

    // ── busy 预检（W2: bash↔streaming 放宽并发，对齐 pi-tui）──
    // 语义变化（w2）：bash 不再与 AI streaming（isGenerating）互斥，允许 streaming 期间执行 bash。
    // 原因（spec C1）：pi 把 bash RPC 排入 _pendingBashMessages，待当前 turn 结束后按 JSONL
    // 顺序回放——对 RPC 透明，runtime 侧无需排队等待。对齐 pi-tui 行为（pi-tui 允许 streaming 时发 bash）。
    // 保留的互斥（仍 reject）：
    // - isBashRunning：bash↔bash 互斥——pi 单 bash slot，并发会乱序。
    // - isCompacting：bash↔compact 互斥——compact 重写上下文，期间 bash 会读到半压缩状态。
    // 注意：sendMessage（sendPrompt）预检仍保留 isGenerating/isBashRunning/isCompacting 三者互斥，
    // 本期不放宽（spec OQ-1）——pi prompt 在 isStreaming 时强制要求 streamingBehavior 参数，
    // sendMessage 预检拒 isGenerating 是安全网。
    const activeSession = this.svc.getSessionByClient(client)
    if (activeSession) {
      if (activeSession.isCompacting || activeSession.isBashRunning) {
        console.warn(`[message-dispatcher] sendBash preemptive reject (busy), sid=${sessionId}`)
        const rejectMsg = { type: 'send.rejected' as const, payload: { sessionId, reason: 'busy' as const, message: 'Agent 正在处理' } }
        this.broker.broadcast(rejectMsg)
        this.messageBus?.publish(sessionId, rejectMsg)
        return { blocked: true, rejected: true }
      }
      activeSession.isBashRunning = true
      // [W1] 生成本次 sendBash 的代次令牌：abortBash 在广播 cancelled 终态前会旋转此 token
      // （清 undefined）。await 返回后比对 token，可判定是否被 abortBash 抢先收口。
      activeSession.bashRunToken = `bash_${Date.now()}_${randomTokenSuffix()}`
    }
    // [W1] 捕获本次 sendBash 的 token 到本地（abortBash 旋转后 activeSession.bashRunToken 已变，
    // 本地 myToken 不变，比对 myToken === activeSession.bashRunToken 即可判定未被抢收口）。
    const myToken = activeSession?.bashRunToken

    // ── bashStart 广播（实时反馈，与 bashResult 终态对称）──
    const excludeFlag = !!excludeFromContext
    const bashStartMsg = { type: 'message.bashStart' as const, payload: { sessionId, command, excludeFromContext: excludeFlag, timestamp: Date.now() } }
    this.broker.broadcast(bashStartMsg)
    this.messageBus?.publish(sessionId, bashStartMsg)

    // ── 调 pi bash + 广播终态 ──
    try {
      const result = await client.bash(command, excludeFromContext)
      // [W1] 竞态守卫：await 期间若 abortBash 被调用，它已置 isBashRunning=false 并广播
      // cancelled bashResult 终态（且旋转了 bashRunToken）。此处若再广播带真实 output 的
      // bashResult 会导致前端收到两条终态（先 cancelled 后真实结果），渲染错乱。
      // 检测 token 变化即说明被 abort 抢先收口，静默跳过本次广播。
      if (activeSession && myToken !== undefined && activeSession.bashRunToken !== myToken) {
        console.warn(`[message-dispatcher] sendBash: aborted during await, skip duplicate terminal. sid=${sessionId}`)
        return { blocked: true }
      }
      const bashResultMsg = {
        type: 'message.bashResult' as const,
        payload: {
          sessionId,
          command,
          output: result.output,
          exitCode: result.exitCode ?? null,
          cancelled: result.cancelled,
          truncated: result.truncated,
          excludeFromContext: excludeFlag,
          timestamp: Date.now(),
          ...(result.fullOutputPath !== undefined && { fullOutputPath: result.fullOutputPath }),
        },
      }
      this.broker.broadcast(bashResultMsg)
      this.messageBus?.publish(sessionId, bashResultMsg)
    } catch (e) {
      const errMsg = toErrorMessage(e)
      console.error(`[message-dispatcher] sendBash failed: sessionId=${sessionId}`, errMsg)
      // [W1] 竞态守卫：若 await 抛错是因 abortBash 抢先收口（如 abort_bash 触发 pi 关闭流），
      // 已有 cancelled bashResult 广播，此处不再发 message.error，避免双重报错。
      if (activeSession && myToken !== undefined && activeSession.bashRunToken !== myToken) {
        console.warn(`[message-dispatcher] sendBash: aborted during await (catch), skip duplicate error. sid=${sessionId}`)
        return { blocked: true }
      }
      // [S2] 对称兜底：与 abortBash「无论成败都广播 bashResult 终态」对称。
      // 前端 message.error handler 只收口 streaming **assistant** 消息（finalizeSession 按
      // role==='assistant' 过滤），不收口 role==='system' 的 streaming bash 消息——
      // 若只发 message.error，前端 bash 气泡会卡在 streaming 态。故此处补发一条
      // cancelled:false + exitCode:null + output 含错误信息的 bashResult 终态让 bash 收口。
      const bashResultErrMsg = {
        type: 'message.bashResult' as const,
        payload: {
          sessionId,
          command,
          output: `[bash error] ${errMsg}`,
          exitCode: null,
          cancelled: false,
          truncated: false,
          excludeFromContext: excludeFlag,
          timestamp: Date.now(),
        },
      }
      this.broker.broadcast(bashResultErrMsg)
      this.messageBus?.publish(sessionId, bashResultErrMsg)
      const bashErrMsg = { type: 'message.error' as const, payload: { sessionId, message: errMsg } }
      this.broker.broadcast(bashErrMsg)
      this.messageBus?.publish(sessionId, bashErrMsg)
      return { blocked: true }
    } finally {
      if (activeSession) {
        activeSession.isBashRunning = false
        // [W1] 复位 token：仅当 token 仍是本次 sendBash 的（未被 abortBash 旋转、
        // 也未被下一次 sendBash 覆盖）时才清，避免误清 abortBash 或后续 sendBash 的标记。
        if (myToken !== undefined && activeSession.bashRunToken === myToken) {
          activeSession.bashRunToken = undefined
        }
      }
    }
    return { blocked: false }
  }

  /**
   * 取消进行中的 bash 执行（pi abort_bash）。
   *
   * 与 abort() 对称：失败不 throw（console.error 兑底），finally 兑底广播 bashResult{cancelled:true}
   * 终态——与 abort 广播 message.complete{aborted} 对称，前端据 bashResult 收口 isBashRunning 态。
   */
  async abortBash(sessionId: string): Promise<void> {
    const client = this.getClientOrThrow(sessionId, 'abortBash')
    const activeSession = this.svc.getSessionByClient(client)
    // [W1] 守卫：当前没有 bash 在运行时短路返回，避免无条件广播 bashResult{cancelled:true}
    // 与 abort() 不需要守卫不同——abort 的 isGenerating 可能在 pi 卡死时残留，必须强制终态；
    // 而 isBashRunning 仅在 sendBash 显式置 true，用户对同一 session 重复 abortBash 时应静默跳过。
    if (!activeSession?.isBashRunning) return
    try {
      await client.abortBash()
    } catch (e) {
      // 与 abort() 的错误兑底一致：不 throw，避免请求级 envelope 双重报错。
      console.error(`[message-dispatcher] abortBash failed: sessionId=${sessionId}`, toErrorMessage(e))
    } finally {
      if (activeSession) {
        activeSession.isBashRunning = false
        // [W1] 旋转 token：通知 sendBash「已被 abort 抢先收口」。sendBash 在 await 返回后
        // 检测到 activeSession.bashRunToken !== myToken 即静默跳过终态广播，避免双终态。
        // 用新 token 而非清 undefined：若 sendBash 尚未读 myToken（仍在 await），清 undefined
        // 会让 sendBash 误判「无 abort」——而新 token 保证 sendBash 比对必然不等。
        activeSession.bashRunToken = `abort_${Date.now()}_${randomTokenSuffix()}`
      }
    }
    // 兑底终态：无论 pi 是否响应 abort_bash，都广播 cancelled=true 的 bashResult。
    // pi 卡死时不发任何事件，靠这条让前端 isBashRunning 复位（与 abort 广播 message.complete 同理）。
    const cancelMsg = {
      type: 'message.bashResult' as const,
      payload: {
        sessionId,
        command: '',
        output: '',
        exitCode: null,
        cancelled: true,
        truncated: false,
        excludeFromContext: false,
        timestamp: Date.now(),
      },
    }
    this.broker.broadcast(cancelMsg)
    this.messageBus?.publish(sessionId, cancelMsg)
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
  private getClientOrThrow(sessionId: string, op: 'abort' | 'steer' | 'followUp' | 'abortBash'): IPiEngine {
    const client = this.pm.getClient(sessionId)
    if (!client) {
      // abort 的历史报错串是 "Session X not found"（无前缀），steer/followUp 带 [message-dispatcher] 前缀。
      // 保持原样以免破坏依赖报错文本的测试。
      throw op === 'abort' || op === 'abortBash'
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

    // [W3 + M4] busy 预检：与 sendBash/sendMessage 的 isCompacting 拒绝对称 + 防并发 compact 重入。
    // 补 isCompacting：A 置位（interpreter 从 compaction_start 事件）后，B 进来预检若无 isCompacting
    // 看不到 A → 两个 client.compact RPC 并发 → 双 compaction 事件流。补上后事件层 P-dedup by construction 成立。
    //
    // 事件驱动（M4）：compaction 生命周期广播全删——由 interpreter 从 compaction_start/compaction_end
    // 唯一编排（session.compacting / message.compactionSummary / session.compacted / 对话流错误提示）。
    // dispatcher 退化为「预检 + RPC 触发 + 失败复位」三件事。
    const active = this.svc.getSessionByClient(client)
    if (active && (active.isBashRunning || active.isGenerating || active.isCompacting)) {
      const reason = active.isCompacting ? 'compaction already running'
        : active.isBashRunning ? 'bash running'
          : 'agent generating'
      const errMsg = `Cannot compact while ${reason}`
      console.warn(`[message-dispatcher] compact preemptive reject (busy), sid=${sessionId}, reason=${reason}`)
      // 零广播：不广播 session.compacted{error}。预检在 RPC 前，pi 未发 compaction_start，interpreter 不参与；
      // 错误经 throw → session-message-handler error envelope → useChat compact catch（MF-1：busy/transport 级失败
      // compaction_end 未到达 → catch toast 兜底；compaction 级失败由 interpreter 进对话流，catch 不 toast）。
      throw new Error(errMsg)
    }

    // 事件驱动（M4）：不广播 session.compacting、不置 active.isCompacting——均由 interpreter 从
    // compaction_start 事件驱动。dispatcher 只做 RPC 触发 + 失败复位。
    try {
      await client.compact(customInstructions)
      console.log('[message-dispatcher] compact: complete, sessionId=' + sessionId + ', elapsed=' + (Date.now() - startTime) + 'ms')
    } catch (e) {
      const errMsg = toErrorMessage(e)
      console.error('[message-dispatcher] compact: failed, sid=' + sessionId + ', err=' + errMsg + ', elapsed=' + (Date.now() - startTime) + 'ms')
      // 零广播：不广播 session.compacted{error}。pi 手动 compact 失败必发 compaction_end{errorMessage}
      // （agent-session.js:1464-1483 无静默路径），interpreter 统一编排失败提示（session.compacted{error} +
      // message.error 对话流提示）。此处只传播 RPC error，复位交由下方 finally（兜底防 transport 级失败
      // ——RPC 未达 pi / pi 来不及发 compaction_end——时 session 卡死）。
      throw e
    } finally {
      // 兜底复位：interpreter 的 compaction_end 是复位主力（三路对称），此处防 transport 级失败时
      // interpreter 未触发 compaction_end 导致 session 卡死。置位归 interpreter（compaction_start），
      // dispatcher 不置 true，故此处只写 false（对 false 无害，幂等）。
      if (active) active.isCompacting = false
    }
  }
}
