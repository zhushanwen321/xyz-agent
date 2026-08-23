/**
 * SystemPage · 智能上下文压缩 Section 测试（SystemSmartContextSection，经 SystemPage 入口 mount）。
 *
 * 覆盖：
 *  - 首屏冒烟：DOM 含 switch / model Select / 3 档阈值 input / 排除容器（用户可见断言）。
 *  - 初始值：getSmartContextConfig 返回全量 → Switch 开 + 阈值 input 显示 K 值（200/400/600）。
 *  - 开关交互：切 Switch → setSmartContextEnabled 以 false 被调。
 *  - 模型下拉：选项来自 settingsStore.models 且只含 apiKeySet provider 的模型；
 *    首项「跟随当前会话模型」；点选 → setSmartContextCompactModel 以 "provider/modelId" 被调。
 *  - 阈值换算：input 改为 300（K）→ change → setSmartContextThresholds 收到绝对数 300000。
 *  - 排除 tag：getSmartContextConfig 返回 excludedModels → tag 文本渲染；点 × → 列表移除项被传。
 *
 * mock 策略（对齐 system-page-rename-model.test.ts）：
 *  - vi.mock('@/api/domains/settings') 捕获 smart-context 5 函数 + auto-rename 4 函数
 *    （SystemPage 同时挂 SystemAutoRenameSection）。
 *  - vi.mock('@/composables/useToast') 隔离 toast 全局副作用。
 *  - vi.mock('@/composables/features/command/useCommandStore') 避免真实 command store 初始化报错。
 *  - vi.mock('@/lib/ipc') mock listSystemSounds 及 onUpdateProgress/onUpdateError。
 *  - settings store 用 @xyz-agent/core 的 getSettingsStore() 单例，beforeEach 经
 *    __resetSettingsStoreForTesting 重置避免跨用例残留。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/settings/system-page-smart-context.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
import { __resetSettingsStoreForTesting, getSettingsStore, type SystemSettings } from '@xyz-agent/core'

/** mock 捕获 smart-context / auto-rename API 调用。vi.hoisted 保证在 vi.mock 工厂执行前就绪。 */
const settingsMock = vi.hoisted(() => ({
  getAutoRenameEnabled: vi.fn(() => Promise.resolve({ enabled: true })),
  setAutoRenameEnabled: vi.fn(() => Promise.resolve({ enabled: true })),
  getRenameModel: vi.fn(() => Promise.resolve({ model: '' })),
  setRenameModel: vi.fn(() => Promise.resolve({ model: '' })),
  getSmartContextConfig: vi.fn(() => Promise.resolve({})),
  setSmartContextEnabled: vi.fn(() => Promise.resolve({ enabled: true })),
  setSmartContextCompactModel: vi.fn(() => Promise.resolve({ model: '' })),
  setSmartContextThresholds: vi.fn(() => Promise.resolve({ thresholds: [] })),
  setSmartContextExcludedModels: vi.fn(() => Promise.resolve({ models: [] })),
}))

