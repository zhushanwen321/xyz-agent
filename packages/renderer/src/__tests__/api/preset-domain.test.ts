/**
 * preset command helper 契约单测（pi-launch-presets wave1，TC-1/TC-2）。
 *
 * 覆盖：
 * - list() → WS payload type=preset.list，解包 reply.presets 返回 PiLaunchPreset[]
 * - getDefault() → WS payload type=preset.getDefault，解包 reply.presetId 返回 string
 * - setDefault(id) → WS payload type=preset.setDefault + { presetId }，ack 型返回 void
 *
 * mock 策略：mock transport（捕获 send payload）+ pending（返回可控 reply），
 * 验证 preset.* 消息 payload 形状与 reply 解包。不 mock @/api（直接测 domains/preset 真实实现）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/api/preset-domain.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PiLaunchPreset } from '@xyz-agent/shared'

// 捕获 transport.send 收到的消息 + pending 返回的可控 reply
const transportMock = vi.hoisted(() => {
  const sent: Array<{ type: string; id: string; payload: Record<string, unknown> }> = []
  return {
    sent,
    send: vi.fn((msg: { type: string; id: string; payload: Record<string, unknown> }) => {
      sent.push(msg)
    }),
  }
})

// pending.register 返回的 reply（每用例按需覆盖）
const pendingMock = vi.hoisted(() => ({
  register: vi.fn(),
}))

vi.mock('@/api/transport', () => ({ send: transportMock.send }))
vi.mock('@/api/pending', () => ({
  create: vi.fn(() => 'pid-1'),
  register: pendingMock.register,
}))

import { list, getDefault, setDefault } from '@/api/domains/preset'

beforeEach(() => {
  transportMock.sent.length = 0
  transportMock.send.mockClear()
  pendingMock.register.mockReset()
})

describe('presetApi.list（TC-1/TC-2）', () => {
  it('list() → payload type=preset.list，解包 reply.presets 返回 PiLaunchPreset[]', async () => {
    const fixturePresets: PiLaunchPreset[] = [
      { id: 'builtin:full', name: '全工具模式', builtin: true, order: 0, toolMode: 'all', extensionMode: 'all' },
      { id: 'builtin:readonly', name: '只读模式', builtin: true, order: 2, toolMode: 'allowlist', allowedTools: ['read'], extensionMode: 'all' },
    ]
    pendingMock.register.mockResolvedValueOnce({ presets: fixturePresets })

    const result = await list()

    expect(transportMock.send).toHaveBeenCalledTimes(1)
    expect(transportMock.sent[0]!.type).toBe('preset.list')
    expect(transportMock.sent[0]!.payload).toEqual({})
    expect(result).toEqual(fixturePresets)
    expect(result).toHaveLength(2)
  })
})

describe('presetApi.getDefault（TC-1/TC-2）', () => {
  it('getDefault() → payload type=preset.getDefault，解包 reply.presetId 返回 string', async () => {
    pendingMock.register.mockResolvedValueOnce({ presetId: 'builtin:full' })

    const result = await getDefault()

    expect(transportMock.send).toHaveBeenCalledTimes(1)
    expect(transportMock.sent[0]!.type).toBe('preset.getDefault')
    expect(transportMock.sent[0]!.payload).toEqual({})
    expect(result).toBe('builtin:full')
  })
})

describe('presetApi.setDefault（TC-1/TC-2）', () => {
  it('setDefault(id) → payload type=preset.setDefault + { presetId }，ack 型返回 void', async () => {
    pendingMock.register.mockResolvedValueOnce(undefined)

    const result = await setDefault('builtin:readonly')

    expect(transportMock.send).toHaveBeenCalledTimes(1)
    expect(transportMock.sent[0]!.type).toBe('preset.setDefault')
    expect(transportMock.sent[0]!.payload).toEqual({ presetId: 'builtin:readonly' })
    expect(result).toBeUndefined()
  })
})
