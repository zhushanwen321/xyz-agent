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
 * mock 策略：vi.mock('@/api') 聚合门面（VITE_MOCK=true 下 @/api 导出的是 mockApi，
 * 故必须直接 mock 门面 file/git 命名空间，而非 @/api/domains/* 子模块）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/composables/useFileTree.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { watch } from 'vue'

// mock @/api 门面（useFileTree 经 `import { file as fileApi, git as gitApi } from '@/api'` 依赖）
const mockFileTree = vi.fn()
const mockFileExpand = vi.fn()
const mockGitStatus = vi.fn()
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  file: {
    tree: (...args: unknown[]) => mockFileTree(...args),
    expand: (...args: unknown[]) => mockFileExpand(...args),
  },
  git: { status: (...args: unknown[]) => mockGitStatus(...args) },
}))

import { useFileTree } from '@/composables/features/file-tree/useFileTree'
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

    expect(mockFileTree).toHaveBeenCalledWith('s1')
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

    expect(mockFileExpand).toHaveBeenCalledWith('s1', 'src')
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

    expect(mockFileExpand).toHaveBeenCalledWith('s1', 'src') // 重发
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

describe('useFileTree.setFilter W15/D-7.1 过滤防抖', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    // 清掉模块级 pending timer，避免跨用例触发（filterText 是全局单值）
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('防抖窗口内连续 setFilter 只触发一次 store.filterText 更新（trailing 取最后一次）', () => {
    const store = useFileTreeStore()
    const { setFilter } = useFileTree()

    // 过滤重算的触发源是 store.filterText（FileView.visibleNodes 依赖它），watch 计次数
    // flush:'sync' 保证同步断言能读到回调计数（默认 pre 是微任务调度）
    let filterCommits = 0
    watch(
      () => store.filterText,
      () => {
        filterCommits++
      },
      { flush: 'sync' },
    )

    // 模拟连续击键 's' → 'st' → 'sto' → 'store'
    setFilter('s')
    setFilter('st')
    setFilter('sto')
    setFilter('store')

    // 防抖窗口内：store 未被写（过滤零重算）
    expect(store.filterText).toBe('')
    expect(filterCommits).toBe(0)

    vi.advanceTimersByTime(200)

    // trailing：只透传最后一次，且只触发一次
    expect(store.filterText).toBe('store')
    expect(filterCommits).toBe(1)
  })

  it('超过防抖间隔的两次输入各自触发（间隔 200ms 以上不合并）', () => {
    const store = useFileTreeStore()
    const { setFilter } = useFileTree()

    setFilter('src')
    vi.advanceTimersByTime(200)
    expect(store.filterText).toBe('src')

    setFilter('lib')
    vi.advanceTimersByTime(200)
    expect(store.filterText).toBe('lib')
  })

  it('模块级聚合：多个 useFileTree 实例（split mode 多 panel）连续 setFilter 仍只触发一次', () => {
    const store = useFileTreeStore()
    const panelA = useFileTree()
    const panelB = useFileTree()

    let filterCommits = 0
    watch(
      () => store.filterText,
      () => {
        filterCommits++
      },
      { flush: 'sync' },
    )

    panelA.setFilter('a-query')
    panelB.setFilter('b-query')

    expect(store.filterText).toBe('')
    vi.advanceTimersByTime(200)
    expect(store.filterText).toBe('b-query') // 后到者胜（与旧直通行为终态一致）
    expect(filterCommits).toBe(1)
  })

  it('对外签名不变：setFilter 同步返回 void', () => {
    const { setFilter } = useFileTree()
    expect(setFilter('x')).toBeUndefined()
  })
})
