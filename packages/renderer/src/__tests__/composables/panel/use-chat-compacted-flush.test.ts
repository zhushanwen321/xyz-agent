/**
 * useChat defer 队列 flush 触发集成测试（session-occupancy u5b —— 触发源切换）。
 *
 * [u5b / D6] flush 触发源从 session.compacted 事件切为 session.occupancy 广播全 idle
 * （turn=idle 且 compacting=false 且 bash=false）且队列非空（sendRoute 解除语义，D6 表行 1）。
 * 原 compact-queued-messages W1 契约的语义映射（同步而非删除）：
 * - TC9：压缩生命周期结束（compacted + occupancy idle）→ useCompactQueue().flush 提交 +
 *   条目保持待确认 + isCompacting 复位（occupancy 派生）
 * - TC10：压缩失败（compacted{error}）→ occupancy 三路复位 compacting=false → 同样满足
 *   idle 条件 → 队列照常投递（设计 §3.5 行为变化声明：消息不丢优先，投递到未压缩上下文
 *   由 pi pre-prompt auto-compact 自治；与 W1「failed 不 flush」语义有意不同）
 * - TC11：occupancy idle 触发 flush 但重放失败（send RPC reject）→ toast「发送失败: {原因}」
 *   + 队列保留（A1：原 queueFlushFailed 固定文案退役）；TC11b：S1 busy 拒绝留队静默自愈无 toast
 *
 * 结构对齐 __tests__/useChat.test.ts：vi.hoisted apiMock（streamSubscribe 捕获 handler）+ emit helper
 * + beforeEach resetChatModuleState()（useChat 模块级状态隔离）。
 * useCompactQueue 单例经 effectScope 创建 + _clearAllForTest() 隔离（useSessionScopedState 工厂契约）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/panel/use-chat-compacted-flush.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import type { EffectScope } from 'vue'
import type { ServerMessage } from '@xyz-agent/shared'
import { dispatchSession } from '@/api/events'


// vi.hoisted 保证 mock 工厂在模块加载前就绪；holder 捕获 streamSubscribe 注册的 handler
const apiMock = vi.hoisted(() => {
  const holder: { handler: ((msg: ServerMessage) => void) | null } = { handler: null }
  return {
    holder,
    streamSubscribe: vi.fn((_sid: string, handler: (msg: ServerMessage) => void) => {
      holder.handler = handler
      return () => {
        holder.handler = null
      }
    }),
    send: vi.fn(() => Promise.resolve()),
    getHistory: vi.fn(() => Promise.resolve([])),
    abort: vi.fn(() => Promise.resolve()),
    compact: vi.fn(() => Promise.resolve()),
    steer: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
  }
})

// toast spy：TC10 验证 compacted error 分支不重复 toast（handler 不 toast，compact() catch 是唯一 toast 源）
const toastSpy = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}))

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: {
    streamSubscribe: apiMock.streamSubscribe,
    send: apiMock.send,
    getHistory: apiMock.getHistory,
    abort: apiMock.abort,
    compact: apiMock.compact,
    steer: apiMock.steer,
    followUp: apiMock.followUp,
  },
  session: {},
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    toasts: [],
    error: toastSpy.error,
    info: toastSpy.info,
    warning: toastSpy.warning,
  }),
}))

import { useChatStore } from '@/stores/chat'
import { useChat, resetChatModuleState } from '@/composables/features/chat/useChat'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'

let scope: EffectScope

beforeEach(() => {
  setActivePinia(createPinia())
  resetChatModuleState()
  vi.clearAllMocks()
  apiMock.holder.handler = null
  // useCompactQueue 单例：active effect scope 内确保创建 + 清空分区（单例跨用例共享）
  scope = effectScope()
  scope.run(() => {
    useCompactQueue()
  })
  useCompactQueue()._clearAllForTest()
})

/** 向被测 useChat 订阅的 handler 注入一条 ServerMessage */
function emit(msg: ServerMessage): void {
  if (apiMock.holder.handler) apiMock.holder.handler(msg)
}

