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
 * 完成判定：runHandoff 等待源 session 的 agent_end 事件（或 timeout / abort /
 * pi 中途退出），提取最终文本作为 doc。
 *
 * 失败经 message.error 通道广播到源 session 对话流；timeout / abort / exit 经
 * Promise reject 抛出。
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
import { buildHandoffPrompt, sanitizeReply } from './handoff-prompt.js'
import { wrapWithXmlTag } from './handoff-formatter.js'

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
 * agent 生成 handoff 文档可能涉及多次工具调用（读文件等），10 分钟
 * 是宽松上限：正常 handoff turn 远小于此，超时几乎必然意味着 pi 卡死。
 */
export const HANDOFF_TIMEOUT_MS = 600_000

/**
 * 探测源 pi 进程是否已退出的轮询间隔（ms）。
 *
 * W3：pi 进程在 handoff turn 中途崩溃（prompt 已 ack 但未发 agent_end）时，
 * 既无 agent_end 事件也无 reject 信号能让 agentEndPromise resolve，旧实现会挂起
 * 最长 HANDOFF_TIMEOUT_MS（10 分钟）。轮询 srcClient.exited 是兜底检测：
 * 一旦发现 exited=true 立即 reject（'handoff: source pi exited'）。
 *
 * 选 poll 而非 onExit：IPiEngine.onExit 在 RpcClient 实现里是单槽覆盖语义
 * （rpc-client.ts:439-441，无 unregister），而 ProcessManager.createSession 已注册
 * 自己的 onExit 回调（process-manager.ts:207-216，做 processes.delete + 上层通知）。
 * 此处若再 onExit 会覆盖 PM 的退出处理导致进程清理 / 上层通知丢失。poll
 * srcClient.exited（readonly，进程退出由 RpcClient proc.on('exit') 置位）是非侵入
 * 的观察方式，2 秒间隔对 10 分钟级超时是可忽略的开销。
 */
export const HANDOFF_EXIT_POLL_MS = 2_000

/**
 * 进行中的 handoff 句柄。存入 inflight Map，供 abortHandoff 取消用。
 *
 * detachListener：从 srcClient.onEvent 卸载 agent_end 监听。
 * timeoutTimer：HANDOFF_TIMEOUT_MS 后触发 reject 的定时器。
 * detachExitWatcher：清除退出探测定时器（W3）。
 * resolve/reject：agentEndPromise 的两个端，由 agent_end 事件或 timeout/abort/exit 触发。
 * srcClient：源 session 的 IPiEngine，abort 时调 .abort() 取消 pi turn。
 */
interface InflightHandoff {
  detachListener: () => void
  timeoutTimer: ReturnType<typeof setTimeout>
  detachExitWatcher: () => void
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
 *    S1：额外校验 text 是 string——pi 若发 {type:'text', text:123}（畸形）会被过滤掉
 *    （而非被 String(123) 拼成 "123"），归一化为空文档走 empty reject 路径。
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
      const obj = item as { type?: unknown; text?: unknown }
      return obj.type === 'text' && typeof obj.text === 'string'
    })
    .map((block) => block.text ?? '')
    .join('')
}

