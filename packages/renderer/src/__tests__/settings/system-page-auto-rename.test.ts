/**
 * SystemPage · 会话自动重命名开关 + 容器编排测试。
 *
 * 覆盖（SystemAutoRenameSection）：
 *  - 首屏冒烟：DOM 含 auto-rename Switch（data-testid=setting-auto-rename-session）。
 *  - 初始态：getAutoRenameEnabled 返回 true → Switch 开；返回 false → Switch 关。
 *  - 切换交互：切 Switch → setAutoRenameEnabled 被调用。
 *  - 触发模式 Select：DOM 含 trigger（data-testid=setting-rename-mode）+ getRenameMode 回显 +
 *    三模式选项点选 setRenameMode；开关关闭时仍可用（agent-tool 工具注册不受开关 flag 门控，
 *    与 model Select 随开关 disabled 的差异行为）。
 *  - hint 边界（D1 正交契约）：renameModeHint 文案说明开关依赖——自动生成模式需开关开启、
 *    agent 自主命名不受限。
 *  - 成功 toast 分流：开关关 + 切自动模式 → 提示需开启开关（不承诺已生效，自动路径被
 *    enabled flag 拦截）；开关开 → 原「已生效」文案。
 *
 * 覆盖（SystemPage 容器）：
 *  - 首屏冒烟：4 个 Section 组件渲染 + auto-rename Switch 在 DOM（用户可见断言）。
 *  - update 透传：Section 的 update 事件原样透传为容器 update。
 *
 * mock 策略：
 *  - vi.mock('@xyz-agent/core/transport/api/domains/settings') 捕获 getAutoRenameEnabled / setAutoRenameEnabled。
 *  - vi.mock('@/composables/useToast') 隔离 toast 全局副作用。
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

/** mock 捕获 auto-rename / rename-model / rename-mode / smart-context API 调用。vi.hoisted 保证在 vi.mock 工厂执行前就绪。 */
const settingsMock = vi.hoisted(() => ({
  getAutoRenameEnabled: vi.fn(() => Promise.resolve({ enabled: true })),
  setAutoRenameEnabled: vi.fn(() => Promise.resolve({ enabled: true })),
  getRenameModel: vi.fn(() => Promise.resolve({ model: '' })),
  setRenameModel: vi.fn(() => Promise.resolve({ model: '' })),
  getRenameMode: vi.fn(() => Promise.resolve({ mode: 'first-stop' })),
  setRenameMode: vi.fn((mode: string) => Promise.resolve({ mode })),
  // SystemPage 现挂 SystemSmartContextSection（onMounted 读全量配置）——缺导出会告警
  getSmartContextConfig: vi.fn(() =>
    Promise.resolve({ enabled: true, compactModel: '', reminderThresholds: [200_000, 400_000, 600_000], excludedModels: [] }),
  ),
  setSmartContextEnabled: vi.fn(() => Promise.resolve({ enabled: true })),
  setSmartContextCompactModel: vi.fn(() => Promise.resolve({ model: '' })),
  setSmartContextThresholds: vi.fn(() => Promise.resolve({ thresholds: [200_000, 400_000, 600_000] })),
  setSmartContextExcludedModels: vi.fn(() => Promise.resolve({ models: [] })),
}))

/** toast 捕获（成功 toast 分流断言用；error/warning 仅隔离副作用不需断言）。 */
const toastMock = vi.hoisted(() => ({ info: vi.fn() }))

