/**
 * settings-transport-adapter discoverModels 模式感知 guard 测试（S-13 补口）。
 *
 * adapter 对 discover 模式缺 baseUrl 的短路承诺（success:false 且不调 discoverModels——
 * 不做 silent cast）与 test 模式透传行为此前零测试（唯一引用处整体 mock 本模块），
 * 守卫回归会静默失效。
 *
 * config 域 discoverModels 全程 vi.mock（adapter 层只断言转发/短路边界，不进 WS 链）。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/shell/__tests__/settings-transport-adapter.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const discoverModelsMock = vi.hoisted(() => vi.fn())
vi.mock('@xyz-agent/core/transport/api/domains/config', () => ({
  discoverModels: discoverModelsMock,
  listProviders: vi.fn(),
  setProvider: vi.fn(),
  setScopedModels: vi.fn(),
  setSkillDirs: vi.fn(),
  setAgentDirs: vi.fn(),
  setExtensionDirs: vi.fn(),
  onProviders: vi.fn(() => () => {}),
  onModels: vi.fn(() => () => {}),
  onSkills: vi.fn(() => () => {}),
  onAgents: vi.fn(() => () => {}),
  onExtensions: vi.fn(() => () => {}),
  onSkillDirs: vi.fn(() => () => {}),
  onAgentDirs: vi.fn(() => () => {}),
  onExtensionDirs: vi.fn(() => () => {}),
  onDefaults: vi.fn(() => () => {}),
  onSystemPrompt: vi.fn(() => () => {}),
  onTerminalConfig: vi.fn(() => () => {}),
}))
vi.mock('@xyz-agent/core/transport/api/domains/model', () => ({
  listModels: vi.fn(),
  onModels: vi.fn(() => () => {}),
}))
vi.mock('@xyz-agent/core/transport/api/domains/extension', () => ({
  onExtensions: vi.fn(() => () => {}),
}))

import { createSettingsTransport } from '../settings-transport-adapter'

beforeEach(() => {
  discoverModelsMock.mockReset()
})

describe('SettingsTransport.discoverModels 模式感知 guard', () => {
  it('discover 模式缺 baseUrl：短路返回 success:false 且不调 discoverModels', async () => {
    const transport = createSettingsTransport()
    const reply = await transport.discoverModels({ mode: 'discover' })

    expect(reply).toEqual({ success: false, error: 'baseUrl is required for model discovery' })
    expect(discoverModelsMock).not.toHaveBeenCalled()
  })

  it('mode 缺省按 discover 处理：缺 baseUrl 同样短路', async () => {
    const transport = createSettingsTransport()
    const reply = await transport.discoverModels({})

    expect(reply.success).toBe(false)
    expect(discoverModelsMock).not.toHaveBeenCalled()
  })

  it('test 模式缺 baseUrl：照常透传（端点回落链归 runtime，不校验 baseUrl）', async () => {
    discoverModelsMock.mockResolvedValue({ success: true })
    const transport = createSettingsTransport()
    const req = { mode: 'test' as const, providerId: 'p1' }
    const reply = await transport.discoverModels(req)

    expect(reply).toEqual({ success: true })
    expect(discoverModelsMock).toHaveBeenCalledTimes(1)
    expect(discoverModelsMock).toHaveBeenCalledWith({ ...req, mode: 'test' })
  })

  it('discover 模式带 baseUrl：正常透传（mode 缺省补全）', async () => {
    discoverModelsMock.mockResolvedValue({ success: true, models: [] })
    const transport = createSettingsTransport()
    const reply = await transport.discoverModels({ baseUrl: 'https://api.example.com' })

    expect(reply).toEqual({ success: true, models: [] })
    expect(discoverModelsMock).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com',
      mode: 'discover',
    })
  })
})
