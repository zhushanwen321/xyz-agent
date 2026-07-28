/**
 * MobileShell + BottomTabBar 测试（P4-s2-w1 AC4，s3-w1 更新：sessions tab 现渲染 SessionsTab）。
 *
 * 验收：
 *  - mount MobileShell 断言底部三 tab（Sessions/Files/Settings）DOM 存在
 *  - 点击 tab 切换 activeTab（DOM 断言 content 区域切换）
 *  - mobile-header + mobile-content 区域存在
 *
 * s3-w1 更新：sessions tab content 从占位文本改为 SessionsTab（读 session store），需 setActivePinia。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import MobileShell from '../MobileShell.vue'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('MobileShell + BottomTabBar（P4-s2-w1 AC4）', () => {
  it('mount 后底部三 tab（Sessions/Files/Settings）DOM 存在', () => {
    const wrapper = mount(MobileShell)
    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs).toHaveLength(3)
    expect(wrapper.find('[data-testid="mobile-tab-sessions"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-tab-files"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-tab-settings"]').exists()).toBe(true)
    // tab 文案（i18n zh-CN）
    expect(wrapper.text()).toContain('会话')
    expect(wrapper.text()).toContain('文件')
    expect(wrapper.text()).toContain('设置')
  })

  it('mount 后 header + content 区域存在', () => {
    const wrapper = mount(MobileShell)
    expect(wrapper.find('[data-testid="mobile-header"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-content"]').exists()).toBe(true)
  })

  it('默认 activeTab=sessions，content 渲染 SessionsTab（mobile-session-list 存在）', () => {
    const wrapper = mount(MobileShell)
    // sessions tab 渲染 SessionsTab（s3-w1：含 MobileSessionList）
    expect(wrapper.find('[data-testid="mobile-tab-content-sessions"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-session-list"]').exists()).toBe(true)
    // sessions tab aria-selected=true
    expect(wrapper.find('[data-testid="mobile-tab-sessions"]').attributes('aria-selected')).toBe('true')
  })

  it('点击 Files tab 切换 activeTab，content 切换到 files 占位', async () => {
    const wrapper = mount(MobileShell)
    await wrapper.find('[data-testid="mobile-tab-files"]').trigger('click')
    expect(wrapper.find('[data-testid="mobile-tab-content-files"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-tab-content-sessions"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-tab-files"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.find('[data-testid="mobile-tab-sessions"]').attributes('aria-selected')).toBe('false')
  })

  it('点击 Settings tab 切换 activeTab，content 切换到 settings 占位', async () => {
    const wrapper = mount(MobileShell)
    await wrapper.find('[data-testid="mobile-tab-settings"]').trigger('click')
    expect(wrapper.find('[data-testid="mobile-tab-content-settings"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-tab-settings"]').attributes('aria-selected')).toBe('true')
  })
})
