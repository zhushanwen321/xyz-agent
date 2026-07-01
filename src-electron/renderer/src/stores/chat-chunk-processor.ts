/**
 * chat store 的流式 chunk 分发处理器（从 chat.ts 提取，控制主文件行数 ≤500）。
 *
 * applyChunk 按 ServerMessage.type 追加/更新流式 chunk。store.appendAssistantChunk 调此函数，
 * 传入 store refs（messages/retryStates/queueStates）+ applyFileChanges 回调。
 *
 * 块类型覆盖（W01 契约 + W05-W10 扩展）：
 * - text（message_start/text_delta/complete）—— 主流式路径
 * - thinking（thinking_start/delta/end）—— 折进 trace（W05 endTime）
 * - tool_call（start/end/update）—— 折进 trace（W05 detail）
 * - error（message.error / stream_error / complete.stopReason:error）—— 挂最后 assistant 块
 * - W05-A：thinking_end/tool_call_update/status/complete.usage（纯字段）
 * - W06-B：auto_retry_start/end（retryStates）、queue_update（queueStates，store 级状态）
 * - W07-C：bashExecution/compactionSummary/branchSummary（system 提示行）
 * - W10：message.file_changes（FileChanges 通道，调 store.applyFileChanges）
 */
import type { Ref } from 'vue'
import type {
  ChangeSetStatus,
  ContentBlock,
  FileChange,
  Message,
  ServerMessage,
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

/**
 * appendAssistantChunk 的可变状态上下文（store refs 传入，模块级函数据此更新）。
 */
export interface ChunkContext {
  messages: Ref<Map<string, Message[]>>
  retryStates: Ref<Map<string, RetryState>>
  queueStates: Ref<Map<string, QueueState>>
  /** W10：file_changes case 调 store.applyFileChanges（合并逻辑在 store 内） */
  applyFileChanges: (
    sessionId: string,
    messageId: string,
    changes: FileChange[],
    changeSetStatus: ChangeSetStatus,
    isFullSet: boolean,
  ) => void
  /** D5 重构：changeSetInvalidated case 调 store.markChangeSetsSuperseded（commit 后旧卡片过期） */
  markChangeSetsSuperseded: (sessionId: string) => void
}

/** 从后往前找最后一条 assistant message 的下标 */
export function findLastAssistantIndex(list: Message[]): number {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].role === 'assistant') return i
  }
  return -1
}

/**
 * 按 toolCallId 全局查找所属 assistant message 的下标（ID 锚定，不靠位置）。
 *
 * [HISTORICAL] 为什么不用 findLastAssistantIndex：event-adapter 并行处理 pi 事件
 * （void this.handleEvent 不 await），tool_execution_end 的 async handler（含 hook + git 对账）
 * 可能晚于下一个 message_start 发送。若用「最后一条 assistant」定位，end 会命中错位的 message
 * （如 toolResult 假 message_start 建的空 message），更新静默失败，toolCall 永久卡 running。
 *
 * 按 toolCallId 锚定让乱序无害化：无论事件到达顺序，end/update 都精确命中真正含该 toolCall 的 message。
 * 从后往前扫：toolCall 总是挂在最近的 assistant message（多 assistant turn 时命中最新）。
 * 消息量通常 <100，O(n) 可接受；性能瓶颈出现再加索引。
 */
export function findToolCallOwner(list: Message[], toolCallId: string): number {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].role === 'assistant' && list[i].toolCalls?.some((tc) => tc.id === toolCallId)) {
      return i
    }
  }
  return -1
}

/**
 * 按 ServerMessage.type 追加/更新流式 chunk。
 * 不可变更新（新数组 + Map.set）保证 Vue 对 Map 的集合响应性可靠触发。
 */
