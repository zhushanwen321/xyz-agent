/**
 * settingsStore.models 订阅机制单测。
 *
 * 覆盖 2026-07-01 改动：store 新增 models ref + init() 中订阅 modelApi.onModels。
 * models 与 providers 同源（runtime sendInitialState 推 + provider 变更广播），
 * 故同样走应用级常驻订阅（init 注册、幂等、dispose 断开）。
 *
 * mock 策略：vi.mock('@/api') 把整个 api 门面替掉（config / model / extension / settings
 * 订阅与请求），vi.mock('@/i18n') 避免 setLocale 拉起 i18n 实例 + locale 文件加载。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/stores/settings-store-models.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ModelInfo } from '@xyz-agent/shared'

/**
 * onModels 回调句柄：vi.hoisted 保证在 vi.mock 工厂执行前就绪，
 * 使 mock 工厂能引用它来捕获每次订阅注册的 handler。
 */
const { onModelsHandler } = vi.hoisted(() => ({
  onModelsHandler: { current: null as ((models: ModelInfo[]) => void) | null },
}))

vi.mock('@/api', () => ({
  config: {
    onProviders: vi.fn(() => () => {}),
    onSkills: vi.fn(() => () => {}),
    onAgents: vi.fn(() => () => {}),
    onSkillDirs: vi.fn(() => () => {}),
    onAgentDirs: vi.fn(() => () => {}),
    onDefaults: vi.fn(() => () => {}),
  },
  model: {
    onModels: vi.fn((cb: (models: ModelInfo[]) => void) => {
      onModelsHandler.current = cb
      return () => {
        onModelsHandler.current = null
      }
    }),
  },
  extension: { onExtensions: vi.fn(() => () => {}) },
  settings: {
    getSystem: vi.fn(async () => ({ locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue' })),
  },
}))

vi.mock('@/i18n', () => ({
  setLocale: vi.fn(),
}))

import { model as modelApi } from '@/api'
import { useSettingsStore } from '@/stores/settings'

beforeEach(() => {
  setActivePinia(createPinia())
  onModelsHandler.current = null
  vi.clearAllMocks()
})

describe('settingsStore.models 订阅机制', () => {
  it('U1: init 订阅 onModels —— handler 推送后 models 更新', async () => {
    const store = useSettingsStore()
    await store.init()

    const M1: ModelInfo = {
      id: 'claude-4',
      name: 'Claude 4',
      providerId: 'anthropic',
      providerName: 'Anthropic',
    }
    const M2: ModelInfo = {
      id: 'gpt-4o',
      name: 'GPT-4o',
      providerId: 'openai',
      providerName: 'OpenAI',
    }
    onModelsHandler.current?.([M1, M2])

    expect(store.models).toEqual([M1, M2])
  })

  it('U2: init 幂等 —— 连续两次 init，onModels 只订阅一次', async () => {
    const store = useSettingsStore()
    await store.init()
    await store.init()

    expect(vi.mocked(modelApi.onModels).mock.calls.length).toBe(1)
  })

  it('U3: models 初始值 —— init 前为空数组', () => {
    const store = useSettingsStore()
    expect(store.models).toEqual([])
  })

  it('U4: dispose 清订阅 —— dispose 后推送不再生效，models 保持空', async () => {
    const store = useSettingsStore()
    await store.init()
    store.dispose()

    const M1: ModelInfo = {
      id: 'claude-4',
      name: 'Claude 4',
      providerId: 'anthropic',
      providerName: 'Anthropic',
    }
    onModelsHandler.current?.([M1])

    expect(store.models).toEqual([])
  })
})
