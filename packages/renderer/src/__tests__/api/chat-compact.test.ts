/**
 * chat 域 compact API 单测（timeout-slow-flow-wallclock D3，u-y3）。
 *
 * 验证：
 * - T1: compact('s1') → command('session.compact', {sessionId}, COMPACT_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS)
 * - T2: 第三参显式传递（backstop 形态），且 > COMPACT_RPC_TIMEOUT_MS（校准链余量恒为正，
 *       结构保证 renderer 恒不先于 runtime 判死——300s 双端零余量竞态前科的同根守护）
 * - T3: compact('s1', 'instructions') → payload 含 customInstructions
 *
 * 策略：mock '../request' 的 command 函数，断言 type + payload + timeout 形态
 * （对齐 chat-bash.test.ts 的 hoisted mock 模式）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/api/chat-compact.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const commandMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('../../../../core/src/transport/api/request', () => ({
  command: commandMock,
}))

import { compact } from '@xyz-agent/core/transport/api/domains/chat'
import { COMPACT_RPC_TIMEOUT_MS, RENDERER_RPC_MARGIN_MS } from '@xyz-agent/shared'

beforeEach(() => {
  commandMock.mockClear()
})

describe('chat.compact API（D3 双端对齐 backstop）', () => {
  it('T1: compact(s1) → command("session.compact", {sessionId:"s1"}, COMPACT+MARGIN 表达式值)', async () => {
    await compact('s1')

    expect(commandMock).toHaveBeenCalledOnce()
    expect(commandMock).toHaveBeenCalledWith(
      'session.compact',
      { sessionId: 's1', customInstructions: undefined },
      COMPACT_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS,
    )
  })

  it('T2: backstop 超时显式传递且 = 1_860_000，严格大于 runtime 第一刀（余量恒为正）', async () => {
    await compact('s1')

    const [, , timeoutMs] = commandMock.mock.calls[0]!
    expect(timeoutMs).toBe(1_860_000)
    expect(timeoutMs).toBeGreaterThan(COMPACT_RPC_TIMEOUT_MS)
  })

  it('T3: compact(s1, "focus on X") → payload.customInstructions 透传', async () => {
    await compact('s1', 'focus on X')

    expect(commandMock).toHaveBeenCalledWith(
      'session.compact',
      { sessionId: 's1', customInstructions: 'focus on X' },
      COMPACT_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS,
    )
  })
})
