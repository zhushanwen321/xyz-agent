/**
 * MessageDispatcher — 从 session-service 巨石拆出的消息派发职责。
 *
 * 负责:sendMessage / abort / steerMessage / followUpMessage / compact +
 * sendMessageHook 注册。
 *
 * sendMessage 经 sendPrompt 骨架(hook 拦截 → ensureActive → 标记活跃 → prompt)。
 * [HISTORICAL] sendSubagentMessage(marker 拼装分支)已删除(composer 四符号设计 D2)——
 * 定向消息改走 session-service.subagentAction 直发 client.prompt,不经本骨架。
 *
 * 依赖经构造注入:svc(dispatcher 窄接口 IDispatcherSessionOps,按消费者收窄——
 * 调用点实测 6 方法,见 session-internal.ts)、
 * pm(getClient / 进程操作)、messageBus(发布,wave:perf-w09 接口收敛——
 * dispatcher 只依赖 publish 抽象,broker 依赖已删除:命令编排消息全部是
 * session 级 push 型,单通道走 bus 定向发布,broadcast 双写腿已收口)。
 */
import type { IDispatcherSessionOps } from './session-internal.js'
import type { IPiEngine, IProcessManager } from '../ports/pi-engine.js'
import type { SendMessageHook, PendingBashResultData } from './types.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import type { IMessageBus } from '../message-bus/message-bus.js'
import { toErrorMessage, RpcTimeoutError } from '../../utils/errors.js'

/** 生成代次 token 用的进制（base-36：数字 + 小写字母，紧凑且无符号字符）。 */
const RANDOM_TOKEN_RADIX = 36
/** Math.random().toString(N) 返回形如 "0.xxxx"，跳过前导 "0." 取随机段。 */
const RANDOM_TOKEN_SLICE_START = 2

/**
 * 时长换算系数（命名对齐 dialog-queue 惯例）：formatTimeoutDuration 的整时折算用，
 * 是纯单位换算（ms/秒、ms/分、ms/时）而非业务超时值——业务超时链值域 SSOT 在
 * packages/shared/src/timeouts.ts，两者语义不同禁止混用。
 */
const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000

/**
 * 超时时长的人类可读格式（诚实文案用）：整小时/整分钟取整表述，其余折算秒。
 * env 逃生门可把 bash RPC 超时调成任意值，文案必须如实反映实际等待上限（timeout-slow-flow-wallclock D2）。
 */
function formatTimeoutDuration(timeoutMs: number): string {
  if (timeoutMs >= MS_PER_HOUR && timeoutMs % MS_PER_HOUR === 0) return `${timeoutMs / MS_PER_HOUR} 小时`
  if (timeoutMs >= MS_PER_MINUTE && timeoutMs % MS_PER_MINUTE === 0) return `${timeoutMs / MS_PER_MINUTE} 分钟`
  return `${Math.round(timeoutMs / MS_PER_SECOND)} 秒`
}

/**
 * bash RPC 超时的合成终态诚实文案（§5.2 样例 6 三步恢复指引）。
 *
 * 设计要点：超时是「停止等待」不是「处决命令」——pi 侧命令可能仍在后台运行且照常落盘，
 * 文案必须诚实告知这一事实 + 给出可操作出路（取消 / 重开查结果 / 先取消再重跑），
 * 取代旧「[bash error] RPC ... timed out」的技术性误导措辞（用户误以为命令失败）。
 */
