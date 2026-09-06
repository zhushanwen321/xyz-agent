/**
 * createUseChat factory 行为测试（P3 chat 域 w5）。
 *
 * 锁定 createUseChat(deps) factory 产物的纯行为（不经 renderer 薄包装）：
 * send 流程 / busy 转 steer / ensureStreamSubscription 幂等 / send.rejected handler /
 * message.* 单一入口 / session.* 跨 store 协调 / 错误路径 toast 不 throw /
 * hydrateHistory / loadMoreHistory / disposeSession。
 *
 * 模式（对齐 w4 store.test.ts）：effectScope + createChatStore（真实 store）+ mockDeps
 * （chatApi/sessionStore/toast/compactQueue vi.fn），streamSubscribe mock 捕获 handler
 * 供测试主动 emit 消息（模拟 WS 事件流）。beforeEach resetChatModuleStateForTest() 清
 * 模块级 streamSubscriptions + historyTruncatedSessions + subscriptionStates（测试隔离）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { textToSegments } from '@xyz-agent/shared'
import type { ServerMessage } from '@xyz-agent/shared'
import { createChatStore } from '../store'
import { getExecutingBash as getExecutingBashForTest } from '../bash-effects'
import { createUseChat, resetChatModuleStateForTest } from '../useChat'
import type { UseChatDeps } from '../useChat'

/** 构造 ServerMessage（payload 默认带 sessionId，对齐 w4 store.test.ts msg helper） */
function msg(sid: string, type: string, payload: Record<string, unknown> = {}): ServerMessage {
  return { type, payload: { sessionId: sid, ...payload } } as ServerMessage
}

interface Fixture {
  useChat: ReturnType<typeof createUseChat>
  chatApi: {
    send: ReturnType<typeof vi.fn>
    subagentAction: ReturnType<typeof vi.fn>
    steer: ReturnType<typeof vi.fn>
    followUp: ReturnType<typeof vi.fn>
    abort: ReturnType<typeof vi.fn>
    compact: ReturnType<typeof vi.fn>
    bash: ReturnType<typeof vi.fn>
    abortBash: ReturnType<typeof vi.fn>
    getHistory: ReturnType<typeof vi.fn>
    getFullHistory: ReturnType<typeof vi.fn>
    streamSubscribe: ReturnType<typeof vi.fn>
  }
  chatStore: ReturnType<typeof createChatStore>
  sessionStore: { applySnapshot: ReturnType<typeof vi.fn> }
  toast: { error: ReturnType<typeof vi.fn> }
  /** 主动向 sid 的 streamSubscribe handler 注入一条 ServerMessage（模拟 WS 事件） */
  emit: (sid: string, m: ServerMessage) => void
  dispose: () => void
}

function makeFixture(): Fixture {
  const scope = effectScope(true)
  const streamHandlers = new Map<string, (m: ServerMessage) => void>()
  const chatStore = scope.run(() => createChatStore())!
  const chatApi = {
    send: vi.fn().mockResolvedValue(undefined),
    subagentAction: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    bash: vi.fn().mockResolvedValue(undefined),
    abortBash: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue({ messages: [], historyTruncated: false }),
    getFullHistory: vi.fn().mockResolvedValue([]),
    streamSubscribe: vi.fn((sid: string, h: (m: ServerMessage) => void) => {
      streamHandlers.set(sid, h)
      return () => {
        streamHandlers.delete(sid)
      }
    }),
  }
  const sessionStore = { applySnapshot: vi.fn() }
  const toast = { error: vi.fn() }
  const compactQueue = { flush: vi.fn().mockResolvedValue(true) }
  const deps: UseChatDeps = {
    chatApi,
    writeSegments: vi.fn().mockResolvedValue(undefined),
    getChatStore: () => chatStore,
    getSessionStore: () => sessionStore,
    toast,
    t: (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k),
    getCompactQueue: () => compactQueue,
  }
  const useChat = createUseChat(deps)
  return {
    useChat,
    chatApi,
    chatStore,
    sessionStore,
    toast,
    emit: (sid, m) => {
      streamHandlers.get(sid)?.(m)
    },
    dispose: () => scope.stop(),
  }
}

