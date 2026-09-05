/**
 * composer real domain 单测（U15-U17）。
 *
 * 覆盖：
 * - U15 getFileCandidates：发 file.search，payload 含 sessionId 无 query
 * - U16 getFileCandidates：pending.resolve {files} → 解包返回 FileNode[]
 * - U17 getMentionCandidates：返回空数组（@ 已废弃）
 *
 * mock 策略：vi.mock('@xyz-agent/core/transport/ws-client') 捕获 send +
 * vi.mock(core pending 源文件相对路径) 控制 create/register——request 已下沉 core
 * （tc u1），mock 目标须与 core 内相对 import 同一模块 ID 才能拦截。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/api/composer-domain.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 捕获 ws-client.send 的调用（返回 true = 消息已送出；request.command 对 send false
// 会走 fast-fail reject，mock 须符合 ws-client.send 的真实 boolean 契约）
const sendMock = vi.fn((): boolean => true)
vi.mock('@xyz-agent/core/transport/ws-client', () => ({
  send: (...args: unknown[]) => sendMock(...args),
}))

// mock pending：register 返回可控 Promise，create 返回固定 id
const registerMock = vi.fn()
vi.mock('../../../../core/src/transport/api/pending', () => ({
  RPC_BACKSTOP_TIMEOUT_MS: 65_000,
  createCommandId: () => 'test-id',
  register: (id: string) => registerMock(id),
  reject: vi.fn(),
}))

import { getFileCandidates, getMentionCandidates } from '@xyz-agent/core/transport/api/domains/composer'

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
