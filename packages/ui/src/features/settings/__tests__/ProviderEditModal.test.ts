/**
 * ProviderEditModal 首屏冒烟测试（W3 · TC-3）。
 *
 * 首屏渲染 gate（AGENTS.md 测试规范 §8）：mount，验证 setup 链路（useProviderEdit 经 core
 * transport/store + toast/quota/config inject noop fallback）不抛错，Dialog 原语挂载。
 *
 * ProviderEditModal 的 DialogContent 经 reka Portal Teleport 到 body，渲染时序 + body 清理
 * 在 happy-dom 不稳定，故首屏 gate 用「组件实例化 + Dialog 原语存在」断言，不深度测交互
 * （深度交互由 core 的 use-provider-edit 单测覆盖，W2 已交付 28 用例）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { provideSettingsTransport, __resetSettingsStoreForTesting, providePlatform } from '@xyz-agent/core'
import ProviderEditModal from '../ProviderEditModal.vue'
import type { ProviderInfo } from '@xyz-agent/shared'

function fakeTransport() {
  const noopUnsub = () => {}
  return {
    onProviders: () => noopUnsub, onModels: () => noopUnsub, onSkills: () => noopUnsub,
    onAgents: () => noopUnsub, onSkillDirs: () => noopUnsub, onAgentDirs: () => noopUnsub,
    onExtensionDirs: () => noopUnsub, onDefaults: () => noopUnsub, onSystemPrompt: () => noopUnsub,
    onTerminalConfig: () => noopUnsub, onExtensions: () => noopUnsub,
    listProviders: async () => [], discoverModels: async () => ({ success: true, models: [] }),
    setProvider: async () => {},
  } as unknown as Parameters<typeof provideSettingsTransport>[0]
}

const PROVIDER: ProviderInfo = {
  id: 'test', name: 'Test', api: 'openai-completions', baseUrl: 'https://example.com',
  enabled: true, models: [],
} as unknown as ProviderInfo

describe('ProviderEditModal 首屏冒烟', () => {
  beforeEach(() => {
    __resetSettingsStoreForTesting()
    provideSettingsTransport(fakeTransport())
    providePlatform({
      kind: 'mock',
      storage: { get: async () => null, set: async () => {}, updateSystem: async () => {}, getSystem: async () => null },
    } as unknown as Parameters<typeof providePlatform>[0])
  })
  afterEach(() => {
    // 清理 reka Portal Teleport 到 body 的残留（跨用例隔离）
    document.body.innerHTML = ''
  })

  it('open=true + provider：setup 链路不抛错 + Dialog 原语挂载', () => {
    const wrapper = mount(ProviderEditModal, { props: { open: true, provider: PROVIDER } })
    expect(wrapper.exists()).toBe(true)
    // Dialog 原语（ui primitives）作为根容器渲染
    expect(wrapper.findComponent({ name: 'Dialog' }).exists()).toBe(true)
  })

  it('open=false：组件仍实例化（v-if 守卫不影响 setup）', () => {
    const wrapper = mount(ProviderEditModal, { props: { open: false, provider: PROVIDER } })
    expect(wrapper.exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'Dialog' }).exists()).toBe(true)
  })

  it('provider=null（新增态）：setup 不抛错（useProviderEdit 处理 null provider）', () => {
    const wrapper = mount(ProviderEditModal, { props: { open: true, provider: null } })
    expect(wrapper.exists()).toBe(true)
  })
})
