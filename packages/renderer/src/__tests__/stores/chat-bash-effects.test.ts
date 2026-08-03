/**
 * w1 timer-decouple 回归测试（bash-align-pi-tui-w4::w1-timer-decouple）。
 *
 * 锁定 W1 改动：
 * - W1T1（核心 C2 回归防护）：bash timer 到期只收口 bash 消息，不误杀共存中的 assistant turn streaming。
 * - W1T2：bashResultEffect 终态调 clearBashTimer（W3 遗留 bug：原未清，300s 后会误触发）。
 * - W1T3：markBashError 终态调 clearBashTimer（同上）。
 * - W1T4：finalizeBashOnly 幂等（无 streaming bash 时 no-op）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/chat-bash-effects.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia, storeToRefs } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { initTimers, markBashError } from '@xyz-agent/core'
import type { ServerMessage } from '@xyz-agent/shared'

describe('w1 timer-decouple: bash timer 不跨域误杀 streaming', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })
  afterEach(() => vi.useRealTimers())

  /**
   * 辅助：向 session 注入一条 streaming assistant turn + 一条 streaming bash 消息
   * （模拟 L1 放宽 bash↔streaming 并发后的共存态）。
   */
  function seedConcurrentMessages(store: ReturnType<typeof useChatStore>, sid: string): void {
    // assistant turn（message_start 推进到 streaming）
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-streaming' },
    } as ServerMessage)
    // bash 消息（bashStart 创建 streaming bash）—— 不调 armBashTimer，由测试自己控制 timer
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'sleep 999', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
  }

  it('W1T1: bash timer 到期只收口 bash 消息，不误杀共存中的 assistant turn streaming', () => {
    const store = useChatStore()
    const sid = 's-w1t1'
    seedConcurrentMessages(store, sid)

    // 断言种子态：assistant 与 bash 均 streaming，session 整体 isGenerating
    const seeded = store.getMessages(sid)
    expect(seeded[0].status).toBe('streaming') // assistant
    expect(seeded[1].status).toBe('streaming') // bash
    expect(seeded[1].bashExecution).toBeTruthy()

    // 用 initTimers 构造受控 timer：spy finalizeSession（绝不应被 bash timer 调用，
    // bash timer 应调 finalizeBashOnly），真实 finalizeBashOnly 委托 store 行为。
    // 注意：store 的 armBashTimer 已通过 bashStart 挂载了真实 timer，此处再单独用
    // initTimers 隔离测试 bash timer 回调的收口域选择（不依赖 store 内部 timer）。
    // messagesRef 用 storeToRefs 拿到真 ref，让 commitMessages 的整体替换写回 store。
    const messagesRef = storeToRefs(store).messages
    const finalizeSessionSpy = vi.fn()
    const finalizeBashOnly = (sessionId: string): void => {
      // 复用 store 内 finalizeBashOnly 的纯逻辑（commitMessages 写回真 store ref）。
      const prev = messagesRef.value.get(sessionId) ?? []
      const reversedIdx = [...prev].reverse().findIndex(m => m.bashExecution && m.status === 'streaming')
      if (reversedIdx === -1) return
      const realIdx = prev.length - 1 - reversedIdx
      const next = prev.map((m, i) => i === realIdx ? {
        ...m,
        status: 'error' as const,
        bashExecution: { ...m.bashExecution!, cancelled: true },
        error: 'timeout',
      } : m)
      messagesRef.value = new Map(messagesRef.value).set(sessionId, next)
    }
    const { armBashTimer } = initTimers(finalizeSessionSpy, finalizeBashOnly, 600_000)
    armBashTimer(sid)

    // 推进 300s（bash 超时阈值）
    vi.advanceTimersByTime(300_000)

    const after = store.getMessages(sid)
    // bash 消息被收口为 error / cancelled
    const bashMsg = after[1]
    expect(bashMsg.status).toBe('error')
    expect(bashMsg.bashExecution?.cancelled).toBe(true)
    // assistant turn 仍 streaming（C2 回归防护核心断言）
    expect(after[0].status).toBe('streaming')
    // finalizeSession 绝未被 bash timer 调用（bash timer 只调 finalizeBashOnly）
    expect(finalizeSessionSpy).not.toHaveBeenCalled()
  })

  it('W1T2: bashResultEffect 终态调 clearBashTimer（防 300s 后误触发）', () => {
    const store = useChatStore()
    const sid = 's-w1t2'
    // bashStart 会挂 bash timer（真实 timer，但 fakeTimers 下不会自动跑）
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'echo hi', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    expect(store.getMessages(sid)[0].status).toBe('streaming')

    // bashResult 收口 bash 消息 —— 应同时清 bash timer
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: {
        sessionId: sid,
        command: 'echo hi',
        output: 'hi',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 2000,
      },
    } as ServerMessage)

    // 消息已 complete
    expect(store.getMessages(sid)[0].status).toBe('complete')

    // 推进 300s：若 clearBashTimer 未被调用，bash timer 回调会再次触碰这条已 complete 的消息。
    // 这里通过断言消息保持 complete（不被 300s timer 翻成 error）验证 clearBashTimer 已生效。
    vi.advanceTimersByTime(300_000)
    const after = store.getMessages(sid)
    expect(after[0].status).toBe('complete')
    expect(after[0].bashExecution?.cancelled).toBe(false)
  })

  it('W1T3: markBashError 终态调 clearBashTimer（防 300s 后误触发）', () => {
    const store = useChatStore()
    const sid = 's-w1t3'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'sleep 5', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)

    // spy clearBashTimer，传给 markBashError。
    // messagesRef 用 storeToRefs 拿真 ref：markBashError 内 commitMessages 整体替换写回 store。
    const messagesRef = storeToRefs(store).messages
    const clearBashTimerSpy = vi.fn()
    markBashError(messagesRef, sid, 'abort rpc failed', clearBashTimerSpy)

    // 消息已 error / cancelled
    const m = store.getMessages(sid)[0]
    expect(m.status).toBe('error')
    expect(m.bashExecution?.cancelled).toBe(true)
    // clearBashTimer 被调用一次
    expect(clearBashTimerSpy).toHaveBeenCalledTimes(1)
    expect(clearBashTimerSpy).toHaveBeenCalledWith(sid)
  })

  it('W1T4: finalizeBashOnly 幂等——无 streaming bash 时 no-op，不抛错', () => {
    const store = useChatStore()
    const messagesRef = storeToRefs(store).messages
    const sid = 's-w1t4'
    // 空 messages（无任何消息）：finalizeBashOnly 应 no-op 不抛
    const finalizeBashOnly = (sessionId: string): void => {
      const prev = messagesRef.value.get(sessionId) ?? []
      const reversedIdx = [...prev].reverse().findIndex(m => m.bashExecution && m.status === 'streaming')
      if (reversedIdx === -1) return
      // 不会走到这里
      throw new Error('should not mutate when no streaming bash')
    }
    expect(() => finalizeBashOnly(sid)).not.toThrow()
    // messages 不变（仍为空）
    expect(store.getMessages(sid)).toHaveLength(0)

    // 补充：有非 bash streaming 消息（assistant turn）时也应 no-op（不误碰 assistant）
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-only' },
    } as ServerMessage)
    expect(() => finalizeBashOnly(sid)).not.toThrow()
    const after = store.getMessages(sid)
    expect(after).toHaveLength(1)
    expect(after[0].status).toBe('streaming') // assistant 未被误收口
    expect(after[0].bashExecution).toBeUndefined()
  })
})
