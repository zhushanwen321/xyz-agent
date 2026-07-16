/**
 * W4 红灯测试：加载更多历史（fallback 全量读 + 合并去重）。
 *
 * 对应 FR-4（加载更多 fallback）+ AC-7（合并去重）。
 *
 * 策略：mock WS RPC（chat.getFullHistory），验证：
 * - 点击加载更多 → 调用 getFullHistory RPC
 * - 返回的全量历史合并到消息列表头部
 * - 按 messageId 去重（无重复无丢失）
 * - 幂等：再次点击不重复追加
 *
 * [红灯说明] loadMoreHistory 尚未实现。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/load-more-history.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Message } from '@xyz-agent/shared'

// mock @/api 的 chat domain（getFullHistory 是新增方法）
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    chat: {
      ...actual.chat,
      getFullHistory: vi.fn(),
    },
  }
})

import { useChatStore } from '@/stores/chat'
import { useChat } from '@/composables/features/useChat'
import { chat } from '@/api'

function makeMessage(id: string, content: string): Message {
  return { id, role: 'assistant', content, status: 'complete', timestamp: Date.now() }
}

describe('W4 加载更多历史 fallback', () => {
  let loadMoreHistory: (sessionId: string) => Promise<void>

  beforeEach(() => {
    setActivePinia(createPinia())
    loadMoreHistory = useChat().loadMoreHistory
    vi.mocked(chat.getFullHistory).mockReset()
  })

  it('AC-7: 加载更多后全量历史合并到列表头部，无重复', async () => {
    const store = useChatStore()
    const sid = 's1'

    // 当前 store 已有尾部 3 条（尾读加载的）
    store.hydrate(sid, [
      makeMessage('m8', 'msg-8'),
      makeMessage('m9', 'msg-9'),
      makeMessage('m10', 'msg-10'),
    ])

    // getFullHistory 返回全部 10 条（含已有的 m8/m9/m10）
    vi.mocked(chat.getFullHistory).mockResolvedValue([
      makeMessage('m1', 'msg-1'),
      makeMessage('m2', 'msg-2'),
      makeMessage('m3', 'msg-3'),
      makeMessage('m4', 'msg-4'),
      makeMessage('m5', 'msg-5'),
      makeMessage('m6', 'msg-6'),
      makeMessage('m7', 'msg-7'),
      makeMessage('m8', 'msg-8'),
      makeMessage('m9', 'msg-9'),
      makeMessage('m10', 'msg-10'),
    ])

    await loadMoreHistory(sid)

    // 合并后应有 10 条（去重，无重复）
    const messages = store.getMessages(sid)
    expect(messages).toHaveLength(10)

    // 验证无重复 id
    const ids = messages.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)

    // 验证顺序：m1 在最前
    expect(messages[0].id).toBe('m1')
  })

  it('调用 getFullHistory RPC（带 sessionId）', async () => {
    const store = useChatStore()
    const sid = 's1'
    store.hydrate(sid, [makeMessage('m1', 'msg-1')])

    vi.mocked(chat.getFullHistory).mockResolvedValue([makeMessage('m1', 'msg-1')])

    await loadMoreHistory(sid)

    expect(chat.getFullHistory).toHaveBeenCalledWith(sid)
  })

  it('幂等：再次加载不重复追加同一批消息', async () => {
    const store = useChatStore()
    const sid = 's1'

    store.hydrate(sid, [makeMessage('m5', 'msg-5')])

    vi.mocked(chat.getFullHistory).mockResolvedValue([
      makeMessage('m1', 'msg-1'),
      makeMessage('m2', 'msg-2'),
      makeMessage('m3', 'msg-3'),
      makeMessage('m4', 'msg-4'),
      makeMessage('m5', 'msg-5'),
    ])

    await loadMoreHistory(sid)
    expect(store.getMessages(sid)).toHaveLength(5)

    // 再次加载（RPC 返回相同）
    await loadMoreHistory(sid)
    // 不应重复追加
    expect(store.getMessages(sid)).toHaveLength(5)
  })

  it('RPC 失败时不破坏现有消息', async () => {
    const store = useChatStore()
    const sid = 's1'
    store.hydrate(sid, [makeMessage('m1', 'msg-1')])

    vi.mocked(chat.getFullHistory).mockRejectedValue(new Error('network error'))

    await expect(loadMoreHistory(sid)).resolves.not.toThrow()

    // 现有消息不受影响
    expect(store.getMessages(sid)).toHaveLength(1)
    expect(store.getMessages(sid)[0].id).toBe('m1')
  })
})
