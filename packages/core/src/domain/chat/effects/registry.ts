/**
 * message.* 事件 effect 注册表（消除 double-dispatch，架构审查候选 F2）。
 *
 * [归位] 迁自 renderer stores/chat-message-effects.ts（P3 chat 域绞杀 w3：AC3 达成——
 * domain/chat/effects 零跨域 import）。
 * [P4 s5 w2] tasks 路由（routeToolResultToTasks/routeToolStartToTasks）与
 * openTasksPanelOnFirstData 回调已随 tasks 域删除移除。
 *
 * 背景：原 chat-chunk-processor（21 case，更新 messages/retryStates/queueStates）
 * 与 useChat.ensureStreamSubscription（9 case，翻 isStreaming + applySnapshot）对同一
 * ServerMessage 流 switch 两次。新增 message.* type 必须两处同步改，易漏。
 *
 * 归一：本文件把「每个 message.* type 触发的全部副作用」集中到单一 handler：
 * (a) chunk 状态更新（原 applyChunk 逻辑）+ (b) 终态收口（finalizeSession，替代原 useChat
 * setStreaming 的 lifecycle flag 翻转）。useChat 收到 message.* 只调 store.applyMessageEvent（单一入口），
 * 不再自己 switch message.*。session.*（compacting/compacted/renamed/state_changed/
 * thinkingLevelSet）涉及跨 store（sessionStore.applySnapshot），
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
 *
 * [W21 data-source-governance] entry 形态实时 feed：message.message_end /
 * message.tool_call_start / message.tool_call_end 的 handler 输入从「直译事件 payload」
 * 改为「重构 entry」（event-adapter 翻译时重构，字段对齐 pi entry schema）。状态类更新
 * 全走 reducer（ctx.applyEntryFrame 喂 store 内 per-session ChatViewState，与文件重放
 * 的 replayEntries 同一个 applyEntry——「live ≡ reload」构造性成立）；overlay 语义
 * （streaming 气泡 / running toolCall / delta 累积）保留 effect（transient 态 reducer
 * 无法表达，D5：partial content 不进 reducer，entry 提交时以 reducer 为权威）。
 */
import type {
  ContentBlock,
  Message,
  PiCompactionEntry,
  PiCustomMessageEntry,
  PiEntry,
  PiMessageEntry,
  PiToolCallEntryForm,
  ServerMessage,
  ServerMessageType,
  ToolCall,
} from '@xyz-agent/shared'
import { applyEntry, createInitialChatViewState, normalizePiToolResult } from '../apply-entry'
import type { RetryState, QueueState, FinalizeReason } from '../store-types'
import type { MessageEffectContext, MessageEffectHandler } from '../effect-types'
export type { MessageEffectContext, MessageEffectHandler } from '../effect-types'
import {
  readString,
  readNumber,
  readBool,
  readStringArray,
  readDetail,
  readUsage,
  readCompactionSummary,
  readBranchSummary,
  readFileChanges,
  readChangeSetStatus,
} from '../readers'
import { findLastAssistantIndex, findToolCallOwner } from '../chunk-processor'
import { commitMessages, type MessagesRef } from '../mutations'
import { truncateToolCall } from '../truncate-tool-output'
import { bashStartEffect, bashResultEffect } from '../bash-effects'
// [TODO @i18n-migration] core/i18n 落地后恢复 i18n.global.t 调用（§0.3 列为后续迁移）。
// 当前 branchSummary 的 summary 兜底文案用硬编码英文占位（summary 几乎总在场，兜底罕见）；
// compactionSummary 已 W6 entry 化，兜底文案收敛到 reducer 中文 fallback（live/reload 一致）。

