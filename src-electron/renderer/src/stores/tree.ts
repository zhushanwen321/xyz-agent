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

// ── 归组后的展示节点 ──────────────────────────────────────────

/** 当前活跃路径上的展示节点 */
export interface PathNode {
  /** 代表 entry 的 id（用于 navigate/fork） */
  entryId: string
  /** 显示角色 */
  role: 'user' | 'assistant'
  /** 显示文本（已截断） */
  text: string
  /** 此节点之后的分支 tabs（如果有分叉） */
  branchTabs?: BranchTab[]
}

/** 分支 tab */
export interface BranchTab {
  /** 分支标签（第一个 user message 截断 或 assistant 摘要） */
  label: string
  /** navigate 到该分支时的 target entryId */
  targetId: string
  /** 是否是当前活跃分支 */
  isActive: boolean
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

/** 首行截断 */
function truncateFirst(text: string, max: number): string {
  if (!text) return ''
  const first = text.split('\n')[0] ?? ''
  return first.length > max ? first.slice(0, max) + '...' : first
}

// ── Active Path 构建 ────────────────────────────────────────────

/**
 * 从原始 tree + leafId 构建当前活跃路径的展示节点列表。
 *
 * 归组规则：
 * - user 节点直接显示
 * - assistant + 后续 toolResult + toolCall-only assistant 归为一组，
 *   只显示最终有 text 的 assistant
 * - toolResult 永远不显示
 * - 非 message 节点（compaction 等）跳过
 *
 * 分支规则：
 * - 节点有多个 "有意义的子节点"（user 或 assistant）时生成分支 tab
 * - 每个 tab 标签取分支中第一个 user message 的截断文本
 */
function buildActivePath(tree: TreeNode[], leafId: string | null): PathNode[] {
  if (!leafId || tree.length === 0) return []

  // 构建 id → node map 和 id → parentId map
  const byId = new Map<string, TreeNode>()
  const parentMap = new Map<string, string | null>()
  const visited = new Set<string>()
  function walk(nodes: TreeNode[]) {
    for (const n of nodes) {
      if (visited.has(n.id)) continue
      visited.add(n.id)
      byId.set(n.id, n)
      parentMap.set(n.id, n.parentId)
      if (n.children.length > 0) walk(n.children)
    }
  }
  walk(tree)

  // 从 leaf 到 root 收集路径 id（逆序），然后反转
  const pathIds: string[] = []
  const pathIdSet = new Set<string>()
  let cur: string | null = leafId
  while (cur && !pathIdSet.has(cur)) {
    pathIdSet.add(cur)
    pathIds.push(cur)
    cur = parentMap.get(cur) ?? null
  }
  pathIds.reverse()

  // 遍历路径，构建 PathNode[]
  const result: PathNode[] = []
  let i = 0

  while (i < pathIds.length) {
    const node = byId.get(pathIds[i]!)
    if (!node) { i++; continue }

    // 跳过非 message 节点
    if (node.type !== 'message') { i++; continue }

    // 跳过 toolResult
    if (node.role === 'toolResult') { i++; continue }

    if (node.role === 'user') {
      const pathNode: PathNode = {
        entryId: node.id,
        role: 'user',
        text: truncateFirst(node.text || '', 70),
      }

      // 分支检查
      const tabs = buildBranchTabs(node, leafId, parentMap)
      if (tabs && tabs.length > 1) {
        pathNode.branchTabs = tabs
      }

      result.push(pathNode)
      i++
    } else if (node.role === 'assistant') {
      // 归组：沿路径向下找最终有 text 的 assistant
      let displayText = node.text
      let representativeId = node.id
      let lastAssistantIdx = i

      let j = i + 1
      while (j < pathIds.length) {
        const nextNode = byId.get(pathIds[j]!)
        if (!nextNode) break
        if (nextNode.type !== 'message') { j++; continue }
        if (nextNode.role === 'toolResult') { j++; continue }
        if (nextNode.role === 'assistant') {
          if (nextNode.text) {
            displayText = nextNode.text
            representativeId = nextNode.id
          }
          lastAssistantIdx = j
          j++
          continue
        }
        // 遇到 user 或其他角色，停止归组
        break
      }

      const pathNode: PathNode = {
        entryId: representativeId,
        role: 'assistant',
        text: displayText ? truncateFirst(displayText, 70) : '...',
      }

      // 分支检查在链的最后一个 assistant
      const lastAssistant = byId.get(pathIds[lastAssistantIdx]!)
      if (lastAssistant) {
        const tabs = buildBranchTabs(lastAssistant, leafId, parentMap)
        if (tabs && tabs.length > 1) {
          pathNode.branchTabs = tabs
        }
      }

      result.push(pathNode)
      i = j // 跳过归组内的所有节点
    } else {
      // 未知 role 的 message 节点（如 system），跳过
      i++
    }
  }

  return result
}

/** 构建分支 tabs（检查节点是否有多个有意义的子节点） */
function buildBranchTabs(
  node: TreeNode,
  leafId: string,
  parentMap: Map<string, string | null>,
): BranchTab[] | null {
  const meaningfulChildren = node.children.filter(
    c => c.type === 'message' && c.role !== 'toolResult',
  )
  if (meaningfulChildren.length <= 1) return null

  return meaningfulChildren.map(child => ({
    label: getBranchLabel(child),
    targetId: getFirstNavigableId(child),
    isActive: isAncestorOf(child.id, leafId, parentMap),
  }))
}

/** 分支标签：找分支中第一个 user message 的截断文本 */
function getBranchLabel(node: TreeNode): string {
  if (node.role === 'user' && node.text) {
    return truncateFirst(node.text, 20)
  }
  if (node.role === 'assistant' && node.text) {
    return truncateFirst(node.text, 20)
  }
  // 递归找子节点
  for (const child of node.children) {
    if (child.type === 'message') {
      const label = getBranchLabel(child)
      if (label !== '...') return label
    }
  }
  return '...'
}

/** 找到分支中第一个可 navigate 的 entry id */
function getFirstNavigableId(node: TreeNode): string {
  if (node.role === 'user' || node.role === 'assistant') return node.id
  for (const child of node.children) {
    return getFirstNavigableId(child)
  }
  return node.id
}

/** 检查 nodeId 是否是 descendantId 的祖先（或自身） */
function isAncestorOf(
  nodeId: string,
  descendantId: string,
  parentMap: Map<string, string | null>,
): boolean {
  let cur: string | null = descendantId
  while (cur) {
    if (cur === nodeId) return true
    cur = parentMap.get(cur) ?? null
  }
  return false
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

  // ── 计算属性：活跃路径的展示节点列表 ────────────────────────

  function getActivePath(sid: string): PathNode[] {
    const s = getSessionState(sid)
    if (s.tree.length === 0) return []
    return buildActivePath(s.tree, s.leafId)
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
    getActivePath,
  }
})
