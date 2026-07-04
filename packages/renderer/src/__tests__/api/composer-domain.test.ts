/**
 * composer real domain 单测（U15-U17）。
 *
 * 覆盖：
 * - U15 getFileCandidates：发 file.search，payload 含 sessionId 无 query
 * - U16 getFileCandidates：pending.resolve {files} → 解包返回 FileNode[]
 * - U17 getMentionCandidates：返回空数组（@ 已废弃）
 *
 * mock 策略：vi.mock('@/api/transport') 捕获 send + vi.mock('@/api/pending') 控制 create/register。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/api/composer-domain.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 捕获 transport.send 的调用
const sendMock = vi.fn()
vi.mock('@/api/transport', () => ({
  send: (...args: unknown[]) => sendMock(...args),
}))

// mock pending：register 返回可控 Promise，create 返回固定 id
const registerMock = vi.fn()
vi.mock('@/api/pending', () => ({
  create: () => 'test-id',
  register: (id: string) => registerMock(id),
}))

import { getFileCandidates, getMentionCandidates } from '@/api/domains/composer'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('composer domain (real)', () => {
  it('U15 getFileCandidates：发 file.search，payload {sessionId} 无 query', async () => {
    registerMock.mockReturnValueOnce(Promise.resolve({ sessionId: 's1', files: [] }))

    await getFileCandidates('s1')

    expect(sendMock).toHaveBeenCalledTimes(1)
    const msg = sendMock.mock.calls[0]![0] as { type: string; id: string; payload: Record<string, unknown> }
    expect(msg.type).toBe('file.search')
    expect(msg.id).toBe('test-id')
    expect(msg.payload).toEqual({ sessionId: 's1' })
    // 无 query 字段（G7：query 从签名删除）
    expect('query' in msg.payload).toBe(false)
  })

  it('U16 getFileCandidates：resolve {files} → 解包返回 FileNode[]', async () => {
    const files = [{ path: 'x.ts', name: 'x.ts', type: 'file' }]
    registerMock.mockReturnValueOnce(Promise.resolve({ sessionId: 's1', files }))

    const result = await getFileCandidates('s1')

    expect(result).toEqual(files)
  })

  it('U17 getMentionCandidates：返回空数组（@ 已废弃）', async () => {
    const result = await getMentionCandidates()

    expect(result).toEqual([])
    // 不发 WS 请求
    expect(sendMock).not.toHaveBeenCalled()
  })
})
