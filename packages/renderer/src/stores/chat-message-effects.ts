/**
 * message.* 事件 effect 注册表（消除 double-dispatch，架构审查候选 F2）。
 *
 * 背景：原 chat-chunk-processor（21 case，更新 messages/retryStates/queueStates）
 * 与 useChat.ensureStreamSubscription（9 case，翻 isStreaming + updateLabel）对同一
 * ServerMessage 流 switch 两次。新增 message.* type 必须两处同步改，易漏。
 *
 * 归一：本文件把「每个 message.* type 触发的全部副作用」集中到单一 handler：
 * (a) chunk 状态更新（原 applyChunk 逻辑）+ (b) lifecycle flag 翻转（原 useChat
 * setStreaming）。useChat 收到 message.* 只调 store.applyMessageEvent（单一入口），
 * 不再自己 switch message.*。session.*（compacting/compacted/renamed/state_changed/
 * thinkingLevelSet）涉及跨 store（sessionStore.updateLabel/updateSessionState），
 * 保留在 useChat。
 *
 * 行为等价性：
 * - 状态更新顺序与原 applyChunk 逐 case 一致（handler 内先更新 chunk 状态，后翻 flag，
 *   对应原 useChat 先 appendAssistantChunk 再 switch 翻 flag 的顺序）。
 * - flag 翻转时机：message_start→true、complete/error/stream_error→false，与原 useChat
 *   switch 完全一致。
 *
 * 设计：dispatchMessageEvent(ctx, sessionId, msg) 查 messageEffects 表执行 handler；
 * 非 message.* 或未注册 type 直接 no-op。MessageEffectContext 含 store refs
 * 上下文 + setStreaming 回调（由 store 注入，翻转 isStreaming）。
 */
import type {
  ChangeSetStatus,
  ContentBlock,
  FileChange,
  Message,
  ServerMessage,
  ServerMessageType,
  ToolCall,
} from '@xyz-agent/shared'
import type { RetryState, QueueState } from './chat-store-types'
import {
  readString,
  readRecord,
  readNumber,
  readBool,
  readStringArray,
  readDetail,
  readUsage,
  readBashExecution,
  readCompactionSummary,
  readBranchSummary,
  readFileChanges,
  readChangeSetStatus,
} from './chat-readers'
import { findLastAssistantIndex, findToolCallOwner } from './chat-chunk-processor'

/**
 * message.* 事件副作用上下文（store refs + 跨方法回调，模块级函数据此更新）。
 *
 * - messages/retryStates/queueStates：原 ChunkContext，chunk 状态写入目标。
 * - applyFileChanges/markChangeSetsSuperseded：原 ChunkContext 回调（store 内合并逻辑）。
 * - setStreaming：lifecycle flag 翻转（原 useChat.switch 的副作用，归一进 handler）。
 */
export interface MessageEffectContext {
  messages: { value: Map<string, Message[]> }
  retryStates: { value: Map<string, RetryState> }
  queueStates: { value: Map<string, QueueState> }
  /** file_changes case 调 store.applyFileChanges（合并逻辑在 store 内） */
  applyFileChanges: (
    sessionId: string,
    messageId: string,
    changes: FileChange[],
    changeSetStatus: ChangeSetStatus,
    isFullSet: boolean,
  ) => void
  /** changeSetInvalidated case 调 store.markChangeSetsSuperseded（commit 后旧卡片过期） */
  markChangeSetsSuperseded: (sessionId: string) => void
  /** lifecycle flag 翻转（原 useChat.setStreaming，message_start→true / 终态→false）。
   *  sessionId 仅 message_start 传入（记录哪个 session 在流式），终态不传（清空）。 */
  setStreaming: (value: boolean, sessionId?: string | null) => void
  /** queue_update 投递信号：pi drain 某条 steer/followUp 时，转对应 pending user 消息为 complete */
  markPendingDelivered: (sessionId: string, text: string) => void
}

