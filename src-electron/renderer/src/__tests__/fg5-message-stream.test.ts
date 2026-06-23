/**
 * FG5 单测 —— message-stream 回合分组纯逻辑 + chat store 块类型扩展。
 *
 * 覆盖：
 * - groupTurns：扁平 messages → 回合（user 开启 + assistant 归入，纯文字无折叠条）
 * - countThinking/countToolCalls/hasFailedTool：badge 统计 + 失败检测
 * - chat store：thinking/tool_call 流式块追加、hydrate 历史注入、error 块
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/fg5-message-stream.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  groupTurns,
  toRenderItems,
  countThinking,
  countToolCalls,
  hasFailedTool,
} from '@/composables/logic/messageTurns'
import { useChatStore } from '@/stores/chat'
import * as mockApi from '@/api/mock'
import type { Message } from '@xyz-agent/shared'

const NOW = Date.now()

function userMsg(id: string, content: string): Message {
  return { id, role: 'user', content, status: 'complete', timestamp: NOW }
}
function assistantMsg(id: string, content: string, extra: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content, status: 'complete', timestamp: NOW, ...extra }
}
function systemMsg(id: string, content: string, extra: Partial<Message> = {}): Message {
  return { id, role: 'system', content, status: 'complete', timestamp: NOW, ...extra }
}

describe('FG5 groupTurns 回合分组', () => {
  it('user + assistant → 单回合（含 user 起点与 assistant 收尾）', () => {
    const turns = groupTurns([userMsg('u1', 'hi'), assistantMsg('a1', 'hello')])
    expect(turns).toHaveLength(1)
    expect(turns[0].user?.id).toBe('u1')
    expect(turns[0].assistants).toHaveLength(1)
    expect(turns[0].assistants[0].content).toBe('hello')
  })

  it('多 user 消息 → 每个 user 开启新回合', () => {
    const turns = groupTurns([
      userMsg('u1', 'q1'),
      assistantMsg('a1', 'r1'),
      userMsg('u2', 'q2'),
      assistantMsg('a2', 'r2'),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[0].user?.id).toBe('u1')
    expect(turns[1].user?.id).toBe('u2')
  })

  it('纯文字回合（无 thinking/tool）→ hasFoldable=false（无折叠条）', () => {
    const turns = groupTurns([userMsg('u1', 'q'), assistantMsg('a1', '纯文字回答')])
    expect(turns[0].hasFoldable).toBe(false)
  })

  it('含 toolCalls 的回合 → hasFoldable=true', () => {
    const turns = groupTurns([
      userMsg('u1', '读文件'),
      assistantMsg('a1', '已读', {
        toolCalls: [
          {
            id: 'tc1',
            toolName: 'read',
            input: {},
            status: 'completed',
            startTime: NOW,
          },
        ],
      }),
    ])
    expect(turns[0].hasFoldable).toBe(true)
    expect(countToolCalls(turns[0])).toBe(1)
  })

  it('含 thinking 块 → countThinking 统计', () => {
    const turns = groupTurns([
      userMsg('u1', '思考'),
      assistantMsg('a1', '结论', {
        thinking: [{ id: 'th1', content: '推理过程', collapsed: true }],
      }),
    ])
    expect(turns[0].hasFoldable).toBe(true)
    expect(countThinking(turns[0])).toBe(1)
  })

  it('失败的 tool → hasFailedTool=true', () => {
    const turns = groupTurns([
      userMsg('u1', '提交'),
      assistantMsg('a1', '失败', {
        toolCalls: [
          {
            id: 'tc1',
            toolName: 'bash',
            input: {},
            output: 'EBUSY',
            status: 'error',
            startTime: NOW,
          },
        ],
      }),
    ])
    expect(hasFailedTool(turns[0])).toBe(true)
  })

  it('最后一条 assistant streaming → isWorking=true（其余 false）', () => {
    const turns = groupTurns([
      userMsg('u1', 'q1'),
      assistantMsg('a1', 'r1'),
      userMsg('u2', 'q2'),
      assistantMsg('a2', '正在', { status: 'streaming' }),
    ])
    expect(turns[0].isWorking).toBe(false)
    expect(turns[1].isWorking).toBe(true)
  })

  it('首条 assistant 无前置 user → 自启回合（边缘情况）', () => {
    const turns = groupTurns([assistantMsg('a1', '无前置')])
    expect(turns).toHaveLength(1)
    expect(turns[0].user).toBeNull()
    expect(turns[0].assistants[0].id).toBe('a1')
  })

  // P2-1（WP-L3-08）：steer 续轮产生多 assistant 同回合，
  // Turn.vue 仅最后一条作收尾 summary，前序 content 折进 trace（isMidAssistant）。
  it('多 assistant 同回合（steer 续轮）→ 前序归入，末条作收尾', () => {
    const turns = groupTurns([
      userMsg('u1', '改一下登录'),
      assistantMsg('a1', '正在处理 schema…'), // steer 前的中间产出
      assistantMsg('a2', '已将 AuthService.login 改为 async。'), // 收尾
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].assistants).toHaveLength(2)
    // Turn.vue 的 isMidAssistant(idx) = idx < length-1 → a1 是中间，a2 是收尾
    const last = turns[0].assistants[turns[0].assistants.length - 1]
    expect(last.id).toBe('a2')
    expect(last.content).toBe('已将 AuthService.login 改为 async。')
    // 收尾 summary 恒显（draft §4：收尾位固定不折叠）
    expect(turns[0].assistants[0].content).toBe('正在处理 schema…')
  })

  // W07-C：system 消息（bashExecution/compaction/branch）作独立项穿插，不归入 turn
  it('toRenderItems：system 消息穿插在 turn 之间，groupTurns 过滤掉 system', () => {
    const items = toRenderItems([
      userMsg('u1', 'q'),
      assistantMsg('a1', 'r'),
      systemMsg('s1', 'bash', { bashExecution: { command: 'ls', exitCode: 0 } }),
      userMsg('u2', 'q2'),
      assistantMsg('a2', 'r2'),
    ])
    // 顺序：turn(u1+a1) → system(s1) → turn(u2+a2)
    expect(items.map((i) => i.kind)).toEqual(['turn', 'system', 'turn'])
    const sysItem = items[1]
    if (sysItem.kind !== 'system') throw new Error('expected system item')
    expect(sysItem.message.bashExecution?.command).toBe('ls')
    // groupTurns 过滤掉 system，只剩 2 个 turn
    const turns = groupTurns([
      userMsg('u1', 'q'),
      assistantMsg('a1', 'r'),
      systemMsg('s1', 'bash'),
      userMsg('u2', 'q2'),
      assistantMsg('a2', 'r2'),
    ])
    expect(turns).toHaveLength(2)
  })
})

describe('FG5 chat store 块类型扩展', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('hydrate 注入历史且标记（重复调用幂等）', () => {
    const store = useChatStore()
    const history = [userMsg('u1', '历史'), assistantMsg('a1', '历史回答')]
    store.hydrate('s1', history)
    store.hydrate('s1', history) // 重复不覆盖
    expect(store.isHydrated('s1')).toBe(true)
    expect(store.getMessages('s1')).toHaveLength(2)
  })

  it('hydrate 深拷贝：外部突变不污染 store', () => {
    const store = useChatStore()
    const history = [userMsg('u1', '原内容')]
    store.hydrate('s1', history)
    history[0].content = '改了'
    expect(store.getMessages('s1')[0].content).toBe('原内容')
  })

  it('appendAssistantChunk 处理 thinking 块（start + delta）', () => {
    const store = useChatStore()
    store.appendAssistantChunk('sx', {
      type: 'message.message_start',
      payload: { sessionId: 'sx', messageId: 'a1' },
    })
    store.appendAssistantChunk('sx', {
      type: 'message.thinking_start',
      payload: { sessionId: 'sx', thinkingId: 'th1' },
    })
    store.appendAssistantChunk('sx', {
      type: 'message.thinking_delta',
      payload: { sessionId: 'sx', delta: '推理' },
    })
    const msgs = store.getMessages('sx')
    expect(msgs[0].thinking).toHaveLength(1)
    expect(msgs[0].thinking?.[0].content).toBe('推理')
  })

  it('appendAssistantChunk 处理 tool_call 块（start + end）', () => {
    const store = useChatStore()
    store.appendAssistantChunk('sx', {
      type: 'message.message_start',
      payload: { sessionId: 'sx', messageId: 'a1' },
    })
    store.appendAssistantChunk('sx', {
      type: 'message.tool_call_start',
      payload: { sessionId: 'sx', toolCallId: 'tc1', toolName: 'read' },
    })
    store.appendAssistantChunk('sx', {
      type: 'message.tool_call_end',
      payload: { sessionId: 'sx', toolCallId: 'tc1', output: 'done', status: 'completed' },
    })
    const msgs = store.getMessages('sx')
    expect(msgs[0].toolCalls).toHaveLength(1)
    expect(msgs[0].toolCalls?.[0].status).toBe('completed')
  })

  it('complete with stopReason:error → status:error（错误块）', () => {
    const store = useChatStore()
    store.appendAssistantChunk('sx', {
      type: 'message.message_start',
      payload: { sessionId: 'sx', messageId: 'a1' },
    })
    store.appendAssistantChunk('sx', {
      type: 'message.complete',
      payload: { sessionId: 'sx', stopReason: 'error' },
    })
    expect(store.getMessages('sx')[0].status).toBe('error')
  })

  // ── W05-A: 4 个新 case（纯字段）─────────────────────────────────

  it('thinking_end 给最后 ThinkingBlock 设 endTime', () => {
    const store = useChatStore()
    store.appendAssistantChunk('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    store.appendAssistantChunk('sx', { type: 'message.thinking_start', payload: { sessionId: 'sx', thinkingId: 'th1' } })
    store.appendAssistantChunk('sx', { type: 'message.thinking_delta', payload: { sessionId: 'sx', delta: '推理' } })
    expect(store.getMessages('sx')[0].thinking?.[0].endTime).toBeUndefined()
    store.appendAssistantChunk('sx', { type: 'message.thinking_end', payload: { sessionId: 'sx' } })
    expect(store.getMessages('sx')[0].thinking?.[0].endTime).toBeTypeOf('number')
  })

  it('tool_call_update 更新 ToolCall.detail（对齐生产端，只读 detail）', () => {
    const store = useChatStore()
    store.appendAssistantChunk('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    store.appendAssistantChunk('sx', { type: 'message.tool_call_start', payload: { sessionId: 'sx', toolCallId: 'tc1', toolName: 'bash' } })
    // string detail
    store.appendAssistantChunk('sx', { type: 'message.tool_call_update', payload: { sessionId: 'sx', toolCallId: 'tc1', detail: '执行中…' } })
    expect(store.getMessages('sx')[0].toolCalls?.[0].detail).toBe('执行中…')
    // object detail
    store.appendAssistantChunk('sx', { type: 'message.tool_call_update', payload: { sessionId: 'sx', toolCallId: 'tc1', detail: { progress: 50 } } })
    expect(store.getMessages('sx')[0].toolCalls?.[0].detail).toEqual({ progress: 50 })
  })

  it('complete.usage 回填 Message.usage（inputTokens/outputTokens）', () => {
    const store = useChatStore()
    store.appendAssistantChunk('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    store.appendAssistantChunk('sx', {
      type: 'message.complete',
      payload: { sessionId: 'sx', stopReason: 'complete', usage: { inputTokens: 120, outputTokens: 80, totalTokens: 200 } },
    })
    expect(store.getMessages('sx')[0].usage).toEqual({ inputTokens: 120, outputTokens: 80 })
  })

  it('message.status 接收不崩（运行态，不改 Message.status）', () => {
    const store = useChatStore()
    store.appendAssistantChunk('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    store.appendAssistantChunk('sx', { type: 'message.status', payload: { sessionId: 'sx', status: 'steered', detail: '已转向' } })
    // status 仍是 streaming（message.status 是运行过程态，与 Message.status 正交）
    expect(store.getMessages('sx')[0].status).toBe('streaming')
  })

  // ── W06-B: store 级状态（retry/queue）───────────────────────────

  it('auto_retry_start 设置 retryState，auto_retry_end 清空', () => {
    const store = useChatStore()
    expect(store.getRetryState('sx')).toBeUndefined()
    store.appendAssistantChunk('sx', {
      type: 'message.auto_retry_start',
      payload: { sessionId: 'sx', attempt: 2, maxAttempts: 3, delayMs: 500, errorMessage: 'timeout' },
    })
    expect(store.getRetryState('sx')).toEqual({ attempt: 2, maxAttempts: 3, delayMs: 500, errorMessage: 'timeout' })
    store.appendAssistantChunk('sx', {
      type: 'message.auto_retry_end',
      payload: { sessionId: 'sx', success: true, attempt: 2 },
    })
    expect(store.getRetryState('sx')).toBeUndefined()
  })

  it('queue_update 设置 queueState（steering/followUp）', () => {
    const store = useChatStore()
    expect(store.getQueueState('sx')).toBeUndefined()
    store.appendAssistantChunk('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx', steering: ['再快一点'], followUp: ['下一步'] },
    })
    expect(store.getQueueState('sx')).toEqual({ steering: ['再快一点'], followUp: ['下一步'] })
    // 两字段都缺 → 清空
    store.appendAssistantChunk('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx' },
    })
    expect(store.getQueueState('sx')).toBeUndefined()
  })

  it('retry/queue 状态按 session 隔离（互不串扰）', () => {
    const store = useChatStore()
    store.appendAssistantChunk('sa', { type: 'message.auto_retry_start', payload: { sessionId: 'sa', attempt: 1 } })
    store.appendAssistantChunk('sb', { type: 'message.queue_update', payload: { sessionId: 'sb', steering: ['x'] } })
    expect(store.getRetryState('sa')?.attempt).toBe(1)
    expect(store.getRetryState('sb')).toBeUndefined()
    expect(store.getQueueState('sb')?.steering).toEqual(['x'])
    expect(store.getQueueState('sa')).toBeUndefined()
  })

  // ── W07-C: shared 类型扩展（bash/compaction/branch 作 system 提示行）──

  it('bashExecution 作 system 消息追加（含 exitCode/truncated）', () => {
    const store = useChatStore()
    store.appendAssistantChunk('sx', {
      type: 'message.bashExecution',
      payload: { sessionId: 'sx', command: 'npm test', exitCode: 1, truncated: true, fullOutputPath: '/tmp/out' },
    })
    const msgs = store.getMessages('sx')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].bashExecution).toEqual({ command: 'npm test', exitCode: 1, truncated: true, fullOutputPath: '/tmp/out' })
  })

  it('compactionSummary 作 system 消息追加', () => {
    const store = useChatStore()
    store.appendAssistantChunk('sx', {
      type: 'message.compactionSummary',
      payload: { sessionId: 'sx', summary: '压缩完成', tokensBefore: 50000 },
    })
    const msg = store.getMessages('sx')[0]
    expect(msg.role).toBe('system')
    expect(msg.compactionSummary).toEqual({ summary: '压缩完成', tokensBefore: 50000 })
  })

  it('branchSummary 作 system 消息追加', () => {
    const store = useChatStore()
    store.appendAssistantChunk('sx', {
      type: 'message.branchSummary',
      payload: { sessionId: 'sx', summary: '新分支', fromId: 'msg-9' },
    })
    const msg = store.getMessages('sx')[0]
    expect(msg.role).toBe('system')
    expect(msg.branchSummary).toEqual({ summary: '新分支', fromId: 'msg-9' })
  })

  it('mock getHistory 返回 fixture 全字段（G2-006 契约）', async () => {
    const s1 = await mockApi.chat.getHistory('s1')
    expect(s1.length).toBeGreaterThanOrEqual(2)
    // 含 user / assistant text / tool_call / 失败 tool
    const roles = s1.map((m) => m.role)
    expect(roles).toContain('user')
    expect(roles).toContain('assistant')
    const withTools = s1.find((m) => (m.toolCalls?.length ?? 0) > 0)
    expect(withTools).toBeTruthy()
  })

  it('mock getHistory 空会话返回空数组', async () => {
    const s3 = await mockApi.chat.getHistory('s3')
    expect(s3).toEqual([])
  })
})
