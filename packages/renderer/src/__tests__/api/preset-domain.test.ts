/**
 * preset command helper 契约单测（pi-launch-presets wave1，TC-1/TC-2）。
 *
 * 覆盖：
 * - list() → WS payload type=preset.list，解包 reply.presets 返回 PiLaunchPreset[]
 * - getDefault() → WS payload type=preset.getDefault，解包 reply.presetId 返回 string
 * - setDefault(id) → WS payload type=preset.setDefault + { presetId }，ack 型返回 void
 *
 * mock 策略：mock core ws-client（捕获 send payload）+ core pending 源文件相对路径
 * （返回可控 reply），验证 preset.* 消息 payload 形状与 reply 解包。不 mock @/api
 * （直接测 domains/preset 真实实现）。request 已下沉 core（tc u1），mock 目标须与
 * core 内相对 import 同一模块 ID 才能拦截。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/api/preset-domain.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PiLaunchPreset } from '@xyz-agent/shared'

// 捕获 transport.send 收到的消息 + pending 返回的可控 reply
// （send 返回 true = 消息已送出，符合 transport.send 的 boolean 契约：
// request.command 对 send false 会走 fast-fail reject）
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

// pending.register 返回的 reply（每用例按需覆盖）
const pendingMock = vi.hoisted(() => ({
  register: vi.fn(),
}))

vi.mock('@xyz-agent/core/transport/ws-client', () => ({ send: transportMock.send }))
vi.mock('../../../../core/src/transport/api/pending', () => ({
  createCommandId: vi.fn(() => 'pid-1'),
  register: pendingMock.register,
  reject: vi.fn(),
}))

import { list, getDefault, setDefault, create, update, remove } from '@/api/domains/preset'

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

describe('presetApi.create（W-RN-3 reply 解包）', () => {
  it('create(preset) → payload type=preset.create + { preset }，解包 reply.preset 返回 PiLaunchPreset', async () => {
    const input: PiLaunchPreset = {
      id: 'custom:abc',
      name: '我的预设',
      builtin: false,
      order: 5,
      toolMode: 'all',
      extensionMode: 'all',
    }
    // runtime 可能补全字段（reply 是权威态）
    const saved: PiLaunchPreset = { ...input, order: 3, description: '由 runtime 补全' }
    pendingMock.register.mockResolvedValueOnce({ preset: saved })

    const result = await create(input)

    expect(transportMock.send).toHaveBeenCalledTimes(1)
    expect(transportMock.sent[0]!.type).toBe('preset.create')
    expect(transportMock.sent[0]!.payload).toEqual({ preset: input })
    // 解包 reply.preset（含 runtime 补全字段）
    expect(result).toEqual(saved)
    expect(result.order).toBe(3)
  })
})

describe('presetApi.update（W-RN-3 reply 解包）', () => {
  it('update(preset) → payload type=preset.update + { preset }，解包 reply.preset 返回 PiLaunchPreset', async () => {
    const input: PiLaunchPreset = {
      id: 'builtin:full',
      name: '全工具模式',
      builtin: true,
      order: 0,
      toolMode: 'denylist',
      deniedTools: ['bash'],
      extensionMode: 'all',
    }
    const saved: PiLaunchPreset = { ...input, deniedTools: ['bash', 'edit'] }
    pendingMock.register.mockResolvedValueOnce({ preset: saved })

    const result = await update(input)

    expect(transportMock.send).toHaveBeenCalledTimes(1)
    expect(transportMock.sent[0]!.type).toBe('preset.update')
    expect(transportMock.sent[0]!.payload).toEqual({ preset: input })
    expect(result).toEqual(saved)
  })
})

describe('presetApi.remove', () => {
  it('remove(id) → payload type=preset.delete + { presetId }，ack 型返回 void', async () => {
    pendingMock.register.mockResolvedValueOnce(undefined)

    const result = await remove('custom:abc')

    expect(transportMock.send).toHaveBeenCalledTimes(1)
    expect(transportMock.sent[0]!.type).toBe('preset.delete')
    expect(transportMock.sent[0]!.payload).toEqual({ presetId: 'custom:abc' })
    expect(result).toBeUndefined()
  })
})