describe('createUseChat factory 行为', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
  })

  it('send 流程：appendUser + chatApi.send 调用', async () => {
    const f = makeFixture()
    await f.useChat.send('s1', textToSegments('hello'))
    expect(f.chatApi.send).toHaveBeenCalledTimes(1)
    // appendUser 写入 messages 分区（user message 存在）
    expect(f.chatStore.getMessages('s1').length).toBeGreaterThan(0)
    f.dispose()
  })

  it('busy 转 steer：isActive 时 send 委托 steer', async () => {
    const f = makeFixture()
    await f.useChat.send('s2', textToSegments('hi'))
    // 触发 streaming → isActive=true
    f.emit('s2', msg('s2', 'message.message_start', { messageId: 'a1' }))
    expect(f.chatStore.isActive('s2')).toBe(true)
    await f.useChat.send('s2', textToSegments('more'))
    expect(f.chatApi.steer).toHaveBeenCalledTimes(1)
    // 第二次是 steer（非 send）
    expect(f.chatApi.send).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('ensureStreamSubscription 幂等：同 session 二次 send streamSubscribe 只订阅一次', async () => {
    const f = makeFixture()
    await f.useChat.send('s3', textToSegments('one'))
    // 完成首轮（清 streaming/dispatching，否则 isActive guard 拦截）
    f.emit('s3', msg('s3', 'message.message_start', { messageId: 'a1' }))
    f.emit('s3', msg('s3', 'message.complete', { stopReason: 'end_turn' }))
    await f.useChat.send('s3', textToSegments('two'))
    expect(f.chatApi.streamSubscribe).toHaveBeenCalledTimes(1)
    expect(f.chatApi.send).toHaveBeenCalledTimes(2)
    f.dispose()
  })

  it('send.rejected handler：clearPendingSend + toast.error', async () => {
    const f = makeFixture()
    await f.useChat.send('s4', textToSegments('hi'))
    f.emit('s4', msg('s4', 'send.rejected', { reason: 'busy', message: '被拒' }))
    expect(f.toast.error).toHaveBeenCalledWith('被拒')
    f.dispose()
  })

  it('message.* 单一入口：message_start → isGenerating=true', async () => {
    const f = makeFixture()
    await f.useChat.send('s5', textToSegments('hi'))
    expect(f.chatStore.isGenerating('s5')).toBe(false)
    f.emit('s5', msg('s5', 'message.message_start', { messageId: 'm1' }))
    expect(f.chatStore.isGenerating('s5')).toBe(true)
    f.dispose()
  })

  it('session.renamed → sessionStore.applySnapshot(label)', async () => {
    const f = makeFixture()
    await f.useChat.send('s6', textToSegments('hi'))
    f.emit('s6', msg('s6', 'session.renamed', { name: '新名' }))
    expect(f.sessionStore.applySnapshot).toHaveBeenCalledWith('s6', { label: '新名' })
    f.dispose()
  })

  it('session.renamed 空 name 跳过（guard）', async () => {
    const f = makeFixture()
    await f.useChat.send('s6b', textToSegments('hi'))
    f.emit('s6b', msg('s6b', 'session.renamed', { name: '' }))
    expect(f.sessionStore.applySnapshot).not.toHaveBeenCalled()
    f.dispose()
  })

  it('session.state_changed → sessionStore.applySnapshot(modelId/thinkingLevel)', async () => {
    const f = makeFixture()
    await f.useChat.send('s7', textToSegments('hi'))
    f.emit('s7', msg('s7', 'session.state_changed', { modelId: 'gpt-4', thinkingLevel: 'high' }))
    expect(f.sessionStore.applySnapshot).toHaveBeenCalledWith('s7', {
      modelId: 'gpt-4',
      thinkingLevel: 'high',
    })
    f.dispose()
  })

  it('steer API 失败：toast.error + abortPending（不 throw）', async () => {
    const f = makeFixture()
    await f.useChat.send('s8', textToSegments('hi'))
    f.emit('s8', msg('s8', 'message.message_start', { messageId: 'a1' }))
    f.chatApi.steer.mockRejectedValueOnce(new Error('WS断'))
    // busy → steer，steer 内部 catch
    await f.useChat.send('s8', textToSegments('more'))
    await nextTick()
    expect(f.toast.error).toHaveBeenCalled()
    f.dispose()
  })

  it('首尾空白保真：steer 原文（含空白）直达 chatApi.steer（Gate B 观测①回归）', async () => {
    const f = makeFixture()
    await f.useChat.send('s8w', textToSegments('hi'))
    f.emit('s8w', msg('s8w', 'message.message_start', { messageId: 'a1' }))
    // busy → steer；提交文本带首尾空白，发往 pi 的 promptText 必须原文保真
    // （segmentsToPrompt 曾 trim，pi 落盘 ≠ 提交原文破坏显示对账）
    await f.useChat.send('s8w', textToSegments('  注意  '))
    expect(f.chatApi.steer).toHaveBeenCalledWith('s8w', '  注意  ')
    f.dispose()
  })

  it('纯空白文本不发送：steer 空挡拦截（保真修复后空白拦截归调用方）', async () => {
    const f = makeFixture()
    await f.useChat.send('s8b', textToSegments('hi'))
    f.emit('s8b', msg('s8b', 'message.message_start', { messageId: 'a1' }))
    await f.useChat.send('s8b', textToSegments('   '))
    expect(f.chatApi.steer).not.toHaveBeenCalled()
    f.dispose()
  })

  it('abort API 失败：toast.error（乐观 clearPendingSend，不 throw）', async () => {
    const f = makeFixture()
    f.chatApi.abort.mockRejectedValueOnce(new Error('pi死'))
    await f.useChat.abort('s9')
    await nextTick()
    expect(f.toast.error).toHaveBeenCalled()
    f.dispose()
  })

  it('hydrateHistory：注入历史 + historyTruncated 标记', async () => {
    const f = makeFixture()
    f.chatApi.getHistory.mockResolvedValueOnce({ messages: [], historyTruncated: true })
    await f.useChat.hydrateHistory('s10')
    expect(f.useChat.hasMoreHistory('s10')).toBe(true)
    // 幂等：二次 hydrate 不重复请求
    const callsBefore = f.chatApi.getHistory.mock.calls.length
    await f.useChat.hydrateHistory('s10')
    expect(f.chatApi.getHistory.mock.calls.length).toBe(callsBefore)
    f.dispose()
  })

  it('loadMoreHistory：全量加载后清截断标记', async () => {
    const f = makeFixture()
    f.chatApi.getHistory.mockResolvedValueOnce({ messages: [], historyTruncated: true })
    await f.useChat.hydrateHistory('s11')
    expect(f.useChat.hasMoreHistory('s11')).toBe(true)
    f.chatApi.getFullHistory.mockResolvedValueOnce([])
    await f.useChat.loadMoreHistory('s11')
    expect(f.useChat.hasMoreHistory('s11')).toBe(false)
    f.dispose()
  })

  it('disposeSession：取消订阅，再 send 重新订阅', async () => {
    const f = makeFixture()
    await f.useChat.send('s12', textToSegments('hi'))
    expect(f.chatApi.streamSubscribe).toHaveBeenCalledTimes(1)
    f.useChat.disposeSession('s12')
    await f.useChat.send('s12', textToSegments('again'))
    expect(f.chatApi.streamSubscribe).toHaveBeenCalledTimes(2)
    f.dispose()
  })

  it('compact：ensureStreamSubscription + chatApi.compact 调用', async () => {
    const f = makeFixture()
    await f.useChat.compact('s13')
    expect(f.chatApi.compact).toHaveBeenCalledTimes(1)
    expect(f.chatApi.streamSubscribe).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('compact transport/busy 级失败（compaction_end 未到达）：toast 兜底（MF-1）', async () => {
    const f = makeFixture()
    // transport/busy 级失败：RPC 未达 pi / dispatcher busy 预检拒绝 → compaction_end 不发 →
    // interpreter 不参与 → 零用户反馈（违反 AGENTS.md 规则 #3）
    f.chatApi.compact.mockRejectedValueOnce(new Error('RPC 超时'))
    await f.useChat.compact('s15')
    // manualCompactionState 仍 false（compaction_end 未到达）→ catch toast 兜底
    expect(f.toast.error).toHaveBeenCalledTimes(1)
    expect(f.toast.error).toHaveBeenCalledWith(
      expect.stringContaining('composable.compactFailed')
    )
    f.dispose()
  })

  it('compact compaction 级失败（compaction_end 先于 RPC reject 到达）：catch 不 toast（MF-1）', async () => {
    const f = makeFixture()
    // 模拟 pi 时序：compact() 失败时先 emit compaction_end 后 throw（agent-session.js catch 块）
    // compaction_end 经 stdout 先于 RPC error reply 到达 → session.compacted handler 先 set
    // manualCompactionState=true → catch 见 ended=true → 不 toast（interpreter 已进对话流提示）
    f.chatApi.compact.mockImplementationOnce(() => {
      f.emit('s16', msg('s16', 'session.compacted', { error: '上下文压缩失败' }))
      return Promise.reject(new Error('上下文压缩失败'))
    })
    await f.useChat.compact('s16')
    // compaction 级失败：interpreter 经 compaction_end{errorMessage} → message.error 进对话流（确定可见）
    // catch 不 toast（避免与 interpreter 双提示）
    expect(f.toast.error).not.toHaveBeenCalled()
    f.dispose()
  })

  it('abortBash API 失败：toast.error（markStreamingBashError 兼底，不 throw）', async () => {
    const f = makeFixture()
    f.chatApi.abortBash.mockRejectedValueOnce(new Error('pi死'))
    // abortBash 失败 → markStreamingBashError（无 streaming bash 时 no-op）+ toast.error
    await f.useChat.abortBash('s14')
    await nextTick()
    expect(f.toast.error).toHaveBeenCalled()
    f.dispose()
  })

  // ── D-2 token 合帧接线（W12）：经 streamSubscribe 回调 → coalescer → store 全链路 ──

  it('D-2 接线：同窗口 N 条 text_delta 只进一次 applyMessageEvent，内容有序拼接', async () => {
    const f = makeFixture()
    await f.useChat.send('s20', textToSegments('hi'))
    f.emit('s20', msg('s20', 'message.message_start', { messageId: 'a1' }))
    const applySpy = vi.spyOn(f.chatStore, 'applyMessageEvent')
    f.emit('s20', msg('s20', 'message.text_delta', { delta: 'He', contentIndex: 0 }))
    f.emit('s20', msg('s20', 'message.text_delta', { delta: 'll', contentIndex: 0 }))
    f.emit('s20', msg('s20', 'message.text_delta', { delta: 'o', contentIndex: 0 }))
    expect(applySpy).not.toHaveBeenCalled() // microtask 前全部缓冲中
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))
    expect(applySpy).toHaveBeenCalledTimes(1) // N 条 → 1 次合成提交
    const last = f.chatStore.getMessages('s20').at(-1)
    expect(last?.content).toBe('Hello')
    // contentIndex 透传：text contentBlock 带 contentIndex（R-18）
    expect(last?.contentBlocks?.some((b) => b.type === 'text' && b.contentIndex === 0)).toBe(true)
    f.dispose()
  })

  it('D-2 接线：message.complete 到达时同步 flush（先 delta 后终态，不等 microtask）', () => {
    const f = makeFixture()
    void f.useChat.send('s21', textToSegments('hi'))
    f.emit('s21', msg('s21', 'message.message_start', { messageId: 'a1' }))
    f.emit('s21', msg('s21', 'message.text_delta', { delta: 'par' }))
    f.emit('s21', msg('s21', 'message.text_delta', { delta: 'tial' }))
    // complete 不带 content（权威覆盖关闭）→ content 只能来自 flush 落地的 delta 累积。
    // 若 flush 未先于 complete 执行，sealed 守卫（isLastAssistantStreaming）会丢弃 delta，content 为空。
    f.emit('s21', msg('s21', 'message.complete', { stopReason: 'end_turn' }))
    const last = f.chatStore.getMessages('s21').at(-1)
    expect(last?.content).toBe('partial') // flush 先行证据：delta 累积值已落地
    expect(last?.status).not.toBe('streaming') // complete 同步收口
    expect(f.chatStore.isGenerating('s21')).toBe(false)
    f.dispose()
  })

  it('D-2 接线：complete 后迟到 delta（同窗口 2 条）被 sealed 守卫丢弃，content 不串改（P8 门槛）', async () => {
    const f = makeFixture()
    await f.useChat.send('s22', textToSegments('hi'))
    f.emit('s22', msg('s22', 'message.message_start', { messageId: 'a1' }))
    f.emit('s22', msg('s22', 'message.text_delta', { delta: 'final' }))
    // complete 同步 flush 前置 delta 并收口（上一用例锁定的时序），实体进入终态
    f.emit('s22', msg('s22', 'message.complete', { stopReason: 'end_turn' }))
    const sealed = f.chatStore.getMessages('s22').at(-1)
    expect(sealed?.status).toBe('complete')
    expect(sealed?.content).toBe('final')

    // 迟到 delta：同 microtask 窗口 2 条 → flush 时合成为 1 条 'late-x' dispatch，
    // 但 isLastAssistantStreaming sealed 守卫为 false（终态后无 streaming assistant）→
    // 丢弃，已 complete 的 content 不被串改（07 文档 §3.4 P8 ⛔ 门槛）。
    const applySpy = vi.spyOn(f.chatStore, 'applyMessageEvent')
    f.emit('s22', msg('s22', 'message.text_delta', { delta: 'late' }))
    f.emit('s22', msg('s22', 'message.text_delta', { delta: '-x' }))
    expect(applySpy).not.toHaveBeenCalled() // microtask 前缓冲中
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))
    // 合成 delta 确实被 dispatch（1 次）——被丢弃是 sealed 守卫的行为，不是缓冲丢失
    expect(applySpy).toHaveBeenCalledTimes(1)
    const dispatched = applySpy.mock.calls[0][1] as ServerMessage
    expect((dispatched.payload as Record<string, unknown>).delta).toBe('late-x')
    const after = f.chatStore.getMessages('s22').at(-1)
    expect(after?.content).toBe('final') // sealed：content 不变
    expect(after?.status).toBe('complete')
    f.dispose()
  })
})

