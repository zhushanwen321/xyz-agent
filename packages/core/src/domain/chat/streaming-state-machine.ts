/**
 * streaming 状态机深模块（B6 *Impl 消除，ADR-0058 深模块化范式）。
 *
 * 从 chat store 提取「messages ref 的 streaming→终态 mutate + 断连瞬态清理」内聚逻辑：
 * - applySubagentStreamDelta：subagent streaming delta 吸收（替换非追加，contentBlock 幂等）
 * - finalizeSubagentStream：subagent streaming 收口（sealed 守卫，幂等 no-op）
 * - finalizeMessages：finalizeSession 的 message 终态映射（bash 跳过 / toolCall 收口 / endTime 条件）
 * - collectFinalizeCandidates：finalizeAllStreaming 候选 session 并集（6 源 refs）
 * - clearIndependentTransient：resetTransientStates 的 session 级独立瞬态清理
 *
 * 形态：factory 函数（createStreamingStateMachine）闭包持有 refs + helpers，方法签名只留
 * 业务参数。store.ts 仅做 ref 委托（6 处调用点），不再有模块级 *Impl 反模式
 * （原为绕 max-lines-per-function 拆分）。
 */
import type { ContentBlock, Message } from '@xyz-agent/shared'
import { commitMessages, type MessagesRef } from './mutations'
import { findLastAssistantIndex } from './chunk-processor'
import type { FinalizeReason } from './store-types'

/** 工厂依赖注入接口：全部 refs + setter + helpers 由 store 装配，本模块不直连外部状态。 */
export interface StreamingStateMachineDeps {
  messages: MessagesRef
  compactingSessions: { value: Set<string> }
  handingOffSessions: { value: Set<string> }
  retryStates: { value: Map<string, unknown> }
  queueStates: { value: Map<string, unknown> }
  pendingSend: { value: Set<string> }
  setCompacting: (sessionId: string, value: boolean) => void
  setHandingOff: (sessionId: string, value: boolean) => void
}

/**
 * 构造 streaming 状态机。逻辑体与 store.ts 迁移前模块级函数逐字等价（仅去掉 refs 显式参数，
 * 由闭包持有），行为由 streaming-state-machine.test.ts + store.test.ts 双锁。
 */
