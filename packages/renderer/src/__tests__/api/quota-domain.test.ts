/**
 * quota domain 契约单测（PR #187 A2-4：reason 透传）。
 *
 * 覆盖：
 * - getCached / fetchQuota / refreshQuota 三 RPC 的 payload 形状（type + providerId）
 *   与 reply 解包（data / lastFetchAt / reason）——reason 是本 PR 新增透传字段，
 *   失败态渲染（CodingPlanSection failMessage）依赖它
 * - configure 的 payload 携带（providerId/enabled/cookie/fetcher/apiKey）
 *
 * mock 策略：对齐 preset-domain.test.ts——mock transport（捕获 send payload）+
 * pending（返回可控 reply），测 domains/quota 真实实现（不 mock @/api）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/api/quota-domain.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { NormalizedQuotaRow } from '@xyz-agent/shared'

// 捕获 transport.send 收到的消息（send 返回 true = 已送出，符合 boolean 契约）
const transportMock = vi.hoisted(() => {
  const sent: Array<{ type: string; id: string; payload: Record<string, unknown> }> = []
  return {
    sent,
    send: vi.fn((msg: { type: string; id: string; payload: Record<string, unknown> }): boolean => {
      sent.push(msg)
      return true
    }),
  }
})

const pendingMock = vi.hoisted(() => ({
  register: vi.fn(),
}))

vi.mock('@/api/transport', () => ({ send: transportMock.send }))
vi.mock('@/api/pending', () => ({
  RPC_BACKSTOP_TIMEOUT_MS: 65_000,
  createCommandId: vi.fn(() => 'qid-1'),
  register: pendingMock.register,
  reject: vi.fn(),
}))

import { getCached, fetchQuota, refreshQuota, configure } from '@/api/domains/quota'

beforeEach(() => {
  transportMock.sent.length = 0
  transportMock.send.mockClear()
  pendingMock.register.mockReset()
})

/** 带绝对量的三窗口 fixture（双轨展示语义的最小数据） */
const ROW: NormalizedQuotaRow = {
  label: 'Kimi Coding Plan',
  wins: [
    { pct: 24, used: 1204, limit: 5000, unit: 'requests', resetSec: 9005 },
    { pct: 41, used: null, limit: null, resetSec: null },
    { pct: null, resetSec: null },
  ],
}

describe('quotaApi.getCached', () => {
  it('payload type=quota.getCached + providerId；reply 解包 data/lastFetchAt/reason（失败缓存透传 reason）', async () => {
    pendingMock.register.mockResolvedValueOnce({ data: ROW, lastFetchAt: 1000, reason: 'unauthorized' })

    const result = await getCached('kimi-coding')

    expect(transportMock.send).toHaveBeenCalledTimes(1)
    expect(transportMock.sent[0]!.type).toBe('quota.getCached')
    expect(transportMock.sent[0]!.payload).toEqual({ providerId: 'kimi-coding' })
    // reason 透传：上次查询失败时缓存层携带，UI 失败态渲染依赖
    expect(result).toEqual({ data: ROW, lastFetchAt: 1000, reason: 'unauthorized' })
  })

  it('成功缓存无 reason → 解包后 reason 为 undefined（非 null 兜底）', async () => {
    pendingMock.register.mockResolvedValueOnce({ data: ROW, lastFetchAt: 1000 })

    const result = await getCached('zhipu')

    expect(result.data).toEqual(ROW)
    expect(result.lastFetchAt).toBe(1000)
    expect(result.reason).toBeUndefined()
  })
})

describe('quotaApi.fetchQuota', () => {
  it('payload type=quota.fetch；失败态 reply（data=null + reason）原样解包不抛错', async () => {
    pendingMock.register.mockResolvedValueOnce({ data: null, lastFetchAt: null, reason: 'network' })

    const result = await fetchQuota('kimi-coding')

    expect(transportMock.sent[0]!.type).toBe('quota.fetch')
    expect(transportMock.sent[0]!.payload).toEqual({ providerId: 'kimi-coding' })
    expect(result).toEqual({ data: null, lastFetchAt: null, reason: 'network' })
  })
})

describe('quotaApi.refreshQuota', () => {
  it('payload type=quota.refresh（绕过 throttle 的测试查询通道）；成功 reply 解包', async () => {
    pendingMock.register.mockResolvedValueOnce({ data: ROW, lastFetchAt: 2000 })

    const result = await refreshQuota('kimi-coding')

    expect(transportMock.sent[0]!.type).toBe('quota.refresh')
    expect(transportMock.sent[0]!.payload).toEqual({ providerId: 'kimi-coding' })
    expect(result).toEqual({ data: ROW, lastFetchAt: 2000 })
    expect(result.reason).toBeUndefined()
  })
})

describe('quotaApi.configure', () => {
  it('payload type=quota.configure 携带全量配置字段；reply 解包 ok/error', async () => {
    pendingMock.register.mockResolvedValueOnce({ ok: true })

    const result = await configure('kimi-coding', true, 'ck=1', 'kimi-coding', 'sk-own')

    expect(transportMock.sent[0]!.type).toBe('quota.configure')
    expect(transportMock.sent[0]!.payload).toEqual({
      providerId: 'kimi-coding',
      enabled: true,
      cookie: 'ck=1',
      fetcher: 'kimi-coding',
      apiKey: 'sk-own',
    })
    expect(result).toEqual({ ok: true })
  })
})
