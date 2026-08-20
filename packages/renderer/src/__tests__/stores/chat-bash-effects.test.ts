/**
 * w1 timer-decouple 回归测试（bash-align-pi-tui-w4::w1-timer-decouple；
 * W1 fix-chat-flow-order entry 化后种子方式更新）。
 *
 * 锁定 W1 改动：
 * - W1T1（核心 C2 回归防护）：bash timer 到期只收口 bash 消息，不误杀共存中的 assistant turn streaming。
 * - W1T2：bashResult entry 化后消息恒 complete，无 300s timer 再触碰（bashStart 不再挂 timer）。
 * - W1T3：markBashError 终态调 clearBashTimer + 清 executingBash（abortBash RPC 失败兜底）。
 * - W1T4：finalizeBashOnly 幂等（无 streaming bash 时 no-op）。
 *
 * [W1 fix-chat-flow-order] bashStart 不再创建 streaming bash 消息（改写 ephemeral
 * executingBash）——W1T1/W1T3 的「streaming bash 消息」种子改为手动 setMessages 注入
 * （防御场景：entry 化后正常流转不产生 streaming bash 消息，仅手动种子可触发该路径）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/chat-bash-effects.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia, storeToRefs } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { initTimers, markBashError, commitMessages, getExecutingBash } from '@xyz-agent/core'
import type { Message, ServerMessage } from '@xyz-agent/shared'

/** 手动种子：streaming bash 消息（entry 化后正常流转不产生，仅手动注入可达） */
function streamingBashMsg(command: string): Message {
  return {
    id: `bash-${command}`,
    role: 'system',
    content: '',
    status: 'streaming',
    bashExecution: {
      command,
      output: '',
      exitCode: null,
      cancelled: false,
      truncated: false,
      excludeFromContext: false,
      timestamp: 0,
    },
  } as Message
}

describe('w1 timer-decouple: bash timer 不跨域误杀 streaming', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })
  afterEach(() => vi.useRealTimers())

  it('W1T1: bash timer 到期只收口 bash 消息（手动种子），不误杀共存中的 assistant turn streaming', () => {
    const store = useChatStore()
    const sid = 's-w1t1'
    // assistant turn（message_start 推进到 streaming）
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-streaming' },
    } as ServerMessage)
    // streaming bash 消息手动种子（entry 化后 bashStart 不建消息项）
    store.setMessages(sid, [...store.getMessages(sid), streamingBashMsg('sleep 999')])

    // 断言种子态：assistant 与 bash 均 streaming
    const seeded = store.getMessages(sid)
    expect(seeded[0].status).toBe('streaming') // assistant
    expect(seeded[1].status).toBe('streaming') // bash
    expect(seeded[1].bashExecution).toBeTruthy()

    // 用 initTimers 构造受控 timer：spy finalizeSession（绝不应被 bash timer 调用，
    // bash timer 应调 finalizeBashOnly），真实 finalizeBashOnly 委托 store 行为。
    // messagesRef 用 storeToRefs 拿到真 ref，让 commitMessages 的整体替换写回 store。
    const messagesRef = storeToRefs(store).messages
    const finalizeSessionSpy = vi.fn()
    const finalizeBashOnly = (sessionId: string): void => {
      const prev = messagesRef.value.get(sessionId)?.value ?? []
      const reversedIdx = [...prev].reverse().findIndex(m => m.bashExecution && m.status === 'streaming')
      if (reversedIdx === -1) return
      const realIdx = prev.length - 1 - reversedIdx
      const next = prev.map((m, i) => i === realIdx ? {
        ...m,
        status: 'error' as const,
        bashExecution: { ...m.bashExecution!, cancelled: true },
        error: 'timeout',
      } : m)
      commitMessages(messagesRef, sessionId, next)
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

  it('W1T2: bashStart→bashResult entry 化后消息恒 complete，推进 300s 无 timer 再触碰', () => {
    const store = useChatStore()
    const sid = 's-w1t2'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'echo hi', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    // [W1 fix-chat-flow-order] bashStart 不建消息项、不挂 bash timer（ephemeral 执行态）
    expect(store.getMessages(sid)).toHaveLength(0)

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

    // 消息经 entry 入流即为 complete（无 streaming 中间态）
    expect(store.getMessages(sid)[0].status).toBe('complete')

    // 推进 300s：无任何 bash timer 回调触碰这条已 complete 的消息（bashStart 不再挂 timer）
    vi.advanceTimersByTime(300_000)
    const after = store.getMessages(sid)
    expect(after[0].status).toBe('complete')
    expect(after[0].bashExecution?.cancelled).toBe(false)
  })

  it('W1T3: markBashError 调 clearBashTimer + 清 executingBash（abortBash RPC 失败兜底）', () => {
    const store = useChatStore()
    const sid = 's-w1t3'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'sleep 5', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    expect(getExecutingBash(sid)).toBeDefined()

    // spy clearBashTimer，传给 markBashError。
    // messagesRef 用 storeToRefs 拿真 ref：markBashError 内 commitMessages 整体替换写回 store。
    const messagesRef = storeToRefs(store).messages
    const clearBashTimerSpy = vi.fn()
    markBashError(messagesRef, sid, 'abort rpc failed', clearBashTimerSpy)

    // executingBash 已清（abortBash RPC 失败时无 bashResult 帧到达的唯一兜底清点）
    expect(getExecutingBash(sid)).toBeUndefined()
    // clearBashTimer 被调用一次（无 streaming bash 消息也调用——契约保留）
    expect(clearBashTimerSpy).toHaveBeenCalledTimes(1)
    expect(clearBashTimerSpy).toHaveBeenCalledWith(sid)
  })

  it('W1T3b: markBashError 对手动种子的 streaming bash 消息仍推 error 态（防御路径保留）', () => {
    const store = useChatStore()
    const sid = 's-w1t3b'
    store.setMessages(sid, [streamingBashMsg('sleep 5')])
    const messagesRef = storeToRefs(store).messages

    markBashError(messagesRef, sid, 'abort rpc failed')

    const m = store.getMessages(sid)[0]
    expect(m.status).toBe('error')
    expect(m.bashExecution?.cancelled).toBe(true)
    expect(m.error).toBe('abort rpc failed')
  })

  it('W1T4: finalizeBashOnly 幂等——无 streaming bash 时 no-op，不抛错', () => {
    const store = useChatStore()
    const messagesRef = storeToRefs(store).messages
    const sid = 's-w1t4'
    // 空 messages（无任何消息）：finalizeBashOnly 应 no-op 不抛
    const finalizeBashOnly = (sessionId: string): void => {
      const prev = messagesRef.value.get(sessionId)?.value ?? []
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
