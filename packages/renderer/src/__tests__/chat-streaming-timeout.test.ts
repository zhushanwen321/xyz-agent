/**
 * Chat store streaming 超时阈值回归测试（W6）。
 *
 * 锁定 W6 改动：streaming 超时从 24h（86_400_000ms，等于放弃主动检测）降到
 * 10min（600_000ms）。理由：24h 的 streaming 消息对用户毫无价值——pi 进程早已
 * 挂死，但 UI 永远显示「生成中」直到用户手动停止。10min 是合理的「认定 pi 已挂」
 * 上限（远超正常 LLM 响应时间，但不会让用户干等一天）。
 *
 * 当前实现问题：DEFAULT_STREAMING_TIMEOUT_MS = 86_400_000（24h），
 * streaming 消息在 10min 时不会被 timer finalize，UI 卡「生成中」直到 24h。
 *
 * 预期（W6 后）：
 *   - DEFAULT_STREAMING_TIMEOUT_MS = 600_000（10min）
 *   - streaming 消息在 10min + 1s 后被 timer finalize 为 error 态
 *
 * 注：常量未从 chat.ts 导出，故通过行为（timer 触发时机）间接断言阈值。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/chat-streaming-timeout.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import * as chatModule from '@/stores/chat'
import { useChatStore } from '@/stores/chat'

describe('chat store streaming 超时阈值 = 10min（W6，原 24h）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })
  afterEach(() => vi.useRealTimers())

  it('DEFAULT_STREAMING_TIMEOUT_MS 常量值为 600_000（10min），非 86_400_000（24h）', () => {
    // DEFAULT_STREAMING_TIMEOUT_MS 已由 chat.ts 导出（W6），直接断言其值。
    const timeout = (chatModule as unknown as { DEFAULT_STREAMING_TIMEOUT_MS?: number }).DEFAULT_STREAMING_TIMEOUT_MS
    expect(timeout).toBe(600_000)
    expect(timeout).not.toBe(86_400_000)
  })

  it('streaming 消息在 10min + 1s 后被 timer finalize（转 error 态）', () => {
    const store = useChatStore()
    const sid = 's-timeout-10min'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    expect(store.isGenerating(sid)).toBe(true)

    // 推进 10min + 1s（600_100ms）
    // W6：10min 阈值到期 → timer 触发 finalizeSession('timeout') → streaming 转 error
    // 当前 24h 阈值，10min 不会触发 → 仍 streaming，红灯
    vi.advanceTimersByTime(600_000 + 1_000)

    // 关键断言：10min 后应已收口（当前 24h，未触发，红灯）
    expect(store.isGenerating(sid)).toBe(false)
    const after = store.getMessages(sid)
    expect(after[0].status).toBe('error')
  })

  it('streaming 消息在 10min - 1s 时仍未被 finalize（守卫：未到阈值不误触发）', () => {
    const store = useChatStore()
    const sid = 's-timeout-before'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a2' },
    })
    expect(store.isGenerating(sid)).toBe(true)

    // 推进 10min - 1s（599_000ms）—— 未到 10min 阈值，不应触发
    vi.advanceTimersByTime(599_000)

    // 守卫断言：未到阈值仍 streaming（W6 实现后应通过；当前 24h 阈值下也通过）
    expect(store.isGenerating(sid)).toBe(true)
  })

  it('24h 时 streaming 消息仍 streaming（W6 后 24h 不再是阈值，但 24h 内更早的 10min 已收口）', () => {
    // 此测试锁定语义：W6 后阈值是 10min，24h 远超阈值，消息早应在 10min 收口。
    // 当前实现 24h 阈值，推进 10min 不触发 → 仍 streaming（红灯，证阈值未降）。
    const store = useChatStore()
    const sid = 's-timeout-24h'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a3' },
    })

    // 推进 10min：W6 后应已收口；当前 24h 阈值未触发
    vi.advanceTimersByTime(600_000)
    expect(store.isGenerating(sid)).toBe(false)
  })
})
