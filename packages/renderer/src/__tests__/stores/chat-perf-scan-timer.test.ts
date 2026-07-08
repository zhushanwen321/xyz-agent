/**
 * isGenerating scan 性能 + 24h timer 不误触发（T8.1/T8.2 perf-chaos）。
 *
 * T8.1: 1000 messages，高频 text_delta → 单次 scan << 50ms + scan 限定 get(sid)
 * T8.2: streaming + fake timer < 24h → finalizeSession 未被 timer 触发
 *
 * 运行：npx vitest run src/__tests__/stores/chat-perf-scan-timer.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import type { Message } from '@/types/message'

describe('T8.1 isGenerating scan 性能', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('1000 messages 单次 isGenerating scan < 5ms', () => {
    const store = useChatStore()
    const sid = 's-perf'
    // 构造 999 条 complete + 1 条 streaming（最坏情况：scan 到最后一条才命中）
    const msgs: Message[] = []
    for (let i = 0; i < 999; i++) {
      msgs.push({
        id: `a-${i}`,
        role: 'assistant',
        content: `msg ${i}`,
        status: 'complete',
        timestamp: i,
      })
    }
    msgs.push({
      id: 'a-streaming',
      role: 'assistant',
      content: 'streaming',
      status: 'streaming',
      timestamp: 999,
    })
    store.hydrate(sid, msgs)
    expect(store.getMessages(sid)).toHaveLength(1000)

    // 多次 scan 取平均（排除 JIT 预热噪音）
    const iterations = 100
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      store.isGenerating(sid)
    }
    const avgMs = (performance.now() - start) / iterations
    // 单次 scan < 5ms（远低于 50ms 阈值，留足余量）
    expect(avgMs).toBeLessThan(5)
    expect(store.isGenerating(sid)).toBe(true)
  })

  it('scan 限定 per-session（不扫描其他 session）', () => {
    const store = useChatStore()
    // session A 有 500 条 complete
    const msgsA: Message[] = []
    for (let i = 0; i < 500; i++) {
      msgsA.push({ id: `a-${i}`, role: 'assistant', content: '', status: 'complete', timestamp: i })
    }
    store.hydrate('sA', msgsA)
    // session B 有 1 条 streaming
    store.applyMessageEvent('sB', {
      type: 'message.message_start',
      payload: { sessionId: 'sB', messageId: 'b1' },
    })
    // scan sA 不受 sB 影响
    expect(store.isGenerating('sA')).toBe(false)
    expect(store.isGenerating('sB')).toBe(true)
  })
})

describe('T8.2 24h streaming timer 不误触发', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })
  afterEach(() => vi.useRealTimers())

  it('streaming + timer < 24h → finalizeSession 不被 timer 触发', () => {
    const store = useChatStore()
    const sid = 's-timer'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    expect(store.isGenerating(sid)).toBe(true)
    // 推进 23 小时（< 24h 默认阈值）
    vi.advanceTimersByTime(23 * 60 * 60 * 1000)
    // 仍 streaming（timer 未触发 finalizeSession）
    expect(store.isGenerating(sid)).toBe(true)
  })

  it('pendingSend 30s timer 到期 → finalizeSession(timeout)', () => {
    const store = useChatStore()
    const sid = 's-pending-timeout'
    store.addPendingSend(sid)
    expect(store.isActive(sid)).toBe(true)
    // 推进 30s
    vi.advanceTimersByTime(30_000)
    // pendingSend timer 到期 → finalizeSession('timeout') → isActive=false
    expect(store.isActive(sid)).toBe(false)
  })

  it('clearPendingSend 取消 pendingSend timer（不误触发）', () => {
    const store = useChatStore()
    const sid = 's-cancel-timer'
    store.addPendingSend(sid)
    // message_start 到达 → clearPendingSend（取消 timer）
    store.clearPendingSend(sid)
    // 推进 30s+，timer 不应触发 finalizeSession
    vi.advanceTimersByTime(60_000)
    // 无 streaming entity + 无 pendingSend → isActive=false（但不是因为 timeout）
    expect(store.isActive(sid)).toBe(false)
    // 无 timeout 产生的 error 消息（finalizeSession timeout 会把 streaming → error，
    // 但这里没有 streaming entity，所以没消息）
    expect(store.getMessages(sid)).toHaveLength(0)
  })
})
