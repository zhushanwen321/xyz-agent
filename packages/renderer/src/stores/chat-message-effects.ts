/**
 * message.* 事件 effect 注册表（消除 double-dispatch，架构审查候选 F2）。
 *
 * 背景：原 chat-chunk-processor（21 case，更新 messages/retryStates/queueStates）
 * 与 useChat.ensureStreamSubscription（9 case，翻 isStreaming + updateLabel）对同一
 * ServerMessage 流 switch 两次。新增 message.* type 必须两处同步改，易漏。
 *
 * 归一：本文件把「每个 message.* type 触发的全部副作用」集中到单一 handler：
 * (a) chunk 状态更新（原 applyChunk 逻辑）+ (b) 终态收口（finalizeSession，替代原 useChat
 * setStreaming 的 lifecycle flag 翻转）。useChat 收到 message.* 只调 store.applyMessageEvent（单一入口），
 * 不再自己 switch message.*。session.*（compacting/compacted/renamed/state_changed/
 * thinkingLevelSet）涉及跨 store（sessionStore.updateLabel/updateSessionState），
 * 保留在 useChat。
 *
 * 行为等价性：
 * - 状态更新顺序与原 applyChunk 逐 case 一致（handler 内先更新 chunk 状态，后收口，
 *   对应原 useChat 先 appendAssistantChunk 再 switch 翻 flag 的顺序）。
 * - 收口时机：message_start 挂载超时兜底 timer、complete/error/stream_error 调
 *   finalizeSession 收口（status 由 streaming 派生 isGenerating，非手动 flag）。
 *
 * 设计：dispatchMessageEvent(ctx, sessionId, msg) 查 messageEffects 表执行 handler；
 * 非 message.* 或未注册 type 直接 no-op。MessageEffectContext 含 store refs
 * 上下文 + finalizeSession/clearPendingSend/armStreamingTimer 回调（由 store 注入，
 * 完成收口与超时兜底）。
 */
import type {
  ChangeSetStatus,
  ContentBlock,
  FileChange,
  Message,
  ServerMessage,
  ServerMessageType,
  SteerFollowUpMode,
  ToolCall,
} from '@xyz-agent/shared'
import { parseBgNotifyDetails } from '@xyz-agent/shared'
import type { RetryState, QueueState, FinalizeReason } from './chat-store-types'
import {
  readString,
  readRecord,
  readNumber,
  readBool,
  readStringArray,
  readDetail,
  readUsage,
  readCompactionSummary,
  readBranchSummary,
  readFileChanges,
  readChangeSetStatus,
} from './chat-readers'
import { findLastAssistantIndex, findToolCallOwner } from './chat-chunk-processor'

/**
 * 计数差集：返回 prev 比 next 多出的元素（按出现次数，非子串匹配）。
 *
 * [B1] queue_update drain 驱动 pending→complete 用。pi drain 一条 steer 时 splice 移除一项，
 * prev=['A','A'] → next=['A'] → 差集 ['A']（drain 了一条）。用 includes 会因 'A' 仍在 next 里
 * 漏判，导致第二条 pending 永久卡住。计数差集精确匹配出现次数差。
 *
 * 与 markPendingDelivered 的 findIndex FIFO 配合：countDrained 返回 N 条相同文本 →
 * 调 N 次 markPendingDelivered，每次转最早的 pending（FIFO，与 pi splice 顺序一致）。
 */
function countDrained(prev: string[], next: string[]): string[] {
  const remaining = [...next]
  const drained: string[] = []
  for (const text of prev) {
    const idx = remaining.indexOf(text)
    if (idx !== -1) {
      remaining.splice(idx, 1) // 仍在队列，消掉一个名额
    } else {
      drained.push(text) // prev 有但 next 没有/少了 → 被 drain
    }
  }
  return drained
}