vi.mock('@xyz-agent/core/transport/api/domains/settings', () => ({
  getAutoRenameEnabled: settingsMock.getAutoRenameEnabled,
  setAutoRenameEnabled: settingsMock.setAutoRenameEnabled,
  getRenameModel: settingsMock.getRenameModel,
  setRenameModel: settingsMock.setRenameModel,
  getRenameMode: settingsMock.getRenameMode,
  setRenameMode: settingsMock.setRenameMode,
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
  // info 走共享 toastMock 捕获（分流断言用）；error/warning 仅隔离副作用
  useToast: () => ({ info: toastMock.info, error: vi.fn(), warning: vi.fn() }),
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
  settingsMock.getRenameModel.mockReset()
  settingsMock.setRenameModel.mockReset()
  settingsMock.getRenameMode.mockReset()
  settingsMock.setRenameMode.mockReset()
  // 默认解析值：与组件默认 ref(true) / ref('') / ref('first-stop') 一致
  settingsMock.getAutoRenameEnabled.mockResolvedValue({ enabled: true })
  settingsMock.setAutoRenameEnabled.mockResolvedValue({ enabled: true })
  settingsMock.getRenameModel.mockResolvedValue({ model: '' })
  settingsMock.setRenameModel.mockResolvedValue({ model: '' })
  settingsMock.getRenameMode.mockResolvedValue({ mode: 'first-stop' })
  settingsMock.setRenameMode.mockImplementation((mode: string) => Promise.resolve({ mode }))
  toastMock.info.mockClear()
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

  it('mount 后 DOM 含 rename model Select 且加载已配置模型', async () => {
    settingsMock.getRenameModel.mockResolvedValue({ model: 'zai-coding-cn/glm-5.3' })
    wrapper = mount(SystemAutoRenameSection, { props: { system: systemFixture() } })
    await flushPromises()
    expect(wrapper.find('[data-testid="setting-rename-model"]').exists()).toBe(true)
    expect(settingsMock.getRenameModel).toHaveBeenCalled()
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

  it('mount 后 DOM 含 rename-mode Select 且 getRenameMode 被调用', async () => {
    wrapper = mount(SystemAutoRenameSection, { props: { system: systemFixture() } })
    await flushPromises()
    expect(wrapper.find('[data-testid="setting-rename-mode"]').exists()).toBe(true)
    expect(settingsMock.getRenameMode).toHaveBeenCalled()
  })

  it('getRenameMode 返回 first-prompt 时 trigger 显示「首次请求时」', async () => {
    settingsMock.getRenameMode.mockResolvedValue({ mode: 'first-prompt' })
    wrapper = mount(SystemAutoRenameSection, { props: { system: systemFixture() } })
    await flushPromises()
    const trigger = wrapper.find('[data-testid="setting-rename-mode"]')
    expect(trigger.text()).toContain('首次请求时')
  })

  it('下拉含三模式选项；点选 agent 自主命名 → setRenameMode 收到 "agent-tool"', async () => {
    wrapper = mount(SystemAutoRenameSection, { props: { system: systemFixture() } })
    await flushPromises()

    // reka-ui SelectContent 仅 open 时挂载（teleport 到 body），happy-dom 需显式 dispatch
    const trigger = wrapper.find('[data-testid="setting-rename-mode"]').element as HTMLElement
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    trigger.click()
    await flushPromises()

    const options = document.body.querySelectorAll('[role="option"]')
    const labels = Array.from(options).map((el) => el.textContent ?? '')
    expect(labels).toContain('首次请求时')
    expect(labels).toContain('首轮回复完成')
    expect(labels).toContain('agent 自主命名')

    const target = Array.from(options).find((el) => (el.textContent ?? '').includes('agent 自主命名'))
    expect(target).toBeTruthy()
    target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    target!.click()
    await flushPromises()
    expect(settingsMock.setRenameMode).toHaveBeenCalledWith('agent-tool')
    // 开关开（默认 true）→ 原「已生效」文案（toast 分流的正向对照）
    expect(toastMock.info).toHaveBeenCalledWith(expect.stringContaining('已生效'))
  })

  it('renameModeHint 说明开关依赖：自动生成需开关开启，agent 自主命名不受限', async () => {
    wrapper = mount(SystemAutoRenameSection, { props: { system: systemFixture() } })
    await flushPromises()
    // D1 正交契约的用户可见边界：flag 只门控自动路径，agent-tool 工具面不受门控
    const text = wrapper.text()
    expect(text).toContain('需开启上方自动重命名开关')
    expect(text).toContain('不受该开关限制')
  })

  it('开关关 + 切自动模式 → 成功 toast 提示需开启开关（不承诺已生效）', async () => {
    settingsMock.getAutoRenameEnabled.mockResolvedValue({ enabled: false })
    wrapper = mount(SystemAutoRenameSection, { props: { system: systemFixture() } })
    await flushPromises()

    const trigger = wrapper.find('[data-testid="setting-rename-mode"]').element as HTMLElement
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    trigger.click()
    await flushPromises()

    const options = document.body.querySelectorAll('[role="option"]')
    const target = Array.from(options).find((el) => (el.textContent ?? '').includes('首次请求时'))
    expect(target).toBeTruthy()
    target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    target!.click()
    await flushPromises()

    expect(settingsMock.setRenameMode).toHaveBeenCalledWith('first-prompt')
    // 自动路径被 enabled flag 拦截——toast 不承诺「已生效」，指向恢复动作
    expect(toastMock.info).toHaveBeenCalledWith(expect.stringContaining('需开启上方自动重命名开关'))
  })

  it('auto-rename 开关关闭时 mode Select 仍可用（agent-tool 不受 flag 门控）', async () => {
    settingsMock.getAutoRenameEnabled.mockResolvedValue({ enabled: false })
    wrapper = mount(SystemAutoRenameSection, { props: { system: systemFixture() } })
    await flushPromises()
    const trigger = wrapper.find('[data-testid="setting-rename-mode"]')
    expect(trigger.attributes('disabled')).toBeUndefined()
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
