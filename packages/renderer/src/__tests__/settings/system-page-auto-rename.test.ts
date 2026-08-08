/**
 * SystemPage · 会话自动重命名开关 + 容器编排测试。
 *
 * 覆盖（SystemAutoRenameSection）：
 *  - 首屏冒烟：DOM 含 auto-rename Switch（data-testid=setting-auto-rename-session）。
 *  - 初始态：getAutoRenameEnabled 返回 true → Switch 开；返回 false → Switch 关。
 *  - 切换交互：切 Switch → setAutoRenameEnabled 被调用。
 *
 * 覆盖（SystemPage 容器）：
 *  - 首屏冒烟：4 个 Section 组件渲染 + auto-rename Switch 在 DOM（用户可见断言）。
 *  - update 透传：Section 的 update 事件原样透传为容器 update。
 *
 * mock 策略：
 *  - vi.mock('@/api/domains/settings') 捕获 getAutoRenameEnabled / setAutoRenameEnabled。
 *  - vi.mock('@/composables/useToast') 隔离 toast 全局副作用。
 *  - vi.mock('@/stores/command') 避免 useCommandStore 真实 pinia store 初始化报错（容器用例挂 SystemShortcutSection 需要）。
 *  - vi.mock('@/lib/ipc') mock listSystemSounds（容器用例挂 SystemSoundSection onMounted 调用）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/settings/system-page-auto-rename.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { SystemSettings } from '@xyz-agent/core'
import SystemAutoRenameSection from '@/components/settings/system/SystemAutoRenameSection.vue'
import SystemPage from '@/components/settings/system/SystemPage.vue'
import SystemAppearanceSection from '@/components/settings/system/SystemAppearanceSection.vue'
import SystemSoundSection from '@/components/settings/system/SystemSoundSection.vue'
import SystemShortcutSection from '@/components/settings/system/SystemShortcutSection.vue'

/** mock 捕获 auto-rename API 调用。vi.hoisted 保证在 vi.mock 工厂执行前就绪。 */
const settingsMock = vi.hoisted(() => ({
  getAutoRenameEnabled: vi.fn(() => Promise.resolve({ enabled: true })),
  setAutoRenameEnabled: vi.fn(() => Promise.resolve({ enabled: true })),
}))

vi.mock('@/api/domains/settings', () => ({
  getAutoRenameEnabled: settingsMock.getAutoRenameEnabled,
  setAutoRenameEnabled: settingsMock.setAutoRenameEnabled,
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ info: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}))

// storeToRefs 要求真正的 reactive 属性，故用 ref 暴露 appCommands / shortcutOverrides
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

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  settingsMock.getAutoRenameEnabled.mockReset()
  settingsMock.setAutoRenameEnabled.mockReset()
  // 默认解析值：与组件默认 ref(true) 一致
  settingsMock.getAutoRenameEnabled.mockResolvedValue({ enabled: true })
  settingsMock.setAutoRenameEnabled.mockResolvedValue({ enabled: true })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('SystemAutoRenameSection 会话自动重命名开关', () => {
  it('mount 后 DOM 含 auto-rename Switch', async () => {
    wrapper = mount(SystemAutoRenameSection, { props: { system: systemFixture() } })
    await flushPromises()
    const sw = wrapper.find('[data-testid="setting-auto-rename-session"]')
    expect(sw.exists()).toBe(true)
  })

  it('getAutoRenameEnabled 返回 true 时 Switch 为开', async () => {
    settingsMock.getAutoRenameEnabled.mockResolvedValue({ enabled: true })
    wrapper = mount(SystemAutoRenameSection, { props: { system: systemFixture() } })
    await flushPromises()
    const sw = wrapper.find('[data-testid="setting-auto-rename-session"]')
    expect(sw.attributes('data-state')).toBe('checked')
  })

  it('getAutoRenameEnabled 返回 false 时 Switch 为关', async () => {
    settingsMock.getAutoRenameEnabled.mockResolvedValue({ enabled: false })
    wrapper = mount(SystemAutoRenameSection, { props: { system: systemFixture() } })
    await flushPromises()
    const sw = wrapper.find('[data-testid="setting-auto-rename-session"]')
    expect(sw.attributes('data-state')).toBe('unchecked')
  })

  it('切换 Switch 触发 setAutoRenameEnabled', async () => {
    settingsMock.getAutoRenameEnabled.mockResolvedValue({ enabled: true })
    wrapper = mount(SystemAutoRenameSection, { props: { system: systemFixture() } })
    await flushPromises()
    const sw = wrapper.find('[data-testid="setting-auto-rename-session"]')
    // reka-ui Switch 通过 click 切换并 emit update:model-value
    await sw.trigger('click')
    await flushPromises()
    expect(settingsMock.setAutoRenameEnabled).toHaveBeenCalledTimes(1)
    expect(settingsMock.setAutoRenameEnabled).toHaveBeenCalledWith(false)
  })
})

describe('SystemPage 容器编排', () => {
  it('首屏渲染：4 个 Section 组件在 DOM + auto-rename Switch 可见', async () => {
    wrapper = mount(SystemPage, { props: { system: systemFixture() } })
    await flushPromises()
    expect(wrapper.findComponent(SystemAppearanceSection).exists()).toBe(true)
    expect(wrapper.findComponent(SystemSoundSection).exists()).toBe(true)
    expect(wrapper.findComponent(SystemShortcutSection).exists()).toBe(true)
    expect(wrapper.findComponent(SystemAutoRenameSection).exists()).toBe(true)
    expect(wrapper.find('.page-head').exists()).toBe(true)
    expect(wrapper.find('[data-testid="setting-auto-rename-session"]').exists()).toBe(true)
  })

  it('Section 的 update 事件透传为容器 update（locale 变更）', async () => {
    wrapper = mount(SystemPage, { props: { system: systemFixture() } })
    await flushPromises()
    const appearance = wrapper.findComponent(SystemAppearanceSection)
    appearance.vm.$emit('update', { locale: 'en-US' })
    await flushPromises()
    const updates = wrapper.emitted('update')
    expect(updates).toBeTruthy()
    expect(updates![updates!.length - 1]).toEqual([{ locale: 'en-US' }])
  })
})