// ── `@` 定向发送分流（U2b，composer-symbol-system §3.3.4/§3.3.7）──────────────────────

describe('send 定向分流（含 subagent 段）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
  })

  it('subagentId 非空 → subagentAction(message) 被调且 text 序列化含 file/session 段；send 不被调', async () => {
    const f = makeFixture()
    await f.useChat.send('d1', [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'session', sessionId: 'sess-9', label: '设计讨论' },
      { type: 'file', path: '/a.ts', lineRange: [1, 5] },
      { type: 'text', text: '展开讲讲' },
    ])
    expect(f.chatApi.subagentAction).toHaveBeenCalledTimes(1)
    expect(f.chatApi.subagentAction).toHaveBeenCalledWith('d1', 'message', {
      subagentId: 'rec-1',
      // 定向文本 = 其余段序列化：session → #sessionId、file → path:L 范围、subagent 段空串不进。
      // 前导空格 = subagent(chip)→text 边界补格，segmentsToPrompt 不 trim（保真）随行发出
      text: ' #sess-9 /a.ts:L1-L5 展开讲讲',
    })
    // 不走主 agent 通道（§3.3.8 命题 1：无主 agent turn）
    expect(f.chatApi.send).not.toHaveBeenCalled()
    f.dispose()
  })

  it('subagentId 非空：不 appendUser（无 user 气泡，live ≡ reload——pi 只落 custom entry）', async () => {
    const f = makeFixture()
    await f.useChat.send('d1b', [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'text', text: '汇报进度' },
    ])
    const messages = f.chatStore.getMessages('d1b')
    expect(messages.some((m) => m.role === 'user')).toBe(false)
    // 定向气泡由 subagent.directive 广播驱动（见下一 describe），send 路径自身不插
    expect(messages.length).toBe(0)
    f.dispose()
  })

  it('subagentId 空串（新建占位 chip）→ subagentAction(start)，slug 自动生成 chat- 前缀，占位 slug 被覆盖', async () => {
    const f = makeFixture()
    await f.useChat.send('d2', [
      // U2a 新建项：subagentId 空串 + slug 为 i18n 占位文案（不可作 id）
      { type: 'subagent', subagentId: '', slug: '新任务' },
      { type: 'text', text: '帮我修 bug' },
    ])
    expect(f.chatApi.subagentAction).toHaveBeenCalledTimes(1)
    const [sid, action, params] = f.chatApi.subagentAction.mock.calls[0] as unknown as [
      string, string, { slug?: string; task?: string },
    ]
    expect(sid).toBe('d2')
    expect(action).toBe('start')
    expect(params.slug).toMatch(/^chat-/) // 自动 slug 生成规则
    expect(params.slug).not.toBe('新任务') // 占位 slug 不可作 id，被覆盖
    // 前导空格 = subagent(chip)→text 边界补格（segmentsToPrompt 不 trim，原文保真）
    expect(params.task).toBe(' 帮我修 bug')
    expect(f.chatApi.send).not.toHaveBeenCalled()
    f.dispose()
  })

  it('纯 chip 无文本 → 空文本挡：不调 subagentAction，toast 可读错误（不静默）', async () => {
    const f = makeFixture()
    await f.useChat.send('d3', [{ type: 'subagent', subagentId: 'rec-1', slug: 'build-api' }])
    expect(f.chatApi.subagentAction).not.toHaveBeenCalled()
    expect(f.chatApi.send).not.toHaveBeenCalled()
    expect(f.toast.error).toHaveBeenCalledWith('composable.subagentDirectiveEmpty')
    f.dispose()
  })

  it('RPC 失败 → toast 错误可见（不 throw、不静默丢失）', async () => {
    const f = makeFixture()
    f.chatApi.subagentAction.mockRejectedValueOnce(new Error('subagent 已结束'))
    await expect(
      f.useChat.send('d4', [
        { type: 'subagent', subagentId: 'rec-x', slug: 'closed-one' },
        { type: 'text', text: '继续' },
      ]),
    ).resolves.toBeUndefined()
    expect(f.toast.error).toHaveBeenCalledWith(
      'composable.subagentDirectiveFailed:{"msg":"subagent 已结束"}',
    )
    f.dispose()
  })

  it('定向发送仍 ensureStreamSubscription（消费 subagent.directive 广播的前提）', async () => {
    const f = makeFixture()
    await f.useChat.send('d5', [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'text', text: 'hi' },
    ])
    expect(f.chatApi.streamSubscribe).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('主 agent busy 时定向消息不转 steer（与主 agent turn 正交）', async () => {
    const f = makeFixture()
    await f.useChat.send('d6', textToSegments('首发'))
    f.emit('d6', msg('d6', 'message.message_start', { messageId: 'a1' }))
    expect(f.chatStore.isActive('d6')).toBe(true)
    await f.useChat.send('d6', [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'text', text: 'busy 时追问' },
    ])
    expect(f.chatApi.steer).not.toHaveBeenCalled()
    expect(f.chatApi.subagentAction).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('session 段（无 subagent 段）照常走 message.send，#sessionId 序列化进 prompt（U1 验证）', async () => {
    const f = makeFixture()
    await f.useChat.send('d7', [
      { type: 'session', sessionId: 'sess-1', label: '旧会话' },
      { type: 'text', text: '看看这个' },
    ])
    expect(f.chatApi.send).toHaveBeenCalledTimes(1)
    // send 参数：prompt = 序列化文本 + clientUuid 标记（非纯文本消息 needsBackfill 拼标记，
    // 标记被 pi extension input hook 剥离，这里只断言用户可见正文部分）
    const [calledSid, calledPrompt] = f.chatApi.send.mock.calls[0] as unknown as [string, string]
    expect(calledSid).toBe('d7')
    expect(calledPrompt.startsWith('#sess-1 看看这个')).toBe(true)
    expect(calledPrompt).toMatch(/<!--xyz:msg:u-[0-9a-fA-F-]{36}-->$/)
    expect(f.chatApi.subagentAction).not.toHaveBeenCalled()
    f.dispose()
  })
})

