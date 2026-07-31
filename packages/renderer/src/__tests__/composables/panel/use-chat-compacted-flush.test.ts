/**
 * useChat session.compacted → flush 集成测试（compact-queued-messages W1，TC9-TC10）。
 *
 * 覆盖契约（/tmp/cw-plan-w1.json contracts C2）：
 * - TC9：compacted 成功（payload 无 error）→ useCompactQueue().flush 重放 + 队列清空 + isCompacting 复位
 * - TC10：compacted 失败（payload.error 非空）→ 队列保留 + 不 flush + 不 toast
 *   （compact() 的 RPC catch 已 toast，handler 重复 toast 是 bug）
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

vi.mock('@/api', () => ({
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
import { useChat, resetChatModuleState } from '@/composables/features/useChat'
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

describe('useChat session.compacted → flush 重放（compact-queued-messages W1）', () => {
  it('TC9: compacted 成功（无 error）→ flush 重放 + 队列清空 + isCompacting 复位', async () => {
    const chat = useChatStore()
    const { compact } = useChat()
    await compact('c-f')
    // 建立 compact 生命周期：compacting → compacted
    emit({ type: 'session.compacting', payload: { sessionId: 'c-f', status: 'compacting' } })
    expect(chat.isCompacting('c-f')).toBe(true)

    // 压缩期间用户消息入队
    useCompactQueue().enqueue('c-f', 'queued msg')

    // 压缩成功广播（无 error）→ handler flush 重放
    emit({ type: 'session.compacted', payload: { sessionId: 'c-f', status: 'compacted' } })
    await vi.waitFor(() => {
      expect(apiMock.send).toHaveBeenCalledWith('c-f', 'queued msg')
    })

    // 队列已清空 + isCompacting 复位 + flush 成功不 toast
    expect(useCompactQueue().count('c-f')).toBe(0)
    expect(chat.isCompacting('c-f')).toBe(false)
    expect(toastSpy.error).not.toHaveBeenCalled()
  })

  it('TC10: compacted 失败（error 非空）→ 队列保留 + 不 flush + 不 toast', async () => {
    const { compact } = useChat()
    await compact('c-e')
    useCompactQueue().enqueue('c-e', 'q')

    emit({
      type: 'session.compacted',
      payload: { sessionId: 'c-e', status: 'compacted', error: 'Cannot compact while agent generating' },
    })
    await Promise.resolve()

    // 队列保留（不 flush、不重放）
    expect(useCompactQueue().count('c-e')).toBe(1)
    expect(apiMock.send).not.toHaveBeenCalled()
    expect(apiMock.steer).not.toHaveBeenCalled()
    // error 分支 handler 不 toast（compact() 的 RPC catch 已 toast，双 toast 是 bug）
    expect(toastSpy.error).not.toHaveBeenCalled()
  })
})
