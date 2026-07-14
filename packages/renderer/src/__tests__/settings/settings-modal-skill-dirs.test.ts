/**
 * SettingsModal skill/agent 目录更新错误处理测试（W2 · D10）。
 *
 * bug 根因：onUpdateSkillDirs/onUpdateAgentDirs 调 settingsStore.setSkillDirs(...)
 * 未 await 未 catch。store 内 await config.setSkillDirs 若 reject → unhandled rejection +
 * 静默失败（用户无反馈，discovery.json 未更新）。
 *
 * 验证（U5）：config.setSkillDirs reject 时，onUpdateSkillDirs 触发的 toast 含 error 条目
 * （非静默吞，符合 CLAUDE.md 规则 #3：错误必须反馈）。
 *
 * mock 策略：
 *  - vi.mock('@/api')：config.setSkillDirs reject；config.listProviders resolve（refreshProviders 不抛）。
 *  - vi.mock('@/i18n')：避免 setLocale 拉起实例。
 *  - SettingsModal open=true 时 onMounted 不拉数据（仅 watch open），故无需更多 mock。
 *  - 通过 findComponent(SettingsResourcePage) 直接 emit update-dirs，绕开 LoadPaths UI 深链。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/settings-modal-skill-dirs.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api', () => ({
  config: {
    setSkillDirs: vi.fn(() => Promise.reject(new Error('network down'))),
    setAgentDirs: vi.fn(() => Promise.reject(new Error('network down'))),
    listProviders: vi.fn(() => Promise.resolve([])),
  },
  settings: {
    getSystem: vi.fn(async () => ({ locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue' })),
    updateSystem: vi.fn(async () => {}),
  },
}))

vi.mock('@/i18n', () => ({ setLocale: vi.fn() }))

import SettingsModal from '@/components/settings/SettingsModal.vue'
import SettingsResourcePage from '@/components/settings/SettingsResourcePage.vue'
import type { SkillDirConfig } from '@xyz-agent/shared'
import { useToast } from '@/composables/useToast'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  // 清空全局 toasts（useToast 是模块级单例）
  const { toasts } = useToast()
  toasts.value = []
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('SettingsModal onUpdateSkillDirs 错误反馈（W2 D10）', () => {
  it('config.setSkillDirs reject → 触发 error toast（非静默失败）', async () => {
    wrapper = mount(SettingsModal, {
      props: { open: true },
      attachTo: document.body,
    })
    await flushPromises()

    // Dialog 内容经 reka-ui teleport 到 body，故从 document.body 查询。
    // 找到 skill 菜单按钮（含 'Skill' 文本的 nav 按钮）。
    const navButtons = Array.from(document.body.querySelectorAll('nav button'))
    const skillBtn = navButtons.find((b) => (b.textContent ?? '').includes('Skill'))
    expect(skillBtn).toBeTruthy()
    skillBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    // 找到 SettingsResourcePage 子组件（teleport 后仍在 wrapper 组件树内），直接 emit update-dirs。
    const resourcePage = wrapper.findComponent(SettingsResourcePage)
    expect(resourcePage.exists()).toBe(true)
    const dirs: SkillDirConfig[] = [{ path: '/x', enabled: true }]
    resourcePage.vm.$emit('update-dirs', dirs)
    await flushPromises()

    // 断言：error toast 已产生（非静默吞）
    const { toasts } = useToast()
    expect(toasts.value.some((t) => t.type === 'error')).toBe(true)
    expect(toasts.value.some((t) => t.message.includes('network down'))).toBe(true)
  })
})