// ── [steer-bubble u2 / docs/design/steer-followup-user-bubble-display.md D2 维护点 2]
//    send inflight 挂钩：乐观 +1 / catch 回滚 −1 / 挂钩位置约定（busy 转 steer 不挂）──

describe('send inflight 挂钩（steer-bubble u2 / D2 维护点 2）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
  })

  /** message_end(user) 帧（payload.entry 为 event-adapter 重构形态——send 乐观插入的确认帧） */
  function userEnd(sid: string, text: string): ServerMessage {
    return {
      type: 'message.message_end',
      payload: {
        sessionId: sid,
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 },
        },
      },
    } as ServerMessage
  }

  it('send 乐观插入 → inflight +1；pi 投递确认 message_end(user) 到达 → 抵消归零', async () => {
    const f = makeFixture()
    await f.useChat.send('s30', textToSegments('hi'))
    // 乐观插入即「已显示」——待 message_end(user) 确认（不落入腿 2 includes 兜底，
    // 防与队列未投递同文本碰撞误命中）
    expect(f.chatStore.getInflight('s30')).toBe(1)

    f.emit('s30', userEnd('s30', 'hi'))
    expect(f.chatStore.getInflight('s30')).toBe(0)
    f.dispose()
  })

  it('send RPC 失败 → catch 回滚 −1（pi 侧无消息、message_end 永不到来，配额不悬空）', async () => {
    const f = makeFixture()
    f.chatApi.send.mockRejectedValueOnce(new Error('WS断'))

    await f.useChat.send('s31', textToSegments('hi'))

    // +1 后回滚 −1 → 0：不回滚则配额永久悬空、下一次 F1 投递的 message_end 被错抵
    expect(f.chatStore.getInflight('s31')).toBe(0)
    expect(f.toast.error).toHaveBeenCalled()
    f.dispose()
  })

  it('busy 转 steer 分支不挂钩（走 pushPending 暂存，投递时腿 1/腿 2 消费各自计数）', async () => {
    const f = makeFixture()
    await f.useChat.send('s32', textToSegments('hi')) // 首发 send：+1
    f.emit('s32', msg('s32', 'message.message_start', { messageId: 'a1' })) // busy
    expect(f.chatStore.isActive('s32')).toBe(true)

    await f.useChat.send('s32', textToSegments('more')) // B 策略转 steer

    // 只有首发的 +1；steer 的 pushPending 不动 inflight（其确认走腿 1 消费 +m 链路）
    expect(f.chatStore.getInflight('s32')).toBe(1)
    expect(f.chatApi.steer).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('editAndResend 不挂钩（其 message_end 走 includes 不命中跳过，无需配额）', async () => {
    const f = makeFixture()
    // 建 1 条可编辑的 user 消息（首条 user 消息 id）
    await f.useChat.send('s33', textToSegments('old'))
    const userMsgId = f.chatStore.getMessages('s33').find((m) => m.role === 'user')!.id

    await f.useChat.editAndResend('s33', userMsgId, textToSegments('edited'))

    // 挂钩在 send 调用点不在 appendUser 内：编辑重发路径零计数（误挂会在此 +1，
    // 其 message_end 到达时错抵真正的 inflight 配额）
    expect(f.chatStore.getInflight('s33')).toBe(1) // 仅首发 send 的 +1
    f.dispose()
  })
})