export class HandoffService {
  /** per-session 进行中状态。同一 session 不可并发 handoff。 */
  private readonly inflight = new Map<string, InflightHandoff>()
  /**
   * 已 abort 的 session id 集合（跨 inflight 生命周期）。
   *
   * 背景：abort 与 pi agent_end 是竞态。agent_end 可能在 abort 的 reject 到达前先触发 finalize('resolve', doc)
   * （settled 标志让后续 abort reject 变 no-op），runHandoff 拿到部分文档继续创建新 session——
   * 用户点了取消却看到半截文档到了新 session。
   *
   * 修复：abortHandoff 把 srcSessionId 加入此 Set。runHandoff 在拿到 doc 后、创建新 session 前
   * 检查此 Set，命中则 throw 'handoff aborted' 阻断后续（不 create / 不注入 / 不广播 complete）。
   * 检查后立即 delete（避免 Set 无限增长 + 同 session 下次 handoff 正常工作）。
   */
  private readonly abortedSessions = new Set<string>()
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
   * 5. 注册 agent_end 监听 + timeout + exit 探测，建 agentEndPromise（W3/W4）。
   *    settle（resolve/reject）前先 cleanupInflight 移除 entry，关闭 settle 后到 finally
   *    之间 abort 仍生效的窗口；poll srcClient.exited 兜底检测 pi 中途退出（最长挂 10 分钟）。
   * 6. fire-and-forget 发送 handoff prompt（await 只确认 pi 收到 ack）。
   * 7. Promise.race 等 agentEndPromise / timeoutPromise。
   * 8. 成功 → 新建 session + markHandedOff + 注入 doc + 广播。
   *
   * @param srcSessionId 源 session id
   * @param reply 可选的用户备注（sanitize 后追加到 prompt 末尾）
   * @param options Staging Mode（ADR-0056）：modelOverride/thinkingOverride 仅作用于新建的承接 session，
   *   源 session 的 handoff turn 仍用源 session 自身模型（override 不影响源 turn）。
   * @throws 已有进行中 handoff / 历史为空 / session 不可用 / agent 产空文档 / timeout / abort
   */
  async runHandoff(
    srcSessionId: string,
    reply?: string,
    options?: { modelOverride?: string; thinkingOverride?: string },
  ): Promise<void> {
    // 1. 并发守卫：同一 session 不可并发 handoff
    if (this.inflight.has(srcSessionId)) {
      throw new Error(`handoff already in progress for session ${srcSessionId}`)
    }

    // 1.5 清理上次 handoff 残留的 aborted 标记。上次 abort 若在 agentEndPromise reject 路径
    // 结束（未走到 8.5 检查点），abortedSessions 会残留 → 本次正常 handoff 在 8.5 误判 throw。
    // 此处清理保证每次 runHandoff 从干净状态开始（inflight 守卫已确保上次 handoff 不在跑）。
    this.abortedSessions.delete(srcSessionId)

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

    // 5. 建 agentEndPromise + 注册 inflight（监听 + timeout + exit 探测）。
    // agentEndPromise 是唯一的等待支路：agent_end resolve、timeout / abort / exit reject
    // 都经它的 resolve/reject 完成（inflight.timeoutTimer 与 abortHandoff 共享 reject 句柄）。
    //
    // W4：三条 settle 路径（agent_end / timeout / exit）在调用 resolve/reject 之前
    // 先 cleanupInflight 把 entry 从 Map 移除，否则 agent_end resolve 后到 runHandoff 的
    // finally 之间（仍在 await agentEndPromise 之后、cleanup 之前的微任务窗口）abortHandoff
    // 仍能拿到 entry 调 reject（已 resolved 的 promise，no-op）+ 广播 handoffAborted，
    // 随后 runHandoff 继续广播 handoffComplete → 前端先 aborted 再 complete，UX 抖动。
    // settle 先 cleanup 后，abort 在该窗口拿到 undefined（no-op，不广播）。
    const agentEndPromise = new Promise<string>((resolve, reject) => {
      // settled 防止 resolve/reject 被多次调用（listener + timeout + exit 三路可能并发）。
      let settled = false
      const finalize = (action: 'resolve' | 'reject', value: string | Error): void => {
        if (settled) return
        settled = true
        // W4：resolve/reject 之前先清 inflight，关闭「settle 后到 finally 之间 abort 仍生效」窗口。
        this.cleanupInflight(srcSessionId)
        if (action === 'resolve') resolve(value as string)
        else reject(value as Error)
      }

      const detachListener = srcClient.onEvent((event) => {
        const typed = event as PiAgentEndEvent
        if (typed.type !== 'agent_end') return
        const doc = extractFinalTextFromAgentEnd(typed.messages)
        if (!doc) {
          finalize('reject', new Error('handoff: agent produced empty document'))
          return
        }
        finalize('resolve', doc)
      })
      const timeoutTimer = setTimeout(() => {
        finalize('reject', new Error(`handoff timeout after ${HANDOFF_TIMEOUT_MS}ms`))
      }, HANDOFF_TIMEOUT_MS)
      // W3：轮询源 pi 是否已退出。pi 在 handoff turn 中途崩溃（prompt 已 ack 但无 agent_end）
      // 时无事件能让 promise settle，旧实现会挂到 timeout（10 分钟）。poll srcClient.exited
      // 兜底检测，命中即 reject。
      const exitTimer = setInterval(() => {
        if (srcClient.exited) {
          finalize('reject', new Error('handoff: source pi exited'))
        }
      }, HANDOFF_EXIT_POLL_MS)
      const detachExitWatcher = (): void => {
        clearInterval(exitTimer)
      }
      this.inflight.set(srcSessionId, {
        detachListener,
        timeoutTimer,
        detachExitWatcher,
        resolve: (doc: string) => finalize('resolve', doc),
        reject: (err: Error) => finalize('reject', err),
        srcClient,
      })
    })

    // B1（wave:perf-w08 删除）：原此处广播 session.handoffStarted 到源 session 对话流。
    // 02 文档 D1-1 定案删除——前端无消费方（core/src/domain/chat/useChat.ts 已删
    // 「正在交接…」处理，仅剩注释），广播是每 handoff 一次的无效盲发。
    // protocol.ts 的类型定义保留（02 文档无删类型定案；W09 接口收敛时统一处置）。

    let doc: string
    try {
      // 6. fire-and-forget 发送 handoff prompt（await 只确认 pi 收到 ack，不等 turn 完成）
      // B3：buildHandoffPrompt 不再接受 reply 参数，reply 改为新 session 开场消息
      await srcClient.prompt(buildHandoffPrompt())

      // 7. 等结果（agent_end resolve / timeout 或 abort reject）
      doc = await agentEndPromise
    } finally {
      // 8. 清理 inflight（无论成功 / 失败 / abort）
      this.cleanupInflight(srcSessionId)
    }

    // 8.5 abort 阻断检查（跨 finalize/inflight 生命周期）。
    // agent_end 与 abort 竞态时 agent_end 可能先 resolve（settled 让 abort reject 变 no-op），
    // 此时 doc 是部分文档。检查 abortedSessions：用户已表达取消意图，不再创建新 session / 注入 / 广播。
    // 检查后立即 delete（避免 Set 增长 + 同 session 下次 handoff 不受影响）。
    if (this.abortedSessions.has(srcSessionId)) {
      this.abortedSessions.delete(srcSessionId)
      throw new Error('handoff aborted')
    }

    // 9. 新建空白 session（复用源 cwd）
    // Staging Mode（ADR-0056）：透传 modelOverride/thinkingOverride 让承接 session 用用户当前选定模型/思考等级，
    // 而非全局默认。源 session 的 handoff turn 已用自身模型跑完，不受此 override 影响。
    const newSession = await this.opts.sessionService.create(srcCwd, `handoff from ${srcLabel}`, {
      modelOverride: options?.modelOverride,
      thinkingOverride: options?.thinkingOverride,
    })
    const newId = newSession.id

    // 10. 标记源 session 已交接
    this.opts.sessionService.markHandedOff(srcSessionId, newId)

    // 11. 注入 doc 触发新 session turn（fire-and-forget：await 只确认 pi 收到 ack）
    // B2：用 wrapWithXmlTag 包装 doc，让新 session 能识别 handoff 文档边界
    // B3：reply 作为开场消息追加到 doc 之后（sanitize 后）
    const newClient = await this.opts.sessionService.ensureActive(newId)
    const wrappedDoc = wrapWithXmlTag(doc, srcLabel)
    const finalPrompt = reply
      ? `${wrappedDoc}\n\n${sanitizeReply(reply)}`
      : wrappedDoc
    await newClient.prompt(finalPrompt)

    // 12-13. 广播（先 sessionList 再 handoffComplete，保证重连恢复）。
    // DM3 协议变更：payload 移除 doc 和 reply 字段（doc 已注入新 session，无需广播）。
    // W5：payload 不含 sessionId——协议类型 ServerMessageMapBase['session.handoffComplete']
    // 只有 srcSessionId/newSessionId/sourceLabel。多塞的 sessionId 被前端 routeInbound
    // 隐式当路由字段（按 sessionId 走 dispatchSession 而非 dispatchGlobal），是「碰巧能工作」
    // 非设计：前端 useHandoffEffect 用 onGlobalType 订阅，本就走 global 通道。去掉 sessionId
    // 让 routeInbound 正确分流到 dispatchGlobal。
    this.opts.broadcastSessionList()
    this.opts.broker.broadcast({
      type: 'session.handoffComplete',
      id: this.opts.nextPushId(),
      payload: {
        srcSessionId,
        newSessionId: newId,
        sourceLabel: srcLabel,
      },
    })
  }

