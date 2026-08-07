/**
 * FilesTab 测试（P4-s4-w1 Files tab 接入 shell）。
 *
 * 验收：
 *  - sessionId=null 显示 selectSession 提示，不渲染 MobileFilesView
 *  - sessionId 非空 + store setTree 后渲染 MobileFilesView（树可见）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import type { FileNode } from '@xyz-agent/shared'
import FilesTab from '../FilesTab.vue'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('FilesTab（P4-s4-w1 Files tab 接入 shell）', () => {
  it('sessionId=null 显示 selectSession 提示，不渲染 MobileFilesView', () => {
    const wrapper = mount(FilesTab, { props: { sessionId: null } })
    expect(wrapper.find('[data-testid="mobile-files-select-session"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-files-view"]').exists()).toBe(false)
  })

  it('sessionId 非空 + store setTree 后渲染 MobileFilesView（树可见）', async () => {
    const { useFileTreeStore } = await import('@/stores/fileTree')
    const store = useFileTreeStore()
    const tree: FileNode[] = [
      { path: '/p/src', name: 'src', type: 'dir' },
      { path: '/p/readme.md', name: 'readme.md', type: 'file' },
    ]
    store.setTree('s1', tree)

    const wrapper = mount(FilesTab, { props: { sessionId: 's1' } })
    expect(wrapper.find('[data-testid="mobile-files-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-files-tree"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('src')
    expect(wrapper.text()).toContain('readme.md')
  })

  it('切 session 时重置 showDetail + 清全局 selectedPath（避免上一 session 脏态）', async () => {
    const { useFileTreeStore } = await import('@/stores/fileTree')
    const store = useFileTreeStore()
    store.setTree('s1', [{ path: '/p/a.md', name: 'a.md', type: 'file' }])
    store.setTree('s2', [{ path: '/p/b.md', name: 'b.md', type: 'file' }])

    const wrapper = mount(FilesTab, { props: { sessionId: 's1' } })
    // 点文件进 detail 态（MobileFilesView 写 store.selectedPath + emit select）
    await wrapper.find('[data-testid="mobile-file-node-/p/a.md"]').trigger('click')
    expect(wrapper.find('[data-testid="mobile-file-detail"]').exists()).toBe(true)
    // setup store 经 pinia 访问时 ref 自动解包，故直接读 store.selectedPath（无 .value）
    expect(store.selectedPath).toBe('/p/a.md')

    // 切 session：showDetail 应回 false，selectedPath 应清空（不再渲染旧 session 的 detail）
    await wrapper.setProps({ sessionId: 's2' })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="mobile-files-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-file-detail"]').exists()).toBe(false)
    expect(store.selectedPath).toBeNull()
  })
})
