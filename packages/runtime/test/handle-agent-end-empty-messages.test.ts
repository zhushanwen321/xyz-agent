/**
 * W1 TDD 测试：event-adapter handleAgentEnd 对空 messages 数组的防御。
 *
 * 背景：handleAgentEnd 当前直接取 messages 最后一个元素：
 *   const lastMsg = messages[messages.length - 1]
 *   const rawReason = lastMsg.stopReason ?? 'stop'
 * 当 agent_end 携带 messages 为空数组 [] 或 undefined 时，lastMsg 为 undefined，
 * 访问 .stopReason 抛 TypeError：Cannot read properties of undefined (reading 'stopReason')。
 * 该异常会从 translate() 抛出，经 EventAdapter.attach 的整批 try-catch 吞掉 →
 * agent_end 整批事件丢失 → isGenerating 永不复位 + message.complete 不送达。
 *
 * W1 改动：handleAgentEnd 在 messages 为空/undefined 时降级为
 *   turn-end { stopReason: 'error' }（不带 usage/content），保证 onTurnFinalize 仍能触发。
 *
 * [红灯说明] 当前 handleAgentEnd 无防御，translate(空 messages 的 agent_end) 会抛 TypeError →
 *   断言「不抛 + 返回 turn-end」失败。加防御后应转绿。
 */
import { describe, it, expect } from 'vitest'
import { translate } from '../src/infra/pi/event-adapter.js'
import type { PiAgentEndEvent } from '../src/infra/pi/pi-protocol.js'
import type { PiTranslatedEvent } from '../src/services/session/types.js'

describe('W1: event-adapter handleAgentEnd 对空 messages 的防御', () => {
  /** 构造一个 agent_end 原始 pi 事件（messages 可控）。 */
  function agentEndEvent(messages: unknown): PiAgentEndEvent {
    // PiBaseMessage 只要求 type；agent_end 额外含 messages + willRetry
    return {
      type: 'agent_end',
      messages: messages as PiAgentEndEvent['messages'],
      willRetry: false,
    } as PiAgentEndEvent
  }

  /** 从一批 translated event 里找出 turn-end。 */
  function findTurnEnd(events: PiTranslatedEvent[]): PiTranslatedEvent & { kind: 'turn-end' } | undefined {
    return events.find((e) => e.kind === 'turn-end') as
      (PiTranslatedEvent & { kind: 'turn-end' }) | undefined
  }

  // ── AE1：messages 为空数组 → 降级为 turn-end{stopReason:'error'}，不抛 ─
  it('AE1: agent_end 携带空 messages 数组 → 不抛 TypeError，降级为 turn-end{stopReason:error}', () => {
    const ev = agentEndEvent([])

    // 当前实现会抛（messages[messages.length-1] 为 undefined → 访问 .stopReason）。
    // 用 expect().not.toThrow 捕获；并断言降级产出 turn-end 带 stopReason 'error'。
    expect(() => translate(ev, 'sid-empty')).not.toThrow()

    const out = translate(ev, 'sid-empty')
    const turnEnd = findTurnEnd(out)
    expect(turnEnd).toBeDefined()
    expect(turnEnd!.stopReason).toBe('error')
  })

  // ── AE2：messages undefined → 同样降级 ──────────────────────────
  it('AE2: agent_end 携带 messages undefined → 不抛，降级为 turn-end{stopReason:error}', () => {
    const ev = agentEndEvent(undefined)

    expect(() => translate(ev, 'sid-empty')).not.toThrow()

    const out = translate(ev, 'sid-empty')
    const turnEnd = findTurnEnd(out)
    expect(turnEnd).toBeDefined()
    expect(turnEnd!.stopReason).toBe('error')
  })
})