describe('useChat occupancy 全 idle → flush 触发（session-occupancy u5b）', () => {
  it('TC9: 压缩结束（compacted + occupancy idle）→ flush 逐条提交（clientUuid 透传）+ 条目保持待确认 + isCompacting 复位', async () => {
    const chat = useChatStore()
    const { compact } = useChat()
    await compact('c-f')
    // 建立 compact 生命周期：compacting（occupancy 帧 + reason 文案）→ compacted → occupancy idle
    emit({ type: 'session.compacting', payload: { sessionId: 'c-f', status: 'compacting', reason: 'manual' } })
    emit({ type: 'session.occupancy', payload: { sessionId: 'c-f', turn: 'idle', compacting: true, bash: false } })
    expect(chat.isCompacting('c-f')).toBe(true)

    // 压缩期间用户消息入队
    useCompactQueue().enqueue('c-f', 'queued msg')

    // 压缩成功广播（无 error）+ occupancy 全 idle（compacting=false 三路复位）→ flush 触发。
    // [u5b] compacted 帧本身不再触发 flush（触发源切换），idle 条件由 occupancy 帧判定。
    emit({ type: 'session.compacted', payload: { sessionId: 'c-f', status: 'compacted' } })
    emit({ type: 'session.occupancy', payload: { sessionId: 'c-f', turn: 'idle', compacting: false, bash: false } })
    await vi.waitFor(() => {
      // [u4b / D5.1] send 等价编排：clientUuid = 条目 id 透传（S1 归属 + core ① 匹配资格）
      expect(apiMock.send).toHaveBeenCalledWith('c-f', 'queued msg', undefined, { clientUuid: expect.any(String) })
    })

    // [u4b] 提交 ≠ 出队（E2「成功即清队」退役）：条目保持 mode 已写等确认帧逐条出队 +
    // isCompacting 复位 + flush 成功不 toast
    expect(useCompactQueue().count('c-f')).toBe(1)
    expect(useCompactQueue().peek('c-f')[0]!.mode).toBe('send')
    expect(chat.isCompacting('c-f')).toBe(false)
    expect(toastSpy.error).not.toHaveBeenCalled()
  })

  it('TC11: occupancy idle 触发 flush 但重放失败（send RPC reject）→ toast「发送失败: {原因}」+ 队列保留（A1）', async () => {
    const chat = useChatStore()
    const { compact } = useChat()
    await compact('c-g')
    useCompactQueue().enqueue('c-g', 'q')
    // flush 首条 send RPC 失败 → doFlush 留队回滚后原始错误上抛 → handler toast
    // 「发送失败: {原因}」（设计 §3.5 错误规格表；原 queueFlushFailed 固定文案退役——
    // 与 rejected 帧路径构成双 toast，A1 一并消除），队列保留，恢复后自动重试
    apiMock.send.mockRejectedValueOnce(new Error('rpc fail'))

    emit({ type: 'session.occupancy', payload: { sessionId: 'c-g', turn: 'idle', compacting: false, bash: false } })
    await vi.waitFor(() => {
      // renderer 包装注入真实 i18n（zh-CN）：composable.sendFailed = '消息发送失败：{msg}'
      expect(toastSpy.error).toHaveBeenCalledWith('消息发送失败：rpc fail')
    })

    // 队列保留（flush 失败不清空）+ isCompacting 复位（occupancy 派生）
    expect(useCompactQueue().count('c-g')).toBe(1)
    expect(chat.isCompacting('c-g')).toBe(false)
  })

  it('TC11b: flush 提交遇 S1 busy 拒绝（send.rejected 广播）→ 留队静默自愈，无任何 toast（A1）', async () => {
    // 设计 D2 接管表 / §3.5：busy 类拒绝留队后由下一次 occupancy idle 帧自动重投（自愈路径），
    // 静默——flush 返回 false 不再触发 queueFlushFailed toast。
    const { compact } = useChat()
    await compact('c-s1')
    useCompactQueue().enqueue('c-s1', 'q')
    // 模拟 runtime busy 预检：广播 send.rejected（带条目 id）后 reply resolve——
    // dispatchSession 直投真实 events 通路（doFlush 的 S1 窗口订阅面，同 use-compact-queue.test 惯例）
    const entryId = useCompactQueue().peek('c-s1')[0]!.id
    apiMock.send.mockImplementationOnce(async () => {
      dispatchSession('c-s1', {
        type: 'send.rejected',
        payload: { sessionId: 'c-s1', reason: 'busy', message: 'Agent 正在处理', clientUuid: entryId },
      })
    })

    emit({ type: 'session.occupancy', payload: { sessionId: 'c-s1', turn: 'idle', compacting: false, bash: false } })
    await vi.waitFor(() => {
      // S1 判定生效：条目留队、占位回滚（重试时重挂重标）
      expect(useCompactQueue().peek('c-s1')[0]!.mode).toBe(undefined)
    })
    // 静默：S1 留队无任何 toast（flush 来源的 rejected 帧静默 + flush false 不 toast）
    expect(toastSpy.error).not.toHaveBeenCalled()
    // 队列保留，等下一次 occupancy idle 帧重投
    expect(useCompactQueue().count('c-s1')).toBe(1)
  })

  it('TC10: 压缩失败（compacted{error}）→ occupancy 三路复位 idle → 队列照常投递（u5b 行为变化）', async () => {
    // 设计 §3.5 错误规格表「压缩失败 × defer 队列」：compacting 经转移 #6 复位（成功/失败/
    // aborted 三路均复位）→ occupancy 转 idle → flush 照常投递。与 W1「failed 不 flush」不同，
    // 消息会投递到未压缩的近满上下文（可能触发 pi pre-prompt auto-compact 由其自治）——
    // 消息不丢优先；压缩失败本身已有 message.error 气泡提示可重试。
    const chat = useChatStore()
    const { compact } = useChat()
    await compact('c-e')
    emit({ type: 'session.occupancy', payload: { sessionId: 'c-e', turn: 'idle', compacting: true, bash: false } })
    useCompactQueue().enqueue('c-e', 'q')

    emit({
      type: 'session.compacted',
      payload: { sessionId: 'c-e', status: 'compacted', error: 'Cannot compact while agent generating' },
    })
    emit({ type: 'session.occupancy', payload: { sessionId: 'c-e', turn: 'idle', compacting: false, bash: false } })
    await vi.waitFor(() => {
      expect(apiMock.send).toHaveBeenCalledWith('c-e', 'q', undefined, { clientUuid: expect.any(String) })
    })

    // 消息已投递（条目保持待确认出队）+ 压缩失败不阻塞投递 + handler 不额外 toast
    //（压缩失败的错误反馈归 interpreter message.error，flush 链路不重复提示）
    expect(useCompactQueue().count('c-e')).toBe(1)
    expect(chat.isCompacting('c-e')).toBe(false)
    expect(toastSpy.error).not.toHaveBeenCalled()
  })

  it('TC10b: occupancy 非 idle（compacting=true）→ 不触发 flush（触发条件含三维 idle 判定）', async () => {
    // 占用中即使 compacted 到达（时序乱序防御）也不投递——防止向压缩中的 pi 发 send 被拒循环
    useCompactQueue().enqueue('c-h', 'q')
    emit({ type: 'session.compacted', payload: { sessionId: 'c-h', status: 'compacted' } })
    emit({ type: 'session.occupancy', payload: { sessionId: 'c-h', turn: 'idle', compacting: true, bash: false } })
    await Promise.resolve()
    expect(apiMock.send).not.toHaveBeenCalled()
    expect(useCompactQueue().count('c-h')).toBe(1)
  })

  it('TC10c: bash 忙（turn=idle + bash=true）→ 不触发 flush（D6 行 6 defer，bash 结束解除）', async () => {
    const { compact } = useChat()
    await compact('c-i') // 建立会话订阅（emit 依赖 streamSubscribe handler）
    useCompactQueue().enqueue('c-i', 'q')
    emit({ type: 'session.occupancy', payload: { sessionId: 'c-i', turn: 'idle', compacting: false, bash: true } })
    await Promise.resolve()
    expect(apiMock.send).not.toHaveBeenCalled()
    // bash 结束（bash=false 广播）→ flush 触发
    emit({ type: 'session.occupancy', payload: { sessionId: 'c-i', turn: 'idle', compacting: false, bash: false } })
    await vi.waitFor(() => {
      expect(apiMock.send).toHaveBeenCalledWith('c-i', 'q', undefined, { clientUuid: expect.any(String) })
    })
  })
})
