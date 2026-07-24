/**
 * settings 域订阅机制单测（重构后：订阅生命周期在 useSettings composable）。
 *
 * 覆盖 2026-07-01 改动 + 2026-07-02 架构返工 G2：
 * store 新增 models ref；订阅编排（init/dispose）从 store 下沉到 useSettings composable。
 * models 与 providers 同源（runtime sendInitialState 推 + provider 变更广播），
 * 故同样走应用级常驻订阅（init 注册、幂等、dispose 断开）。
 *
 * mock 策略：vi.mock('@/api') 把整个 api 门面替掉（config / model / extension / settings
 * 订阅与请求），vi.mock('@/i18n') 避免 setLocale 拉起 i18n 实例 + locale 文件加载。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/stores/settings-store-models.test.ts
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
    onExtensionDirs: vi.fn(() => () => {}),
    onDefaults: vi.fn(() => () => {}),
    // FR-4/FR-5 system prompt config：useSettings.init 会订阅 onSystemPrompt（PR #87 新增）
    onSystemPrompt: vi.fn(() => () => {}),
    // Phase 6 terminal config：useSettings.init 会订阅 onTerminalConfig
    onTerminalConfig: vi.fn(() => () => {}),
    getTerminalConfig: vi.fn(async () => ({ config: { version: 1, shell: '', shellArgs: [], fontSize: 14, fontFamily: '', scrollback: 1000, cursorStyle: 'block' as const, bell: false }, corrupted: false })),
    setTerminalConfig: vi.fn(async () => ({ config: { version: 1, shell: '', shellArgs: [], fontSize: 14, fontFamily: '', scrollback: 1000, cursorStyle: 'block' as const, bell: false }, corrupted: false })),
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
    updateSystem: vi.fn(async () => {}),
  },
}))

vi.mock('@/i18n', () => ({
  setLocale: vi.fn(),
}))

import { model as modelApi } from '@/api'
import { useSettingsStore } from '@/stores/settings'
import { useSettings } from '@/composables/features/useSettings'

beforeEach(() => {
  setActivePinia(createPinia())
  onModelsHandler.current = null
  vi.clearAllMocks()
  // 每个用例前重置 init 守卫，让 init 可重复挂载订阅
  useSettings().resetSettingsInit()
})

describe('useSettings 订阅机制（models 推回 settings store）', () => {
  it('U1: init 订阅 onModels —— handler 推送后 store.models 更新', async () => {
    await useSettings().init()

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

    expect(useSettingsStore().models).toEqual([M1, M2])
  })

  it('U2: init 幂等 —— 连续两次 init，onModels 只订阅一次', async () => {
    const { init } = useSettings()
    await init()
    await init()

    expect(vi.mocked(modelApi.onModels).mock.calls.length).toBe(1)
  })

  it('U3: models 初始值 —— init 前为空数组', () => {
    expect(useSettingsStore().models).toEqual([])
  })

  it('U4: dispose 清订阅 —— dispose 后推送不再生效，models 保持空', async () => {
    const { init, dispose } = useSettings()
    await init()
    dispose()

    const M1: ModelInfo = {
      id: 'claude-4',
      name: 'Claude 4',
      providerId: 'anthropic',
      providerName: 'Anthropic',
    }
    onModelsHandler.current?.([M1])

    expect(useSettingsStore().models).toEqual([])
  })
})