export function applyChunk(ctx: ChunkContext, sessionId: string, msg: ServerMessage): void {
  const { messages, retryStates, queueStates } = ctx
  const prev = messages.value.get(sessionId) ?? []
  switch (msg.type) {
    case 'message.message_start': {
      // G-023: message_start 到达清除 QueueBubble（新回合已启动，排队消息已投递或过期）
      queueStates.value.delete(sessionId)
      const messageId = readString(msg.payload, 'messageId') ?? `a-${crypto.randomUUID()}`
      messages.value.set(sessionId, [
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
      break
    }
    case 'message.text_delta': {
      const idx = findLastAssistantIndex(prev)
      if (idx < 0) return
      const delta = readString(msg.payload, 'delta') ?? ''
      const next = [...prev]
      // 首个 text_delta push text 块到 contentBlocks（幂等：已含 text 块则不重复 push）。
      const prevBlocks = next[idx].contentBlocks ?? []
      const contentBlocks = prevBlocks.some((b) => b.type === 'text')
        ? prevBlocks
        : [...prevBlocks, { type: 'text', refId: 'text' } satisfies ContentBlock]
      next[idx] = { ...next[idx], content: next[idx].content + delta, contentBlocks }
      messages.value.set(sessionId, next)
      break
    }
    case 'message.thinking_start': {
      const idx = findLastAssistantIndex(prev)
      if (idx < 0) return
      const blockId = readString(msg.payload, 'thinkingId') ?? `th-${crypto.randomUUID()}`
      const next = [...prev]
      const thinking = [...(next[idx].thinking ?? []), { id: blockId, content: '', collapsed: true, startTime: Date.now() }]
      // push 到 contentBlocks 尾部（refId 复用 blockId，防两处分别 randomUUID 断链）。
      const contentBlocks = [...(next[idx].contentBlocks ?? []), { type: 'thinking', refId: blockId } satisfies ContentBlock]
      next[idx] = { ...next[idx], thinking, contentBlocks }
      messages.value.set(sessionId, next)
      break
    }
    case 'message.thinking_end': {
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
      messages.value.set(sessionId, next)
      break
    }
    case 'message.thinking_delta': {
      const idx = findLastAssistantIndex(prev)
      if (idx < 0) return
      const delta = readString(msg.payload, 'delta') ?? ''
      const next = [...prev]
      const thinking = [...(next[idx].thinking ?? [])]
      const last = thinking[thinking.length - 1]
      if (last) thinking[thinking.length - 1] = { ...last, content: last.content + delta }
      next[idx] = { ...next[idx], thinking }
      messages.value.set(sessionId, next)
      break
    }
    case 'message.tool_call_start': {
      const idx = findLastAssistantIndex(prev)
      if (idx < 0) return
      const callId = readString(msg.payload, 'toolCallId') ?? `tc-${crypto.randomUUID()}`
      const toolName = readString(msg.payload, 'toolName') ?? 'tool'
      const call: ToolCall = {
        id: callId,
        toolName,
        input: readRecord(msg.payload, 'input'),
        status: 'running',
        startTime: Date.now(),
      }
      const next = [...prev]
      const toolCalls = [...(next[idx].toolCalls ?? []), call]
      // push 到 contentBlocks 尾部（callId 复用，与 toolCalls[].id 一致）。
      const contentBlocks = [...(next[idx].contentBlocks ?? []), { type: 'toolCall', refId: callId } satisfies ContentBlock]
      next[idx] = { ...next[idx], toolCalls, contentBlocks }
      messages.value.set(sessionId, next)
      break
    }
    case 'message.tool_call_end': {
      const callId = readString(msg.payload, 'toolCallId')
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
            output: readString(msg.payload, 'output') ?? c.output,
            status: (readString(msg.payload, 'status') as ToolCall['status']) ?? 'completed',
            error: readString(msg.payload, 'error') ?? c.error,
            endTime: Date.now(),
          }
          : c,
      )
      next[idx] = { ...next[idx], toolCalls }
      messages.value.set(sessionId, next)
      break
    }
    case 'message.tool_call_update': {
      // W05-A：Extension 工具调用进度更新。event-adapter tool_execution_update
      // 生产端只发 detail（string | object），消费对齐生产端（不臆造 progress）。
      const callId = readString(msg.payload, 'toolCallId')
      if (!callId) return
      // ID 锚定（见 tool_call_end 注释），避免乱序命中错误 message。
      const idx = findToolCallOwner(prev, callId)
      if (idx < 0) return
      const detail = readDetail(msg.payload, 'detail')
      const next = [...prev]
      const toolCalls = (next[idx].toolCalls ?? []).map((c) =>
        c.id === callId ? { ...c, detail } : c,
      )
      next[idx] = { ...next[idx], toolCalls }
      messages.value.set(sessionId, next)
      break
    }
    case 'message.complete': {
      const idx = findLastAssistantIndex(prev)
      if (idx < 0) return
      const last = prev[idx]
      if (last.status !== 'streaming') return
      const stopReason = readString(msg.payload, 'stopReason')
      const isErrorStop = stopReason === 'error'
      // 收口兜底：流结束时仍 status:'running' 的 toolCall 说明未收到 tool_call_end
      // （进程崩溃/WS 断连/abort/event-adapter 乱序丢消息）。强收口避免 Block.vue
      // 永久锁定展开（isRunning → toolExpanded 恒 true）。
      // - error stopReason → 收口为 error（保留失败语义）
      // - 其它 → 收口为 end_not_received（诚实态，区别于假装成功的 completed）
      // 延迟到达的真实 tool_call_end 会用真实 output 覆盖收口值（end_not_received → completed）。
      const finalizedToolCalls = (last.toolCalls ?? []).map((c) =>
        c.status === 'running'
          ? { ...c, status: (isErrorStop ? 'error' : 'end_not_received') as ToolCall['status'], endTime: c.endTime ?? Date.now() }
          : c,
      )
      // W05-A：消费 message.complete.usage（{inputTokens,outputTokens,totalTokens}）
      // 回填 Message.usage（字段已存在 message.ts:99）。stopReason:error → status:error。
      const usage = readUsage(msg.payload)
      const next = [...prev]
      next[idx] = {
        ...last,
        status: isErrorStop ? 'error' : 'complete',
        toolCalls: finalizedToolCalls,
        ...(usage ? { usage } : {}),
      }
      messages.value.set(sessionId, next)
      break
    }
    case 'message.status': {
      // W05-A：运行时态推送（steer/aborted/sent/queued 等运行状态）。
      // 区别于请求级 reply（send/steer/follow_up/abort 的 reply 已走 pending 通道，
      // 不经 streamSubscribe）——此处是 pi status 事件经 event-adapter 直推。
      // 当前最小化：仅接收记录，不改 Message.status（streaming/complete/error 是
      // 消息生命周期，message.status 是运行过程态，两者正交）。
      break
    }
    case 'message.bashExecution': {
      // W07-C：bash 执行记录。作 system 提示行渲染（非 user/assistant）。
      const exec = readBashExecution(msg.payload)
      messages.value.set(sessionId, [
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
      break
    }
    case 'message.compactionSummary': {
      // W07-C：上下文压缩摘要。作 system 提示行。
      const summary = readCompactionSummary(msg.payload)
      messages.value.set(sessionId, [
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
      break
    }
    case 'message.branchSummary': {
      // W07-C：分支摘要。作 system 提示行。
      const summary = readBranchSummary(msg.payload)
      messages.value.set(sessionId, [
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
      break
    }
    case 'message.auto_retry_start': {
      // W06-B：自动重试开始。写 retryStates[sessionId]（UI 据此显重试指示位）。
      const state: RetryState = {}
      const attempt = readNumber(msg.payload, 'attempt')
      if (attempt !== undefined) state.attempt = attempt
      const maxAttempts = readNumber(msg.payload, 'maxAttempts')
      if (maxAttempts !== undefined) state.maxAttempts = maxAttempts
      const delayMs = readNumber(msg.payload, 'delayMs')
      if (delayMs !== undefined) state.delayMs = delayMs
      const errorMessage = readString(msg.payload, 'errorMessage')
      if (errorMessage) state.errorMessage = errorMessage
      retryStates.value = new Map(retryStates.value).set(sessionId, state)
      break
    }
    case 'message.auto_retry_end': {
      // W06-B：自动重试结束。清空 retryStates[sessionId]（不可变 delete）。
      if (retryStates.value.has(sessionId)) {
        const nextMap = new Map(retryStates.value)
        nextMap.delete(sessionId)
        retryStates.value = nextMap
      }
      break
    }
    case 'message.queue_update': {
      // W06-B：消息队列更新。payload（event-adapter）：{ steering?, followUp? }。
      const state: QueueState = {}
      const steering = readStringArray(msg.payload, 'steering')
      if (steering) state.steering = steering
      const followUp = readStringArray(msg.payload, 'followUp')
      if (followUp) state.followUp = followUp
      if (!state.steering && !state.followUp) {
        if (queueStates.value.has(sessionId)) {
          const nextMap = new Map(queueStates.value)
          nextMap.delete(sessionId)
          queueStates.value = nextMap
        }
      } else {
        queueStates.value = new Map(queueStates.value).set(sessionId, state)
      }
      break
    }
    case 'message.stream_error': {
      // FR-5: streaming 错误（pi message_update{error}）。若无前置 assistant 流（prompt
      // 级失败/流启动前即报错），合成 error 消息，避免错误内容丢失（违反规则 #3）。
      const streamErrContent = readString(msg.payload, 'content') ?? ''
      const sIdx = findLastAssistantIndex(prev)
      if (sIdx < 0) {
        messages.value.set(sessionId, [
          ...prev,
          { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: streamErrContent, status: 'error', timestamp: Date.now() },
        ])
        break
      }
      const sNext = [...prev]
      sNext[sIdx] = {
        ...sNext[sIdx],
        content: streamErrContent ? `${sNext[sIdx].content}${streamErrContent}` : sNext[sIdx].content,
        status: 'error',
      }
      messages.value.set(sessionId, sNext)
      break
    }
    case 'message.error': {
      // 规则 #3：错误必须重置 streaming 状态，避免单条气泡卡「生成中」。
      const errorText = readString(msg.payload, 'message') ?? 'Unknown error'
      const idx = findLastAssistantIndex(prev)
      if (idx >= 0 && prev[idx].status === 'streaming') {
        const last = prev[idx]
        const next = [...prev]
        next[idx] = {
          ...last,
          content: last.content ? `${last.content}\n\n${errorText}` : errorText,
          status: 'error',
        }
        messages.value.set(sessionId, next)
        break
      }
      messages.value.set(sessionId, [
        ...prev,
        { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: errorText, status: 'error', timestamp: Date.now() },
      ])
      break
    }
    case 'message.file_changes': {
      // W10：FileChanges 通道（ADR-0024 D5 重构：baseline diff）。isFullSet 恒 true，全集替换。
      const messageId = readString(msg.payload, 'messageId')
      if (!messageId) return
      const fileChanges = readFileChanges(msg.payload)
      const status = readChangeSetStatus(msg.payload)
      const isFullSet = readBool(msg.payload, 'isFullSet')
      ctx.applyFileChanges(sessionId, messageId, fileChanges, status, isFullSet)
      break
    }
    case 'message.changeSetInvalidated': {
      // D5 重构：commit 成功后工作区 diff 重置，旧 changeSet 卡片需标为已过期。
      // 前端按 payload.sessionId 路由，把该 session 非 resolved 态的 changeSet 推 superseded。
      ctx.markChangeSetsSuperseded(sessionId)
      break
    }
    default:
      return
  }
}
