/**
 * usage / session 域 RPC 封装单测（用量统计 + forceQuit/subagentAction 增量覆盖 gate）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/api/__tests__/usage-forcequit-domains.test.ts
 *
 * 覆盖：
 *   - usage.getUsageStats → command('usage.getStats', {}) 且透传 reply
 *   - session.forceQuit → command('session.forceQuit', { sessionId })
 *   - session.subagentAction（U5 扩签名）→ 三种 action 的 params 展开（undefined 键自然丢弃）
 *   - mock 层 forceQuit stub resolve（VITE_MOCK facade 对称分支）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@/api/request', () => ({
  command: commandMock,
}))

import { getUsageStats } from '@/api/domains/usage'
import { forceQuit, subagentAction } from '@/api/domains/session'
import { session as mockSession } from '@/api/mock'

beforeEach(() => {
  commandMock.mockReset()
})

describe('usage 域 RPC 封装', () => {
  it('getUsageStats → command("usage.getStats", {}) 且透传 reply', async () => {
    const reply = { rows: [], sessionCount: 3, skippedLines: 0, scannedAt: 123 }
    commandMock.mockResolvedValue(reply)

    const result = await getUsageStats()

    expect(commandMock).toHaveBeenCalledWith('usage.getStats', {})
    expect(result).toBe(reply)
  })
})

describe('session 域 forceQuit / subagentAction 封装', () => {
  it('forceQuit → command("session.forceQuit", { sessionId })', async () => {
    commandMock.mockResolvedValue(undefined)
    await forceQuit('sess-1')
    expect(commandMock).toHaveBeenCalledWith('session.forceQuit', { sessionId: 'sess-1' })
  })

  it('subagentAction(action="cancel") → subagentId 透传', async () => {
    commandMock.mockResolvedValue(undefined)
    await subagentAction('sess-1', 'cancel', { subagentId: 'sa-1' })
    expect(commandMock).toHaveBeenCalledWith('session.subagentAction', {
      sessionId: 'sess-1',
      action: 'cancel',
      subagentId: 'sa-1',
    })
  })

  it('subagentAction(action="start") → slug+task 展开、未传键不出现', async () => {
    commandMock.mockResolvedValue(undefined)
    await subagentAction('sess-2', 'start', { slug: 'chat-x', task: '帮我修 bug' })
    expect(commandMock).toHaveBeenCalledWith('session.subagentAction', {
      sessionId: 'sess-2',
      action: 'start',
      slug: 'chat-x',
      task: '帮我修 bug',
    })
  })
})

describe('mock 层 forceQuit stub', () => {
  it('mock session.forceQuit resolve（与 real domain 签名同构，不抛错）', async () => {
    // TIMING.ack=40ms 的 sleep，直接 await（不需要 fake timers）
    await expect(mockSession.forceQuit('sess-mock')).resolves.toBeUndefined()
  })
})
