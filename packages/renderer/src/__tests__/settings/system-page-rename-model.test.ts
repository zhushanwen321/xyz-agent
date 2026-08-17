/**
 * SystemPage · 重命名模型 Select 测试（SystemAutoRenameSection 子组件，经 SystemPage 入口 mount）。
 *
 * 覆盖：
 *  - 首屏冒烟：DOM 含 rename-model Select trigger（data-testid=setting-rename-model）。
 *  - 初始值：getRenameModel 返回 "p1/m1"（在可选列表）→ trigger 显示模型名；
 *    返回不在列表的 ref → trigger 显示该 ref + （不可用）。
 *  - 凭证过滤：apiKeySet=false 的 provider 的模型不出现在 option 文案中。
 *  - 选择交互：打开下拉点选模型 option → setRenameModel 以 "provider/modelId" 被调。
 *  - 联动：auto-rename 开 → trigger 可用；关 → trigger disabled。
 *
 * mock 策略：
 *  - vi.mock('@/api/domains/settings') 捕获 getRenameModel / setRenameModel /
 *    getAutoRenameEnabled / setAutoRenameEnabled。
 *  - vi.mock('@/composables/useToast') 隔离 toast 全局副作用。
 *  - vi.mock('@/composables/features/command/useCommandStore') 避免真实 command store 初始化报错
 *    （容器用例挂 SystemShortcutSection 需要）。
 *  - vi.mock('@/lib/ipc') mock listSystemSounds（SystemSoundSection onMounted 调用）
 *    及 onUpdateProgress/onUpdateError（UpdateCheckCard 订阅）。
 *  - settings store 用 @xyz-agent/core 的 getSettingsStore() 单例（模块级 store，
 *    providers/models 是 ref，测试直接写 .value 注入 fixture），
 *    beforeEach 经 __resetSettingsStoreForTesting 重置避免跨用例残留。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/settings/system-page-rename-model.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
import { __resetSettingsStoreForTesting, getSettingsStore, type SystemSettings } from '@xyz-agent/core'

/** mock 捕获 auto-rename / rename-model API 调用。vi.hoisted 保证在 vi.mock 工厂执行前就绪。 */
const settingsMock = vi.hoisted(() => ({
  getAutoRenameEnabled: vi.fn(() => Promise.resolve({ enabled: true })),
  setAutoRenameEnabled: vi.fn(() => Promise.resolve({ enabled: true })),
  getRenameModel: vi.fn(() => Promise.resolve({ model: '' })),
  setRenameModel: vi.fn(() => Promise.resolve({ model: '' })),
}))

vi.mock('@/api/domains/settings', () => ({
  getAutoRenameEnabled: settingsMock.getAutoRenameEnabled,
  setAutoRenameEnabled: settingsMock.setAutoRenameEnabled,
  getRenameModel: settingsMock.getRenameModel,
  setRenameModel: settingsMock.setRenameModel,
  // stores/settings → '@/api' → mock/index 转发引用 real 域的 getSystem/updateSystem，
  // 工厂缺导出会在模块加载时抛 "No export defined"；本测试不消费，给空实现即可
  getSystem: vi.fn(() => Promise.resolve({})),
  updateSystem: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ info: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}))

// SystemShortcutSection 需要 command store；用 ref 暴露响应式属性（storeToRefs 兼容）
vi.mock('@/composables/features/command/useCommandStore', () => {
  const { ref } = require('vue') as typeof import('vue')
  return {
    useCommandStore: () => ({
      appCommands: ref([]),
      shortcutOverrides: ref({}),
      setShortcutOverride: vi.fn(),
      registerApp: vi.fn(),
    }),
  }
})

vi.mock('@/lib/ipc', () => ({
  listSystemSounds: vi.fn(() => Promise.resolve({ sounds: [] })),
  // UpdateCheckCard → useAppUpdate 订阅 onUpdateProgress/onUpdateError（useAppUpdate refactor 18c67d16f 后新增；
  // 缺此导出 vitest 抛 No export is defined on the mock → 容器用例崩 mount）
  onUpdateProgress: vi.fn(() => () => {}),
  onUpdateError: vi.fn(() => () => {}),
}))

import SystemPage from '@/components/settings/system/SystemPage.vue'

/** 最小 SystemSettings fixture。 */
function systemFixture(): SystemSettings {
  return {
    locale: 'zh-CN',
    theme: 'dark',
    themePreset: 'cold-blue',
    fontSize: 'medium',
    completionSound: true,
  }
}

/** 有凭证 provider fixture（ProviderInfo 必填字段：id/name/apiKeySet/status/models）。 */
function authedProvider(): ProviderInfo {
  return { id: 'p1', name: 'Prov One', apiKeySet: true, status: 'connected', models: [] }
}

/** 无凭证 provider fixture（apiKeySet=false，其模型不应出现在下拉）。 */
function unauthedProvider(): ProviderInfo {
  return { id: 'p2', name: 'Prov Two', apiKeySet: false, status: 'not_configured', models: [] }
}