/**
 * message.* 事件副作用上下文（store refs + 跨方法回调，模块级函数据此更新）。
 *
 * - messages/retryStates/queueStates：原 ChunkContext，chunk 状态写入目标。
 * - applyFileChanges/markChangeSetsSuperseded：原 ChunkContext 回调（store 内合并逻辑）。
 * - finalizeSession + clearPendingSend：统一收口出口（替代 setStreaming flag 翻转）。
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
  /** 统一收口出口（替代 setStreaming）。终态 handler 调。
   *  reason 决定终态映射；handler 自己改 entity status 后调此方法（幂等：entity 已终态则 no-op，
   *  只清 pendingSend + timer）。errorText 可选：error/stream_error 时写入。 */
  finalizeSession: (sessionId: string, reason: FinalizeReason, errorText?: string) => void
  /** message_start 清空窗（替代 setStreaming 隐式清 dispatching）。 */
  clearPendingSend: (sessionId: string) => void
  /** message_start 挂载 streaming 超时兜底 timer（防 complete 永不到的 pi 静默卡死）。 */
  armStreamingTimer: (sessionId: string) => void
  /** queue_update 投递信号 */
  markPendingDelivered: (sessionId: string, text: string, sendMode?: SteerFollowUpMode) => void
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
/**
 * 最后一条 assistant 是否仍 streaming（sealed guard helper，D-010）。
 * finalizeSession 后实体已终态 → 此函数返回 false → delta handler 早 return。
 */
function isLastAssistantStreaming(
  messages: { value: Map<string, Message[]> },
  sid: string,
): boolean {
  const list = messages.value.get(sid)
  if (!list || list.length === 0) return false
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'assistant') return list[i].status === 'streaming'
  }
  return false
}

