/**
 * AppShell 拓扑渲染 gate（review MF-5）：D-6 拓扑回填的回归防线。
 *
 * 覆盖（v6-spec-shell SSOT）：
 *  - 三个拓扑 testid 存在：app-shell / app-shell-aside / app-shell-main
 *  - 关键类：AppShell p-3（12px 四周统一）、aside pt-[52px]（traffic-light 安全区，恒定）、
 *    MainPanel rounded-[10px]（float-panel 圆角与窗口共线）
 *  - 折叠态 !gap-0（强制覆盖 gap-3），展开态无
 *  - TrafficLight 挂载在 AppShell 层（v6-spec-shell §3 修订②：aside 折叠归零不改定位基准、
 *    不被 overflow-hidden 裁剪），不在 aside 内
 *
 * Mock 策略（沿用 sidebar-layout / session-status-icons 既有模式，避免全局副作用）：
 *  - useSettingsShell 置空（AppShell 壳副作用，非拓扑被测面）
 *  - SettingsModal / Workspace / Overview / Sidebar stub（重组件依赖树，非拓扑被测面）
 *  - useSidebarNew stub（AppShell 仅消费 syncSessionToPanel）
 *  - 其余（AsideRegion / AppNavControls / TrafficLight / MainPanel + stores）走真实实现
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/shell/app-shell-topology.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

vi.mock('@/composables/shell/useSettingsShell', () => ({
  useSettingsShell: () => {},
}))
vi.mock('@/components/settings/SettingsModal.vue', () => ({
  default: { name: 'SettingsModal', template: '<div data-testid="settings-modal-stub" />' },
}))
vi.mock('@/components/workspace/Workspace.vue', () => ({
  default: { name: 'Workspace', template: '<div />' },
}))
vi.mock('@/components/overview/Overview.vue', () => ({
  default: { name: 'Overview', template: '<div />' },
}))
vi.mock('@/components/sidebar/Sidebar.vue', () => ({
  default: { name: 'Sidebar', template: '<div data-testid="sidebar-stub" />' },
}))
vi.mock('@/composables/features/sidebar/useSidebarNew', () => ({
  useSidebarNew: () => ({ syncSessionToPanel: vi.fn() }),
}))

import AppShell from '@/components/shell/AppShell.vue'
import { useSidebarStore } from '@/stores/sidebar'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('AppShell 拓扑渲染 gate（D-6 回填回归防线）', () => {
  it('展开态：三个拓扑 testid 存在 + 关键类（p-3 / aside pt-[52px] / main rounded-[10px]）', () => {
    const wrapper = mount(AppShell)

    // ① app-shell 根容器：p-3(12px) 四周统一 + relative 定位基准
    const shell = wrapper.find('[data-testid="app-shell"]')
    expect(shell.exists()).toBe(true)
    expect(shell.classes()).toContain('p-3')
    expect(shell.classes()).toContain('relative')

    // ② aside：pt-[52px] traffic-light 安全区恒定
    const aside = wrapper.find('[data-testid="app-shell-aside"]')
    expect(aside.exists()).toBe(true)
    expect(aside.classes()).toContain('pt-[52px]')

    // ③ main float-panel：rounded-[10px]（与窗口圆角共线）
    const main = wrapper.find('[data-testid="app-shell-main"]')
    expect(main.exists()).toBe(true)
    expect(main.classes()).toContain('rounded-[10px]')

    // 展开态无 !gap-0（gap-3 生效）
    expect(shell.classes()).not.toContain('!gap-0')
  })

  it('折叠态：AppShell 根容器加 !gap-0（强制覆盖 gap-3，aside 归零）', async () => {
    const sidebar = useSidebarStore()
    const wrapper = mount(AppShell)
    expect(wrapper.find('[data-testid="app-shell"]').classes()).not.toContain('!gap-0')

    sidebar.collapsed = true
    await nextTick()
    expect(wrapper.find('[data-testid="app-shell"]').classes()).toContain('!gap-0')
  })

  it('TrafficLight 挂载在 AppShell 层（aside 外）：折叠态不被 aside overflow-hidden 裁剪', async () => {
    const wrapper = mount(AppShell)
    const shell = wrapper.find('[data-testid="app-shell"]')

    // traffic-light 是 AppShell 直接子节点（与 AppNavControls 同层，v6-spec-shell §3 修订②）
    const tl = wrapper.find('.traffic-light')
    expect(tl.exists()).toBe(true)
    expect(tl.element.parentElement).toBe(shell.element)
    // 不在 aside 内（折叠态 aside overflow-hidden 会裁剪）
    expect(wrapper.find('[data-testid="app-shell-aside"] .traffic-light').exists()).toBe(false)
    // 折叠态依然存在于 DOM（aside 归零不影响挂载点）
    const sidebar = useSidebarStore()
    sidebar.collapsed = true
    await nextTick()
    expect(wrapper.find('.traffic-light').element.parentElement).toBe(
      wrapper.find('[data-testid="app-shell"]').element,
    )
  })
})
