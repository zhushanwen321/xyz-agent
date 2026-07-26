/**
 * HandoffService —— fast-handoff 功能的 runtime 编排层。
 *
 * 职责：用户在源 session 点 handoff → 触发 pi 跑 /skill:handoff 生成文档 →
 * 监听 agent_end → 取末条 assistant 文档 → xml tag 包装 → 新建空白 session →
 * 注入首条 → 广播跳转。
 *
 * 镜像 fork 的 runtime 链路（session-lifecycle.ts forkSession），但 handoff 是
 * "打包交接到新线程"而非"从某点分叉"——不继承历史，只注入 handoff 文档。
 *
 * 完成判定：pi 无 skill 专属完成事件，靠 EventInterpreter 的 onTurnFinalize opt
 * 回调（经组合根 index.ts 接线到 onTurnEnd）确认 /skill:handoff 跑完。文档内容
 * 从 agent_end 后的末条 assistant 取（BLOCKER 1：tail 读 pi JSONL 文件，降级 getHistory），
 * 不监听 file-write tool_call（文件名不可预知）。
 *
 * 编排链路全异步（runHandoff 触发 → onTurnEnd 收尾），失败/取消经两条独立通道：
 *   - 取消（abortHandoff）：inflight.aborted 标记 + 委托 SessionService.abort 中断 pi turn
 *   - 失败（文档空/新建 session 抛错）：广播 message.error 反馈到源 session 对话流
 */
import type { IMessageBroker } from '../interfaces.js'
import type { IProcessManager } from './ports/pi-engine.js'
import type { SessionService } from './session/session-service.js'
import { normalizeContent } from '@xyz-agent/shared'
import type { Segment } from '@xyz-agent/shared'
import { wrapWithXmlTag } from './handoff-formatter.js'
import { readTailBytes } from '../utils/jsonl.js'

/**
 * 进行中的 handoff 状态（per-session，同一 session 不可并发 handoff）。
 *
 * SUGGESTION 1：原含 startedAt / focus 字段但均未被 read（startedAt 仅 set，focus 仅 set——
 * runHandoff 拼命令用的是入参 focus 而非 inflight.focus）。删除死字段，仅保留 aborted
 * （abort() set → onTurnEnd line ~107 消费）。
 */
interface HandoffInProgress {
  /** 用户取消标记。onTurnEnd 检测后跳过新建/注入（只清理 inflight）。 */
  aborted?: boolean
}

interface HandoffServiceOpts {
  sessionService: SessionService
  broker: IMessageBroker
  pm: IProcessManager
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
   * WARNING nextPushId：handoffComplete / message.error 原用 Date.now() 可能碰撞，
   * 且与其他广播点 nextPushId() 不一致。
   */
  nextPushId: () => string
}

/** SUGGESTION 3：focus（来自客户端 payload.focus，trust boundary 外）截断阈值。 */
const FOCUS_MAX_LENGTH = 500
/**
 * BLOCKER 1：extractHandoffDoc 尾读窗口大小（256KB，覆盖最近若干 turn，长 session 不全读）。
 * 与 session-history.ts 的 TAIL_WINDOW 同量级（256KB 起步），handoff 文档总在 turn 末尾，256KB 充裕。
 */
// eslint-disable-next-line no-magic-numbers -- 256KB tail window，与 session-history.ts TAIL_WINDOW 对齐
const HANDOFF_DOC_TAIL_BYTES = 256 * 1024

export class HandoffService {
  /** per-session 进行中状态。同一 session 不可并发 handoff（runHandoff 守卫拒绝）。 */
  private readonly inflight = new Map<string, HandoffInProgress>()
  private readonly opts: HandoffServiceOpts

  constructor(opts: HandoffServiceOpts) {
    this.opts = opts
  }