/**
 * 计数差集：返回 prev 比 next 多出的元素（按出现次数，非子串匹配）。
 *
 * [B1] queue_update drain 驱动 pending→complete 用。pi drain 一条 steer 时 splice 移除一项，
 * prev=['A','A'] → next=['A'] → 差集 ['A']（drain 了一条）。用 includes 会因 'A' 仍在 next 里
 * 漏判，导致第二条 pending 永久卡住。计数差集精确匹配出现次数差。
 *
 * [W14] 与 drainN 计数 FIFO 配合：countDrained 返回数组的 length = 被投递条数 N →
 * drainN(sid, mode, N) 按入队顺序取 N 条（FIFO，与 pi splice 顺序一致），不按文本找——
 * pi 入队存 skill 展开后文本 ≠ 提交原文，文本匹配在该场景必挂（D6）。
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
  messages: MessagesRef,
  sid: string,
): boolean {
  const list = messages.value.get(sid)?.value
  if (!list || list.length === 0) return false
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'assistant') return list[i].status === 'streaming'
  }
  return false
}

/**
 * 按 pi contentIndex（产出顺序）有序插入 contentBlocks（§11 检查点 3 顺序语义统一）。
 *
 * 背景：streaming 事件到达顺序受 tool_execution_start 延迟扭曲（工具执行晚于模型输出），
 * 若纯 append，同 turn 内 text 在 tool 之后时 toolCall 块会排到 text 后面，与持久化路径
 * （按 pi content array 顺序 = contentIndex 顺序）错位。统一语义：contentBlocks 顺序 =
 * contentIndex 顺序（模型产出顺序），插入时找到第一个 contentIndex 更大的块插到其前。
 * 无 contentIndex（旧事件/兼容）时退化为 append 尾部。
 */