export function createStreamingStateMachine(deps: StreamingStateMachineDeps) {
  const { messages, compactingSessions, handingOffSessions, retryStates, queueStates, pendingSend, setCompacting, setHandingOff } = deps

  /**
   * subagent streaming delta 吸收纯逻辑（W4，模块作用域）：
   * 虚拟 session 有 streaming assistant 时替换其 content，无 streaming assistant 时 push 新的。
   * 吸收自原 subagent store applyStreamDelta（去 getMessages/setMessages 回调参数，直接操作
   * 传入的 messages ref），让 chat store 成为所有 assistant content mutation 的唯一入口。
   *
   * 扩展层传的 lines 是 buffer 的 split('\n')，每次都是完整文本 → 用替换而非追加。
   * contentBlock 幂等：已有 text 块则不重复 push（与主流式 text_delta handler 对齐）。
   */
  function applySubagentStreamDelta(virtualId: string, lines: string[]): void {
    const fullText = lines.join('\n')
    const prev = messages.value.get(virtualId) ?? []
    const lastAssistantIdx = findLastAssistantIndex(prev)
    const next = [...prev]
    if (lastAssistantIdx >= 0 && next[lastAssistantIdx].status === 'streaming') {
      const prevMsg = next[lastAssistantIdx]
      // 不可变写法（W1）：shallowRef 下不依赖字段级 mutate，整体构造新对象
      const contentBlocks: ContentBlock[] = prevMsg.contentBlocks?.some((b) => b.type === 'text')
        ? prevMsg.contentBlocks
        : [...(prevMsg.contentBlocks ?? []), { type: 'text', refId: 'text' }]
      next[lastAssistantIdx] = { ...prevMsg, content: fullText, contentBlocks }
    } else {
      next.push({
        id: `sa-${crypto.randomUUID()}`,
        role: 'assistant',
        content: fullText,
        status: 'streaming',
        contentBlocks: [{ type: 'text', refId: 'text' }],
        timestamp: Date.now(),
      })
    }
    commitMessages(messages, virtualId, next)
  }

  /**
   * subagent streaming 收口纯逻辑（W4，模块作用域）：把虚拟 session 最后一条 streaming
   * assistant 翻成 complete。
   *
   * sealed 守卫对齐（D-010 parity）：实体一旦 complete 不再被后续 delta 污染。无 streaming
   * 实体时幂等 no-op。不走 finalizeSession：subagent 虚拟 session 无 pendingSend / streaming
   * timer 生命周期（由 subagent store 的 panelStreamUnsub 管理），只翻 status。
   */
  function finalizeSubagentStream(virtualId: string): void {
    const prev = messages.value.get(virtualId)
    if (!prev || prev.length === 0) return
    const lastAssistantIdx = findLastAssistantIndex(prev)
    if (lastAssistantIdx < 0 || prev[lastAssistantIdx].status !== 'streaming') return
    const next = [...prev]
    next[lastAssistantIdx] = { ...next[lastAssistantIdx], status: 'complete' }
    commitMessages(messages, virtualId, next)
  }

  /**
   * finalizeAllStreaming 的候选 session 集合构造（W3 / W-S3，模块作用域）。
   *
   * 遍历所有可能持有瞬态态的 session 的 key 并集：messages.keys() ∪ compactingSessions ∪
   * retryStates ∪ queueStates ∪ pendingSend。不能只遍历 messages.keys()——compacting /
   * retry / queue / pendingSend 可能独立于消息存在，仅遍历 messages 会漏掉这些 session。
   *
   * [W3 / W-S3] pendingSend 并入：纯 pendingSend 态（用户已发起、message_start 空窗、无消息实体）
   * 不在 messages.keys() 内，断连时不会立即收口，UI 卡「发送中」。
   */
  function collectFinalizeCandidates(): Set<string> {
    const candidateSids = new Set<string>(messages.value.keys())
    for (const sid of compactingSessions.value) candidateSids.add(sid)
    for (const sid of handingOffSessions.value) candidateSids.add(sid)
    for (const sid of retryStates.value.keys()) candidateSids.add(sid)
    for (const sid of queueStates.value.keys()) candidateSids.add(sid)
    for (const sid of pendingSend.value) candidateSids.add(sid)
    return candidateSids
  }

  /**
   * resetTransientStates 的 session 级独立瞬态清理（W3，模块作用域）。
   * 清 compacting / handingOff / retry / queue（断连兜底：这些态在断连后无事件驱动清理）。
   */
  function clearIndependentTransient(sessionId: string): void {
    setCompacting(sessionId, false)
    setHandingOff(sessionId, false)
    if (retryStates.value.has(sessionId)) {
      const next = new Map(retryStates.value)
      next.delete(sessionId)
      retryStates.value = next
    }
    if (queueStates.value.has(sessionId)) {
      const next = new Map(queueStates.value)
      next.delete(sessionId)
      queueStates.value = next
    }
  }

  /**
   * finalizeSession 的 message 终态映射纯逻辑（模块作用域）。
   *
   * 把 streaming/running 实体推到终态（reason 决定 message.status + toolCall.status 映射），
   * 同步收口 running toolCall。幂等（sealed 后实体不变）。
   */
  function finalizeMessages(sessionId: string, reason: FinalizeReason, errorText?: string): void {
    const prev = messages.value.get(sessionId)
    if (!prev) return
    const next = prev.map((m) => {
      // [M1 PR#116 review] 跳过 bash 消息：bash 消息（role:'system' + bashExecution）的生命周期
      // 由 finalizeBashOnly / bashResultEffect / markBashError 独立管理（W1 timer-decouple 解耦）。
      // 若此处统一翻终态，L1 放宽 bash↔assistant 并发后，assistant error → finalizeSession('error')
      // 会把共存中的 streaming bash 一并翻成 error，bashResult 到达时找不到 streaming bash →
      // 真实结果被丢弃。与 W1 的 finalizeBashOnly 解耦对称。
      if (m.bashExecution) return m
      const isStreaming = m.status === 'streaming'
      // toolCall 统一收口（无论 message 是否还 streaming；[W4] 收敛到此处单一路径，
      // 避免 message.complete 局部 finalizeToolCalls 与此两套映射漂移）。
      // - error/stream_error → toolCall 'error'；其它非 normal/aborted → 'end_not_received'（设 endTime）；
      //   normal/aborted 不设 endTime（与原逻辑一致）。
      // 延迟到达的真实 tool_call_end 会用真实 output 覆盖收口值（end_not_received → completed）。
      const toolCalls = m.toolCalls?.map((tc): typeof tc => {
        if (tc.status !== 'running') return tc
        const tcIsError = reason === 'error' || reason === 'stream_error'
        return {
          ...tc,
          status: tcIsError ? 'error' : 'end_not_received',
          ...(reason !== 'normal' && reason !== 'aborted' ? { endTime: Date.now() } : {}),
        }
      })
      if (!isStreaming) {
        // message 已终态（如 message.complete handler 已改 status），只补 toolCall 收口。
        // 无 running toolCall 则原样返回（保持引用稳定，避免无谓 re-render）。
        return m.toolCalls?.some((tc) => tc.status === 'running') ? { ...m, toolCalls } : m
      }
      // message 仍 streaming → 转终态 + 收口 toolCall
      const isErrorReason = reason === 'error' || reason === 'stream_error' || reason === 'timeout' || reason === 'disconnect' || reason === 'restart'
      const finalStatus = isErrorReason ? 'error' : 'complete'
      // [M2 error-visibility] 追加形态双通道（SSOT docs/architecture/conversation-error-visibility.md §3.3.2）：
      // errorText 写 Message.error 字段（message.ts:269 注释明确用途对口），content 保持崩溃前正常正文不动。
      // 旧 `${content}\n\n${errorText}` 拼接把 errorText 混进 content，渲染层无法区分哪段是错误。
      // 仅 assistant 消息写 error；非 assistant（user 提问等）保持 m.error 原值不写。
      const finalError = errorText && m.role === 'assistant' ? errorText : m.error
      return { ...m, status: finalStatus, content: m.content, error: finalError, toolCalls } satisfies Message
    })
    commitMessages(messages, sessionId, next)
  }

  return {
    applySubagentStreamDelta,
    finalizeSubagentStream,
    finalizeMessages,
    collectFinalizeCandidates,
    clearIndependentTransient,
  }
}
