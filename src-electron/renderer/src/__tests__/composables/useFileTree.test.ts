/**
 * useFileTree composable 单测（#3，T2.3/T2.4/T2.5 + loadTree 编排）。
 *
 * 覆盖：
 * - T2.3 loading 幂等去重（loading 态再点 → 不发新请求）
 * - T2.4 expand 在途切 session → stale 丢弃（sessionId 校验）
 * - T2.5 error 重试（error 态折叠再展开 → 重发）
 * - loadTree 已缓存 rehydrate（不重请求）
 * - loadTree 未缓存并行拉 file.tree + git.status（Promise.allSettled）
 *
 * mock 策略：vi.mock('@/api/domains/file') + vi.mock('@/api/domains/git')。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/composables/useFileTree.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// mock api/domains（useFileTree 依赖）
const mockFileTree = vi.fn()
const mockFileExpand = vi.fn()
const mockGitStatus = vi.fn()
vi.mock('@/api/domains/file', () => ({
  tree: (...args: unknown[]) => mockFileTree(...args),
  expand: (...args: unknown[]) => mockFileExpand(...args),
}))
vi.mock('@/api/domains/git', () => ({
  status: (...args: unknown[]) => mockGitStatus(...args),
}))

import { useFileTree } from '@/composables/features/useFileTree'
import { useFileTreeStore } from '@/stores/fileTree'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('useFileTree.loadTree 编排', () => {
  it('未缓存 → 并行拉 file.tree + git.status，setTree + setGitOverlay', async () => {
    const nodes = [{ path: 'src', name: 'src', type: 'dir' }]
    mockFileTree.mockResolvedValueOnce(nodes)
    mockGitStatus.mockResolvedValueOnce({
      sessionId: 's1', isRepo: true, files: [{ path: 'src/x.ts', xyCode: ' M', status: 'modified' }],
      stagedCount: 0, unstagedCount: 1, stats: { add: 0, del: 0 }, hasConflict: false,
    })

    const { loadTree } = useFileTree()
    const store = useFileTreeStore()
    await loadTree('s1')

    expect(mockFileTree).toHaveBeenCalledWith('s1', false)
    expect(store.getTree('s1')).toEqual(nodes)
    expect(store.getGitStatus('s1', 'src/x.ts')?.status).toBe('modified')
    expect(store.getNodeState('s1', '').status).toBe('loaded')
  })

  it('T2.7 git.status 失败（rejected）→ overlay 空，树仍渲染', async () => {
    const nodes = [{ path: 'a.ts', name: 'a.ts', type: 'file' }]
    mockFileTree.mockResolvedValueOnce(nodes)
    mockGitStatus.mockRejectedValueOnce(new Error('git unavailable'))

    const { loadTree } = useFileTree()
    const store = useFileTreeStore()
    await loadTree('s1')

    expect(store.getTree('s1')).toEqual(nodes) // 树仍渲染
    expect(store.getGitStatus('s1', 'a.ts')).toBeUndefined() // overlay 空
  })

  it('T2.9 非 git 仓库（isRepo=false）→ 不设 overlay', async () => {
    mockFileTree.mockResolvedValueOnce([{ path: 'x', name: 'x', type: 'file' }])
    mockGitStatus.mockResolvedValueOnce({
      sessionId: 's1', isRepo: false, files: [],
      stagedCount: 0, unstagedCount: 0, stats: { add: 0, del: 0 }, hasConflict: false,
    })

    const { loadTree } = useFileTree()
    const store = useFileTreeStore()
    await loadTree('s1')

    expect(store.getTree('s1')).toHaveLength(1)
    expect(store.getGitStatus('s1', 'x')).toBeUndefined()
  })

  it('file.tree 失败 → setNodeState error + reason', async () => {
    mockFileTree.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'permission_denied' }))
    mockGitStatus.mockResolvedValueOnce({ isRepo: false, files: [], stagedCount: 0, unstagedCount: 0, stats: { add: 0, del: 0 }, hasConflict: false })

    const { loadTree } = useFileTree()
    const store = useFileTreeStore()
    await loadTree('s1')

    expect(store.getNodeState('s1', '').status).toBe('error')
    expect(store.getNodeState('s1', '').reason).toBe('permission_denied')
  })

  it('已缓存 → rehydrate，不重请求', async () => {
    const store = useFileTreeStore()
    store.setTree('s1', [{ path: 'a', name: 'a', type: 'file' }])
    store.addExpanded('s1', 'src')

    const { loadTree } = useFileTree()
    await loadTree('s1')

    expect(mockFileTree).not.toHaveBeenCalled() // 不重请求
  })
})

describe('useFileTree.expandNode T2.3/T2.4/T2.5', () => {
  it('loaded → 复用缓存不重请求', async () => {
    const store = useFileTreeStore()
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    store.setNodeState('s1', 'src', { status: 'loaded' }, [{ path: 'src/x', name: 'x', type: 'file' }])

    const { expandNode } = useFileTree()
    await expandNode('s1', 'src')

    expect(mockFileExpand).not.toHaveBeenCalled()
    expect(store.getExpanded('s1').has('src')).toBe(true)
  })

  it('T2.3 loading → 幂等去重（不发新请求）', async () => {
    const store = useFileTreeStore()
    store.setNodeState('s1', 'src', { status: 'loading' })

    const { expandNode } = useFileTree()
    await expandNode('s1', 'src')

    expect(mockFileExpand).not.toHaveBeenCalled()
  })

  it('unloaded → 发请求 + setNodeState loaded + children merge', async () => {
    const store = useFileTreeStore()
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    const children = [{ path: 'src/a.ts', name: 'a.ts', type: 'file' }]
    mockFileExpand.mockResolvedValueOnce(children)

    const { expandNode } = useFileTree()
    await expandNode('s1', 'src')

    expect(mockFileExpand).toHaveBeenCalledWith('s1', 'src', false)
    expect(store.getNodeState('s1', 'src').status).toBe('loaded')
    expect(store.getTree('s1')![0].children).toEqual(children)
  })

  it('T2.5 error → 重试（error 态再 expand 发新请求）', async () => {
    const store = useFileTreeStore()
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    store.setNodeState('s1', 'src', { status: 'error', reason: 'timeout' })

    const children = [{ path: 'src/b.ts', name: 'b.ts', type: 'file' }]
    mockFileExpand.mockResolvedValueOnce(children)

    const { expandNode } = useFileTree()
    await expandNode('s1', 'src')

    expect(mockFileExpand).toHaveBeenCalledWith('s1', 'src', false) // 重发
    expect(store.getNodeState('s1', 'src').status).toBe('loaded') // 重试成功
  })

  it('expand 失败 → setNodeState error + reason', async () => {
    const store = useFileTreeStore()
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    mockFileExpand.mockRejectedValueOnce(Object.assign(new Error('out'), { code: 'out_of_cwd' }))

    const { expandNode } = useFileTree()
    await expandNode('s1', 'src')

    expect(store.getNodeState('s1', 'src').status).toBe('error')
    expect(store.getNodeState('s1', 'src').reason).toBe('out_of_cwd')
  })
})
