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
  const chatStore = scope.run(() => createChatStore({ openTasksPanelOnFirstData: vi.fn() }))!
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

  it('steer API 失败：toast.error + removePending（不 throw）', async () => {
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

  it('abortBash API 失败：toast.error（markStreamingBashError 兼底，不 throw）', async () => {
    const f = makeFixture()
    f.chatApi.abortBash.mockRejectedValueOnce(new Error('pi死'))
    // abortBash 失败 → markStreamingBashError（无 streaming bash 时 no-op）+ toast.error
    await f.useChat.abortBash('s14')
    await nextTick()
    expect(f.toast.error).toHaveBeenCalled()
    f.dispose()
  })
})
