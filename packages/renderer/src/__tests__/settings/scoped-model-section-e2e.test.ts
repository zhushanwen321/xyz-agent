/**
 * ScopedModelSection e2e-mock 测试（A5 验收标准）。
 *
 * A5: VITE_MOCK 下 ProviderPage 渲染出 ScopedModelSection 区域（组件挂载链路通）。
 * mockFidelityNote: mock 模式下 settingsStore.scopedModels 默认空数组，
 * providers 来自 fixtureProviders（settings-data.ts），ScopedModelSection
 * 经 props/emits 接线挂载到 ProviderPage 顶部，无 runtime WS 依赖。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SCOPED_MODEL_E2E_TOKEN } from './impl-token'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderInfo } from '@xyz-agent/shared'
import { getSettingsStore, __resetSettingsStoreForTesting } from '@xyz-agent/core'

const configMock = vi.hoisted(() => ({
  onProviders: vi.fn(() => () => {}),
  listProviders: vi.fn(async () => []),
  setProvider: vi.fn(async () => {}),
  deleteProvider: vi.fn(async () => {}),
  toggleProviderEnabled: vi.fn(async () => {}),
  removeProviderByKind: vi.fn(async () => {}),
  testProvider: vi.fn(async () => ({ ok: true })),
  discoverModels: vi.fn(async () => ({ success: true, models: [] })),
  setDefaultModel: vi.fn(async () => {}),
  setScopedModels: vi.fn(async () => [] as string[]),
  onDefaultsWithSource: vi.fn(() => () => {}),
  checkEnvVars: vi.fn(async () => ({})),
  oauthLogin: vi.fn(async () => ({ started: false, error: 'mock' })),
  oauthCancel: vi.fn(async () => ({ cancelled: false })),
  hasOAuth: vi.fn(async () => false),
  onAuthDeviceCode: vi.fn(() => () => {}),
  onAuthAuthUrl: vi.fn(() => () => {}),
  onAuthSuccess: vi.fn(() => () => {}),
  onAuthError: vi.fn(() => () => {}),
  listBuiltinProviders: vi.fn(async () => []),
}))

vi.mock('@/api', () => ({
  project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  config: configMock,
  default: { config: configMock },
}))

import ProviderPage from '@/components/settings/provider/ProviderPage.vue'

const MOCK_PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    apiKeySet: true,
    status: 'connected',
    enabled: true,
    models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200_000, input: ['text'] }],
  },
]

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  __resetSettingsStoreForTesting()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('A5: e2e-mock ScopedModelSection 挂载', () => {
  it('A5: impl-token 存在（红阶段区分力守卫）', () => {
    expect(SCOPED_MODEL_E2E_TOKEN).toBe('scoped-model-e2e-v1')
  })

  it('A5: ProviderPage 渲染 ScopedModelSection 区域（组件挂载链路通）', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: MOCK_PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    // ScopedModelSection 区域存在
    expect(wrapper.find('[data-testid="scoped-model-section"]').exists()).toBe(true)
    // 添加按钮存在
    expect(wrapper.find('[data-testid="scoped-add-btn"]').exists()).toBe(true)
    // 空状态提示可见（默认 scopedModels 为空）
    expect(wrapper.find('[data-testid="scoped-empty"]').exists()).toBe(true)
  })
})