  /**
   * 触发 handoff：让源 session 的 pi 跑 /skill:handoff 生成文档。
   * 文档产出完成后的编排（新建+注入+广播）在 onTurnEnd 回调里做。
   *
   * @throws session 不活跃（pi 进程不存活，需先 restore）/ 已有进行中 handoff
   */
  async runHandoff(srcSessionId: string, focus?: string): Promise<void> {
    // 并发守卫：同一 session 不可并发 handoff（否则两个 /skill:handoff turn 互相干扰，
    // onTurnEnd 无法区分是哪个触发的）。
    if (this.inflight.has(srcSessionId)) {
      throw new Error(`handoff already in progress for session ${srcSessionId}`)
    }
    // 标记进行中（在 prompt 之前 set，保证 onTurnEnd 回调时 inflight 已有条目——
    // 否则 agent_end 早于 set 完成时 onTurnEnd 会误判为非 handoff turn 而忽略）。
    this.inflight.set(srcSessionId, {})

    const client = this.opts.pm.getClient(srcSessionId)
    if (!client) {
      // session 不活跃：清理 inflight 后抛错，让 handler 走 error envelope 引导用户 restore。
      this.inflight.delete(srcSessionId)
      throw new Error(`handoff: source session ${srcSessionId} is not active, restore it first`)
    }
    // TOCTOU 守卫：inflight.set 与 client.prompt 之间，abort() 可能已标记 aborted=true
    // （用户立即取消）。此时 prompt 不应触发（用户已取消），直接清理 inflight 收尾——
    // 否则 prompt 启动新 turn，但 abort 路径的 onTurnEnd（经 dispatcher.abort 广播的
    // message.complete{aborted}）已 delete inflight，新 agent_end 找不到 inflight → 文档静默丢弃，
    // 用户 abort 了却仍跑了 handoff skill（无产出）。
    if (this.inflight.get(srcSessionId)?.aborted) {
      this.inflight.delete(srcSessionId)
      return
    }
    // SUGGESTION 3：focus 来自客户端 payload.focus（trust boundary 外），sanitize 后拼到 pi 命令——
    // 去换行（防注入额外行）+ 截断（防超长 prompt）。pi 按首个空格切分作 args 透传到 handoff skill。
    const safeFocus = focus ? sanitizeFocus(focus) : ''
    const cmd = safeFocus ? `/skill:handoff ${safeFocus}` : '/skill:handoff'
    // client.prompt 抛错时 inflight 残留——但 onTurnEnd 永不触发（pi turn 没跑起来），
    // 故在此 catch 清理，避免泄漏 + 让 handler 走 error envelope。
    try {
      await client.prompt(cmd)
    } catch (e) {
      this.inflight.delete(srcSessionId)
      throw e
    }
  }

