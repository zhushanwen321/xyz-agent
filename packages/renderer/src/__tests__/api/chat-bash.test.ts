/**
 * chat 域 bash/abortBash API 单测（composer-bash-execute W2）。
 *
 * 验证：
 * - T1: bash('s1','ls',false) → command('message.bash', {sessionId, command, excludeFromContext},
 *   BASH_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS（3660s 语义化取值，timeout-slow-flow-wallclock D5——
 *   校准链 renderer = runtime bash 第一刀 + 60s 余量，场景 3「>65s 长命令不被 renderer 误杀」的 API 层断言）
 * - T2: bash('s1','pwd') 省略 excludeFromContext → payload 不含 excludeFromContext 键（与 send images 归一对称）
 * - T3: abortBash('s1') → command('message.abortBash', {sessionId}, RPC_BACKSTOP_TIMEOUT_MS)
 *
 * 策略：mock core request 模块的 command 函数，断言 type + payload 形态（domains 已迁 core，
 * 桥不转发 mock——说明符直指 core 模块文件，跨包相对路径）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/api/chat-bash.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// mock command 捕获调用参数。vi.hoisted 必须：vi.mock 工厂提升到文件顶部时，
// 外层 const commandMock 尚未初始化，需用 hoisted 在提升阶段创建稳定引用。
const commandMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('../../../../core/src/transport/api/request', () => ({
  command: commandMock,
}))

import { bash, abortBash } from '@xyz-agent/core/transport/api/domains/chat'
import { BASH_RPC_TIMEOUT_MS, RENDERER_RPC_MARGIN_MS } from '@xyz-agent/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../../../../core/src/transport/api/pending'

beforeEach(() => {
  commandMock.mockClear()
})

describe('chat.bash / chat.abortBash API', () => {
  it('T1: bash(s1, ls, false) → command("message.bash", {sessionId, command, excludeFromContext:false})', async () => {
    await bash('s1', 'ls', false)

    expect(commandMock).toHaveBeenCalledOnce()
    expect(commandMock).toHaveBeenCalledWith(
      'message.bash',
      { sessionId: 's1', command: 'ls', excludeFromContext: false },
      BASH_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS,
    )
  })

  it('T2: bash(s1, pwd) 省略 excludeFromContext → payload 只含 {sessionId, command}（无 excludeFromContext 键）', async () => {
    await bash('s1', 'pwd')

    expect(commandMock).toHaveBeenCalledOnce()
    const [type, payload] = commandMock.mock.calls[0]!
    expect(type).toBe('message.bash')
    // 显式断言不含 excludeFromContext 键（与 send 的 images 归一模式对称）
    expect(payload).toEqual({ sessionId: 's1', command: 'pwd' })
    expect(payload).not.toHaveProperty('excludeFromContext')
  })

  it('T3: abortBash(s1) → command("message.abortBash", {sessionId:"s1"})', async () => {
    await abortBash('s1')

    expect(commandMock).toHaveBeenCalledOnce()
    expect(commandMock).toHaveBeenCalledWith('message.abortBash', { sessionId: 's1' }, RPC_BACKSTOP_TIMEOUT_MS)
  })
})
