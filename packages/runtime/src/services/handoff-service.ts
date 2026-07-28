/**
 * HandoffService —— fast-handoff 功能的 runtime 编排层（agent-driven）。
 *
 * 职责：用户在源 session 点 handoff → runtime 让源 session 跑一个 handoff turn
 * （pi agent 根据 HANDOFF_PROMPT_TEMPLATE 生成 handoff 文档）→ runtime 从
 * agent_end 事件提取文档文本 → 新建空白 session → 注入文档首条 → 广播跳转。
 *
 * 与旧同步拼字符串实现的区别：主 session 的 pi 全程跑一个 agent turn 生成文档，
 * 而非 runtime 自行 assembleHandoffDoc。文档质量交给 agent，runtime 只负责编排
 * （prompt / 监听 agent_end / 提取 text / 创建新 session / 注入 / 广播）。
 *
 * 完成判定：runHandoff 等待源 session 的 agent_end 事件（或 timeout / abort），
 * 提取最终文本作为 doc。
 *
 * 失败经 message.error 通道广播到源 session 对话流；timeout / abort 经
 * Promise.race reject 抛出。
 *
 * [HISTORICAL] BLOCKER 2 注释保留：runHandoff 创建新 session 后除广播
 * session.handoffComplete 外，还调 broadcastSessionList 作为 WS 重连恢复兜底
 * （session.handoffComplete 推送在断连窗口丢失时，renderer 重连的 sendInitialState
 * 用 sessionList 恢复侧栏）。
 */
import type { IMessageBroker } from '../interfaces.js'
import type { SessionService } from './session/session-service.js'
import type { IPiEngine } from './ports/pi-engine.js'
import type { PiAgentEndEvent, PiAgentEndMessage } from '../infra/pi/pi-protocol.js'
import { buildHandoffPrompt } from './handoff-prompt.js'

interface HandoffServiceOpts {
  sessionService: SessionService
  broker: IMessageBroker
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
   */
  nextPushId: () => string
}

/**
 * handoff turn 等待 agent_end 的超时（ms）。
 *
 * agent 生成 handoff 文档可能涉及多次工具调用（读文件 / 写 temp），10 分钟
 * 是宽松上限：正常 handoff turn 远小于此，超时几乎必然意味着 pi 卡死。
 */
export const HANDOFF_TIMEOUT_MS = 600_000

/**
 * 进行中的 handoff 句柄。存入 inflight Map，供 abortHandoff 取消用。
 *
 * detachListener：从 srcClient.onEvent 卸载 agent_end 监听。
 * timeoutTimer：HANDOFF_TIMEOUT_MS 后触发 reject 的定时器。
 * resolve/reject：agentEndPromise 的两个端，由 agent_end 事件或 timeout/abort 触发。
 * srcClient：源 session 的 IPiEngine，abort 时调 .abort() 取消 pi turn。
 */
interface InflightHandoff {
  detachListener: () => void
  timeoutTimer: ReturnType<typeof setTimeout>
  resolve: (doc: string) => void
  reject: (err: Error) => void
  srcClient: IPiEngine
}

/**
 * 从 agent_end 事件的 messages 末条提取最终文本。
 *
 * 防御性实现（参考 event-adapter.ts:196-202 但独立）：
 * 1. messages 为 undefined / 空数组 → 返回 ''。
 * 2. 末条 content 是 unknown，先 Array.isArray 断言。
 * 3. filter 出 object 且 type==='text' 的 block，取 .text。
 * 4. 全部 text block join 后返回；无 text block → ''。
 *
 * @param messages agent_end 事件的 messages 数组（PiAgentEndMessage[]）
 * @returns 提取的纯文本；空 / undefined / 无 text → ''
 */
export function extractFinalTextFromAgentEnd(messages: PiAgentEndMessage[] | undefined): string {
  if (!messages || messages.length === 0) return ''
  const last = messages[messages.length - 1]
  const content: unknown = last.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((item): item is { type: 'text'; text: string } => {
      if (typeof item !== 'object' || item === null) return false
      const obj = item as { type?: unknown }
      return obj.type === 'text'
    })
    .map((block) => block.text ?? '')
    .join('')
}

export class HandoffService {
  /** per-session 进行中状态。同一 session 不可并发 handoff。 */
  private readonly inflight = new Map<string, InflightHandoff>()
  private readonly opts: HandoffServiceOpts

  constructor(opts: HandoffServiceOpts) {
    this.opts = opts
  }