const messageEffects: Partial<Record<ServerMessageType, MessageEffectHandler>> = {
  // ── 主流式生命周期（chunk 创建/收口 + isGenerating 派生）──
  'message.message_start': (ctx, sid, payload) => {
    const { messages, queueStates, clearPendingSend, armStreamingTimer } = ctx
    // G-023: message_start 到达清除 QueueBubble（新回合已启动，QueueBubble 不再需要显示）。
    // 只清 queueStates 显示态——pending→complete 的转换完全由 queue_update 的 countDrained
    // 精确驱动（pi 保证 queue_update(drain) 先于 message_start 到达，见 agent-session.ts:515-536
    // 注释 "remove it BEFORE emitting"）。此前有个 W2 flush（把残留 pending 强转 complete），
    // 基于错误前提「queue_update 可能晚于 message_start 乱序」——pi 同步保证不会乱序，
    // 且 abort 清空队列时强转会把「被丢弃」误标成「已投递」。已删除。
    queueStates.value.delete(sid)
    const prev = messages.value.get(sid) ?? []
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
    // 空窗结束：clearPendingSend（接管 dispatching 语义）
    clearPendingSend(sid)
    // 挂载 streaming 超时兜底 timer：防 message.complete 永不到的 pi 静默卡死。
    armStreamingTimer(sid)
  },

  'message.complete': (ctx, sid, payload) => {
    const { messages, finalizeSession } = ctx
    const prev = messages.value.get(sid) ?? []
    const stopReason = readString(payload, 'stopReason')
    const isErrorStop = stopReason === 'error'
    // [HISTORICAL] 收口**所有** status==='streaming' 的 assistant 气泡，不只用
    // findLastAssistantIndex 收最后一条。一个 turn 可能产生多个 assistant 气泡
    // （工具调用气泡 + 文字总结气泡）：只转最后一条会让前面的 toolCall 气泡永远 streaming，
    // 内部 status 虽视觉无感（turn 整体收口），但状态机不一致且影响后续定位逻辑。
    // usage（W05-A turn 级聚合）只回填最后一条 assistant——回填到非末 assistant 语义错位。
    // [W4] toolCall 终态收口收敛到 finalizeSession 统一处（原局部 finalizeToolCalls 已删除，
    // 避免两套映射漂移）。此处只改 message status + 回填 usage，toolCalls 保持原样传入；
    // 紧接着的 finalizeSession(sid, reason) 会把 running toolCall 按 reason 统一收口。
    //
    // 权威 content 覆盖：runtime 从 pi agent_end 提取的完整文本 content（见
    // event-adapter handleAgentEnd）。streaming 期间通过 text_delta 逐块累积，但末尾
    // delta 的 async 渲染竞态可能导致 markdown 未正确渲染（如 ** 未闭合）。用权威源
    // 覆盖最后一条 assistant 的 content，强制 MarkdownRenderer watch 重新触发渲染。
    // 仅非空时覆盖（abort 路径 payload 无 content，保留客户端累积值）。
    const finalContent = readString(payload, 'content')
    const lastAssistantIdx = findLastAssistantIndex(prev)
    let changed = false
    const next = prev.map((m, i) => {
      if (m.role !== 'assistant' || m.status !== 'streaming') return m
      changed = true
      // 仅最后一条 assistant 回填 usage + content（turn 级聚合，回填到非末 assistant 语义错位）
      const usage = i === lastAssistantIdx ? readUsage(payload) : undefined
      const shouldOverrideContent = i === lastAssistantIdx && finalContent && finalContent.length > 0
      return {
        ...m,
        status: isErrorStop ? 'error' : 'complete',
        ...(usage ? { usage } : {}),
        ...(shouldOverrideContent ? { content: finalContent } : {}),
      } satisfies Message
    })
    if (changed) messages.value.set(sid, next)
    // 统一收口（finalizeSession 幂等：entity 已改则 no-op，只清 pendingSend + timer）
    // 此处 message status 已改终态 → finalizeSession 内走「只补 toolCall 收口」分支。
    const reason: FinalizeReason = isErrorStop ? 'error' : (stopReason === 'aborted' ? 'aborted' : 'normal')
    finalizeSession(sid, reason)
  },

  'message.error': (ctx, sid, payload) => {
    const { messages, finalizeSession } = ctx
    const errorText = readString(payload, 'message') ?? 'Unknown error'
    // 检查是否有前置 streaming assistant（finalizeSession 会收口它）
    const prev = messages.value.get(sid) ?? []
    const idx = findLastAssistantIndex(prev)
    const hasStreaming = idx >= 0 && prev[idx].status === 'streaming'
    // 统一收口：finalizeSession 做 streaming entity error 化 + 清 pendingSend + 清 timer
    finalizeSession(sid, 'error', errorText)
    // 无前置 streaming entity 时 finalizeSession 不追加消息——需手动追加
    if (!hasStreaming) {
      messages.value.set(sid, [
        ...prev,
        { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: errorText, status: 'error', timestamp: Date.now() },
      ])
    }
  },

  'message.stream_error': (ctx, sid, payload) => {
    const { messages, finalizeSession } = ctx
    const streamErrContent = readString(payload, 'content') ?? 'Stream error'
    const prev = messages.value.get(sid) ?? []
    const idx = findLastAssistantIndex(prev)
    const hasStreaming = idx >= 0 && prev[idx].status === 'streaming'
    // 统一收口
    finalizeSession(sid, 'stream_error', streamErrContent)
    // 无前置 streaming entity 时需手动追加
    if (!hasStreaming) {
      messages.value.set(sid, [
        ...prev,
        { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: streamErrContent, status: 'error', timestamp: Date.now() },
      ])
    }
  },

  // ── 文本流（纯 chunk 更新，不翻 lifecycle flag）──
  'message.text_delta': (ctx, sid, payload) => {
    const { messages } = ctx
    // [D-010 sealed] finalizeSession 后晚到 delta 幂等丢弃
    if (!isLastAssistantStreaming(messages, sid)) return
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
    // [D-010 sealed]
    if (!isLastAssistantStreaming(messages, sid)) return
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
    // [D-010 sealed]
    if (!isLastAssistantStreaming(messages, sid)) return
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
    // [D-010 sealed]
    if (!isLastAssistantStreaming(messages, sid)) return
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
    // [D-010 sealed]
    if (!isLastAssistantStreaming(messages, sid)) return
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
    // details：pi tool_execution_end result.details（结构化扩展数据）。
    // subagent sync 模式的 progress 快照（currentTool/turn/tokens）在这里，前端 Block.vue 据此滚动更新。
    const details = readRecord(payload, 'details')
    const next = [...prev]
    const toolCalls = (next[idx].toolCalls ?? []).map((c) =>
      c.id === callId
        ? {
          ...c,
          output: readString(payload, 'output') ?? c.output,
          outputRaw: readString(payload, 'outputRaw') ?? c.outputRaw,
          status: (readString(payload, 'status') as ToolCall['status']) ?? 'completed',
          error: readString(payload, 'error') ?? c.error,
          endTime: Date.now(),
          details,
        }
        : c,
    )
    next[idx] = { ...next[idx], toolCalls }
    messages.value.set(sid, next)
  },

  'message.tool_call_update': (ctx, sid, payload) => {
    const { messages } = ctx
    // [D-010 sealed]
    if (!isLastAssistantStreaming(messages, sid)) return
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

  // ── pi CustomMessage 注入（扩展向对话流注入结构化通知）──
  'message.customStart': (ctx, sid, payload) => {
    const { messages } = ctx
    const customType = readString(payload, 'customType') ?? ''
    const content = readString(payload, 'content') ?? ''
    const details = readRecord(payload, 'details')
    const prev = messages.value.get(sid) ?? []
    // role:'system' → messageTurns 产出独立 RenderItem（穿插在 turn 间，不并入 user/assistant turn）
    const msg: Message = {
      id: `cm-${crypto.randomUUID()}`,
      role: 'system',
      content,
      status: 'complete',
      customType,
      // 保留原始 details（含 __gui__），前端检测 details.__gui__ 路由到 GuiComponentRenderer
      details,
      timestamp: Date.now(),
    }
    // subagent-bg-notify：解析 details 为 BgNotifyDetails（单条或批量），渲染层据此出卡片
    if (customType === 'subagent-bg-notify' && details) {
      const bgNotify = parseBgNotifyDetails(details)
      if (bgNotify) msg.bgNotify = bgNotify
    }
    messages.value.set(sid, [...prev, msg])
  },

  // ── 运行态 / 元信息（system 提示行，W05-A/W07-C）──
  'message.status': () => {
    // W05-A：运行时态推送（steer/aborted/sent/queued 等运行状态）。
    // 区别于请求级 reply（send/steer/follow_up/abort 的 reply 已走 pending 通道，
    // 不经 streamSubscribe）——此处是 pi status 事件经 event-adapter 直推。
    // 当前最小化：仅接收记录，不改 Message.status（streaming/complete/error 是
    // 消息生命周期，message.status 是运行过程态，两者正交）。
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

    // pending→complete 驱动：计数差集找出「被 drain 投递的」项（prev 比 new 多出的元素）。
    // [B1] 不能用 includes（子串语义）——重复文本 'A' 入队两条、drain 一条后 new=['A']，
    // includes('A')===true 会漏判，第二条 pending 永久卡住。计数差集按出现次数精确匹配。
    // [W5] 带 sendMode 调 markPendingDelivered，避免跨类型同文本误转（steer「补」与 followUp「补」）。
    const prev = queueStates.value.get(sid)
    if (prev) {
      for (const text of countDrained(prev.steering ?? [], steering ?? [])) {
        markPendingDelivered(sid, text, 'steer')
      }
      for (const text of countDrained(prev.followUp ?? [], followUp ?? [])) {
        markPendingDelivered(sid, text, 'follow-up')
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
