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
  sessionStore: { updateLabel: ReturnType<typeof vi.fn>; updateSessionState: ReturnType<typeof vi.fn> }
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
  const sessionStore = { updateLabel: vi.fn(), updateSessionState: vi.fn() }
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

  it('session.renamed → sessionStore.updateLabel', async () => {
    const f = makeFixture()
    await f.useChat.send('s6', textToSegments('hi'))
    f.emit('s6', msg('s6', 'session.renamed', { name: '新名' }))
    expect(f.sessionStore.updateLabel).toHaveBeenCalledWith('s6', '新名')
    f.dispose()
  })

  it('session.renamed 空 name 跳过（guard）', async () => {
    const f = makeFixture()
    await f.useChat.send('s6b', textToSegments('hi'))
    f.emit('s6b', msg('s6b', 'session.renamed', { name: '' }))
    expect(f.sessionStore.updateLabel).not.toHaveBeenCalled()
    f.dispose()
  })

  it('session.state_changed → sessionStore.updateSessionState', async () => {
    const f = makeFixture()
    await f.useChat.send('s7', textToSegments('hi'))
    f.emit('s7', msg('s7', 'session.state_changed', { modelId: 'gpt-4', thinkingLevel: 'high' }))
    expect(f.sessionStore.updateSessionState).toHaveBeenCalledWith('s7', {
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
