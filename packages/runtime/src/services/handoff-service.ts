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
 * 从 agent_end 后的末条 assistant 取（降级 getHistory），不监听 file-write tool_call
 * （文件名不可预知）。
 *
 * 编排链路全异步（runHandoff 触发 → onTurnEnd 收尾），失败/取消经两条独立通道：
 *   - 取消（abortHandoff）：inflight.aborted 标记 + 委托 SessionService.abort 中断 pi turn
 *   - 失败（文档空/新建 session 抛错）：广播 message.error 反馈到源 session 对话流
 */
import type { IMessageBroker } from '../interfaces.js'
import type { IProcessManager } from './ports/pi-engine.js'
import type { SessionService } from './session/session-service.js'
import { normalizeContent } from '@xyz-agent/shared'
import { wrapWithXmlTag } from './handoff-formatter.js'

/** 进行中的 handoff 状态（per-session，同一 session 不可并发 handoff）。 */
interface HandoffInProgress {
  startedAt: number
  focus?: string
  /** 用户取消标记。onTurnEnd 检测后跳过新建/注入（只清理 inflight）。 */
  aborted?: boolean
}

interface HandoffServiceOpts {
  sessionService: SessionService
  broker: IMessageBroker
  pm: IProcessManager
}

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
    this.inflight.set(srcSessionId, { startedAt: Date.now(), focus })

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
    // focus 原样拼接到 skill 命令后（pi 按首个空格切分作 args，透传到 handoff skill 的 focus 参数）。
    const cmd = focus ? `/skill:handoff ${focus}` : '/skill:handoff'
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

      // 注入首条消息（wrapped 文档作 user message，驱动新 agent 立即执行文档里的下一项）
      await this.opts.sessionService.sendMessage(newId, wrapped)

      // 标记源 session 已交接（内存 handedOffTo + 磁盘 handoff_marker）。
      // M3：经 SessionService.markHandedOff 收口（拥有 sessions Map + sessionFilePath），
      // 不直接改 srcSession.handedOffTo 绕过所有权——getSession 若返回防御性副本会让直接写入失效。
      // toSummary 透传 handedOffTo → 活跃态立即生效；磁盘 marker → scanner 重扫后回填。
      this.opts.sessionService.markHandedOff(sessionId, newId)

      // 广播完成，前端据 newSessionId 跳转新 session、据 srcSessionId 标记源 session 已交接
      this.opts.broker.broadcast({
        type: 'session.handoffComplete',
        id: `handoff_${Date.now()}`,
        payload: { srcSessionId: sessionId, newSessionId: newId },
      })
    } catch (e) {
      // 编排失败（create/sendMessage 抛错），广播错误反馈到源 session 对话流。
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
   * getHistory 取末条 assistant.content（normalizeContent 拍平 string | Segment[] 联合类型）。
   * 末条 assistant 即 /skill:handoff 的产出（pi turn 内最后一条 assistant 消息）。
   *
   * @returns 文档字符串；无 assistant 消息（skill 未产出）返回 undefined
   */
  private async extractHandoffDoc(sessionId: string): Promise<string | undefined> {
    const { messages } = await this.opts.sessionService.getHistory(sessionId)
    if (!messages || messages.length === 0) return undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'assistant') {
        // content 可能是 string（assistant 热路径）或 Segment[]（少数情况），统一归一为纯文本
        const content = normalizeContent(msg.content)
        return content || undefined
      }
    }
    return undefined
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
    this.opts.broker.broadcast({
      type: 'message.error',
      id: `handoff_err_${Date.now()}`,
      payload: { sessionId, message: errorMsg },
    })
  }
}
