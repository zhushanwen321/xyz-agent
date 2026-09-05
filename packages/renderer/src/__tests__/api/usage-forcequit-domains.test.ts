/**
 * usage / session 域 RPC 封装单测（用量统计 + forceQuit/subagentAction 增量覆盖 gate）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/__tests__/api/usage-forcequit-domains.test.ts
 *
 * 覆盖：
 *   - usage.getUsageStats → command('usage.getStats', {}) 且透传 reply
 *   - session.forceQuit → command('session.forceQuit', { sessionId })
 *   - session.subagentAction（U5 扩签名）→ 三种 action 的 params 展开（undefined 键自然丢弃）
 *   - mock 层 forceQuit stub resolve（VITE_MOCK facade 对称分支）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const commandMock = vi.hoisted(() => vi.fn())
// [tc-transport-consolidation u2 改锚] domains 已迁 core：core 域内 import { command } from '../request'
// 是 core 内模块 ID，vi.mock('@/api/request') 拦截壳桥模块、不转发（u1 v2 先例）——mock 说明符须
// 直指 core request 模块文件（四段子路径无 exports 条目，故用跨包相对路径，vi.mock 按解析后模块 ID 拦截）。
// 断言与 factory 零改动。
vi.mock('../../../../core/src/transport/api/request', () => ({
  command: commandMock,
}))

import { getUsageStats } from '@xyz-agent/core/transport/api/domains/usage'
import { forceQuit, subagentAction } from '@xyz-agent/core/transport/api/domains/session'
import { session as mockSession } from '@xyz-agent/core/transport/mock'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../../../../core/src/transport/api/pending'

beforeEach(() => {
  commandMock.mockReset()
})

describe('usage 域 RPC 封装', () => {
  it('getUsageStats → command("usage.getStats", {}) 且透传 reply', async () => {
    const reply = { rows: [], sessionCount: 3, skippedLines: 0, scannedAt: 123 }
    commandMock.mockResolvedValue(reply)

    const result = await getUsageStats()

    expect(commandMock).toHaveBeenCalledWith('usage.getStats', {}, RPC_BACKSTOP_TIMEOUT_MS)
    expect(result).toBe(reply)
  })
})

describe('session 域 forceQuit / subagentAction 封装', () => {
  it('forceQuit → command("session.forceQuit", { sessionId })', async () => {
    commandMock.mockResolvedValue(undefined)
    await forceQuit('sess-1')
    expect(commandMock).toHaveBeenCalledWith('session.forceQuit', { sessionId: 'sess-1' }, RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('subagentAction(action="cancel") → subagentId 透传', async () => {
    commandMock.mockResolvedValue(undefined)
    await subagentAction('sess-1', 'cancel', { subagentId: 'sa-1' })
    expect(commandMock).toHaveBeenCalledWith('session.subagentAction', {
      sessionId: 'sess-1',
      action: 'cancel',
      subagentId: 'sa-1',
    }, RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('subagentAction(action="start") → slug+task 展开、未传键不出现', async () => {
    commandMock.mockResolvedValue(undefined)
    await subagentAction('sess-2', 'start', { slug: 'chat-x', task: '帮我修 bug' })
    expect(commandMock).toHaveBeenCalledWith('session.subagentAction', {
      sessionId: 'sess-2',
      action: 'start',
      slug: 'chat-x',
      task: '帮我修 bug',
    }, RPC_BACKSTOP_TIMEOUT_MS)
  })
})

describe('mock 层 forceQuit stub', () => {
  it('mock session.forceQuit resolve（与 real domain 签名同构，不抛错）', async () => {
    // TIMING.ack=40ms 的 sleep，直接 await（不需要 fake timers）
    await expect(mockSession.forceQuit('sess-mock')).resolves.toBeUndefined()
  })
})
