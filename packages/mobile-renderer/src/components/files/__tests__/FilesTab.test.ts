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
})