// ── subagent.directive live 广播消费（U2b，§3.3.3a live 链路）──────────────────────

describe('subagent.directive 广播消费', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
  })

  /** 构造 subagent.directive ServerMessage（payload 对齐 ServerMessageMap 契约） */
  function directiveMsg(sid: string, subagentId: string, slug: string, text: string): ServerMessage {
    return {
      type: 'subagent.directive',
      payload: { sessionId: sid, subagentId, slug, direction: 'user', text },
    } as ServerMessage
  }

  it('payload.sessionId 匹配订阅 sid → 聊天流插入定向消息（reload 形态逐字段一致）', async () => {
    const f = makeFixture()
    await f.useChat.send('e1', [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'text', text: '汇报进度' },
    ])
    f.emit('e1', directiveMsg('e1', 'rec-1', 'build-api', '汇报进度'))
    const inserted = f.chatStore.getMessages('e1').at(-1)
    // U2c 契约：role system + customType + content + details + display:true（live ≡ reload）
    expect(inserted).toMatchObject({
      role: 'system',
      customType: 'subagent-directive',
      content: '汇报进度',
      details: { subagentId: 'rec-1', slug: 'build-api', direction: 'user' },
      display: true,
      status: 'complete',
    })
    expect(inserted?.id).toMatch(/^cm-/) // customStart 先例：客户端生成 id
    f.dispose()
  })

  it('payload.sessionId 不匹配订阅 sid → 丢弃（ADR-0049 per-session 隔离，架构约定 7）', async () => {
    const f = makeFixture()
    await f.useChat.send('e2', [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'text', text: 'hi' },
    ])
    const before = f.chatStore.getMessages('e2').length
    // 伪造异 session 广播到达 e2 的 handler（防御层校验 payload.sessionId === 订阅 sid）
    f.emit('e2', directiveMsg('other-session', 'rec-1', 'build-api', '串台消息'))
    expect(f.chatStore.getMessages('e2').length).toBe(before)
    expect(f.chatStore.getMessages('e2').some((m) => m.content === '串台消息')).toBe(false)
    f.dispose()
  })

  it('未订阅的 session 收不到广播（per-sid 通道路由，无 handler 可触发）', async () => {
    const f = makeFixture()
    // e3 从未 send（未 ensureStreamSubscription）→ streamHandlers 无条目，emit 天然 no-op
    f.emit('e3', directiveMsg('e3', 'rec-1', 'build-api', '未订阅'))
    expect(f.chatStore.getMessages('e3').length).toBe(0)
    f.dispose()
  })
})

