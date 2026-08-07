/**
 * MobileFilesView 测试（P4-s4-w1 AC7 文件树只读渲染）。
 *
 * 验收：
 *  - mock fileTreeStore tree 后树结构渲染（dir/file 节点文本可见）
 *  - 无任何「新建/删除/重命名」按钮或 testid（只读断言，AC7）
 *  - 空态显示 mobile.files.empty
 *  - 展开/折叠递归渲染子节点
 *  - 点击文件节点 emit select(path)
 *  - [Major1 fix] mount + sessionId 变化触发 fileApi.tree RPC（loadTree 链路）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import type { FileNode } from '@xyz-agent/shared'

// Mock fileApi.tree / gitApi.status（vi.hoisted 避免 TDZ；loadTree 调 fileApi.tree 触发 RPC）
// loadTree 内 Promise.allSettled([fileApi.tree, gitApi.status])，两域均需 mock 否则走 transport 报错。
const { treeMock, statusMock } = vi.hoisted(() => ({
  treeMock: vi.fn(() => Promise.resolve([] as FileNode[])),
  statusMock: vi.fn(() => Promise.resolve({ isRepo: false, files: [] })),
}))
vi.mock('@/api/domains/file', () => ({ tree: treeMock, expand: vi.fn() }))
vi.mock('@/api/domains/git', () => ({ status: statusMock }))

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
  treeMock.mockClear()
  statusMock.mockClear()
  treeMock.mockResolvedValue([])
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

  // ── [Major1 fix] loadTree 链路：mount + sessionId 变化触发 fileApi.tree RPC ──
  describe('loadTree 链路（Major1 fix：触发 fileApi.tree RPC）', () => {
    it('mount 时（sessionId 非空）触发 fileApi.tree RPC', async () => {
      // store 无缓存 → loadTree 发 RPC
      mount(MobileFilesView, { props: { sessionId: 's1' } })
      // loadTree 是 async（watch immediate 触发），等微任务
      await new Promise((r) => setTimeout(r, 0))

      expect(treeMock).toHaveBeenCalledWith('s1')
    })

    it('sessionId 变化时重触发 fileApi.tree RPC', async () => {
      treeMock.mockResolvedValue(mockTree())
      const wrapper = mount(MobileFilesView, { props: { sessionId: 's1' } })
      await new Promise((r) => setTimeout(r, 0))
      // s1 已缓存（treeMock resolve 后 setTree），切 s2 触发新 RPC
      wrapper.setProps({ sessionId: 's2' })
      await new Promise((r) => setTimeout(r, 0))

      expect(treeMock).toHaveBeenCalledWith('s2')
    })

    it('store 已缓存时不重复发 RPC（loadTree 缓存复用）', async () => {
      const { useFileTreeStore } = await import('@/stores/fileTree')
      const store = useFileTreeStore()
      store.setTree('cached', mockTree()) // 预置缓存

      mount(MobileFilesView, { props: { sessionId: 'cached' } })
      await new Promise((r) => setTimeout(r, 0))

      // 已缓存 → loadTree 走 rehydrate 分支，不调 fileApi.tree
      expect(treeMock).not.toHaveBeenCalled()
    })
  })
})
