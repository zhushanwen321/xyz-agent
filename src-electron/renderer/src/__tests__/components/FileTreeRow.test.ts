/**
 * FileTreeRow 组件渲染测试（#4，[HISTORICAL] 三视角防护）。
 *
 * 防护的事故：v-if/v-else 链断裂导致折叠目录被同时渲染为「目录行 + 同名文件行」，
 * 77 单测 + 集成全绿但用户打开发现「同名文件打不开」。根因是只有 store/composable
 * 白盒测试，缺组件渲染断言。本测试补「观察者 + 使用者」视角。
 *
 * 覆盖：
 * - 折叠目录：只渲染 dir 行，不存在同名 file 行（本次 bug 回归防护）
 * - 文件节点：只渲染 file 行，不存在 dir 行
 * - 展开目录（isExpanded）：子节点出现
 * - 字号一致性（D-007）：dir/file 行 name span 均含 text-[12px]
 * - chevron 槽（D-022）：dir 行含 ChevronRight，file 行含空占位
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/components/FileTreeRow.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import FileTreeRow from '@/components/sidebar/FileTreeRow.vue'
import { useFileTreeStore } from '@/stores/fileTree'
import type { FileNode } from '@xyz-agent/shared'

// mock 重依赖 composable（FileTreeRow 调 useFileTree.expandNode/collapseNode/selectFile + useSideDrawer.open）
const mockExpandNode = vi.fn()
const mockCollapseNode = vi.fn()
const mockSelectFile = vi.fn()
vi.mock('@/composables/features/useFileTree', () => ({
  useFileTree: () => ({
    expandNode: mockExpandNode,
    collapseNode: mockCollapseNode,
    selectFile: mockSelectFile,
  }),
}))
vi.mock('@/composables/features/useSideDrawer', () => ({
  useSideDrawer: () => ({ open: vi.fn() }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/** mount FileTreeRow；默认 stub 掉自身递归（防子节点干扰单行断言），可通过 opts 关闭 */
function mountRow(opts: {
  node: FileNode
  depth?: number
  sessionId?: string
  expanded?: boolean
  stubSelf?: boolean
}) {
  const store = useFileTreeStore()
  // 预置展开态到 store（isExpanded 从 store.getExpanded 读）
  if (opts.expanded) store.addExpanded(opts.sessionId ?? 's1', opts.node.path)
  return mount(FileTreeRow, {
    props: {
      node: opts.node,
      depth: opts.depth ?? 0,
      sessionId: opts.sessionId ?? 's1',
    },
    global: {
      stubs: opts.stubSelf === false ? {} : { FileTreeRow: true },
    },
  })
}

describe('FileTreeRow v-if/v-else 链断裂回归防护', () => {
  it('折叠目录：只渲染 dir 行，不渲染同名 file 行（事故根因）', () => {
    const node: FileNode = { path: '.agents', name: '.agents', type: 'dir' }
    const wrapper = mountRow({ node, expanded: false })

    expect(wrapper.find('[data-testid="file-tree-dir-.agents"]').exists()).toBe(true)
    // 关键回归断言：折叠目录绝不能额外渲染同名 file 行
    expect(wrapper.find('[data-testid="file-tree-file-.agents"]').exists()).toBe(false)
  })

  it('展开目录：仍只渲染 dir 行，不渲染同名 file 行', () => {
    const node: FileNode = {
      path: 'src',
      name: 'src',
      type: 'dir',
      children: [{ path: 'src/a.ts', name: 'a.ts', type: 'file' }],
    }
    const wrapper = mountRow({ node, expanded: true, stubSelf: true })

    expect(wrapper.find('[data-testid="file-tree-dir-src"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-tree-file-src"]').exists()).toBe(false)
  })

  it('文件节点：只渲染 file 行，不渲染 dir 行', () => {
    const node: FileNode = { path: 'a.ts', name: 'a.ts', type: 'file' }
    const wrapper = mountRow({ node })

    expect(wrapper.find('[data-testid="file-tree-file-a.ts"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-tree-dir-a.ts"]').exists()).toBe(false)
  })
})

describe('FileTreeRow 展开态子节点渲染', () => {
  it('目录展开 + 子节点存在 → 渲染子行（stub 自身时子行以 stub 形式存在）', () => {
    const node: FileNode = {
      path: 'src',
      name: 'src',
      type: 'dir',
      children: [{ path: 'src/a.ts', name: 'a.ts', type: 'file' }],
    }
    // 关闭自身 stub，让子 FileTreeRow 真实渲染
    const wrapper = mountRow({ node, expanded: true, stubSelf: false })

    expect(wrapper.find('[data-testid="file-tree-dir-src"]').exists()).toBe(true)
    // 子文件行真实渲染（递归一层，子为 file 走 v-else）
    expect(wrapper.find('[data-testid="file-tree-file-src/a.ts"]').exists()).toBe(true)
  })

  it('目录折叠 → 子节点不渲染', () => {
    const node: FileNode = {
      path: 'src',
      name: 'src',
      type: 'dir',
      children: [{ path: 'src/a.ts', name: 'a.ts', type: 'file' }],
    }
    const wrapper = mountRow({ node, expanded: false, stubSelf: false })

    expect(wrapper.find('[data-testid="file-tree-dir-src"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-tree-file-src/a.ts"]').exists()).toBe(false)
  })
})

