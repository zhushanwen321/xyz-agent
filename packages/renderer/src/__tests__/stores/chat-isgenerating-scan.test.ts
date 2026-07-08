/**
 * isGenerating 派生 scan + finalizeAllStreaming 多 session 收口单测。
 *
 * 覆盖：
 * - isGenerating：空 session / 有 streaming / 无 streaming / per-session 隔离
 * - isActive：isGenerating ∨ pendingSend
 * - finalizeAllStreaming：多 session 同时 streaming → 全部收口（F1 修正）
 * - finalizeAllStreaming：非 streaming session 不受影响
 *
 * 运行：npx vitest run src/__tests__/stores/chat-isgenerating-scan.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'

describe('isGenerating 派生 scan（D-005）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('空 session（无消息）isGenerating=false', () => {
    const store = useChatStore()
    expect(store.isGenerating('empty')).toBe(false)
  })

  it('有 streaming assistant → isGenerating=true', () => {
    const store = useChatStore()
    const sid = 's1'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    expect(store.isGenerating(sid)).toBe(true)
  })

  it('assistant complete 后 isGenerating=false', () => {
    const store = useChatStore()
    const sid = 's2'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    expect(store.isGenerating(sid)).toBe(true)
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    })
    expect(store.isGenerating(sid)).toBe(false)
  })

  it('只有 user 消息（无 streaming）isGenerating=false', () => {
    const store = useChatStore()
    const sid = 's3'
    store.appendUser(sid, 'hi')
    expect(store.isGenerating(sid)).toBe(false)
  })

  it('多条 message，只要有 1 条 streaming 就 isGenerating=true', () => {
    const store = useChatStore()
    const sid = 's4'
    store.appendUser(sid, 'q1')
    store.hydrate(sid, [
      ...(store.getMessages(sid)),
      { id: 'old', role: 'assistant', content: 'done', status: 'complete', timestamp: 1 },
    ])
    // 再注一条 streaming
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a2' },
    })
    expect(store.isGenerating(sid)).toBe(true)
  })

  it('per-session 隔离：session A streaming，session B 不受影响', () => {
    const store = useChatStore()
    const sidA = 'sA'
    const sidB = 'sB'
    store.applyMessageEvent(sidA, {
      type: 'message.message_start',
      payload: { sessionId: sidA, messageId: 'a1' },
    })
    expect(store.isGenerating(sidA)).toBe(true)
    expect(store.isGenerating(sidB)).toBe(false)
  })
})

describe('错误事件派生复位 isGenerating（项目规则 #3 核心路径）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('message.error 事件 → isGenerating 派生回 false（无需手动 finalize）', () => {
    const store = useChatStore()
    const sid = 's-err'
    // 先进入 streaming 态
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    expect(store.isGenerating(sid)).toBe(true)
    // message.error 触发 finalizeSession('error') → 派生复位
    store.applyMessageEvent(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: 'test error' },
    })
    // 关键断言：派生回 false（不依赖手动 setStreaming(false)）
    expect(store.isGenerating(sid)).toBe(false)
  })

  it('message.stream_error 事件 → isGenerating 派生回 false', () => {
    const store = useChatStore()
    const sid = 's-streamerr'
    // 先进入 streaming 态
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    expect(store.isGenerating(sid)).toBe(true)
    // message.stream_error 触发 finalizeSession('stream_error') → 派生复位
    // payload content 字段（chat-message-effects.ts handler 读 readString(payload,'content')）
    store.applyMessageEvent(sid, {
      type: 'message.stream_error',
      payload: { sessionId: sid, content: 'stream broken' },
    })
    // 关键断言：派生回 false
    expect(store.isGenerating(sid)).toBe(false)
  })
})

describe('isActive（isGenerating ∨ pendingSend）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('非 streaming 且无 pendingSend → isActive=false', () => {
    const store = useChatStore()
    expect(store.isActive('s1')).toBe(false)
  })

  it('有 pendingSend 但无 streaming → isActive=true', () => {
    const store = useChatStore()
    store.addPendingSend('s1')
    expect(store.isGenerating('s1')).toBe(false)
    expect(store.isActive('s1')).toBe(true)
  })

  it('streaming 且有 pendingSend → isActive=true', () => {
    const store = useChatStore()
    const sid = 's3'
    store.addPendingSend(sid)
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    expect(store.isActive(sid)).toBe(true)
  })

  it('clearPendingSend 后无 streaming → isActive=false', () => {
    const store = useChatStore()
    const sid = 's4'
    store.addPendingSend(sid)
    store.clearPendingSend(sid)
    expect(store.isActive(sid)).toBe(false)
  })
})

describe('finalizeAllStreaming（F1 修正：多 session 收口）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('2 个 session 同时 streaming → 全部收口', () => {
    const store = useChatStore()
    const sidA = 'sA'
    const sidB = 'sB'
    // 两个 session 都在 streaming
    store.applyMessageEvent(sidA, {
      type: 'message.message_start',
      payload: { sessionId: sidA, messageId: 'a1' },
    })
    store.applyMessageEvent(sidB, {
      type: 'message.message_start',
      payload: { sessionId: sidB, messageId: 'b1' },
    })
    expect(store.isGenerating(sidA)).toBe(true)
    expect(store.isGenerating(sidB)).toBe(true)
    // runtime 重启 → 全部收口
    store.finalizeAllStreaming('restart')
    expect(store.isGenerating(sidA)).toBe(false)
    expect(store.isGenerating(sidB)).toBe(false)
    expect(store.getMessages(sidA)[0].status).toBe('error')
    expect(store.getMessages(sidB)[0].status).toBe('error')
  })

  it('非 streaming session 不受 finalizeAllStreaming 影响', () => {
    const store = useChatStore()
    const sidActive = 'sActive'
    const sidIdle = 'sIdle'
    store.applyMessageEvent(sidActive, {
      type: 'message.message_start',
      payload: { sessionId: sidActive, messageId: 'a1' },
    })
    // sidIdle 有 complete 的历史消息
    store.hydrate(sidIdle, [
      { id: 'done', role: 'assistant', content: 'ok', status: 'complete', timestamp: 1 },
    ])
    store.finalizeAllStreaming('disconnect')
    // active 收口
    expect(store.isGenerating(sidActive)).toBe(false)
    // idle 不受影响
    expect(store.getMessages(sidIdle)[0].status).toBe('complete')
  })

  it('3+ session 同时 streaming → 全部收口', () => {
    const store = useChatStore()
    const sids = ['m1', 'm2', 'm3']
    for (const sid of sids) {
      store.applyMessageEvent(sid, {
        type: 'message.message_start',
        payload: { sessionId: sid, messageId: `a-${sid}` },
      })
    }
    sids.forEach((sid) => expect(store.isGenerating(sid)).toBe(true))
    store.finalizeAllStreaming('restart')
    sids.forEach((sid) => {
      expect(store.isGenerating(sid)).toBe(false)
      expect(store.getMessages(sid)[0].status).toBe('error')
    })
  })

  it('无任何 streaming session 时 finalizeAllStreaming 无副作用', () => {
    const store = useChatStore()
    store.hydrate('idle', [
      { id: 'd', role: 'assistant', content: 'ok', status: 'complete', timestamp: 1 },
    ])
    store.finalizeAllStreaming('restart')
    expect(store.getMessages('idle')[0].status).toBe('complete')
  })
})