function buildBashTimeoutOutput(timeoutMs: number): string {
  return [
    `命令执行超过 ${formatTimeoutDuration(timeoutMs)}，已停止等待——命令可能仍在后台运行。`,
    '① 点 bash 气泡的取消（abortBash）可终止它；',
    '② 等它自然结束后，重开本 session 可在历史记录中看到完整结果；',
    '③ 需要立即重跑请先取消再发送。',
  ].join('\n')
}

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
    private readonly svc: IDispatcherSessionOps,
    private readonly pm: IProcessManager,
    private readonly workspaceService: WorkspaceService,
    private messageBus?: IMessageBus,
  ) {}

  /**
   * 后置注入 / 回填 MessageBus（SessionService.setMessageBus 同步回填调用）。
   *
   * bus 的两条注入通道：①构造参数（index.ts 构造 SessionService 时传导）；
   * ②SessionService.setMessageBus 后置注入路径——该路径下 dispatcher 已构造（bus 为
   * undefined），必须回填，否则全部 session 级发布静默 no-op（null-safe 但消息丢失）。
   */
  setMessageBus(bus: IMessageBus): void {
    this.messageBus = bus
  }

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
    return this.sendPrompt(sessionId, content, images)
  }

  /**
   * sendMessage 的发送骨架。
   * @param sessionId    会话 id
   * @param hookContent  hook 审核的文本(用户原文)
   * @param images       shared 形状图片附件（{data;mimeType}），透传给 client.prompt。
   *                     undefined 时不传 images，走原路径。
   */
  private async sendPrompt(
    sessionId: string,
    hookContent: string,
    images?: Array<{ data: string; mimeType: string }>,
  ): Promise<{ blocked: boolean; rejected?: boolean }> {
    // ── BeforeSend hook ──
    // blocked: 已广播 message.error（错误气泡），此处返回 {blocked:true} 让 handler 改发 error envelope。
    // modifiedContent: hook 改写后的文本（transform 语义，Fix-1），未改写时回退原文。
    const hookOutcome = await this.runBeforeSendHook(sessionId, hookContent)
    if (hookOutcome.blocked) {
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
    const promptText = hookOutcome.modifiedContent ?? hookContent
    try {
      await client.prompt(promptText, images)
    } catch (e) {
      const errMsg = toErrorMessage(e)
      console.error(`[message-dispatcher] prompt failed: sessionId=${sessionId}`, errMsg)
      if (activeSession) activeSession.isGenerating = false
      const errMsgMsg = { type: 'message.error' as const, payload: { sessionId, message: errMsg } }
      this.messageBus?.publish(sessionId, errMsgMsg)
      // 与 hook 拦截同等对待：已广播 message.error 气泡，返回 blocked 让 handler 走 error envelope（sendError），
      // renderer pending.reject 触发 Composer 恢复草稿。否则 handler reply success → pending.resolve 误判发送成功。
      return { blocked: true }
    }
    return { blocked: false }
  }

  /**
   * 运行 BeforeSend hook：返回 { blocked: true } 时调用方应中止发送；
   * 返回 { modifiedContent } 时调用方应以改写后的文本发送（transform 语义，Fix-1）。
   * 统一处理 hook 拦截（blocked）与 hook 自身异常（广播 message.error 后视作 blocked）。
   */
  private async runBeforeSendHook(
    sessionId: string,
    hookContent: string,
  ): Promise<{ blocked: boolean; modifiedContent?: string }> {
    if (!this.sendMessageHook) return { blocked: false }
    try {
      const hookResult = await this.sendMessageHook(sessionId, hookContent)
      if (hookResult?.blocked) {
        const msg = { type: 'message.error' as const, payload: { sessionId, message: hookResult.reason ?? 'Message blocked by plugin hook' } }
        this.messageBus?.publish(sessionId, msg)
        return { blocked: true }
      }
      if (typeof hookResult?.modifiedContent === 'string') {
        return { blocked: false, modifiedContent: hookResult.modifiedContent }
      }
      return { blocked: false }
    } catch (e) {
      console.error('[message-dispatcher] sendMessage hook error:', e)
      const msg = { type: 'message.error' as const, payload: { sessionId, message: 'Plugin hook error: ' + (toErrorMessage(e)) } }
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
      // 先取 active 再 destroy——destroySession 会删 processes/clientToId 条目，
      // 之后再经 getSessionByClient 反查会拿 undefined。
      const active = this.svc.getSessionByClient(client)
      if (active) active.isGenerating = false

      if (e instanceof RpcTimeoutError) {
        // D3a（integrity-hardening，修 M5）：abort RPC 超时 = pi 事件循环卡死（ping 3 连败
        // 已判定进程真死，event-interpreter ADR-0047）。仅收口（旧路径）会把卡死 client 留在
        // 进程表——用户每次发消息都命中同一 client → 60s 超时死循环，唯一恢复是删 session /
        // 重启 app。检测即收敛（原则 2）：强杀进程并走完与进程异常退出同构的收敛，下次发消息
        // ensureActive 自动 restore 新 pi（历史完整）。
        //
        // 收敛需在此手动编排而非依赖 pm.onSessionExit 回调：kill 路径的 exit 事件被双层
        // 守卫拦截（rpc-client.kill 置 _killing 跳过 exitCallback；process-manager 的 exit
        // 回调按 processes.has 拦截 intentional destroy），不会传播到 session-service 的
        // onSessionExit 收敛链。编排与 lifecycle.delete / onSessionExit 回调同构（detach →
        // session.exited → removeSessionEntry），非新发明。
        console.warn(`[message-dispatcher] abort RPC timed out (pi event loop frozen), force-destroying session ${sessionId}`)
        await this.forceQuitSession(sessionId, `Abort failed (pi unresponsive): ${errMsg}`, 'pi 无响应（事件循环卡死），进程已强制终止。重发消息即可恢复（自动重启进程，历史完整）')
        return
      }

      // 非超时错误（EPIPE / 进程已退出 / RPC 显式失败等）：保持现行 abort 收口行为。
      // W4：abort 失败（异常退出）写 stopped 终态
      this.svc.persistSessionOutcome(sessionId, 'stopped', `Abort failed: ${errMsg}`)
      const abortErrMsg = { type: 'message.error' as const, payload: { sessionId, message: `Abort failed: ${errMsg}` } }
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
    this.messageBus?.publish(sessionId, completeMsg)
  }

  /**
   * forceQuit —— 强制退出 session（session.forceQuit）：跳过协作式 abort RPC，直接杀 pi
   * 进程并走与 abort 超时相同的收敛编排。
   *
   * 场景：pi 卡在 processing（前端 isGenerating 已丢失 / retry 窗口等不一致态），Composer
   * 无 stop 按钮可用、新 prompt 被 pi 拒绝——用户从 sidebar 右键「强制退出」让进程退出；
   * session.exited 广播后前端标记 dead，点击 dead session 走 restore 重开（历史完整）。
   */
  async forceQuit(sessionId: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) {
      // 不在活跃进程表（已退出 / 未 spawn）：无可杀对象，幂等成功。菜单入口对 dead/idle
      // 历史 session 隐藏，此分支是「菜单渲染后 session 恰好退出」的竞态兑底。
      console.log(`[message-dispatcher] forceQuit: session ${sessionId} not active, nothing to kill`)
      return
    }
    console.warn(`[message-dispatcher] force quit requested by user, killing session ${sessionId}`)
    await this.forceQuitSession(sessionId, 'User forced quit', '用户强制退出，进程已终止。重新打开该 session 即可恢复（历史完整）。')
  }

  /**
   * 强杀收敛编排（abort RPC 超时路径与 forceQuit 共用）：detach → destroy → persist stopped →
   * 广播 session.exited → removeEntry。收敛需手动编排而非依赖 pm.onSessionExit 回调：kill 路径
   * 的 exit 事件被双层守卫拦截（rpc-client.kill 置 _killing 跳过 exitCallback；process-manager
   * 的 exit 回调按 processes.has 拦截 intentional destroy），不会传播到 session-service 的
   * onSessionExit 收敛链。编排与 lifecycle.delete / onSessionExit 回调同构，非新发明。
   *
   * outcomeReason 进终态 entry（诊断）；exitReason 经 session.exited 广播给用户（可操作指引）。
   */
  private async forceQuitSession(sessionId: string, outcomeReason: string, exitReason: string): Promise<void> {
    // 先 detach 再 destroy——destroySession 会删 processes/clientToId 条目，
    // 之后再经 getSessionByClient 反查会拿 undefined。
    this.svc.detachSession(sessionId)
    await this.pm.destroySession(sessionId)
    // stopped 终态须在 removeSessionEntry 前写（persistSessionOutcome 内部按 id 查
    // sessions Map，条目删除后静默跳过）。
    this.svc.persistSessionOutcome(sessionId, 'stopped', outcomeReason)
    // session.exited 须在 removeSessionEntry 前发（其后 messageBus.clearSession 清空
    // 订阅者集合，再发等于空投，前端一条也收不到）。code=null：强杀场景退出码未知，
    // 与 shared 协议「被信号杀死无退出码」语义一致。前端 handleSessionExited 会把
    // reason 作为 error 消息插入聊天流 + toast（与 pi 崩溃路径同一入口）。
    const exitedMsg = { type: 'session.exited' as const, payload: { sessionId, code: null, reason: exitReason } }
    this.messageBus?.publish(sessionId, exitedMsg)
    this.svc.removeSessionEntry(sessionId)
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
   * [W1 fix-chat-flow-order D2] bashResult 双分支延迟——镜像 pi recordBashResult 的双分支
   * （agent-session.js:2225-2247：streaming 期间 bash 缓存到 _pendingBashMessages、级联结束
   * 统一落盘；空闲立即落盘），消除「live 即时入流 vs 文件级联末落盘」的顺序分叉（重开分组跳变）：
   * - session streaming（isGenerating，活跃 run）→ 结果压入 activeSession.pendingBashResults
   *   待落列（不立即广播），agent_settled（级联结束，晚于 pi finally flush 的 bash 落盘，
   *   探针 ②）到达时 flushPendingBashResults 按序以帧发布；
   * - 空闲 → 立即以帧发布。
   * 前端（core registry bashResult handler）把帧转 bashExecution entry 经 applyEntryFrame 入流
   * ——两侧位置都构造性等于 pi 落盘位置。
   *
   * 生命周期：bashStart 广播（开始，执行中反馈——前端 ephemeral executingBash 态，不建消息）
   * → pi bash RPC → bashResult 广播（终态，双分支延迟如上）。
   * 返回 { blocked: true } 有四种形态（一致性审查 SG-A1 修订——catch abort skip 是 D1 新增分支）：
   * 预检拒绝（send.rejected 已广播）、执行失败（message.error + 错误 bashResult 终态帧均已广播）、
   * catch abort skip（**不广播**——abortBash 已抢先收口广播哨兵帧，token 不匹配即跳过，D1 收窄
   * 后唯一残余例外⑤）、空命令哨兵不变式早退（**不广播**——程序不变式守卫非用户可见错误，见方法头；
   * 实施审查 SG-2：调用方对后两种形态的 ack 文案失真已知，归 bash 互斥专项）。
   * 调用方（session-message-handler）据此走对应 ack 路径，与 sendMessage 的返回语义对称。
   */
  async sendBash(
    sessionId: string,
    command: string,
    excludeFromContext?: boolean,
  ): Promise<{ blocked: boolean; rejected?: boolean }> {
    // ── 哨兵不变式守卫（D1 closure，实施审查 S-2 上移至真正入口）──
    // bash-effects 哨兵帧判定 command === '' && cancelled（识别 abortBash 兜底广播、只清态不产
    // entry）。真实帧 command 恒非空是「约定」——空命令在此早退使其升级为结构性不变式：入口
    // 不可能发出 command === '' 的 bash，两类帧永不混淆。程序不变式守卫（UI `!` 解析必出非空
    // 命令，正常不可达）：不广播 send.rejected / message.error（非用户可见错误，广播会以失真
    // 文案打扰），仅 console.warn 留痕；blocked 返回值仅为类型完备。
    if (command === '') {
      console.warn(`[message-dispatcher] sendBash: empty command rejected (sentinel invariant), sid=${sessionId}`)
      return { blocked: true }
    }

    // ── ensureActive(必要时 restore)──
    let client: IPiEngine
    try {
      client = await this.svc.ensureActive(sessionId)
    } catch (e) {
      const errMsg = `Failed to restore session: ${toErrorMessage(e)}`
      console.error(`[message-dispatcher] sendBash: ${errMsg}`)
      const errMsgObj = { type: 'message.error' as const, payload: { sessionId, message: errMsg } }
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
    this.messageBus?.publish(sessionId, bashStartMsg)

    // ── 调 pi bash + 广播终态 ──
    try {
      const result = await client.bash(command, excludeFromContext)
      // [W1 → D1 closure 修订] abort 抢收口守卫：await 期间若 abortBash 被调用，它已广播
      // 哨兵帧（command:''，bash-effects 只清 executingBash 不产 entry）并旋转 token。旧逻辑
      // 在此静默丢弃真实结果——但 pi 侧 recordBashResult 对 cancelled 无分支照常落盘
      // （bash-executor abort 返回 cancelled 结果而非 throw），丢弃导致 live 无记录、重开多出
      // 一条（登记例外①）。哨兵帧与真实帧职责正交（一个只清态、一个产 entry，均幂等），
      // 双终态担忧不成立——故此处不再跳过，发布真实数据（含 streaming 双分支延迟，与 pi
      // 落盘位置一致）。例外收窄登记：仅 catch 分支（transport 抛错，无真实数据可发布）
      // 维持哨兵不产 entry。
      if (activeSession && myToken !== undefined && activeSession.bashRunToken !== myToken) {
        console.warn(`[message-dispatcher] sendBash: aborted during await, publishing real cancelled terminal. sid=${sessionId}`)
      }
      // 终态数据在 RPC 完成时刻构造（timestamp = pi recordBashResult 落盘时刻，非 flush 时刻，
      // 保证与文件 entry timestamp 一致）。emit 只传单个 payload 对象。
      const bashResultData: PendingBashResultData = {
        command,
        output: result.output,
        exitCode: result.exitCode ?? null,
        cancelled: result.cancelled,
        truncated: result.truncated,
        excludeFromContext: excludeFlag,
        timestamp: Date.now(),
        ...(result.fullOutputPath !== undefined && { fullOutputPath: result.fullOutputPath }),
      }
      // [W1 fix-chat-flow-order D2] 双分支镜像 pi recordBashResult（agent-session.js:2237-2247）：
      // pi 在 isStreaming 时把 bash 缓存到 _pendingBashMessages（run 级联 finally 统一落盘），
      // xyz 镜像为——session 处于活跃 run（isGenerating）时结果进待落列，agent_settled
      // （级联结束信号，晚于 pi 的 finally flush，探针 ②）到达时 flushPendingBashResults
      // 按序发布；空闲立即发布。已知窄竞态（设计已登记）：xyz 判空闲但 pi 实际 streaming
      // 的窗口内两侧位置短暂不一致，重开后以文件为准收敛。
      if (activeSession?.isGenerating) {
        activeSession.pendingBashResults = [...(activeSession.pendingBashResults ?? []), bashResultData]
      } else {
        this.publishBashResult(sessionId, bashResultData)
      }
    } catch (e) {
      const errMsg = toErrorMessage(e)
      console.error(`[message-dispatcher] sendBash failed: sessionId=${sessionId}`, errMsg)
      // [W1] 竞态守卫：若 await 抛错是因 abortBash 抢先收口（如 abort_bash 触发 pi 关闭流），
      // 已有 cancelled bashResult 广播，此处不再发 message.error，避免双重报错。
      if (activeSession && myToken !== undefined && activeSession.bashRunToken !== myToken) {
        console.warn(`[message-dispatcher] sendBash: aborted during await (catch), skip duplicate error. sid=${sessionId}`)
        return { blocked: true }
      }
      // [D2 timeout-slow-flow-wallclock] bash RPC 超时（RpcTimeoutError，字段化 commandType/
      // timeoutMs）：合成终态换诚实文案（三步恢复指引），不自动 abort_bash——超时是「停止
      // 等待」不是「处决命令」，pi 侧照常执行并 recordBashResult 落盘，重开 session 可见真实
      // 结果；迟到响应维持既有丢弃机制（rpc-client timedOutIds/NULL_EVENTS，本分支不动）。
      // 此处 pi 未卡死（bash 长跑是合法活跃任务，ADR-0047 静默≠卡死），与 abort() 的
      // RpcTimeoutError→强杀自愈分支语义不同，不得复用强杀路径。
      if (e instanceof RpcTimeoutError) {
        const honestOutput = buildBashTimeoutOutput(e.timeoutMs)
        // P6 断言④：超时是「停止等待」不是「处决」——pi 侧孤儿 bash 仍在跑。置孤儿标记让
        // abortBash 守卫放行（诚实文案第①步「abortBash 可终止」的 runtime 承诺），
        // abort_bash 发出且 pi 确认后由 abortBash 清除（见 abortBash）。
        if (activeSession) activeSession.orphanBashRunning = true
        // 错误帧不进待落列（立即发布）：xyz 合成帧，无 pi 落盘时序语义（同下方通用错误分支）。
        this.publishBashResult(sessionId, {
          command,
          output: honestOutput,
          exitCode: null,
          cancelled: false,
          truncated: false,
          excludeFromContext: excludeFlag,
          timestamp: Date.now(),
        })
        // [P6 deviation] 不广播 message.error 技术帧（'RPC command "bash" timed out after...'）：
        // Gate B 实测它与诚实气泡在聊天流双条目并存（renderer 把 message.error 插入对话流），
        // 与 G2「诚实告知」矛盾；诊断信息由 error envelope（session-message-handler blocked
        // 分支）+ runtime 日志承载，用户可见面只保留诚实气泡。
        return { blocked: true }
      }
      // [S2] 对称兜底：与 abortBash「无论成败都广播 bashResult 终态」对称。
      // 前端 message.error handler 只收口 streaming **assistant** 消息（finalizeSession 按
      // role==='assistant' 过滤），不收口 role==='system' 的 streaming bash 消息——
      // 若只发 message.error，前端 bash 气泡会卡在 streaming 态。故此处补发一条
      // cancelled:false + exitCode:null + output 含错误信息的 bashResult 终态让 bash 收口。
      // [W1 fix-chat-flow-order] 错误帧不进待落列（立即发布）：它是 xyz 合成帧，无 pi 落盘
      // 时序语义；且失败场景（transport 断/pi 死）级联可能永不结束，延迟会让用户无反馈。
      this.publishBashResult(sessionId, {
        command,
        output: `[bash error] ${errMsg}`,
        exitCode: null,
        cancelled: false,
        truncated: false,
        excludeFromContext: excludeFlag,
        timestamp: Date.now(),
      })
      const bashErrMsg = { type: 'message.error' as const, payload: { sessionId, message: errMsg } }
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
   * 发布单条 bashResult 帧（sendBash 空闲分支 / 错误兜底 / 待落列 flush 共用）。
   * emit 只传单个 payload 对象（架构规则 1）。
   */
  private publishBashResult(sessionId: string, data: PendingBashResultData): void {
    this.messageBus?.publish(sessionId, { type: 'message.bashResult' as const, payload: { sessionId, ...data } })
  }

  /**
   * [W1 fix-chat-flow-order D2] 按 sessionId 定向 flush bash 待落列。
   *
   * 触发：pi agent_settled（run 级联结束）经 EventInterpreter.onAgentSettled →
   * sessionService.flushPendingBashResults 到达（组合根 index.ts 接线）。时序保证（探针 ②）：
   * pi 在 _runAgentPrompt finally 先 _flushPendingBashMessages（bash entry 统一落盘，
   * agent-session.js:754）再 _emitAgentSettled（:755），故本方法发布帧时 pi 文件内 bash
   * entry 已就位，live 入流位置（级联末）与落盘位置一致。
   *
   * 语义：按入列序（= pi RPC 完成序 = pi _pendingBashMessages 落盘序）发布；先清空再发布
   * （发布中若新 bash 压入，下一轮 settled flush 处理，不混批）。session 已删除 → 条目随
   * session 对象丢弃（挂 activeSession 同区的生命周期语义，见 types.ts 注释），此处自然 no-op。
   */
  flushPendingBashResults(sessionId: string): void {
    const session = this.svc.getSession(sessionId)
    const queue = session?.pendingBashResults
    if (!session || !queue || queue.length === 0) return
    session.pendingBashResults = []
    for (const data of queue) {
      this.publishBashResult(sessionId, data)
    }
  }

  /**
   * 取消进行中的 bash 执行（pi abort_bash）。
   *
   * 与 abort() 对称：失败不 throw（console.error 兑底），finally 兑底广播 bashResult{cancelled:true}
   * 终态——与 abort 广播 message.complete{aborted} 对称，前端据 bashResult 收口 isBashRunning 态。
   *
   * 返回 sent = abort_bash 是否真的发出且 pi 确认（P6 断言④回执真实化）：调用方
   * （session-message-handler）据此决定回执——sent=true 才回 message.status{aborted}，
   * sent=false（守卫短路 / 发送失败）不得谎报 aborted。
   */
  async abortBash(sessionId: string): Promise<{ sent: boolean }> {
    const client = this.getClientOrThrow(sessionId, 'abortBash')
    const activeSession = this.svc.getSessionByClient(client)
    // [W1 + P6 断言④] 守卫：isBashRunning（runtime 在等待）或 orphanBashRunning（D2 超时后
    // runtime 已停止等待但 pi 侧孤儿 bash 仍在跑）任一在 → 放行。旧守卫只看 isBashRunning，
    // 语义「runtime 不等待 = 无命令在跑」与 D2 超时形态「停止等待 ≠ 处决」冲突——超时后
    // abort_bash 被短路永不发出，诚实文案第①步「abortBash 可终止」落空，UI 却仍收 aborted。
    // 两态皆无（空闲 session 的重复/误触取消）→ 短路 { sent: false }，由调用方回执真实化。
    if (!activeSession?.isBashRunning && !activeSession?.orphanBashRunning) return { sent: false }
    // sent = abort_bash 是否发出且 pi 确认（sendCommand 对 success:false reject，resolve =
    // pi 已执行 abort）。失败不提前 return：兑底 cancelled 哨兵广播必须照发（T8b 既有契约）。
    let sent = true
    try {
      await client.abortBash()
      // pi 确认取消 → 孤儿标记清除（pi 单 bash slot，孤儿已终止）。
      if (activeSession) activeSession.orphanBashRunning = false
    } catch (e) {
      // 与 abort() 的错误兑底一致：不 throw，避免请求级 envelope 双重报错。孤儿标记保留：
      // abort_bash 失败（pi 卡死/管道断）时 bash 状态未知，标记残留只让下次 abortBash 再发
      // 一次幂等的 abort_bash，比误清（谎称无孤儿）更诚实。
      console.error(`[message-dispatcher] abortBash failed: sessionId=${sessionId}`, toErrorMessage(e))
      sent = false
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
    this.messageBus?.publish(sessionId, cancelMsg)
    return { sent }
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
