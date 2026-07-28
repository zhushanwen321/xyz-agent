/**
 * MobileFilesView 测试（P4-s4-w1 AC7 文件树只读渲染）。
 *
 * 验收：
 *  - mock fileTreeStore tree 后树结构渲染（dir/file 节点文本可见）
 *  - 无任何「新建/删除/重命名」按钮或 testid（只读断言，AC7）
 *  - 空态显示 mobile.files.empty
 *  - 展开/折叠递归渲染子节点
 *  - 点击文件节点 emit select(path)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import type { FileNode } from '@xyz-agent/shared'
import MobileFilesView from '../MobileFilesView.vue'

/** 构造 mock 文件树 fixture。 */
function mockTree(): FileNode[] {
  return [
    {
      path: '/proj/src',
      name: 'src',
      type: 'dir',
      children: [{ path: '/proj/src/a.ts', name: 'a.ts', type: 'file' }],
    },
    { path: '/proj/readme.md', name: 'readme.md', type: 'file' },
  ]
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('MobileFilesView（P4-s4-w1 AC7 文件树只读）', () => {
  it('mock tree 后树结构渲染（dir/file 节点文本可见）', async () => {
    const { useFileTreeStore } = await import('@/stores/fileTree')
    const store = useFileTreeStore()
    store.setTree('s1', mockTree())

    const wrapper = mount(MobileFilesView, { props: { sessionId: 's1' } })
    const tree = wrapper.find('[data-testid="mobile-files-tree"]')
    expect(tree.exists()).toBe(true)
    expect(tree.text()).toContain('src')
    expect(tree.text()).toContain('readme.md')
  })

  it('无新建/删除/重命名按钮（只读断言，AC7）', async () => {
    const { useFileTreeStore } = await import('@/stores/fileTree')
    const store = useFileTreeStore()
    store.setTree('s1', mockTree())

    const wrapper = mount(MobileFilesView, { props: { sessionId: 's1' } })
    const html = wrapper.html().toLowerCase()
    // 无 new/delete/rename 相关 testid 或 class
    expect(wrapper.find('[data-testid*="new"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid*="delete"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid*="rename"]').exists()).toBe(false)
    // 无原生表单提交/新建 input（只读树无输入）
    expect(html).not.toContain('新建')
    expect(html).not.toContain('删除')
  })

  it('空 tree（store 无 s1 tree）显示空态', () => {
    const wrapper = mount(MobileFilesView, { props: { sessionId: 's1' } })
    expect(wrapper.find('[data-testid="mobile-files-empty"]').exists()).toBe(true)
  })

  it('展开/折叠递归渲染子节点', async () => {
    const { useFileTreeStore } = await import('@/stores/fileTree')
    const store = useFileTreeStore()
    store.setTree('s1', mockTree())

    const wrapper = mount(MobileFilesView, { props: { sessionId: 's1' } })
    // 折叠态：src 子节点 a.ts 不可见
    expect(wrapper.text()).not.toContain('a.ts')

    // 点击 src 节点展开
    const srcNode = wrapper.find('[data-testid="mobile-file-node-/proj/src"]')
    expect(srcNode.exists()).toBe(true)
    await srcNode.trigger('click')
    expect(wrapper.text()).toContain('a.ts')

    // 再点折叠
    await srcNode.trigger('click')
    expect(wrapper.text()).not.toContain('a.ts')
  })

  it('点击文件节点 emit select(path)', async () => {
    const { useFileTreeStore } = await import('@/stores/fileTree')
    const store = useFileTreeStore()
    store.setTree('s1', mockTree())

    const wrapper = mount(MobileFilesView, { props: { sessionId: 's1' } })
    const fileNode = wrapper.find('[data-testid="mobile-file-node-/proj/readme.md"]')
    expect(fileNode.exists()).toBe(true)
    await fileNode.trigger('click')
    expect(wrapper.emitted('select')).toBeTruthy()
    expect(wrapper.emitted('select')![0]).toEqual(['/proj/readme.md'])
  })
})
