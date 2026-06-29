/**
 * fileTreeStore 单测（#3，D-021 结构 + T2.2/T2.6/T2.7/T2.8/T2.8b/T2.9/T4.6）。
 *
 * 验证 D-021 目标结构（非骨架旧结构）：
 * - nodeStates: Map<sid, Map<path, NodeState>>（对象化 + per-session）
 * - gitOverlay: Map<sid, Map<path, GitFileStatus>>（per-session）
 * - setNodeState 原子入口（status + children merge 同 step）
 *
 * 覆盖用例：
 * - T2.2 loaded 复用缓存（setTree + getTree）
 * - T2.6 overlay 先到后挂载（setGitOverlay 独立于 tree）
 * - T2.7 git.status 失败 → overlay 空（不调 setGitOverlay，树仍在）
 * - T2.8/T2.8b 角标全态（setGitOverlay M/A/D/U/untracked）
 * - T2.9 非 git 仓库（isRepo=false 不设 overlay）
 * - T4.6 invalidated 态过滤 graceful（invalidate 不报错）
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/stores/fileTree.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFileTreeStore } from '@/stores/fileTree'
import type { GitFileStatus } from '@xyz-agent/shared'

beforeEach(() => setActivePinia(createPinia()))

describe('fileTreeStore D-021 结构', () => {
  it('nodeStates 是 Map<sid, Map<path, NodeState>>（对象化 + per-session）', () => {
    const store = useFileTreeStore()
    store.setNodeState('s1', 'src', { status: 'loading' })
    store.setNodeState('s1', 'src', { status: 'loaded' })
    store.setNodeState('s2', 'lib', { status: 'error', reason: 'out_of_cwd' })

    // per-session 分桶
    expect(store.nodeStates.get('s1')?.get('src')).toEqual({ status: 'loaded' })
    expect(store.nodeStates.get('s2')?.get('lib')).toEqual({ status: 'error', reason: 'out_of_cwd' })
    // session 隔离
    expect(store.nodeStates.get('s1')?.get('lib')).toBeUndefined()
    expect(store.nodeStates.get('s2')?.get('src')).toBeUndefined()
  })

  it('getNodeState 无记录默认 unloaded', () => {
    const store = useFileTreeStore()
    expect(store.getNodeState('s1', 'any')).toEqual({ status: 'unloaded' })
  })

  it('setNodeState loaded + children 原子 merge（消除双源不一致）', () => {
    const store = useFileTreeStore()
    // 顶层 setTree 先建树
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    // setNodeState loaded 同 step merge children
    const children = [{ path: 'src/index.ts', name: 'index.ts', type: 'file' }]
    store.setNodeState('s1', 'src', { status: 'loaded' }, children)

    // tree 中 src 的 children 已 merge（不是 undefined）
    const tree = store.getTree('s1')!
    expect(tree[0].children).toEqual(children)
    // nodeStates 同步 loaded
    expect(store.getNodeState('s1', 'src').status).toBe('loaded')
  })

  it('setNodeState error 带 reason（来自 WS error code）', () => {
    const store = useFileTreeStore()
    store.setNodeState('s1', 'secret', { status: 'error', reason: 'permission_denied' })
    expect(store.getNodeState('s1', 'secret')).toEqual({ status: 'error', reason: 'permission_denied' })
  })
})

describe('fileTreeStore T2.2 缓存复用', () => {
  it('setTree 后 getTree 返回缓存', () => {
    const store = useFileTreeStore()
    const nodes = [{ path: 'a.ts', name: 'a.ts', type: 'file' }]
    store.setTree('s1', nodes)
    expect(store.getTree('s1')).toEqual(nodes)
  })

  it('未缓存的 session getTree 返回 undefined', () => {
    const store = useFileTreeStore()
    expect(store.getTree('nope')).toBeUndefined()
  })
})

describe('fileTreeStore T2.6/T2.7/T2.8/T2.9 git overlay', () => {
  it('T2.6 setGitOverlay 独立于 tree（overlay 先到后挂载）', () => {
    const store = useFileTreeStore()
    // overlay 先设，tree 未设
    store.setGitOverlay('s1', [{ path: 'src/x.ts', xyCode: ' M', status: 'modified' }])
    expect(store.getGitStatus('s1', 'src/x.ts')?.status).toBe('modified')
    // tree 后设，overlay 不丢
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    expect(store.getGitStatus('s1', 'src/x.ts')?.status).toBe('modified')
  })

  it('T2.8/T2.8b 角标全态（M/A/D/U/untracked）', () => {
    const store = useFileTreeStore()
    const statuses: GitFileStatus[] = [
      { path: 'm.ts', xyCode: ' M', status: 'modified' },
      { path: 'a.ts', xyCode: 'A ', status: 'added' },
      { path: 'd.ts', xyCode: ' D', status: 'deleted' },
      { path: 'u.ts', xyCode: 'UU', status: 'unmerged' },
      { path: 'untracked.ts', xyCode: '??', status: 'untracked' },
    ]
    store.setGitOverlay('s1', statuses)
    for (const s of statuses) {
      expect(store.getGitStatus('s1', s.path)?.status).toBe(s.status)
    }
  })

  it('T2.7/T2.9 非 git 仓库 → 不调 setGitOverlay，getGitStatus 返回 undefined', () => {
    const store = useFileTreeStore()
    // 模拟 git.status isRepo=false → composable 不调 setGitOverlay
    store.setTree('s1', [{ path: 'x.ts', name: 'x.ts', type: 'file' }])
    expect(store.getGitStatus('s1', 'x.ts')).toBeUndefined()
    // 树仍渲染
    expect(store.getTree('s1')).toHaveLength(1)
  })

  it('gitOverlay per-session 分桶', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [{ path: 'a.ts', xyCode: ' M', status: 'modified' }])
    store.setGitOverlay('s2', [{ path: 'b.ts', xyCode: 'A ', status: 'added' }])
    expect(store.getGitStatus('s1', 'a.ts')?.status).toBe('modified')
    expect(store.getGitStatus('s2', 'a.ts')).toBeUndefined()
  })
})

describe('fileTreeStore T4.6 invalidate graceful', () => {
  it('invalidate loaded → invalidated（不报错）', () => {
    const store = useFileTreeStore()
    store.setNodeState('s1', 'src', { status: 'loaded' })
    store.invalidate('s1', ['src'])
    expect(store.getNodeState('s1', 'src').status).toBe('invalidated')
  })

  it('invalidate 未 loaded 的节点不变（只标 loaded→invalidated）', () => {
    const store = useFileTreeStore()
    store.setNodeState('s1', 'src', { status: 'loading' })
    store.invalidate('s1', ['src'])
    expect(store.getNodeState('s1', 'src').status).toBe('loading')
  })

  it('invalidate 不存在的 session graceful（不报错）', () => {
    const store = useFileTreeStore()
    expect(() => store.invalidate('nope', ['any'])).not.toThrow()
  })
})

describe('fileTreeStore 展开态 rehydrate', () => {
  it('addExpanded/getExpanded per-session', () => {
    const store = useFileTreeStore()
    store.addExpanded('s1', 'src')
    store.addExpanded('s1', 'lib')
    expect(store.getExpanded('s1')).toEqual(new Set(['src', 'lib']))
    expect(store.getExpanded('s2')).toEqual(new Set())
  })

  it('removeExpanded 折叠', () => {
    const store = useFileTreeStore()
    store.addExpanded('s1', 'src')
    store.removeExpanded('s1', 'src')
    expect(store.getExpanded('s1').has('src')).toBe(false)
  })

  it('clearSession 清理所有状态', () => {
    const store = useFileTreeStore()
    store.setTree('s1', [])
    store.setNodeState('s1', 'x', { status: 'loaded' })
    store.setGitOverlay('s1', [])
    store.addExpanded('s1', 'x')
    store.clearSession('s1')
    expect(store.getTree('s1')).toBeUndefined()
    expect(store.nodeStates.has('s1')).toBe(false)
  })
})
