/**
 * MobileShell + BottomTabBar 测试（P4-s2-w1 AC4，s3-w1 更新：sessions tab 现渲染 SessionsTab）。
 *
 * 验收：
 *  - mount MobileShell 断言底部三 tab（Sessions/Files/Settings）DOM 存在
 *  - 点击 tab 切换 activeTab（DOM 断言 content 区域切换）
 *  - mobile-header + mobile-content 区域存在
 *
 * s3-w1 更新：sessions tab content 从占位文本改为 SessionsTab（读 session store），需 setActivePinia。
 * s4-w1 更新：files tab content 从占位文本改为 FilesTab（接 currentSessionId），新增 files 分支集成测试。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import type { FileNode } from '@xyz-agent/shared'
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

  it('点击 Files tab 切换 activeTab，content 切换到 files（无 session 时 FilesTab 显示 selectSession 提示）', async () => {
    const wrapper = mount(MobileShell)
    await wrapper.find('[data-testid="mobile-tab-files"]').trigger('click')
    expect(wrapper.find('[data-testid="mobile-tab-content-files"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-tab-content-sessions"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-tab-files"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.find('[data-testid="mobile-tab-sessions"]').attributes('aria-selected')).toBe('false')
    // s4-w1：无 currentSessionId 时 FilesTab 显示 selectSession 提示（非占位文本 "files"）
    expect(wrapper.find('[data-testid="mobile-files-select-session"]').exists()).toBe(true)
  })

  it('s4-w1 TC7: Files tab 无 session 时显示 selectSession 提示', async () => {
    const wrapper = mount(MobileShell)
    await wrapper.find('[data-testid="mobile-tab-files"]').trigger('click')
    expect(wrapper.find('[data-testid="mobile-files-select-session"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-files-view"]').exists()).toBe(false)
  })

  it('s4-w1 TC8: SessionsTab 选中 session 后切 files tab，透传 currentSessionId 渲染 MobileFilesView', async () => {
    const { useFileTreeStore } = await import('@/stores/fileTree')
    const { useSessionStore } = await import('@/stores/session')
    // 灌 session（让 MobileSessionList 渲染可点击项）
    const sessionStore = useSessionStore()
    sessionStore.setGroups([
      {
        cwd: '/proj',
        sessions: [{ id: 's1', label: 'feat', cwd: '/proj', state: 'idle' } as never],
      },
    ])
    // 灌文件树（让 FilesTab 渲染 MobileFilesView 树）
    const fileTreeStore = useFileTreeStore()
    const tree: FileNode[] = [{ path: '/proj/readme.md', name: 'readme.md', type: 'file' }]
    fileTreeStore.setTree('s1', tree)

    const wrapper = mount(MobileShell)
    // sessions tab 默认态：点击 session 项 → SessionsTab emit select → currentSessionId 透传
    await wrapper.find('[data-testid="mobile-session-item-s1"]').trigger('click')
    // 切到 files tab
    await wrapper.find('[data-testid="mobile-tab-files"]').trigger('click')
    // files tab 应渲染 MobileFilesView（currentSessionId 透传成功）
    expect(wrapper.find('[data-testid="mobile-files-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-files-select-session"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-files-tree"]').exists()).toBe(true)
  })

  it('点击 Settings tab 切换 activeTab，content 切换到 settings 占位', async () => {
    const wrapper = mount(MobileShell)
    await wrapper.find('[data-testid="mobile-tab-settings"]').trigger('click')
    expect(wrapper.find('[data-testid="mobile-tab-content-settings"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-tab-settings"]').attributes('aria-selected')).toBe('true')
  })
})
