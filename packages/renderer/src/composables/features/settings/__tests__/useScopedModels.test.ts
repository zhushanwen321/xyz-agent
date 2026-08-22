/**
 * useScopedModels composable 测试（A4 验收标准）。
 *
 * A3: add/remove/move 调 RPC 且乐观更新 + 失败回滚。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { getSettingsStore, __resetSettingsStoreForTesting } from '@xyz-agent/core'
import { SCOPED_MODEL_RENDERER_TOKEN } from './impl-token'

const configMock = vi.hoisted(() => ({
  setScopedModels: vi.fn(async () => [] as string[]),
}))

vi.mock('@/api', () => ({
  config: configMock,
  default: { config: configMock },
}))

import { useScopedModels } from '../useScopedModels'

const MOCK_PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    apiKeySet: true,
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    apiKeySet: false,
    models: [
      { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
    ],
  },
]

beforeEach(() => {
  setActivePinia(createPinia())
  __resetSettingsStoreForTesting()
  configMock.setScopedModels.mockReset()
})

describe('useScopedModels', () => {
  it('A3: impl-token 存在（红阶段区分力守卫）', () => {
    expect(SCOPED_MODEL_RENDERER_TOKEN).toBe('scoped-model-renderer-v1')
  })

  it('A3: scopedRenderItems 从 settingsStore.scopedModels + providers 派生', () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5', 'deleted/missing']

    const { scopedRenderItems } = useScopedModels()
    const items = scopedRenderItems.value
    expect(items.length).toBe(3)

    expect(items[0].modelName).toBe('GPT-4o')
    expect(items[0].providerName).toBe('OpenAI')
    expect(items[0].apiKeySet).toBe(true)
    expect(items[0].missing).toBe(false)

    expect(items[1].modelName).toBe('Claude Sonnet 4.5')
    expect(items[1].providerName).toBe('Anthropic')
    expect(items[1].apiKeySet).toBe(false)
    expect(items[1].missing).toBe(false)

    expect(items[2].missing).toBe(true)
  })

  it('A3: selectableModels 从 providers 派生全量模型列表', () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any

    const { selectableModels } = useScopedModels()
    const models = selectableModels.value
    expect(models.length).toBe(3)
    expect(models[0].fullId).toBe('openai/gpt-4o')
    expect(models[1].fullId).toBe('openai/gpt-4o-mini')
    expect(models[2].fullId).toBe('anthropic/claude-sonnet-4.5')
  })

  it('A3: addScopedModels 乐观更新 + RPC 成功 → 状态保持', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o']

    configMock.setScopedModels.mockResolvedValueOnce(['openai/gpt-4o', 'openai/gpt-4o-mini'])

    const { addScopedModels } = useScopedModels()
    await addScopedModels(['openai/gpt-4o-mini'])

    expect(configMock.setScopedModels).toHaveBeenCalledWith(['openai/gpt-4o', 'openai/gpt-4o-mini'])
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o', 'openai/gpt-4o-mini'])
  })

  it('A3: addScopedModels RPC 失败 → 回滚到旧值', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o']

    configMock.setScopedModels.mockRejectedValueOnce(new Error('network error'))

    const { addScopedModels } = useScopedModels()
    await addScopedModels(['openai/gpt-4o-mini'])

    // 回滚
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o'])
  })

  it('A3: removeScopedModel 乐观更新 + RPC 成功 → 状态保持', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'openai/gpt-4o-mini']

    configMock.setScopedModels.mockResolvedValueOnce(['openai/gpt-4o-mini'])

    const { removeScopedModel } = useScopedModels()
    await removeScopedModel('openai/gpt-4o')

    expect(configMock.setScopedModels).toHaveBeenCalledWith(['openai/gpt-4o-mini'])
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o-mini'])
  })

  it('A3: removeScopedModel RPC 失败 → 回滚', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'openai/gpt-4o-mini']

    configMock.setScopedModels.mockRejectedValueOnce(new Error('fail'))

    const { removeScopedModel } = useScopedModels()
    await removeScopedModel('openai/gpt-4o')

    expect(store.scopedModels.value).toEqual(['openai/gpt-4o', 'openai/gpt-4o-mini'])
  })

  it('A3: moveScopedModel 上移 → 顺序变化 + RPC 成功', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5']

    configMock.setScopedModels.mockResolvedValueOnce(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])

    const { moveScopedModel } = useScopedModels()
    await moveScopedModel('anthropic/claude-sonnet-4.5', 'up')

    expect(configMock.setScopedModels).toHaveBeenCalledWith(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
    expect(store.scopedModels.value).toEqual(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
  })

  it('A3: moveScopedModel 下移 → 顺序变化 + RPC 成功', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5']

    configMock.setScopedModels.mockResolvedValueOnce(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])

    const { moveScopedModel } = useScopedModels()
    await moveScopedModel('openai/gpt-4o', 'down')

    expect(configMock.setScopedModels).toHaveBeenCalledWith(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
    expect(store.scopedModels.value).toEqual(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
  })

  it('A3: moveScopedModel RPC 失败 → 回滚顺序', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5']

    configMock.setScopedModels.mockRejectedValueOnce(new Error('fail'))

    const { moveScopedModel } = useScopedModels()
    await moveScopedModel('openai/gpt-4o', 'down')

    expect(store.scopedModels.value).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4.5'])
  })

  it('A3: addScopedModels 跳过已存在的重复项', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o']

    const { addScopedModels } = useScopedModels()
    await addScopedModels(['openai/gpt-4o'])

    // 不调 RPC（无新项）
    expect(configMock.setScopedModels).not.toHaveBeenCalled()
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o'])
  })
})
