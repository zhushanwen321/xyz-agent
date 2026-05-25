import { defineStore } from 'pinia'
import { reactive } from 'vue'

// ── i18n: filter labels ────────────────────────────────────────

/** 树面板筛选器文字，可按需替换为其他语言 */
export const FILTER_LABELS_ZH = {
  all: '全部',
  noTools: '隐藏工具调用',
} as const

export type FilterLabels = typeof FILTER_LABELS_ZH

// ── Types ──────────────────────────────────────────────────────────

/** 与后端一致的树节点结构 */
export interface TreeNode {
  id: string
  parentId: string | null
  type: string
  role?: string
  text: string
  label?: string
  timestamp: string
  children: TreeNode[]
}

/** 扁平化后的渲染节点 */
export interface FlatNode {
  node: TreeNode
  depth: number
  onPath: boolean
  isLeaf: boolean
  hasSiblings: boolean
}

export type FilterMode = 'all' | 'no-tools'

/** 每个 session 的树状态分区 */
export interface TreeSessionState {
  tree: TreeNode[]
  leafId: string | null
  branchCount: number
  navigateCapable: boolean
  selectedId: string | null
  filterMode: FilterMode
  isOpen: boolean
  isLoading: boolean
  error: string | null
}

// ── Helpers ────────────────────────────────────────────────────────

function createSessionState(): TreeSessionState {
  return {
    tree: [],
    leafId: null,
    branchCount: 0,
    navigateCapable: false,
    selectedId: null,
    filterMode: 'all',
    isOpen: false,
    isLoading: false,
    error: null,
  }
}

/**
 * 从 leaf 到 root 收集活跃路径上所有节点 id
 * 递归遍历树，构建 parentId → children 的映射以加速查找
 */
function buildPathToRoot(tree: TreeNode[], leafId: string | null): Set<string> {
  if (!leafId) return new Set()

  // 扁平化所有节点，建立 id → parentId 映射
  const parentMap = new Map<string, string | null>()
  const visited = new Set<string>()
  function walk(nodes: TreeNode[]) {
    for (const n of nodes) {
      if (visited.has(n.id)) continue  // 防环引用
      visited.add(n.id)
      parentMap.set(n.id, n.parentId)
      if (n.children.length > 0) walk(n.children)
    }
  }
  walk(tree)

  const path = new Set<string>()
  let cur: string | null | undefined = leafId
  while (cur && !path.has(cur)) {
    path.add(cur)
    cur = parentMap.get(cur)
  }
  return path
}

/** 计算分支数：有多于 1 个 children 的节点数 */
function countBranches(nodes: TreeNode[]): number {
  let count = 0
  const visited = new Set<string>()
  function walk(list: TreeNode[]) {
    for (const n of list) {
      if (visited.has(n.id)) continue
      visited.add(n.id)
      if (n.children.length > 1) count++
      if (n.children.length > 0) walk(n.children)
    }
  }
  walk(nodes)
  return count
}

/** 根据过滤模式决定节点是否可见 */
function shouldShow(node: TreeNode, mode: FilterMode): boolean {
  switch (mode) {
    case 'all': return true
    case 'no-tools': return node.type !== 'tool'
  }
}

/**
 * 将树形结构扁平化为 FlatNode[]。
 *
 * 算法：
 * - 线性链（0-1 个 children）→ 同一 depth 追加，不增加缩进
 * - 分支点（>1 个 children）→ 父节点追加后，每个 child 以 depth+1 递归
 */
function flattenTree(
  nodes: TreeNode[],
  leafId: string | null,
  pathSet: Set<string>,
  mode: FilterMode,
): FlatNode[] {
  const result: FlatNode[] = []
  const visited = new Set<string>()

  function walk(list: TreeNode[], depth: number) {
    for (const node of list) {
      if (visited.has(node.id)) continue
      visited.add(node.id)
      if (!shouldShow(node, mode)) {
        // 被过滤掉的节点，其 children 仍需遍历
        if (node.children.length > 0) {
          if (node.children.length > 1) {
            walk(node.children, depth + 1)
          } else {
            walk(node.children, depth)
          }
        }
        continue
      }

      const isLeaf = node.id === leafId
      const hasSiblings = list.length > 1

      result.push({
        node,
        depth,
        onPath: pathSet.has(node.id),
        isLeaf,
        hasSiblings,
      })

      if (node.children.length > 1) {
        // 分支：子节点缩进
        walk(node.children, depth + 1)
      } else if (node.children.length === 1) {
        // 线性：同层级继续
        walk(node.children, depth)
      }
    }
  }

  walk(nodes, 0)
  return result
}

// ── Store ──────────────────────────────────────────────────────────

export const useTreeStore = defineStore('tree', () => {
  const treeSessions = reactive(new Map<string, TreeSessionState>())

  // ── Session 管理 ────────────────────────────────────────────

  function getSessionState(sid: string): TreeSessionState {
    if (!treeSessions.has(sid)) {
      treeSessions.set(sid, createSessionState())
    }
    return treeSessions.get(sid)!
  }

  function removeSession(sid: string): void {
    treeSessions.delete(sid)
  }

  // ── 数据操作 ────────────────────────────────────────────────

  function setTreeData(sid: string, data: { tree: TreeNode[]; leafId: string | null; navigateCapable?: boolean; branchCount?: number }) {
    const s = getSessionState(sid)
    s.tree = data.tree
    s.leafId = data.leafId
    s.branchCount = data.branchCount ?? countBranches(data.tree)
    if (data.navigateCapable !== undefined) {
      s.navigateCapable = data.navigateCapable
    }
    s.isLoading = false
    s.error = null
  }

  function selectNode(sid: string, id: string | null): void {
    getSessionState(sid).selectedId = id
  }

  function setFilterMode(sid: string, mode: FilterMode): void {
    getSessionState(sid).filterMode = mode
  }

  function togglePanel(sid: string): void {
    const s = getSessionState(sid)
    s.isOpen = !s.isOpen
  }

  function setPanelOpen(sid: string, open: boolean): void {
    getSessionState(sid).isOpen = open
  }

  function setNavigateCapable(sid: string, capable: boolean): void {
    getSessionState(sid).navigateCapable = capable
  }

  function setError(sid: string, error: string | null): void {
    getSessionState(sid).error = error
  }

  function clearError(sid: string): void {
    getSessionState(sid).error = null
  }

  function setLoading(sid: string, loading: boolean): void {
    getSessionState(sid).isLoading = loading
  }

  // ── 计算属性：扁平化节点列表 ────────────────────────────────

  function getFlatNodes(sid: string): FlatNode[] {
    const s = getSessionState(sid)
    if (s.tree.length === 0) return []
    const pathSet = buildPathToRoot(s.tree, s.leafId)
    return flattenTree(s.tree, s.leafId, pathSet, s.filterMode)
  }

  return {
    // State
    treeSessions,

    // Session 管理
    getSessionState,
    removeSession,

    // 数据操作
    setTreeData,
    selectNode,
    setFilterMode,
    togglePanel,
    setPanelOpen,
    setNavigateCapable,
    setError,
    clearError,
    setLoading,

    // 计算属性
    getFlatNodes,
  }
})