function insertContentBlockByIndex(blocks: ContentBlock[], block: ContentBlock): ContentBlock[] {
  const idx = block.contentIndex
  if (idx === undefined) return [...blocks, block]
  const insertAt = blocks.findIndex((b) => (b.contentIndex ?? Infinity) > idx)
  if (insertAt === -1) return [...blocks, block]
  const next = [...blocks]
  next.splice(insertAt, 0, block)
  return next
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
    const prev = messages.value.get(sid)?.value ?? []
    const messageId = readString(payload, 'messageId') ?? `a-${crypto.randomUUID()}`
    commitMessages(messages, sid, [
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
    const prev = messages.value.get(sid)?.value ?? []
    const stopReason = readString(payload, 'stopReason')
    const isErrorStop = stopReason === 'error'
    // [HISTORICAL] pi turn 失败（stopReason='error'）时 runtime event-adapter 从 agent_end 提取
    // errorMessage 放进本 payload。曾经过往 handler 只读 stopReason/content/usage 把它丢弃——
    // 秒败 turn（如模型 400 拒绝首请求）content 为空，气泡仅剩一个空 error 态，用户完全不可见。
    // 消费双通道（SSOT docs/architecture/conversation-error-visibility.md §3.3.2）：
    // 有 streaming 气泡 → errorMessage 写最后一条 assistant 的 Message.error 字段（追加形态，
    // content 崩溃前正文不动）；无 streaming 气泡 → 追加纯 error 气泡（errorMessage 即全文）。
    const errorMessage = readString(payload, 'errorMessage')
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
        // 追加形态错误：仅最后一条 assistant 写 Message.error（finalizeMessages 双通道同语义）
        ...(i === lastAssistantIdx && isErrorStop && errorMessage ? { error: errorMessage } : {}),
        ...(shouldOverrideContent ? { content: finalContent } : {}),
      } satisfies Message
    })
    // 秒败 turn（message_start 丢失/未广播）无 streaming 气泡可收口：错误信息必须以纯 error
    // 气泡落进聊天流，否则 complete 事件被消费后错误只剩 stopReason 标志，用户不可见。
    if (isErrorStop && errorMessage && !changed) {
      commitMessages(messages, sid, [
        ...prev,
        { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: errorMessage, status: 'error', timestamp: Date.now() },
      ])
    }
    if (changed) commitMessages(messages, sid, next)
    // 统一收口（finalizeSession 幂等：entity 已改则 no-op，只清 pendingSend + timer）
    // 此处 message status 已改终态 → finalizeSession 内走「只补 toolCall 收口」分支。
    const reason: FinalizeReason = isErrorStop ? 'error' : (stopReason === 'aborted' ? 'aborted' : 'normal')
    finalizeSession(sid, reason)
  },

  'message.error': (ctx, sid, payload) => {
    const { messages, finalizeSession } = ctx
    const errorText = readString(payload, 'message') ?? 'Unknown error'
    // 检查是否有前置 streaming assistant（finalizeSession 会收口它）
    const prev = messages.value.get(sid)?.value ?? []
    const idx = findLastAssistantIndex(prev)
    const hasStreaming = idx >= 0 && prev[idx].status === 'streaming'
    // 统一收口：finalizeSession 做 streaming entity error 化 + 清 pendingSend + 清 timer
    finalizeSession(sid, 'error', errorText)
    // 无前置 streaming entity 时 finalizeSession 不追加消息——需手动追加
    if (!hasStreaming) {
      commitMessages(messages, sid, [
        ...prev,
        { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: errorText, status: 'error', timestamp: Date.now() },
      ])
    }
  },

  'message.stream_error': (ctx, sid, payload) => {
    const { messages, finalizeSession } = ctx
    const streamErrContent = readString(payload, 'content') ?? 'Stream error'
    const prev = messages.value.get(sid)?.value ?? []
    const idx = findLastAssistantIndex(prev)
    const hasStreaming = idx >= 0 && prev[idx].status === 'streaming'
    // 统一收口
    finalizeSession(sid, 'stream_error', streamErrContent)
    // 无前置 streaming entity 时需手动追加
    if (!hasStreaming) {
      commitMessages(messages, sid, [
        ...prev,
        { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: streamErrContent, status: 'error', timestamp: Date.now() },
      ])
    }
  },

  // B1（PR#86 review）：pi 静默卡死 WARN（120s 无活动，提示性，不中断流）。
  // 与 stream_error 物理隔离——仅追加 system 提示消息，不调 finalizeSession，
  // session 保持 streaming 态（pi 可能只是慢，130s 后恢复产出）。
  // [W2 fix-chat-flow-order D4] liveOnly 标记（全仓唯一写入点）：stream_warn 是 xyz runtime
  // 自产健康警告，pi 无对应 entry、重开即消失——无 entry 可构故不 entry 化（直插即本类
  // 消息的正确入流路径），分组层据此归 turn 内 notice（不切断 turn，W3 消费），不参与
  // 「live ≡ reload」等价性断言。
  'message.stream_warn': (ctx, sid, payload) => {
    const { messages } = ctx
    const warnContent = readString(payload, 'content') ?? '长时间无响应'
    const prev = messages.value.get(sid)?.value ?? []
    commitMessages(messages, sid, [
      ...prev,
      { id: `s-${crypto.randomUUID()}`, role: 'system', content: warnContent, status: 'complete', timestamp: Date.now(), liveOnly: true },
    ])
  },

  // ── 文本流（纯 chunk 更新，不翻 lifecycle flag）──
  'message.text_delta': (ctx, sid, payload) => {
    const { messages } = ctx
    // [D-010 sealed] finalizeSession 后晚到 delta 幂等丢弃
    if (!isLastAssistantStreaming(messages, sid)) return
    const prev = messages.value.get(sid)?.value ?? []
    const idx = findLastAssistantIndex(prev)
    if (idx < 0) return
    const delta = readString(payload, 'delta') ?? ''
    const next = [...prev]
    // 首个 text_delta push text 块到 contentBlocks（幂等：已含 text 块则不重复 push）。
    // 插入位置按 contentIndex 有序插入（§11 检查点 3），无 index 时退化为 append。
    const prevBlocks = next[idx].contentBlocks ?? []
    const contentBlocks = prevBlocks.some((b) => b.type === 'text')
      ? prevBlocks
      : insertContentBlockByIndex(prevBlocks, { type: 'text', refId: 'text', ...(readNumber(payload, 'contentIndex') !== undefined ? { contentIndex: readNumber(payload, 'contentIndex') } : {}) } satisfies ContentBlock)
    next[idx] = { ...next[idx], content: next[idx].content + delta, contentBlocks }
    commitMessages(messages, sid, next)
  },

  // ── thinking 流（折进 trace，W05 endTime）──
  'message.thinking_start': (ctx, sid, payload) => {
    const { messages } = ctx
    // [D-010 sealed]
    if (!isLastAssistantStreaming(messages, sid)) return
    const prev = messages.value.get(sid)?.value ?? []
    const idx = findLastAssistantIndex(prev)
    if (idx < 0) return
    const blockId = readString(payload, 'thinkingId') ?? `th-${crypto.randomUUID()}`
    const next = [...prev]
    const thinking = [...(next[idx].thinking ?? []), { id: blockId, content: '', collapsed: true, startTime: Date.now() }]
    // push 到 contentBlocks（refId 复用 blockId，防两处分别 randomUUID 断链）。
    // 按 contentIndex 有序插入（§11 检查点 3），无 index 时退化为 append。
    const contentBlocks = insertContentBlockByIndex(next[idx].contentBlocks ?? [], { type: 'thinking', refId: blockId, ...(readNumber(payload, 'contentIndex') !== undefined ? { contentIndex: readNumber(payload, 'contentIndex') } : {}) } satisfies ContentBlock)
    next[idx] = { ...next[idx], thinking, contentBlocks }
    commitMessages(messages, sid, next)
  },

  'message.thinking_end': (ctx, sid) => {
    const { messages } = ctx
    // [D-010 sealed]
    if (!isLastAssistantStreaming(messages, sid)) return
    const prev = messages.value.get(sid)?.value ?? []
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
    commitMessages(messages, sid, next)
  },

  'message.thinking_delta': (ctx, sid, payload) => {
    const { messages } = ctx
    // [D-010 sealed]
    if (!isLastAssistantStreaming(messages, sid)) return
    const prev = messages.value.get(sid)?.value ?? []
    const idx = findLastAssistantIndex(prev)
    if (idx < 0) return
    const delta = readString(payload, 'delta') ?? ''
    const next = [...prev]
    const thinking = [...(next[idx].thinking ?? [])]
    const last = thinking[thinking.length - 1]
    if (last) thinking[thinking.length - 1] = { ...last, content: last.content + delta }
    next[idx] = { ...next[idx], thinking }
    commitMessages(messages, sid, next)
  },

  // ── tool_call 流（ID 锚定，W05 detail；[W21] 输入换 entry 形态）──
  'message.tool_call_start': (ctx, sid, payload) => {
    const { messages } = ctx
    // [D-010 sealed]
    if (!isLastAssistantStreaming(messages, sid)) return
    const prev = messages.value.get(sid)?.value ?? []
    const idx = findLastAssistantIndex(prev)
    if (idx < 0) return
    // [W21] 输入从直译平铺 payload 改为 toolCall entry 形态（event-adapter 翻译时重构，
    // interpreter 补 contentIndex/messageId 锚点）。entry 缺失（异常帧）降级丢弃；
    // toolCallId 缺失时 fallback 随机 id（迁移前同款宽容防御：异常事件不断流）。
    const entry = payload['entry'] as PiToolCallEntryForm | undefined
    if (entry === undefined) return
    const callId = typeof entry.toolCallId === 'string' ? entry.toolCallId : `tc-${crypto.randomUUID()}`
    const toolName = typeof entry.toolName === 'string' ? entry.toolName : 'tool'
    const call: ToolCall = {
      id: callId,
      toolName,
      input: entry.arguments ?? {},
      status: 'running',
      startTime: Date.now(),
    }
    // goal_control create 的 input.objective 只在此刻可得（tool result details 不回传），提前提取。
    // [P4 s5 w2] tasks 域已删除（D5 存根过渡到期），objective 提取随 tasks store 一并移除。
    const next = [...prev]
    const toolCalls = [...(next[idx].toolCalls ?? []), call]
    // push 到 contentBlocks（callId 复用，与 toolCalls[].id 一致）。
    // 按 contentIndex 有序插入（§11 检查点 3），无 index 时退化为 append。
    const contentBlocks = insertContentBlockByIndex(next[idx].contentBlocks ?? [], { type: 'toolCall', refId: callId, ...(entry.contentIndex !== undefined ? { contentIndex: entry.contentIndex } : {}) } satisfies ContentBlock)
    next[idx] = { ...next[idx], toolCalls, contentBlocks }
    commitMessages(messages, sid, next)
  },

  'message.tool_call_end': (ctx, sid, payload) => {
    const { messages } = ctx
    const prev = messages.value.get(sid)?.value ?? []
    // [W21] 输入从直译平铺 payload 改为 toolResult message entry 形态（与 pi 持久化
    // toolResult entry 同构）。overlay 收口（streaming 气泡上的 running toolCall → 终态）
    // 语义保留；权威回填经 ctx.applyEntryFrame 喂 reducer（先于 overlay 早 return——
    // ref 无 owner 时 reducer 喂入照常，ref 收敛归 W22）。
    const entry = payload['entry'] as PiMessageEntry | undefined
    if (entry === undefined || entry.type !== 'message') return
    // 状态类全走 reducer（w21）：toolResult entry 喂 per-session reducer state
    ctx.applyEntryFrame(sid, entry)
    const callId = typeof entry.message.toolCallId === 'string' ? entry.message.toolCallId : undefined
    // ID 锚定：按 toolCallId 精确定位所属 assistant message（见 findToolCallOwner 注释），
    // 不靠 findLastAssistantIndex（位置定位会被乱序/噪声 message 干扰）。
    // callId 缺失或未命中时降级为最后一条 assistant（防御：兼容异常事件）。
    const idx = callId ? findToolCallOwner(prev, callId) : findLastAssistantIndex(prev)
    if (idx < 0) return
    // details：pi tool_execution_end result.details（结构化扩展数据）。
    // subagent sync 模式的 progress 快照（currentTool/turn/tokens）在这里，前端 Block.vue 据此滚动更新。
    // 三态归一在消费侧做：传 entry.message（body）——与 reducer computeToolCallFill 同语义
    //（content block 数组 → join text），entry.content 已由 adapter 归一为数组形态（W21）。
    // content 缺失（mock/异常帧）保留 running 期间的旧值（迁移前 `?? c.output` 同语义）。
    const hasContent = entry.message.content !== undefined
    const { output, outputRaw } = hasContent
      ? normalizePiToolResult(entry.message)
      : { output: undefined, outputRaw: undefined }
    const details = entry.message.details
    const isError = entry.message.isError === true
    const next = [...prev]
    const toolCalls = (next[idx].toolCalls ?? []).map((c) =>
      c.id === callId
        ? truncateToolCall({
          ...c,
          ...(output !== undefined && { output }),
          ...(outputRaw !== undefined && { outputRaw }),
          // 与重放路径（reducer：isError → status:'error'）保持一致：实时失败的 tool call
          // 必须带 status:'error'，否则前端 Block.vue 的 isFailed 判定恒为 false（恒显示成功）。
          status: isError ? 'error' : 'completed',
          ...(isError && { error: output ?? c.error }),
          endTime: Date.now(),
          ...(details !== undefined && { details: details as Record<string, unknown> }),
        })
        : c,
    )
    next[idx] = { ...next[idx], toolCalls }
    commitMessages(messages, sid, next)
  },

  // ── [W21] message_end —— 重构 entry 喂 reducer（实时 feed 权威载体，reducer 薄封装）──
  'message.message_end': (ctx, sid, payload) => {
    const entry = payload['entry']
    // entry 形态守卫：message entry（type:'message'）才喂（协议契约，异常帧降级丢弃）
    if (typeof entry !== 'object' || entry === null || (entry as { type?: unknown }).type !== 'message') return
    // custom role 去双计：pi 对同一条 custom message 双发 message_start + message_end（同一
    // message 对象——agent-loop.ts:112 prompt 路径 / agent-session sendCustomMessage no-trigger
    // 路径双发）。customStart effect 已在 message_start 时点以 custom_message entry 形态喂入
    // reducer + ref（display 覆写语义对齐重开 custom_message case），此处再喂会双计。
    if ((entry as { message?: { role?: unknown } }).message?.role === 'custom') return
    // toolResult role 不在此跳过（区别于 custom，R2-S1）：pi 对同一条 toolResult 双发
    // tool_execution_end + message_end{role:'toolResult'} 两事件，tool_call_end handler 与
    // 本 handler 各喂 reducer 一次——但任一帧单独到达（另一帧丢失）时本入口可能是该
    // toolResult 的唯一载体，无条件跳过会丢消息（破坏单入口契约）。去重由 reducer 的
    // deliveredToolResultIds 幂等承担（apply-entry applyToolResultMessage：同 toolCallId
    // 首次投递后二次 no-op），对齐 event-adapter handleMessageEnd「toolResult 与
    // tool_execution_end 的回填，去重/合并归 core store 的 reducer 接入层编排」的职责划分。
    ctx.applyEntryFrame(sid, entry as PiEntry)
  },

  'message.tool_call_update': (ctx, sid, payload) => {
    const { messages } = ctx
    // [D-010 sealed]
    if (!isLastAssistantStreaming(messages, sid)) return
    const prev = messages.value.get(sid)?.value ?? []
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
    commitMessages(messages, sid, next)
  },

  // ── Bash 执行（W1 fix-chat-flow-order：bashStart 写 ephemeral executingBash 不建消息项；
  //    bashResult 构造 bashExecution entry 走 applyEntryFrame——reducer 唯一入流通道，
  //    dispatcher 双分支延迟使帧时序构造性对齐 pi 落盘。实现提取于 bash-effects.ts 避免本文件超行）──
  'message.bashStart': bashStartEffect,
  'message.bashResult': bashResultEffect,

  // ── pi CustomMessage 注入（扩展向对话流注入结构化通知）──
  'message.customStart': (ctx, sid, payload) => {
    const { messages } = ctx
    // [custom 双管线收敛（data-source-governance 审计问题 4）] 实时侧不再独立构造 system
    // 消息 + display 覆写：payload 重构为 custom_message entry（与 pi 持久化形态同构），
    // 经 ctx.applyEntryFrame 喂与文件重放（get_entries → replayEntries）同一个 applyEntry
    // ——display 覆写（完成通知类 COMPLETE_NOTIFY_CUSTOM_TYPES → false）、details/content
    // 窄化全部单点收敛在 reducer 的 custom_message case，实时与重开逐字段一致
    // （等价性断言见 __tests__/custom-start-equivalence.test.ts）。
    //
    // entry 构造点注入两个异源字段（与 message_end 实时重构同款语义，差异归一见测试）：
    // - id：cm-uuid 客户端生成（保证 ref 消息 id 唯一；reducer 从 entry.id 派生，ref 与
    //   reducer state 同 id。重开侧为 pi 持久化的 uuidv7 entry id——id 值异源属 W21 已裁决
    //   的 live/reload 差异类，等价性断言按字段归一）。
    // - timestamp：客户端时钟（customStart payload 不携带 timestamp——event-adapter 翻译
    //   不透传；重开侧为 pi 持久化时刻，差值为投递延迟）。
    // display 三态原样进 entry（true/false 显式透传，undefined 安全保留显示，ADR-0048
    // 决策点 3），覆写归 reducer——本文件不再是覆写点。
    const entry: PiCustomMessageEntry = {
      type: 'custom_message',
      id: `cm-${crypto.randomUUID()}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: readString(payload, 'customType') ?? '',
      content: readString(payload, 'content') ?? '',
      details: payload['details'],
      display: payload['display'] === true || payload['display'] === false ? payload['display'] : undefined,
    }
    // 权威喂入：per-session reducer state（与重开 replayEntries 同一个 applyEntry）
    ctx.applyEntryFrame(sid, entry)
    // overlay 投影：渲染 ref 消费同一份派生（W21 裁决：ref 不由 reducer state 直接投影，
    // 收敛归 W22）——applyEntry 在空 state 上派生本条消息（custom_message 投影不依赖前置
    // state，id 已由 entry.id 提供），commit 进 messages ref。
    const derived = applyEntry(createInitialChatViewState(), entry)
    const prev = messages.value.get(sid)?.value ?? []
    commitMessages(messages, sid, [...prev, ...derived.messages])
  },

  // ── 运行态 / 元信息（system 提示行，W05-A/W07-C）──
  // message.status（pi status 事件经 event-adapter 直推：steer/aborted/sent/queued 等运行态）
  // 未注册 handler——dispatchMessageEvent 对未注册 type 直接 no-op（保留事件接收，不消费）。
  // 运行态语义未用：streaming/complete/error 是消息生命周期（finalizeSession 收口），
  // 与 message.status 运行过程态正交（§3.3.6 死代码清理，原空 handler 删除）。

  'message.compactionSummary': (ctx, sid, payload) => {
    const { messages } = ctx
    // [W6 fix-chat-flow-order] compaction 双路径收尾（最后一个未 entry 化的 live 消息类型）。
    // 判定依据（0.84.1 dist 实测）：帧数据源 = runtime event-interpreter 从 pi compaction_end
    // 事件 result 提取 { summary, tokensBefore, timestamp }（event-interpreter handleCompactionEnd），
    // 与 pi 落盘 compaction entry 同源同值——agent-session 手动（:1441 appendCompaction）与 auto
    //（:1670）两路都在 emit compaction_end 前以同一批局部变量先落盘（session-manager
    // appendCompaction，summary/tokensBefore 同值）。帧字段足以构造 PiCompactionEntry →
    // 改直插为构造 entry → applyEntryFrame（user/bash/custom 同款范式），reducer 的 compaction
    // case（apply-entry）自此 live/reload 共用——「live ≡ reload」全类型构造性成立
    // （等价性断言见 apply-entry-equivalence / effects 测试）。
    //
    // 已知窄差异（D2 closure 已消灭，登记 data-source-registry #7 例外④销案）：interpreter 曾
    // 只在 result.summary 真值时发帧（`if (r.summary)` 门），summary 缺失的 compaction live 无
    // 消息、重开有 fallback 行——现恒发帧（summary 缺省透传），两侧同走 reducer fallback
    // 「上下文已压缩」（等价性断言 E4b/E4c，含空串形态）。
    //
    // entry 注入两个异源字段（customStart 同款，差异归一见等价性测试）：id 客户端生成
    // `cmp-<uuid>`（重开侧为 pi uuidv7 entry id——id 值异源属 W21 已裁决差异类）；timestamp
    // 客户端时钟（帧 timestamp ?? Date.now() → ISO；重开侧为 pi 落盘时刻，差值为投递延迟）。
    const summary = readCompactionSummary(payload)
    const entry: PiCompactionEntry = {
      type: 'compaction',
      id: `cmp-${crypto.randomUUID()}`,
      parentId: null,
      timestamp: new Date(summary.timestamp ?? Date.now()).toISOString(),
      ...(summary.summary !== undefined && { summary: summary.summary }),
      ...(summary.tokensBefore !== undefined && { tokensBefore: summary.tokensBefore }),
    }
    // 权威喂入：per-session reducer state（与重开 replayEntries 同一个 applyEntry）
    ctx.applyEntryFrame(sid, entry)
    // overlay 投影（customStart/bash 同款）：compaction 投影不依赖前置 state（reducer
    // compaction case 无条件 append），空 state 派生即本条消息。
    const derived = applyEntry(createInitialChatViewState(), entry)
    const prev = messages.value.get(sid)?.value ?? []
    commitMessages(messages, sid, [...prev, ...derived.messages])
  },

  'message.branchSummary': (ctx, sid, payload) => {
    const { messages } = ctx
    const prev = messages.value.get(sid)?.value ?? []
    // W07-C：分支摘要。作 system 提示行。
    const summary = readBranchSummary(payload)
    commitMessages(messages, sid, [
      ...prev,
      {
        id: `br-${crypto.randomUUID()}`,
        role: 'system',
        content: summary.summary ?? 'Branched',
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
    const { queueStates, drainN, reconcilePending, appendUser } = ctx
    // W06-B：消息队列更新。payload（event-adapter）：{ steering?, followUp? }。
    // pi 发空数组 []（_emitQueueUpdate 总展开为数组），空数组视为无内容（length 判断）。
    const state: QueueState = {}
    const steering = readStringArray(payload, 'steering')
    if (steering?.length) state.steering = steering
    const followUp = readStringArray(payload, 'followUp')
    if (followUp?.length) state.followUp = followUp

    // pending→complete 驱动：计数差集找出「被 drain 投递的」条数（prev 比 new 多出的元素）。
    // [B1] 不能用 includes（子串语义）——重复文本 'A' 入队两条、drain 一条后 new=['A']，
    // includes('A')===true 会漏判，第二条 pending 永久卡住。计数差集按出现次数精确匹配。
    // [W14] 差集数组的 length = N，drainN 计数 FIFO 取前 N 条（不按文本匹配——pi 入队存
    // skill 展开后文本 ≠ 提交原文，文本相等匹配在该场景必丢消息，D1 表末行 + D6）。
    // steer / follow-up 各自差集各自计数（sendMode 隔离，防跨类型同文本误取——W5 语义保留）。
    const prev = queueStates.value.get(sid)
    if (prev) {
      const steerN = countDrained(prev.steering ?? [], steering ?? []).length
      for (const segs of drainN(sid, 'steer', steerN)) appendUser(sid, segs)
      const followN = countDrained(prev.followUp ?? [], followUp ?? []).length
      for (const segs of drainN(sid, 'follow-up', followN)) appendUser(sid, segs)
    }

    // [W14 D6 / PR #185 MF2 定口径] 深度结构性对账：帧内 pendingMessageCount（event-adapter
    // 翻译恒附 = steering.length + followUp.length，与 rpc-mode get_state 同公式同源、数值恒等）
    // = pi 队列深度的推送投影，本帧即深度的权威推送通道——对账直读帧内值，不经任何 runtime
    // 侧快照缓存（queue ReplicatedState 实例及 markDirty 接线已撤销，登记表 #6 修订）。
    // drain 处理后 pendingBuffer 存量应等于深度，偏差则全量重对（reconcilePending：
    // buffer > 深度裁剪僵尸暂存；buffer < 深度 = 扩展注入例外，有界偏差，队列清空时收敛）。
    // 字段缺失（旧 runtime / mock 帧）时退化为帧内数组长度和（恒等公式，等价）。
    reconcilePending(sid, readNumber(payload, 'pendingMessageCount') ?? (steering?.length ?? 0) + (followUp?.length ?? 0))

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
 * - session.* → useChat 保留处理（跨 store：sessionStore.applySnapshot 等）
 *
 * 非 message.* 或未注册的 message.* type 直接 no-op（等价原 applyChunk 的 default return）。
 */
export function dispatchMessageEvent(
  ctx: MessageEffectContext,
  sessionId: string,
  msg: ServerMessage,
): void {
  const handler = messageEffects[msg.type as ServerMessageType]
  // msg.payload 是 ServerMessageMap 的联合（含 SystemPromptSnapshot 等 interface 类型，
  // 无 string index signature）。handler 内部统一用 readString 等安全窄化（见上方注释），
  // 不依赖 index signature，故 cast 到 Record<string, unknown> 是安全的。
  if (handler) handler(ctx, sessionId, msg.payload as Record<string, unknown>)
}
