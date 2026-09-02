/**
 * session.removeByCwd 单测（W2TC1）。
 *
 * 验证 folder 维度批量删除的 API 层契约：
 * - 发 WS type 'session.deleteByCwd'，payload { cwd }
 * - reply 解包为 BatchDeleteResult（{ cwd, deleted, failed }）
 *
 * mock 策略：vi.mock core request 模块捕获 command 调用 + 控制其 resolve 值（domains 已迁 core，
 * 桥不转发 mock——mock 说明符直指 core 模块文件，四段子路径无 exports 条目故用跨包相对路径）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/api/session-removebycwd.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { BatchDeleteResult } from '@xyz-agent/shared'

// 捕获 command 调用，控制 resolve 值（reply payload 即 BatchDeleteResult 本身）
const commandMock = vi.fn()
vi.mock('../../../../core/src/transport/api/request', () => ({
  command: (...args: unknown[]) => commandMock(...args),
}))

import { removeByCwd } from '@/api/domains/session'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('session.removeByCwd（W2TC1）', () => {
  it("调 removeByCwd('/p') 发 session.deleteByCwd + payload {cwd}，返回 BatchDeleteResult", async () => {
    const reply: BatchDeleteResult = { cwd: '/p', deleted: ['s1'], failed: [] }
    commandMock.mockResolvedValueOnce(reply)

    const result = await removeByCwd('/p')

    // command 被调一次，type + payload 正确
    expect(commandMock).toHaveBeenCalledTimes(1)
    expect(commandMock).toHaveBeenCalledWith('session.deleteByCwd', { cwd: '/p' })
    // reply 解包为 BatchDeleteResult
    expect(result).toEqual({ cwd: '/p', deleted: ['s1'], failed: [] })
  })

  it('reply 含多条 deleted + failed 时原样透传', async () => {
    const reply: BatchDeleteResult = {
      cwd: '/proj',
      deleted: ['s1', 's2', 's3'],
      failed: [{ sessionId: 's4', error: 'EPERM' }],
    }
    commandMock.mockResolvedValueOnce(reply)

    const result = await removeByCwd('/proj')

    expect(commandMock).toHaveBeenCalledWith('session.deleteByCwd', { cwd: '/proj' })
    expect(result.deleted).toHaveLength(3)
    expect(result.failed).toEqual([{ sessionId: 's4', error: 'EPERM' }])
  })

  it('command reject 时 removeByCwd 向上抛错（不吞异常）', async () => {
    commandMock.mockRejectedValueOnce(new Error('network'))

    await expect(removeByCwd('/p')).rejects.toThrow('network')
    expect(commandMock).toHaveBeenCalledWith('session.deleteByCwd', { cwd: '/p' })
  })
})