  /**
   * 触发 handoff：让源 session 跑 handoff turn 生成文档，新建 session，注入文档，广播完成。
   *
   * 流程：
   * 1. 并发守卫（inflight Map）。
   * 2. getHistory 判空（无历史不可 handoff）。
   * 3. getSession 取 cwd + label。
   * 4. ensureActive 拿源 session 的 IPiEngine。
   * 5. 注册 agent_end 监听 + timeout，建 agentEndPromise。
   * 6. fire-and-forget 发送 handoff prompt（await 只确认 pi 收到 ack）。
   * 7. Promise.race 等 agentEndPromise / timeoutPromise。
   * 8. 成功 → 新建 session + markHandedOff + 注入 doc + 广播。
   *
   * @param srcSessionId 源 session id
   * @param reply 可选的用户备注（sanitize 后追加到 prompt 末尾）
   * @throws 已有进行中 handoff / 历史为空 / session 不可用 / agent 产空文档 / timeout / abort
   */
  async runHandoff(srcSessionId: string, reply?: string): Promise<void> {
    // 1. 并发守卫：同一 session 不可并发 handoff
    if (this.inflight.has(srcSessionId)) {
      throw new Error(`handoff already in progress for session ${srcSessionId}`)
    }

    // 2. 获取对话历史（兼容离线 session，走文件尾读）—— 仅用于判空
    const { messages } = await this.opts.sessionService.getHistory(srcSessionId)
    if (!messages || messages.length === 0) {
      throw new Error('handoff: no history to handoff')
    }

    // 3. 取源 session 信息
    const srcSession = this.opts.sessionService.getSession(srcSessionId)
    if (!srcSession) {
      throw new Error('handoff: source session not found')
    }
    const srcLabel = srcSession.label || srcSessionId
    const srcCwd = srcSession.cwd

    // 4. 拿源 session 的 IPiEngine（不存在则 restore）
    const srcClient = await this.opts.sessionService.ensureActive(srcSessionId)

    // 5. 建 agentEndPromise + 注册 inflight（监听 + timeout）。
    // agentEndPromise 是唯一的等待支路：agent_end resolve、timeout / abort reject
    // 都经它的 resolve/reject 完成（inflight.timeoutTimer 与 abortHandoff 共享 reject 句柄）。
    const agentEndPromise = new Promise<string>((resolve, reject) => {
      const detachListener = srcClient.onEvent((event) => {
        const typed = event as PiAgentEndEvent
        if (typed.type !== 'agent_end') return
        const doc = extractFinalTextFromAgentEnd(typed.messages)
        if (!doc) {
          reject(new Error('handoff: agent produced empty document'))
          return
        }
        resolve(doc)
      })
      const timeoutTimer = setTimeout(() => {
        reject(new Error(`handoff timeout after ${HANDOFF_TIMEOUT_MS}ms`))
      }, HANDOFF_TIMEOUT_MS)
      this.inflight.set(srcSessionId, {
        detachListener,
        timeoutTimer,
        resolve,
        reject,
        srcClient,
      })
    })

    let doc: string
    try {
      // 6. fire-and-forget 发送 handoff prompt（await 只确认 pi 收到 ack，不等 turn 完成）
      await srcClient.prompt(buildHandoffPrompt(reply))

      // 7. 等结果（agent_end resolve / timeout 或 abort reject）
      doc = await agentEndPromise
    } finally {
      // 8. 清理 inflight（无论成功 / 失败 / abort）
      this.cleanupInflight(srcSessionId)
    }

    // 9. 新建空白 session（复用源 cwd）
    const newSession = await this.opts.sessionService.create(srcCwd, `handoff from ${srcLabel}`)
    const newId = newSession.id

    // 10. 标记源 session 已交接
    this.opts.sessionService.markHandedOff(srcSessionId, newId)

    // 11. 注入 doc 触发新 session turn（fire-and-forget：await 只确认 pi 收到 ack）
    const newClient = await this.opts.sessionService.ensureActive(newId)
    await newClient.prompt(doc)

    // 12-13. 广播（先 sessionList 再 handoffComplete，保证重连恢复）。
    // DM3 协议变更：payload 移除 doc 和 reply 字段（doc 已注入新 session，无需广播）。
    this.opts.broadcastSessionList()
    this.opts.broker.broadcast({
      type: 'session.handoffComplete',
      id: this.opts.nextPushId(),
      payload: {
        sessionId: srcSessionId,
        srcSessionId,
        newSessionId: newId,
        sourceLabel: srcLabel,
      },
    })
  }

  /**
   * 取消进行中的 handoff。
   *
   * 1. inflight 无记录 → no-op return（幂等）。
   * 2. 有记录 → 调 srcClient.abort() 取消 pi turn（失败兜底 console.warn，不 rethrow）。
   * 3. clearTimeout + detachListener。
   * 4. reject inflight 的 promise（让 runHandoff 的 Promise.race reject 'handoff aborted'）。
   * 5. Map.delete。
   *
   * @param srcSessionId 源 session id
   */
  async abortHandoff(srcSessionId: string): Promise<void> {
    const entry = this.inflight.get(srcSessionId)
    if (!entry) return
    try {
      await entry.srcClient.abort()
    } catch (e) {
      // ES4 兜底：pi 进程可能已退出，abort 失败不应阻塞 abort 流程。
      console.warn('[handoff] abort failed:', e)
    }
    clearTimeout(entry.timeoutTimer)
    entry.detachListener()
    entry.reject(new Error('handoff aborted'))
    this.inflight.delete(srcSessionId)
  }

  /**
   * 清理 inflight 句柄（detach + clearTimeout + Map.delete）。
   * runHandoff 的 finally 块调用，保证成功 / 失败 / 抛错路径都清理。
   */
  private cleanupInflight(srcSessionId: string): void {
    const entry = this.inflight.get(srcSessionId)
    if (!entry) return
    clearTimeout(entry.timeoutTimer)
    entry.detachListener()
    this.inflight.delete(srcSessionId)
  }
}