  /**
   * agent_end 回调：pi 跑完 handoff skill 后触发。
   * 被 EventInterpreter 的 onTurnFinalize opt 调用（组合根 index.ts 接线）。
   *
   * stopReason='aborted'（用户取消 pi turn）或 inflight.aborted（用户 abortHandoff）→
   * 只清理，不执行新建/注入。否则取文档 → 包装 → 新建 session → 注入 → 广播 → 清理。
   *
   * 非 handoff 触发的 turn-end（inflight 无条目）直接 return——本回调挂在所有 turn-end 上，
   * 但只有 runHandoff 标记过的 session 才走编排。
   */
  async onTurnEnd(sessionId: string, stopReason?: string): Promise<void> {
    const inflight = this.inflight.get(sessionId)
    if (!inflight) return  // 非 handoff 触发的 turn-end，忽略

    try {
      if (stopReason === 'aborted' || inflight.aborted) {
        return  // 用户取消，不执行新建/注入
      }
      // WARNING 3：pi 跑 /skill:handoff 以 stopReason='error' 结束（model error / skill 失败）。
      // 继续往下走可能取到 partial/error 的末条 assistant 当文档注入——按失败处理广播错误，
      // 跳过编排（与 'aborted' 并列分支）。参考空文档分支（broadcastHandoffError）模式。
      if (stopReason === 'error') {
        this.broadcastHandoffError(sessionId, 'handoff 失败：pi 报错')
        return
      }

      // 取文档：pi 跑完 /skill:handoff 后末条 assistant 即文档内容。
      // 降级 getHistory 取末条 assistant（onTurnFinalize 签名只传 sessionId + stopReason，无 finalContent）。
      const doc = await this.extractHandoffDoc(sessionId)
      if (!doc) {
        // 文档为空 → handoff 失败（skill 未产出文档），广播错误反馈到源 session 对话流
        this.broadcastHandoffError(sessionId, 'handoff 文档为空，生成失败')
        return
      }

      // 取源 session 信息（cwd 复用到新 session；label 作 xml source 展示）
      const srcSession = this.opts.sessionService.getSession(sessionId)
      if (!srcSession) {
        // M1：srcSession undefined——session 在 dispatch 与 onTurnEnd 之间变为非活跃或被 detach。
        // 此时无法取 cwd，create(undefined) 会回退 process.cwd()（runtime cwd，非用户源工作目录），
        // 导致新 agent 在错误 cwd 启动。报错让用户感知 + return（finally 仍清理 inflight）。
        this.broadcastHandoffError(sessionId, 'handoff: 源 session 信息不可用，无法获取工作目录')
        return
      }
      const srcCwd = srcSession.cwd
      const srcLabel = srcSession.label || sessionId

      // 包装文档（xml tag 边界 + action-oriented 后缀）
      const wrapped = wrapWithXmlTag(doc, srcLabel)

      // 新建空白 session（复用源 cwd，保证新 agent 在同一工作目录干活）
      const newSession = await this.opts.sessionService.create(srcCwd, `handoff from ${srcLabel}`)
      const newId = newSession.id

      // 标记源 session 已交接（内存 handedOffTo + 磁盘 handoff_marker）。
      // M3：经 SessionService.markHandedOff 收口（拥有 sessions Map + sessionFilePath），
      // 不直接改 srcSession.handedOffTo 绕过所有权——getSession 若返回防御性副本会让直接写入失效。
      // toSummary 透传 handedOffTo → 活跃态立即生效；磁盘 marker → scanner 重扫后回填。
      this.opts.sessionService.markHandedOff(sessionId, newId)

      // 广播完成（payload 带 wrapped doc）。发送职责归位 renderer——前端收到后 ensureStreamSubscription
      // 再 chatApi.send(doc)，避免 runtime 早 send 导致的时序竞争（sendMessage 在 pi ack 即 resolve，
      // 早于前端订阅建立，pi 流式 message.* 事件被 events.dispatchSession 静默丢弃）。
      // 对齐 fork-ask（useForkActions.ts:109-113 send 前先建订阅）。doc 是 wrapWithXmlTag 包装后的
      // 完整文档，前端直接 send 不需再处理。
      //
      // BLOCKER 2：先 broadcastSessionList 再 handoffComplete——session 级 broadcast 在创建流程
      // 内部发出会早于 renderer 订阅；session.handoffComplete 是 session 级消息（按 srcSessionId 路由），
      // 若 WS 在 handoff 完成窗口断开重连则丢失（无订阅者）。broadcastSessionList 是标准恢复机制
      // （与 session.create/fork/delete/rename 一致，session-message-handler.ts:43/71/134/228）。
      this.opts.broadcastSessionList()
      // WARNING 1：payload 加 sessionId（与 message.error 一致，message.error 在 line ~226 已含 sessionId）。
      // renderer useConnection.ts:123-124 对每条缺 sessionId 的 session.* 消息打 console.warn。
      // 保留 srcSessionId / newSessionId 不变（renderer 已依赖）。sessionId 用 srcSessionId 让路由命中源 panel。
      // WARNING nextPushId：用 nextPushId()（与 broker 其他广播点一致），避免 Date.now() 碰撞。
      this.opts.broker.broadcast({
        type: 'session.handoffComplete',
        id: this.opts.nextPushId(),
        payload: { sessionId, srcSessionId: sessionId, newSessionId: newId, doc: wrapped },
      })
    } catch (e) {
      // 编排失败（create 抛错），广播错误反馈到源 session 对话流。
      // 不让异常逃逸到 EventInterpreter（否则被其 per-event catch 吞掉，用户无感知）。
      const msg = e instanceof Error ? e.message : String(e)
      this.broadcastHandoffError(sessionId, `handoff 失败: ${msg}`)
    } finally {
      this.inflight.delete(sessionId)
    }
  }

