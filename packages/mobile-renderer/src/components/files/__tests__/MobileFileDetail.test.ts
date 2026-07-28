/**
 * MobileFileDetail + FilesTab 文件内容查看测试（P4 D6 spec §二/§九）。
 *
 * 覆盖：
 * - MobileFileDetail：mount 渲染 header（返回按钮 + 文件名）+ DetailPane（stub 验证挂载）
 * - MobileFileDetail：返回按钮 emit back
 * - MobileFileDetail：文件名取 store.selectedPath 的 basename
 * - FilesTab：无 session → selectSession 提示；有 session → MobileFilesView；选文件后 → MobileFileDetail；返回 → MobileFilesView
 * - FilesTab 端到端：点 MobileFilesView 文件节点 → 经 fileTreeStore.selectFile → 切到 MobileFileDetail
 *
 * DetailPane 自身渲染（code/markdown/image via signUrl/diff）由 __tests__/panel/DetailPane.test.ts 覆盖（copy 自 renderer），
 * 此处 stub DetailPane 避免重复其内部 mock 矩阵，聚焦 MobileFileDetail wrapper 行为。
 *
 * 运行：cd packages/mobile-renderer && npx vitest run src/components/files/__tests__/MobileFileDetail.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import type { FileNode } from '@xyz-agent/shared'

// Stub DetailPane（重量级组件，自有独立测试），验证 MobileFileDetail 挂载它 + 透传 sessionId
vi.mock('@/components/panel/DetailPane.vue', () => ({
  default: {
    name: 'DetailPane',
    template: '<div data-testid="detail-pane-stub" />',
    props: ['sessionId'],
  },
}))

// Mock fileApi.tree / gitApi.status（MobileFilesView mount 时 loadTree 触发）
const { treeMock, statusMock } = vi.hoisted(() => ({
  treeMock: vi.fn(() => Promise.resolve([] as FileNode[])),
  statusMock: vi.fn(() => Promise.resolve({ isRepo: false, files: [] })),
}))
vi.mock('@/api/domains/file', () => ({ tree: treeMock, expand: vi.fn() }))
vi.mock('@/api/domains/git', () => ({ status: statusMock }))

beforeEach(() => {
  setActivePinia(createPinia())
  treeMock.mockClear()
  statusMock.mockClear()
  treeMock.mockResolvedValue([])
})

describe('MobileFileDetail wrapper（P4 D6 文件内容查看）', () => {
  it('mount 渲染 header（返回按钮 + 文件名）+ DetailPane', async () => {
    const { useFileTreeStore } = await import('@/stores/fileTree')
    const store = useFileTreeStore()
    store.selectFile('/proj/src/index.ts')

    const MobileFileDetail = (await import('../MobileFileDetail.vue')).default
    const wrapper = mount(MobileFileDetail, { props: { sessionId: 's1' } })

    // header 存在 + 返回按钮存在
    expect(wrapper.find('[data-testid="mobile-file-detail-header"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-file-detail-back"]').exists()).toBe(true)
    // 文件名取 basename（selectedPath 的最后一段）
    expect(wrapper.text()).toContain('index.ts')
    // DetailPane 被挂载（stub 验证）
    expect(wrapper.find('[data-testid="detail-pane-stub"]').exists()).toBe(true)
  })

  it('返回按钮 emit back', async () => {
    const MobileFileDetail = (await import('../MobileFileDetail.vue')).default
    const wrapper = mount(MobileFileDetail, { props: { sessionId: 's1' } })

    await wrapper.find('[data-testid="mobile-file-detail-back"]').trigger('click')
    expect(wrapper.emitted('back')).toBeTruthy()
    expect(wrapper.emitted('back')).toHaveLength(1)
  })

  it('无选中文件时文件名为空（header 仍渲染）', async () => {
    const MobileFileDetail = (await import('../MobileFileDetail.vue')).default
    const wrapper = mount(MobileFileDetail, { props: { sessionId: 's1' } })

    // header 仍渲染（DetailPane 自身有空态）
    expect(wrapper.find('[data-testid="mobile-file-detail-header"]').exists()).toBe(true)
    // fileName 为空串（无 selectedPath），header 不含 basename 文本干扰
    const back = wrapper.find('[data-testid="mobile-file-detail-back"]')
    expect(back.exists()).toBe(true)
  })

  it('DetailPane 接收 sessionId prop', async () => {
    const MobileFileDetail = (await import('../MobileFileDetail.vue')).default
    const wrapper = mount(MobileFileDetail, { props: { sessionId: 'sess-xyz' } })

    const detailPane = wrapper.find('[data-testid="detail-pane-stub"]')
    expect(detailPane.exists()).toBe(true)
    // stub 透传了 sessionId（验证 prop binding，findComponent 取 vm props）
    const detailPaneComp = wrapper.findComponent({ name: 'DetailPane' })
    expect(detailPaneComp.exists()).toBe(true)
    expect(detailPaneComp.props('sessionId')).toBe('sess-xyz')
  })
})

describe('FilesTab tree ↔ detail 状态机（P4 D6）', () => {
  it('无 session → selectSession 提示，不渲染 MobileFilesView/MobileFileDetail', async () => {
    const FilesTab = (await import('../FilesTab.vue')).default
    const wrapper = mount(FilesTab, { props: { sessionId: null } })

    expect(wrapper.find('[data-testid="mobile-files-select-session"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-files-view"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-file-detail"]').exists()).toBe(false)
  })

  it('有 session + 未选文件 → MobileFilesView（文件树态）', async () => {
    const FilesTab = (await import('../FilesTab.vue')).default
    const wrapper = mount(FilesTab, { props: { sessionId: 's1' } })

    expect(wrapper.find('[data-testid="mobile-files-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-file-detail"]').exists()).toBe(false)
  })

  it('点文件节点 → 经 selectFile → 切到 MobileFileDetail（端到端）', async () => {
    const { useFileTreeStore } = await import('@/stores/fileTree')
    const store = useFileTreeStore()
    store.setTree('s1', [
      { path: '/proj/readme.md', name: 'readme.md', type: 'file' },
    ])

    const FilesTab = (await import('../FilesTab.vue')).default
    const wrapper = mount(FilesTab, { props: { sessionId: 's1' } })

    // 初始：文件树态
    expect(wrapper.find('[data-testid="mobile-files-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-file-detail"]').exists()).toBe(false)

    // 点文件节点 → MobileFilesView 内调 selectFile + emit select → FilesTab 切 detail 态
    const fileNode = wrapper.find('[data-testid="mobile-file-node-/proj/readme.md"]')
    expect(fileNode.exists()).toBe(true)
    await fileNode.trigger('click')

    // 切到 MobileFileDetail
    expect(wrapper.find('[data-testid="mobile-file-detail"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-files-view"]').exists()).toBe(false)
    // store.selectedPath 被设置（DetailPane 经 useDetailPane watch 会加载该文件）
    expect(store.selectedPath).toBe('/proj/readme.md')
  })

  it('MobileFileDetail 返回 → 回到文件树态', async () => {
    const { useFileTreeStore } = await import('@/stores/fileTree')
    const store = useFileTreeStore()
    store.setTree('s1', [
      { path: '/proj/readme.md', name: 'readme.md', type: 'file' },
    ])

    const FilesTab = (await import('../FilesTab.vue')).default
    const wrapper = mount(FilesTab, { props: { sessionId: 's1' } })

    // 进 detail 态
    await wrapper.find('[data-testid="mobile-file-node-/proj/readme.md"]').trigger('click')
    expect(wrapper.find('[data-testid="mobile-file-detail"]').exists()).toBe(true)

    // 点返回按钮 → 回文件树态
    await wrapper.find('[data-testid="mobile-file-detail-back"]').trigger('click')
    expect(wrapper.find('[data-testid="mobile-files-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-file-detail"]').exists()).toBe(false)
  })
})