  /**
   * 取消进行中的 handoff。
   *
   * 1. inflight 无记录 → no-op return false（幂等；返回 false 让 handler 区分 no-op）。
   * 2. 有记录 → 调 srcClient.abort() 取消 pi turn（失败兜底 console.warn，不 rethrow）。
   * 3. 调 entry.reject 触发 finalize（内部 clearTimeout + clearInterval + detachListener
   *    + Map.delete），让 runHandoff 的 agentEndPromise reject 'handoff aborted'。返回 true。
   *
   * W1：返回 boolean——handler 仅当真正 abort 了（inflight 有 entry）才广播
   * session.handoffAborted，避免无 inflight 的 no-op 也广播导致前端误复位。
   *
   * @param srcSessionId 源 session id
   * @returns 是否真正执行了 abort（true=有 inflight 已中断；false=no-op，无 inflight）
   */
  async abortHandoff(srcSessionId: string): Promise<boolean> {
    const entry = this.inflight.get(srcSessionId)
    if (!entry) {
      // 竞态窗口：agent_end 先 finalize（cleanupInflight 移除 entry），abort 随后到达。
      // 仍标记 aborted，让 runHandoff 的 abortedSessions 检查阻断半文档泄漏到新 session。
      this.abortedSessions.add(srcSessionId)
      return false
    }
    // 标记 aborted（跨 inflight 生命周期）：即使 agent_end 已先 resolve（竞态），runHandoff
    // 在创建新 session 前检查此 Set 会 throw 阻断。不加此标记则 abort 在 settled 后变 no-op，
    // 半截文档仍会到新 session。
    this.abortedSessions.add(srcSessionId)
    try {
      await entry.srcClient.abort()
    } catch (e) {
      // ES4 兜底：pi 进程可能已退出，abort 失败不应阻塞 abort 流程。
      console.warn('[handoff] abort failed:', e)
    }
    // reject 经 finalize 完成 cleanup（clearTimeout + clearInterval + detach + delete）。
    // finalize 内 settled 标志保证 abort 与并发的 agent_end / timeout / exit 不会重复 settle。
    entry.reject(new Error('handoff aborted'))
    return true
  }

  /**
   * 清理 inflight 句柄（clearTimeout + clearInterval + detach + Map.delete）。
   * runHandoff 的 finally 块 + agentEndPromise 内 finalize（W4）+ abortHandoff 经
   * reject→finalize 三处调用，保证成功 / 失败 / 抛错 / abort / settle 路径都清理。
   */
  private cleanupInflight(srcSessionId: string): void {
    const entry = this.inflight.get(srcSessionId)
    if (!entry) return
    clearTimeout(entry.timeoutTimer)
    entry.detachExitWatcher()
    entry.detachListener()
    this.inflight.delete(srcSessionId)
  }
}