/**
 * 单个 message.* type 的 effect handler。
 *
 * 签名约定：接收上下文 + sessionId + payload，内部执行该 type 的全部副作用
 * （chunk 状态更新 + lifecycle flag）。返回值无意义（统一 void）。
 *
 * payload 类型：ADR-0015 类型基础。ServerMessageMap 对多数 message.* 用
 * Record<string, unknown> 占位（未收紧），handler 内用 readString 等安全窄化，
 * 与原 applyChunk 完全一致（不引入 any）。
 */
type MessageEffectHandler = (
  ctx: MessageEffectContext,
  sessionId: string,
  payload: Record<string, unknown>,
) => void

/**
 * message.* type → effect handler 注册表。
 *
 * 新增 message.* type 只在此表加一行，无需在两个 switch 同步改（消除 double-dispatch）。
 * 表内顺序仅作可读性，与执行顺序无关（每次 dispatch 单 case）。
 */
const messageEffects: Partial<Record<ServerMessageType, MessageEffectHandler>> = {
  // ── 主流式生命周期（chunk 创建/收口 + isStreaming flag 翻转）──
  'message.message_start': (ctx, sid, payload) => {
    const { messages, queueStates, setStreaming } = ctx
    const prev = messages.value.get(sid) ?? []
    // G-023: message_start 到达清除 QueueBubble（新回合已启动，排队消息已投递或过期）
    queueStates.value.delete(sid)
    const messageId = readString(payload, 'messageId') ?? `a-${crypto.randomUUID()}`
    messages.value.set(sid, [
      ...prev,
      {
        id: messageId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        timestamp: Date.now(),
        contentBlocks: [],
      },
    ])
    // lifecycle flag 翻转（原 useChat：message_start → setStreaming(true)）。
    // 传 sid 记录正在流式的 session（Panel per-session 生成态守卫用，防跨 session 误伤）
    setStreaming(true, sid)
  },

  'message.complete': (ctx, sid, payload) => {
    const { messages, setStreaming } = ctx
    const prev = messages.value.get(sid) ?? []
    const stopReason = readString(payload, 'stopReason')
    const isErrorStop = stopReason === 'error'
    // 收口兜底：流结束时仍 status:'running' 的 toolCall 说明未收到 tool_call_end
    // （进程崩溃/WS 断连/abort/event-adapter 乱序丢消息）。强收口避免 Block.vue
    // 永久锁定展开（isRunning → toolExpanded 恒 true）。
    // - error stopReason → 收口为 error（保留失败语义）
    // - 其它 → 收口为 end_not_received（诚实态，区别于假装成功的 completed）
    // 延迟到达的真实 tool_call_end 会用真实 output 覆盖收口值（end_not_received → completed）。
    const finalizeToolCalls = (toolCalls: ToolCall[] | undefined): ToolCall[] =>
      (toolCalls ?? []).map((c) =>
        c.status === 'running'
          ? {
            ...c,
            status: (isErrorStop ? 'error' : 'end_not_received') as ToolCall['status'],
            endTime: c.endTime ?? Date.now(),
          }
          : c,
      )
    // [HISTORICAL] 收口**所有** status==='streaming' 的 assistant 气泡，不只用
    // findLastAssistantIndex 收最后一条。一个 turn 可能产生多个 assistant 气泡
    // （工具调用气泡 + 文字总结气泡）：只转最后一条会让前面的 toolCall 气泡永远 streaming，
    // 内部 status 虽视觉无感（turn 整体收口），但状态机不一致且影响后续定位逻辑。
    // usage（W05-A turn 级聚合）只回填最后一条 assistant——回填到非末 assistant 语义错位。
    const lastAssistantIdx = findLastAssistantIndex(prev)
    let changed = false
    const next = prev.map((m, i) => {
      if (m.role !== 'assistant' || m.status !== 'streaming') return m
      changed = true
      const finalizedToolCalls = finalizeToolCalls(m.toolCalls)
      // 仅最后一条 assistant 回填 usage（turn 级聚合，回填非末会语义错位）
      const usage = i === lastAssistantIdx ? readUsage(payload) : undefined
      return {
        ...m,
        status: isErrorStop ? 'error' : 'complete',
        toolCalls: finalizedToolCalls,
        ...(usage ? { usage } : {}),
      } satisfies Message
    })
    if (changed) messages.value.set(sid, next)
    // lifecycle flag 翻转（原 useChat：complete → setStreaming(false)）
    setStreaming(false)
  },

  'message.error': (ctx, sid, payload) => {
    const { messages, setStreaming } = ctx
    const prev = messages.value.get(sid) ?? []
    // 规则 #3：错误必须重置 streaming 状态，避免单条气泡卡「生成中」。
    const errorText = readString(payload, 'message') ?? 'Unknown error'
    const idx = findLastAssistantIndex(prev)
    if (idx >= 0 && prev[idx].status === 'streaming') {
      const last = prev[idx]
      const next = [...prev]
      next[idx] = {
        ...last,
        content: last.content ? `${last.content}\n\n${errorText}` : errorText,
        status: 'error',
      }
      messages.value.set(sid, next)
    } else {
      messages.value.set(sid, [
        ...prev,
        { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: errorText, status: 'error', timestamp: Date.now() },
      ])
    }
    // lifecycle flag 翻转（原 useChat：error → setStreaming(false)）
    setStreaming(false)
  },

  'message.stream_error': (ctx, sid, payload) => {
    const { messages, setStreaming } = ctx
    const prev = messages.value.get(sid) ?? []
    // FR-5: streaming 错误（pi message_update{error}）。若无前置 assistant 流（prompt
    // 级失败/流启动前即报错），合成 error 消息，避免错误内容丢失（违反规则 #3）。
    const streamErrContent = readString(payload, 'content') ?? ''
    const sIdx = findLastAssistantIndex(prev)
    if (sIdx < 0) {
      messages.value.set(sid, [
        ...prev,
        { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: streamErrContent, status: 'error', timestamp: Date.now() },
      ])
    } else {
      const sNext = [...prev]
      sNext[sIdx] = {
        ...sNext[sIdx],
        content: streamErrContent ? `${sNext[sIdx].content}${streamErrContent}` : sNext[sIdx].content,
        status: 'error',
      }
      messages.value.set(sid, sNext)
    }
    // lifecycle flag 翻转（原 useChat：stream_error 也属终态 → setStreaming(false)）。
    // 若 pi 发了 message_update{error} 后不再发 agent_end，必须在此复位，否则 UI 卡「思考中」。
    setStreaming(false)
  },

  // ── 文本流（纯 chunk 更新，不翻 lifecycle flag）──
  'message.text_delta': (ctx, sid, payload) => {
    const { messages } = ctx
    const prev = messages.value.get(sid) ?? []
    const idx = findLastAssistantIndex(prev)
    if (idx < 0) return
    const delta = readString(payload, 'delta') ?? ''
    const next = [...prev]
    // 首个 text_delta push text 块到 contentBlocks（幂等：已含 text 块则不重复 push）。
    const prevBlocks = next[idx].contentBlocks ?? []
    const contentBlocks = prevBlocks.some((b) => b.type === 'text')
      ? prevBlocks
      : [...prevBlocks, { type: 'text', refId: 'text' } satisfies ContentBlock]
    next[idx] = { ...next[idx], content: next[idx].content + delta, contentBlocks }
    messages.value.set(sid, next)
  },

  // ── thinking 流（折进 trace，W05 endTime）──
  'message.thinking_start': (ctx, sid, payload) => {
    const { messages } = ctx
    const prev = messages.value.get(sid) ?? []
    const idx = findLastAssistantIndex(prev)
    if (idx < 0) return
    const blockId = readString(payload, 'thinkingId') ?? `th-${crypto.randomUUID()}`
    const next = [...prev]
    const thinking = [...(next[idx].thinking ?? []), { id: blockId, content: '', collapsed: true, startTime: Date.now() }]
    // push 到 contentBlocks 尾部（refId 复用 blockId，防两处分别 randomUUID 断链）。
    const contentBlocks = [...(next[idx].contentBlocks ?? []), { type: 'thinking', refId: blockId } satisfies ContentBlock]
    next[idx] = { ...next[idx], thinking, contentBlocks }
    messages.value.set(sid, next)
  },

  'message.thinking_end': (ctx, sid) => {
    const { messages } = ctx
    const prev = messages.value.get(sid) ?? []
    // W05-A：给最后 ThinkingBlock 设 endTime（字段已存在 message.ts:30）。
    // payload 仅 {sessionId}（event-adapter thinking_end 不带额外字段）。
    const idx = findLastAssistantIndex(prev)
    if (idx < 0) return
    const thinking = prev[idx].thinking
    if (!thinking || thinking.length === 0) return
    const lastIdx = thinking.length - 1
    const next = [...prev]
    const nextThinking = [...thinking]
    nextThinking[lastIdx] = { ...nextThinking[lastIdx], endTime: Date.now() }
    next[idx] = { ...next[idx], thinking: nextThinking }
    messages.value.set(sid, next)
  },

  'message.thinking_delta': (ctx, sid, payload) => {
    const { messages } = ctx
    const prev = messages.value.get(sid) ?? []
    const idx = findLastAssistantIndex(prev)
    if (idx < 0) return
    const delta = readString(payload, 'delta') ?? ''
    const next = [...prev]
    const thinking = [...(next[idx].thinking ?? [])]
    const last = thinking[thinking.length - 1]
    if (last) thinking[thinking.length - 1] = { ...last, content: last.content + delta }
    next[idx] = { ...next[idx], thinking }
    messages.value.set(sid, next)
  },

  // ── tool_call 流（ID 锚定，W05 detail）──
  'message.tool_call_start': (ctx, sid, payload) => {
    const { messages } = ctx
    const prev = messages.value.get(sid) ?? []
    const idx = findLastAssistantIndex(prev)
    if (idx < 0) return
    const callId = readString(payload, 'toolCallId') ?? `tc-${crypto.randomUUID()}`
    const toolName = readString(payload, 'toolName') ?? 'tool'
    const call: ToolCall = {
      id: callId,
      toolName,
      input: readRecord(payload, 'input'),
      status: 'running',
      startTime: Date.now(),
    }
    const next = [...prev]
    const toolCalls = [...(next[idx].toolCalls ?? []), call]
    // push 到 contentBlocks 尾部（callId 复用，与 toolCalls[].id 一致）。
    const contentBlocks = [...(next[idx].contentBlocks ?? []), { type: 'toolCall', refId: callId } satisfies ContentBlock]
    next[idx] = { ...next[idx], toolCalls, contentBlocks }
    messages.value.set(sid, next)
  },

  'message.tool_call_end': (ctx, sid, payload) => {
    const { messages } = ctx
    const prev = messages.value.get(sid) ?? []
    const callId = readString(payload, 'toolCallId')
    // ID 锚定：按 toolCallId 精确定位所属 assistant message（见 findToolCallOwner 注释），
    // 不靠 findLastAssistantIndex（位置定位会被乱序/噪声 message 干扰）。
    // callId 缺失或未命中时降级为最后一条 assistant（防御：兼容异常事件）。
    const idx = callId ? findToolCallOwner(prev, callId) : findLastAssistantIndex(prev)
    if (idx < 0) return
    const next = [...prev]
    const toolCalls = (next[idx].toolCalls ?? []).map((c) =>
      c.id === callId
        ? {
          ...c,
          output: readString(payload, 'output') ?? c.output,
          status: (readString(payload, 'status') as ToolCall['status']) ?? 'completed',
          error: readString(payload, 'error') ?? c.error,
          endTime: Date.now(),
        }
        : c,
    )
    next[idx] = { ...next[idx], toolCalls }
    messages.value.set(sid, next)
  },

  'message.tool_call_update': (ctx, sid, payload) => {
    const { messages } = ctx
    const prev = messages.value.get(sid) ?? []
    // W05-A：Extension 工具调用进度更新。event-adapter tool_execution_update
    // 生产端只发 detail（string | object），消费对齐生产端（不臆造 progress）。
    const callId = readString(payload, 'toolCallId')
    if (!callId) return
    // ID 锚定（见 tool_call_end 注释），避免乱序命中错误 message。
    const idx = findToolCallOwner(prev, callId)
    if (idx < 0) return
    const detail = readDetail(payload, 'detail')
    const next = [...prev]
    const toolCalls = (next[idx].toolCalls ?? []).map((c) =>
      c.id === callId ? { ...c, detail } : c,
    )
    next[idx] = { ...next[idx], toolCalls }
    messages.value.set(sid, next)
  },

  // ── 运行态 / 元信息（system 提示行，W05-A/W07-C）──
  'message.status': () => {
    // W05-A：运行时态推送（steer/aborted/sent/queued 等运行状态）。
    // 区别于请求级 reply（send/steer/follow_up/abort 的 reply 已走 pending 通道，
    // 不经 streamSubscribe）——此处是 pi status 事件经 event-adapter 直推。
    // 当前最小化：仅接收记录，不改 Message.status（streaming/complete/error 是
    // 消息生命周期，message.status 是运行过程态，两者正交）。
  },

  'message.bashExecution': (ctx, sid, payload) => {
    const { messages } = ctx
    const prev = messages.value.get(sid) ?? []
    // W07-C：bash 执行记录。作 system 提示行渲染（非 user/assistant）。
    const exec = readBashExecution(payload)
    messages.value.set(sid, [
      ...prev,
      {
        id: `b-${crypto.randomUUID()}`,
        role: 'system',
        content: exec.command ?? 'bash',
        status: 'complete',
        timestamp: exec.timestamp ?? Date.now(),
        bashExecution: exec,
      },
    ])
  },

  'message.compactionSummary': (ctx, sid, payload) => {
    const { messages } = ctx
    const prev = messages.value.get(sid) ?? []
    // W07-C：上下文压缩摘要。作 system 提示行。
    const summary = readCompactionSummary(payload)
    messages.value.set(sid, [
      ...prev,
      {
        id: `c-${crypto.randomUUID()}`,
        role: 'system',
        content: summary.summary ?? '上下文已压缩',
        status: 'complete',
        timestamp: summary.timestamp ?? Date.now(),
        compactionSummary: summary,
      },
    ])
  },

  'message.branchSummary': (ctx, sid, payload) => {
    const { messages } = ctx
    const prev = messages.value.get(sid) ?? []
    // W07-C：分支摘要。作 system 提示行。
    const summary = readBranchSummary(payload)
    messages.value.set(sid, [
      ...prev,
      {
        id: `br-${crypto.randomUUID()}`,
        role: 'system',
        content: summary.summary ?? '已分支',
        status: 'complete',
        timestamp: summary.timestamp ?? Date.now(),
        branchSummary: summary,
      },
    ])
  },

  // ── 自动重试 / 队列（W06-B，store 级状态机）──
  'message.auto_retry_start': (ctx, sid, payload) => {
    const { retryStates } = ctx
    // W06-B：自动重试开始。写 retryStates[sessionId]（UI 据此显重试指示位）。
    const state: RetryState = {}
    const attempt = readNumber(payload, 'attempt')
    if (attempt !== undefined) state.attempt = attempt
    const maxAttempts = readNumber(payload, 'maxAttempts')
    if (maxAttempts !== undefined) state.maxAttempts = maxAttempts
    const delayMs = readNumber(payload, 'delayMs')
    if (delayMs !== undefined) state.delayMs = delayMs
    const errorMessage = readString(payload, 'errorMessage')
    if (errorMessage) state.errorMessage = errorMessage
    retryStates.value = new Map(retryStates.value).set(sid, state)
  },

  'message.auto_retry_end': (ctx, sid) => {
    const { retryStates } = ctx
    // W06-B：自动重试结束。清空 retryStates[sessionId]（不可变 delete）。
    if (retryStates.value.has(sid)) {
      const nextMap = new Map(retryStates.value)
      nextMap.delete(sid)
      retryStates.value = nextMap
    }
  },

  'message.queue_update': (ctx, sid, payload) => {
    const { queueStates, markPendingDelivered } = ctx
    // W06-B：消息队列更新。payload（event-adapter）：{ steering?, followUp? }。
    // pi 发空数组 []（_emitQueueUpdate 总展开为数组），空数组视为无内容（length 判断）。
    const state: QueueState = {}
    const steering = readStringArray(payload, 'steering')
    if (steering?.length) state.steering = steering
    const followUp = readStringArray(payload, 'followUp')
    if (followUp?.length) state.followUp = followUp

    // pending→complete 驱动：对比新旧队列，找出「消失的」steer/followUp 文本（pi drain 投递了它），
    // 转对应 pending user 消息为 complete。按 indexOf 匹配（与 pi 的 splice 语义一致）。
    const prev = queueStates.value.get(sid)
    if (prev) {
      const prevSteering = prev.steering ?? []
      const prevFollowUp = prev.followUp ?? []
      // 找 prev 有但新队列没有/减少的项（被 drain 投递）
      for (const text of prevSteering) {
        if (!steering?.includes(text)) markPendingDelivered(sid, text)
      }
      for (const text of prevFollowUp) {
        if (!followUp?.includes(text)) markPendingDelivered(sid, text)
      }
    }

    const hasContent = !!state.steering?.length || !!state.followUp?.length
    if (!hasContent) {
      if (queueStates.value.has(sid)) {
        const nextMap = new Map(queueStates.value)
        nextMap.delete(sid)
        queueStates.value = nextMap
      }
    } else {
      queueStates.value = new Map(queueStates.value).set(sid, state)
    }
  },

  // ── FileChanges 通道（W10，ADR-0024 D5 baseline diff）──
  'message.file_changes': (ctx, sid, payload) => {
    // W10：FileChanges 通道（ADR-0024 D5 重构：baseline diff）。isFullSet 恒 true，全集替换。
    const messageId = readString(payload, 'messageId')
    if (!messageId) return
    const fileChanges = readFileChanges(payload)
    const status = readChangeSetStatus(payload)
    const isFullSet = readBool(payload, 'isFullSet')
    ctx.applyFileChanges(sid, messageId, fileChanges, status, isFullSet)
  },

  'message.changeSetInvalidated': (ctx, sid) => {
    // D5 重构：commit 成功后工作区 diff 重置，旧 changeSet 卡片需标为已过期。
    // 前端按 payload.sessionId 路由，把该 session 非 resolved 态的 changeSet 推 superseded。
    ctx.markChangeSetsSuperseded(sid)
  },
}

/**
 * message.* 事件的单一入口（消除 double-dispatch）。
 *
 * useChat.ensureStreamSubscription 收到任意 ServerMessage 后：
 * - message.* → 调本函数（经 store.applyMessageEvent 转发），注册表执行全部 effect
 * - session.* → useChat 保留处理（跨 store：sessionStore.updateLabel 等）
 *
 * 非 message.* 或未注册的 message.* type 直接 no-op（等价原 applyChunk 的 default return）。
 */
export function dispatchMessageEvent(
  ctx: MessageEffectContext,
  sessionId: string,
  msg: ServerMessage,
): void {
  const handler = messageEffects[msg.type as ServerMessageType]
  if (handler) handler(ctx, sessionId, msg.payload)
}

/** 注册表是否覆盖某 type（测试可断言完整性，防新增 message.* 漏注册） */
export function hasMessageEffect(type: ServerMessageType): boolean {
  return type in messageEffects
}