  /**
   * 取消进行中的 handoff。
   * 委托 SessionService.abort 中断 pi turn（复用 message-dispatcher 的 abort 兜底广播路径）。
   * onTurnEnd 会检测 inflight.aborted 标记跳过新建/注入。无进行中 handoff 时 no-op。
   */
  async abort(sessionId: string): Promise<void> {
    const inflight = this.inflight.get(sessionId)
    if (!inflight) return
    inflight.aborted = true
    await this.opts.sessionService.abort(sessionId)
  }

  /**
   * 清理进行中 handoff 的 inflight 条目（无副作用，不调 pi abort）。
   *
   * 用于 session 被删除场景（用户主动 delete / pi 进程崩溃 → onSessionExit）：
   * 此时 agent_end 永不触发（无 pi turn 收尾事件），onTurnEnd 不会被调用，
   * inflight 条目会永久泄漏。组合根经 SessionService.onSessionDelete 钩子挂钩调用本方法。
   *
   * 与 abort() 区别：abort 设 aborted 标记 + 委托 SessionService.abort 中断 pi turn
   * （pi 仍在跑，需打断 + onTurnEnd 后续走 aborted 分支跳过编排）；本方法是 pi turn
   * 已经不存在（session 没了）时的纯内存清理。无进行中 handoff 时 no-op。
   */
  cancelInflight(sessionId: string): void {
    this.inflight.delete(sessionId)
  }


  /**
   * 从 agent_end 后的对话流提取 handoff 文档。
   *
   * BLOCKER 1：原依赖 sessionService.getHistory()（走 pi RPC，agent_end 时 pi 可能尚未把
   * 最终 turn flush 到内存 history——RPC 返回空且因 isGenerating 守卫不回退文件尾读）→
   * 取不到末条 assistant → 误报「文档为空」。改为直接 tail 读 session JSONL 文件
   * （pi 持久化文件已落盘——pi agent_end 即意味着该 turn 已 _persist），从尾部倒序找
   * 最后一条 type='message' && role='assistant' 的 entry。fs 失败 / 无 sessionFilePath /
   * 无匹配 entry 时 fallback 调 getHistory() 作兜底（保留原行为作为最后手段）。
   *
   * @returns 文档字符串；无 assistant 消息（skill 未产出）返回 undefined
   */
  private async extractHandoffDoc(sessionId: string): Promise<string | undefined> {
    // 从 active session 视图拿 sessionFilePath（pi 落盘的 JSONL 路径）。
    const session = this.opts.sessionService.getSession(sessionId)
    const filePath = session?.sessionFilePath
    if (filePath) {
      try {
        const doc = readLastAssistantFromJsonlFile(filePath)
        if (doc !== undefined) return doc
        // 尾窗口未命中（极长 session 且 handoff turn 早被挤出 256KB 窗口）——继续走兜底。
      } catch (e) {
        // fs 失败（EACCES 等）——继续走 getHistory 兜底，并记录日志便于诊断。
        console.warn(`[handoff] extractHandoffDoc tail read failed for ${filePath}, falling back to getHistory:`, e)
      }
    }
    // 兜底：保留原 getHistory 行为（pi RPC + 文件 tail fallback）。其 isGenerating 守卫
    // 不可靠（agent_end 时序），故只作最后手段。
    try {
      const { messages } = await this.opts.sessionService.getHistory(sessionId)
      if (!messages || messages.length === 0) return undefined
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.role === 'assistant') {
          // content 可能是 string（assistant 热路径）或 Segment[]（少数情况），统一归一为纯文本
          const content = normalizeContent(m.content)
          return content || undefined
        }
      }
      return undefined
    } catch (e) {
      // getHistory 也失败（pi RPC broken / 无 client / 文件被删）——记录后返回 undefined，
      // onTurnEnd 上层据此广播「文档为空」错误反馈。
      console.warn(`[handoff] extractHandoffDoc getHistory fallback failed for ${sessionId}:`, e)
      return undefined
    }
  }

  /**
   * 广播 handoff 错误反馈到源 session 对话流。
   *
   * 复用 message.error 通道（与 message-dispatcher 的流式错误广播同模式）：
   * payload { sessionId, message }，前端在聊天流渲染错误气泡。区别于请求级 error
   * envelope（走 pending.reject）——handoff 是异步编排，无 pending request 可 reject，
   * 错误只能经 server-push 通道反馈到对话流让用户看到。
   */
  private broadcastHandoffError(sessionId: string, errorMsg: string): void {
    // WARNING nextPushId：用 nextPushId()（与 broker 其他广播点一致），避免 Date.now() 碰撞。
    this.opts.broker.broadcast({
      type: 'message.error',
      id: this.opts.nextPushId(),
      payload: { sessionId, message: errorMsg },
    })
  }
}