vi.mock('@/api/domains/settings', () => ({
  getAutoRenameEnabled: settingsMock.getAutoRenameEnabled,
  setAutoRenameEnabled: settingsMock.setAutoRenameEnabled,
  getRenameModel: settingsMock.getRenameModel,
  setRenameModel: settingsMock.setRenameModel,
  getSmartContextConfig: settingsMock.getSmartContextConfig,
  setSmartContextEnabled: settingsMock.setSmartContextEnabled,
  setSmartContextCompactModel: settingsMock.setSmartContextCompactModel,
  setSmartContextThresholds: settingsMock.setSmartContextThresholds,
  setSmartContextExcludedModels: settingsMock.setSmartContextExcludedModels,
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
  // UpdateCheckCard → useAppUpdate 订阅 onUpdateProgress/onUpdateError；缺导出 mount 崩
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

/** 有凭证 provider fixture（模型挂在 providers[].models —— extension 模型配置候选的正确数据源）。 */
function authedProvider(): ProviderInfo {
  return { id: 'p1', name: 'Prov One', apiKeySet: true, status: 'connected', models: [{ id: 'm1', name: 'Model One' }] }
}

/** 无凭证 provider fixture（apiKeySet=false，其模型不应出现在下拉）。 */
function unauthedProvider(): ProviderInfo {
  return { id: 'p2', name: 'Prov Two', apiKeySet: false, status: 'not_configured', models: [{ id: 'm2', name: 'Model Two' }] }
}

/** 聚合模型 fixture（scoped 过滤后形态，仅含白名单内 m1）。注入用于守卫：
 *  useAuthedModelGroups 改为 providers 派生后，下拉候选必须不受 store.models 内容影响。 */
function modelFixtures(): ModelInfo[] {
  return [
    { id: 'm1', name: 'Model One', providerId: 'p1', providerName: 'Prov One' },
  ]
}

/** smart-context 默认配置 fixture（与 extension 默认值一致）。 */
function smartContextFixture(excludedModels: string[] = []): {
  enabled: boolean
  compactModel: string
  reminderThresholds: number[]
  excludedModels: string[]
} {
  return { enabled: true, compactModel: '', reminderThresholds: [200_000, 400_000, 600_000], excludedModels }
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
  settingsMock.getSmartContextConfig.mockReset()
  settingsMock.setSmartContextEnabled.mockReset()
  settingsMock.setSmartContextCompactModel.mockReset()
  settingsMock.setSmartContextThresholds.mockReset()
  settingsMock.setSmartContextExcludedModels.mockReset()
  // 默认解析值：auto-rename 开 + rename model 未设置 + smart-context 全默认
  settingsMock.getAutoRenameEnabled.mockResolvedValue({ enabled: true })
  settingsMock.setAutoRenameEnabled.mockResolvedValue({ enabled: true })
  settingsMock.getRenameModel.mockResolvedValue({ model: '' })
  settingsMock.setRenameModel.mockResolvedValue({ model: '' })
  settingsMock.getSmartContextConfig.mockResolvedValue(smartContextFixture())
  settingsMock.setSmartContextEnabled.mockResolvedValue({ enabled: false })
  settingsMock.setSmartContextCompactModel.mockResolvedValue({ model: '' })
  settingsMock.setSmartContextThresholds.mockResolvedValue({ thresholds: [200_000, 400_000, 600_000] })
  settingsMock.setSmartContextExcludedModels.mockResolvedValue({ models: [] })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('SystemSmartContextSection 智能上下文压缩', () => {
  it('mount 后 DOM 含 switch / model Select / 3 档阈值 input / 排除容器', async () => {
    await mountPage()
    expect(wrapper!.find('[data-testid="setting-smart-context-switch"]').exists()).toBe(true)
    expect(wrapper!.find('[data-testid="setting-smart-context-model"]').exists()).toBe(true)
    expect(wrapper!.find('[data-testid="setting-smart-context-threshold-1"]').exists()).toBe(true)
    expect(wrapper!.find('[data-testid="setting-smart-context-threshold-2"]').exists()).toBe(true)
    expect(wrapper!.find('[data-testid="setting-smart-context-threshold-3"]').exists()).toBe(true)
    expect(wrapper!.find('[data-testid="setting-smart-context-excluded"]').exists()).toBe(true)
  })

  it('初始值：Switch 开 + 阈值 input 显示 K 值（200/400/600）', async () => {
    await mountPage()
    const sw = wrapper!.find('[data-testid="setting-smart-context-switch"]')
    expect(sw.attributes('data-state')).toBe('checked')
    const t1 = wrapper!.find('[data-testid="setting-smart-context-threshold-1"]').element as HTMLInputElement
    const t3 = wrapper!.find('[data-testid="setting-smart-context-threshold-3"]').element as HTMLInputElement
    expect(t1.value).toBe('200')
    expect(t3.value).toBe('600')
  })

  it('enabled=false 时 Switch 为关且阈值 input disabled', async () => {
    settingsMock.getSmartContextConfig.mockResolvedValue({ ...smartContextFixture(), enabled: false })
    await mountPage()
    const sw = wrapper!.find('[data-testid="setting-smart-context-switch"]')
    expect(sw.attributes('data-state')).toBe('unchecked')
    const t1 = wrapper!.find('[data-testid="setting-smart-context-threshold-1"]')
    expect(t1.attributes('disabled')).toBeDefined()
  })

  it('切换 Switch 触发 setSmartContextEnabled(false)', async () => {
    await mountPage()
    const sw = wrapper!.find('[data-testid="setting-smart-context-switch"]')
    // reka-ui Switch 通过 click 切换并 emit update:model-value
    await sw.trigger('click')
    await flushPromises()
    expect(settingsMock.setSmartContextEnabled).toHaveBeenCalledTimes(1)
    expect(settingsMock.setSmartContextEnabled).toHaveBeenCalledWith(false)
  })

  it('模型下拉：只列已配凭证 provider 的模型，首项跟随当前会话模型；点选后 setSmartContextCompactModel 收到 "p1/m1"', async () => {
    seedStore()
    await mountPage()

    // reka-ui SelectContent 仅在 open 时挂载（SelectPortal teleport 到 body）。
    // SelectTrigger 在 pointerdown 时打开，happy-dom 下需显式 dispatch。
    const trigger = wrapper!.find('[data-testid="setting-smart-context-model"]').element as HTMLElement
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    trigger.click()
    await flushPromises()

    const options = document.body.querySelectorAll('[role="option"]')
    const labels = Array.from(options).map((el) => el.textContent ?? '')
    // 有凭证 provider 的模型在列；无凭证 provider 的模型被过滤；首项「跟随当前会话模型」
    expect(labels).toContain('Model One')
    expect(labels).not.toContain('Model Two')
    expect(labels.some((l) => l.includes('跟随当前会话模型'))).toBe(true)

    // 点选 Model One → setSmartContextCompactModel 收到 "providerId/modelId" 复合串
    const target = Array.from(options).find((el) => (el.textContent ?? '').includes('Model One'))
    expect(target).toBeTruthy()
    target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    target!.click()
    await flushPromises()
    expect(settingsMock.setSmartContextCompactModel).toHaveBeenCalledWith('p1/m1')
  })

  it('阈值输入保存换算：第 1 档改为 300(K) → setSmartContextThresholds 收到 300000 绝对数', async () => {
    await mountPage()
    const t1 = wrapper!.find('[data-testid="setting-smart-context-threshold-1"]')
    ;(t1.element as HTMLInputElement).value = '300'
    await t1.trigger('input')
    await t1.trigger('change')
    await flushPromises()
    expect(settingsMock.setSmartContextThresholds).toHaveBeenCalledWith([300_000, 400_000, 600_000])
  })

  it('排除模型 tag 渲染 + 点 × 移除后 setSmartContextExcludedModels 收到剩余列表', async () => {
    seedStore()
    settingsMock.getSmartContextConfig.mockResolvedValue(
      smartContextFixture(['p1/m1', 'p2/m2']),
    )
    await mountPage()

    const excluded = wrapper!.find('[data-testid="setting-smart-context-excluded"]')
    // tag 文本渲染（用户可见）
    expect(excluded.text()).toContain('p1/m1')
    expect(excluded.text()).toContain('p2/m2')

    // 点第一个 tag 的 × → 移除 p1/m1
    const removeBtn = excluded.findAll('button')[0]
    expect(removeBtn).toBeTruthy()
    await removeBtn.trigger('click')
    await flushPromises()
    expect(settingsMock.setSmartContextExcludedModels).toHaveBeenCalledWith(['p2/m2'])
  })

  it('添加 Select 点选模型后 setSmartContextExcludedModels 收到追加列表', async () => {
    seedStore()
    await mountPage()

    // 打开「添加模型」Select（排除容器内的 SelectTrigger）
    const addTrigger = wrapper!
      .find('[data-testid="setting-smart-context-excluded"]')
      .find('[role="combobox"]')
    expect(addTrigger.exists()).toBe(true)
    const el = addTrigger.element as HTMLElement
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    el.click()
    await flushPromises()

    // 已配凭证且未排除的模型可选项（排除占位项 value=__add__ disabled 不响应点选）
    const options = Array.from(document.body.querySelectorAll('[role="option"]'))
    const labels = options.map((o) => o.textContent ?? '')
    expect(labels).toContain('Model One')
    expect(labels).not.toContain('Model Two')

    const target = options.find((o) => (o.textContent ?? '').includes('Model One'))
    expect(target).toBeTruthy()
    target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    target!.click()
    await flushPromises()
    expect(settingsMock.setSmartContextExcludedModels).toHaveBeenCalledWith(['p1/m1'])
  })
})