/** 聚合模型 fixture（ModelInfo 必填字段：id/name/providerId/providerName）。 */
function modelFixtures(): ModelInfo[] {
  return [
    { id: 'm1', name: 'Model One', providerId: 'p1', providerName: 'Prov One' },
    { id: 'm2', name: 'Model Two', providerId: 'p2', providerName: 'Prov Two' },
  ]
}

/** 注入非空 providers/models 到 settings store 单例（模块级 store 的 ref，直接写 .value）。 */
function seedStore(): void {
  const store = getSettingsStore()
  store.providers.value = [authedProvider(), unauthedProvider()]
  store.models.value = modelFixtures()
}

let wrapper: ReturnType<typeof mount> | null = null

/** mount SystemPage（集成入口）并完成异步加载。 */
async function mountPage(): Promise<void> {
  wrapper = mount(SystemPage, {
    props: { system: systemFixture() },
    attachTo: document.body,
  })
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  __resetSettingsStoreForTesting()
  settingsMock.getAutoRenameEnabled.mockReset()
  settingsMock.setAutoRenameEnabled.mockReset()
  settingsMock.getRenameModel.mockReset()
  settingsMock.setRenameModel.mockReset()
  settingsMock.getAutoRenameEnabled.mockResolvedValue({ enabled: true })
  settingsMock.setAutoRenameEnabled.mockResolvedValue({ enabled: true })
  settingsMock.getRenameModel.mockResolvedValue({ model: '' })
  settingsMock.setRenameModel.mockResolvedValue({ model: '' })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('SystemPage 重命名模型 Select', () => {
  it('mount 后 DOM 含 rename-model Select trigger', async () => {
    await mountPage()
    const trigger = wrapper!.find('[data-testid="setting-rename-model"]')
    expect(trigger.exists()).toBe(true)
  })

  it('getRenameModel 返回可选列表内的 ref 时 trigger 显示模型名', async () => {
    settingsMock.getRenameModel.mockResolvedValue({ model: 'p1/m1' })
    seedStore()
    await mountPage()
    const trigger = wrapper!.find('[data-testid="setting-rename-model"]')
    expect(trigger.text()).toContain('Model One')
  })

  it('ref 不在可选列表时 trigger 显示该 ref + （不可用）', async () => {
    settingsMock.getRenameModel.mockResolvedValue({ model: 'gone/model-x' })
    seedStore()
    await mountPage()
    const trigger = wrapper!.find('[data-testid="setting-rename-model"]')
    expect(trigger.text()).toContain('gone/model-x')
    expect(trigger.text()).toContain('（不可用）')
  })

  it('未设置时 trigger 显示「未设置」', async () => {
    settingsMock.getRenameModel.mockResolvedValue({ model: '' })
    seedStore()
    await mountPage()
    const trigger = wrapper!.find('[data-testid="setting-rename-model"]')
    expect(trigger.text()).toContain('未设置')
  })

  it('auto-rename 关闭时 trigger disabled，开启时可用', async () => {
    settingsMock.getAutoRenameEnabled.mockResolvedValue({ enabled: false })
    await mountPage()
    const trigger = wrapper!.find('[data-testid="setting-rename-model"]')
    expect(trigger.attributes('disabled')).toBeDefined()

    settingsMock.getAutoRenameEnabled.mockResolvedValue({ enabled: true })
    seedStore()
    await mountPage()
    const enabledTrigger = wrapper!.find('[data-testid="setting-rename-model"]')
    expect(enabledTrigger.attributes('disabled')).toBeUndefined()
  })

  it('下拉 option 只含已配凭证 provider 的模型；点选后 setRenameModel 收到 "p1/m1"', async () => {
    seedStore()
    await mountPage()

    // reka-ui SelectContent 仅在 open 时挂载（SelectPortal teleport 到 body）。
    // SelectTrigger 在 pointerdown 时打开，happy-dom 下需显式 dispatch
    // （同 provider-edit-modal.test.ts 的交互模式）。
    const trigger = wrapper!.find('[data-testid="setting-rename-model"]').element as HTMLElement
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    trigger.click()
    await flushPromises()

    const options = document.body.querySelectorAll('[role="option"]')
    const labels = Array.from(options).map((el) => el.textContent ?? '')
    // 有凭证 provider 的模型在列；无凭证 provider 的模型被过滤
    expect(labels).toContain('Model One')
    expect(labels).not.toContain('Model Two')
    expect(labels).toContain('未设置')

    // 点选 Model One → setRenameModel 收到 "providerId/modelId" 复合串
    const target = Array.from(options).find((el) => (el.textContent ?? '').includes('Model One'))
    expect(target).toBeTruthy()
    target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    target!.click()
    await flushPromises()
    expect(settingsMock.setRenameModel).toHaveBeenCalledWith('p1/m1')
  })
})