/**
 * BLOCKER 1：tail 读 pi JSONL 文件，倒序找最后一条 type='message' && role='assistant' &&
 * content 非空的 entry，返回归一化后的文本。
 *
 * pi JSONL entry 结构见 session-history.ts 的 mapEntriesToPiMessages：
 *   { type: 'message', id: ..., message: { role: 'assistant', content: string | Segment[], ... } }
 * content 可能是 string（热路径）或 Segment[]（少数情况），用 normalizeContent 拍平。
 *
 * 用 readTailBytes 做 256KB 尾读（长 session 不全读）。返回值：
 *   - undefined：尾窗口内无匹配 assistant entry（调用方继续走 getHistory 兜底）
 *   - string：归一化后的文档文本
 */
function readLastAssistantFromJsonlFile(filePath: string): string | undefined {
  const entries = readTailBytes(filePath, HANDOFF_DOC_TAIL_BYTES)
  if (entries === null) return undefined  // 文件不存在 / 不可读
  // 倒序找最后一条 assistant message entry（content 非空）
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (e.type !== 'message') continue
    const message = e.message
    if (typeof message !== 'object' || message === null) continue
    const m = message as Record<string, unknown>
    if (m.role !== 'assistant') continue
    // content 类型可能是 string | Segment[]（联合），交给 normalizeContent 处理。
    // Segment 类型见 shared/segments.ts；此处在 JSONL 边界，类型不可静态保证，
    // 按运行时形状收窄到 normalizeContent 接受的联合类型。
    const raw = m.content
    const content = typeof raw === 'string'
      ? normalizeContent(raw)
      : Array.isArray(raw)
        ? normalizeContent(raw as Segment[])
        : ''
    if (content) return content
  }
  return undefined
}

/**
 * SUGGESTION 3：sanitize 客户端传入的 focus（trust boundary 外）。
 *
 * - 去换行（CR/LF → 空格）：防注入额外行，破坏 /skill:handoff args 切分
 * - 截断到 FOCUS_MAX_LENGTH 字符：防超长 prompt（DoS + 上下文污染）
 * - trim：去首尾空白
 */
function sanitizeFocus(focus: string): string {
  return focus.replace(/[\r\n]/g, ' ').trim().slice(0, FOCUS_MAX_LENGTH)
}
