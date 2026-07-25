/**
 * useModelCapabilities 单测（feature:add-file-picture-attach slice6 TC9）。
 *
 * 覆盖 supportsVision 真值表：
 * - input 含 'image' → true
 * - input 仅 ['text'] → false
 * - input undefined → false
 * - modelId 找不到（provider/model 不存在）→ false
 * - modelId 无 '/' 格式异常 → false
 *
 * 范式照搬 useThinkingLevelSync：setActivePinia + 注入 settingsStore.providers 后断言。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/useModelCapabilities.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computed, ref } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import {
  resolveSupportsVision,
  useModelCapabilities,
} from '@/composables/panel/useModelCapabilities'

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 注入 providers 到 settingsStore（listProviders 的本地态写入）。 */
function seedProviders(providers: Array<{ id: string; models: Array<{ id: string; input?: Array<'text' | 'image'> }> }>): void {
  const settingsStore = useSettingsStore()
  settingsStore.providers = providers as never
}

describe('resolveSupportsVision（slice6 TC9 纯函数）', () => {
  it('input 含 image → true', () => {
    seedProviders([{ id: 'p1', models: [{ id: 'm1', input: ['text', 'image'] }] }])
    expect(resolveSupportsVision('p1/m1', useSettingsStore().providers)).toBe(true)
  })

  it('input 仅 text → false', () => {
    seedProviders([{ id: 'p1', models: [{ id: 'm1', input: ['text'] }] }])
    expect(resolveSupportsVision('p1/m1', useSettingsStore().providers)).toBe(false)
  })

  it('input undefined → false', () => {
    seedProviders([{ id: 'p1', models: [{ id: 'm1' }] }])
    expect(resolveSupportsVision('p1/m1', useSettingsStore().providers)).toBe(false)
  })

  it('provider 找不到 → false', () => {
    seedProviders([{ id: 'p1', models: [{ id: 'm1', input: ['image'] }] }])
    expect(resolveSupportsVision('pX/m1', useSettingsStore().providers)).toBe(false)
  })

  it('model 找不到 → false', () => {
    seedProviders([{ id: 'p1', models: [{ id: 'm1', input: ['image'] }] }])
    expect(resolveSupportsVision('p1/mX', useSettingsStore().providers)).toBe(false)
  })

  it('modelId 无 / 格式异常 → false', () => {
    seedProviders([{ id: 'p1', models: [{ id: 'm1', input: ['image'] }] }])
    expect(resolveSupportsVision('malformed', useSettingsStore().providers)).toBe(false)
  })

  it('providers 空数组 → false', () => {
    expect(resolveSupportsVision('p1/m1', [])).toBe(false)
  })
})

describe('useModelCapabilities composable（响应式）', () => {
  it('supportsVision 随 currentModelId + providers 响应变化', () => {
    seedProviders([
      { id: 'p1', models: [{ id: 'vision-model', input: ['text', 'image'] }] },
      { id: 'p2', models: [{ id: 'text-only', input: ['text'] }] },
    ])
    const store = useSettingsStore()
    // 用 ref 模拟 currentModelId 切换（computed 需响应式依赖才追踪）
    const current = ref('p1/vision-model')
    const currentModelId = computed(() => current.value)
    const { supportsVision } = useModelCapabilities(currentModelId)

    expect(supportsVision.value).toBe(true)
    current.value = 'p2/text-only'
    expect(supportsVision.value).toBe(false)
    current.value = 'p1/vision-model'
    expect(supportsVision.value).toBe(true)
    // 验证 composable 委托 resolveSupportsVision（同一真相源）
    expect(supportsVision.value).toBe(resolveSupportsVision(current.value, store.providers))
  })
})