describe('FileTreeRow 视觉一致性（D-007 字号 / D-022 chevron 槽）', () => {
  it('目录行字号 12px + font-mono（D-007：文件树 12px，字号在行容器上供 name span 继承）', () => {
    const node: FileNode = { path: 'src', name: 'src', type: 'dir' }
    const wrapper = mountRow({ node })
    const dirRow = wrapper.find('[data-testid="file-tree-dir-src"]')
    expect(dirRow.classes()).toContain('text-[12px]')
    expect(dirRow.classes()).toContain('font-mono')
  })

  it('文件行字号 12px + font-mono', () => {
    const node: FileNode = { path: 'a.ts', name: 'a.ts', type: 'file' }
    const wrapper = mountRow({ node })
    // 文件行字号在 name span 上（文件行容器无字号 class，name span 自带 font-mono text-[12px]）
    const nameSpan = wrapper.find('[data-testid="file-tree-file-a.ts"] .flex-1')
    expect(nameSpan.classes()).toContain('text-[12px]')
    expect(nameSpan.classes()).toContain('font-mono')
  })

  it('目录行与文件行渲染字号一致（D-007：均 12px，不再 11/12 混用）', () => {
    const dirNode: FileNode = { path: 'src', name: 'src', type: 'dir' }
    const fileNode: FileNode = { path: 'a.ts', name: 'a.ts', type: 'file' }
    const dirWrapper = mountRow({ node: dirNode })
    const fileWrapper = mountRow({ node: fileNode })

    const dirRow = dirWrapper.find('[data-testid="file-tree-dir-src"]')
    const fileNameSpan = fileWrapper.find('[data-testid="file-tree-file-a.ts"] .flex-1')
    // 两处都声明 12px（目录在行容器、文件在 name span），均不含旧的 11px
    expect(dirRow.classes()).toContain('text-[12px]')
    expect(dirRow.classes()).not.toContain('text-[11px]')
    expect(fileNameSpan.classes()).toContain('text-[12px]')
    expect(fileNameSpan.classes()).not.toContain('text-[11px]')
  })

  it('目录行 padding-left 用单一公式 depth*14+8（D-022，非文件行 +10 补偿）', () => {
    const node: FileNode = { path: 'src', name: 'src', type: 'dir' }
    const wrapper = mountRow({ node, depth: 2 })
    const dirRow = wrapper.find('[data-testid="file-tree-dir-src"]')
    expect((dirRow.element as HTMLElement).style.paddingLeft).toBe('36px') // 2*14+8
  })

  it('文件行与目录行同 depth 的 padding-left 一致（icon 垂直对齐前提）', () => {
    const dirNode: FileNode = { path: 'src', name: 'src', type: 'dir' }
    const fileNode: FileNode = { path: 'a.ts', name: 'a.ts', type: 'file' }
    const dirWrapper = mountRow({ node: dirNode, depth: 1 })
    const fileWrapper = mountRow({ node: fileNode, depth: 1 })

    const dirPad = (dirWrapper.find('[data-testid="file-tree-dir-src"]').element as HTMLElement).style.paddingLeft
    const filePad = (fileWrapper.find('[data-testid="file-tree-file-a.ts"]').element as HTMLElement).style.paddingLeft
    expect(dirPad).toBe(filePad) // 同 depth 同 padding，不再 +10 补偿
  })

  it('目录行 chevron 槽含 ChevronRight（可展开指示）', () => {
    const node: FileNode = { path: 'src', name: 'src', type: 'dir' }
    const wrapper = mountRow({ node })
    // chevron-slot 内有 svg（lucide ChevronRight 渲染为 svg）
    const chevronSlot = wrapper.find('[data-testid="file-tree-dir-src"] [data-testid="chevron-slot"]')
    expect(chevronSlot.exists()).toBe(true)
    expect(chevronSlot.find('svg').exists()).toBe(true)
  })

  it('文件行 chevron 槽为空占位（无 svg，宽度对齐目录）', () => {
    const node: FileNode = { path: 'a.ts', name: 'a.ts', type: 'file' }
    const wrapper = mountRow({ node })
    const chevronSlot = wrapper.find('[data-testid="file-tree-file-a.ts"] [data-testid="chevron-slot"]')
    expect(chevronSlot.exists()).toBe(true)
    expect(chevronSlot.find('svg').exists()).toBe(false) // 空占位
  })
})

describe('FileTreeRow 交互', () => {
  it('点折叠目录 → expandNode 被调', async () => {
    const node: FileNode = { path: 'src', name: 'src', type: 'dir' }
    const wrapper = mountRow({ node, expanded: false })
    await wrapper.find('[data-testid="file-tree-dir-src"]').trigger('click')
    expect(mockExpandNode).toHaveBeenCalledWith('s1', 'src')
    expect(mockCollapseNode).not.toHaveBeenCalled()
  })

  it('点展开目录 → collapseNode 被调', async () => {
    const node: FileNode = { path: 'src', name: 'src', type: 'dir' }
    const wrapper = mountRow({ node, expanded: true })
    await wrapper.find('[data-testid="file-tree-dir-src"]').trigger('click')
    expect(mockCollapseNode).toHaveBeenCalledWith('s1', 'src')
    expect(mockExpandNode).not.toHaveBeenCalled()
  })

  it('点文件 → selectFile 被调', async () => {
    const node: FileNode = { path: 'a.ts', name: 'a.ts', type: 'file' }
    const wrapper = mountRow({ node })
    await wrapper.find('[data-testid="file-tree-file-a.ts"]').trigger('click')
    expect(mockSelectFile).toHaveBeenCalledWith('a.ts')
  })
})