// ── ①b toast 抑制（timeout-slow-flow-wallclock D2/r4 极性修正）────────────────
//
// 极性（§7 useChat 行为权威表述）：executingBash 是「命令执行中」瞬时态（bashStart 置 /
// bashResult·markBashError 清），「已收合成终态」= getExecutingBash 查询为空（取反）——
// 为空 → 抑制 bashFailed toast（气泡终态是权威呈现面）；非空（命令仍在执行 = env backstop
// 先到形态）→ 不抑制（toast 是唯一提示）。
describe('sendBash ①b toast 抑制（D2 极性：空→抑制 / 非空→不抑制）', () => {
  it('终态帧先于 error envelope 到达（executingBash 为空）→ 抑制 bashFailed toast，气泡终态是权威面', async () => {
    const f = makeFixture()
    // bash RPC 挂起：手动控制 reject 时机（模拟 runtime 先广播合成终态帧、后回 error envelope）
    let rejectBash: (e: unknown) => void = () => {}
    f.chatApi.bash.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectBash = reject }),
    )
    const sending = f.useChat.sendBash('b1', 'sleep 3700', false)
    // bashStart 到达：executingBash 置位
    f.emit('b1', msg('b1', 'message.bashStart', { command: 'sleep 3700', excludeFromContext: false, timestamp: 1724000000000 }))
    // 合成终态帧到达（dispatcher catch 的诚实文案帧）：executingBash 清空
    f.emit('b1', msg('b1', 'message.bashResult', {
      command: 'sleep 3700', output: '命令执行超过 1 小时，已停止等待……', exitCode: null,
      cancelled: false, truncated: false, excludeFromContext: false, timestamp: 1724000000001,
    }))
    expect(getExecutingBashForTest('b1')).toBeUndefined()
    // error envelope（blocked → 'Bash execution failed'）此时刻达
    rejectBash(new Error('Bash execution failed'))
    await sending
    expect(f.toast.error).not.toHaveBeenCalled()
    f.dispose()
  })

  it('终态帧未到达（executingBash 非空 = env backstop 先到形态）→ 不抑制，toast 是唯一提示', async () => {
    const f = makeFixture()
    let rejectBash: (e: unknown) => void = () => {}
    f.chatApi.bash.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectBash = reject }),
    )
    const sending = f.useChat.sendBash('b2', 'sleep 3700', false)
    // bashStart 到达（命令确实在 runtime 执行中），bashResult 未到（runtime 3600s 未到点）
    f.emit('b2', msg('b2', 'message.bashStart', { command: 'sleep 3700', excludeFromContext: false, timestamp: 1724000000000 }))
    expect(getExecutingBashForTest('b2')).toBeDefined()
    // renderer backstop（3660s 或中间态 65s）先 reject
    rejectBash(new Error('request timeout after 3660000ms'))
    await sending
    expect(f.toast.error).toHaveBeenCalledTimes(1)
    expect(f.toast.error).toHaveBeenCalledWith(expect.stringContaining('request timeout after 3660000ms'))
    f.dispose()
  })

  it('命令从未到达 runtime（executingBash 从未置位）→ 抑制 toast（无终态可呈现，行为归 deviations 登记）', async () => {
    const f = makeFixture()
    f.chatApi.bash.mockRejectedValue(new Error('transport unavailable (ws not open)'))
    await f.useChat.sendBash('b3', 'echo hi', false)
    expect(f.toast.error).not.toHaveBeenCalled()
    f.dispose()
  })
})
