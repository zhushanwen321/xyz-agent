/**
 * fileTreeStore —— 文件树前端状态容器（#3，D-021 目标结构）。
 *
 * [HISTORICAL D-021] 状态存储模型重构（⑥execution-plan W3 强制对齐项）：
 * 骨架是旧结构（nodeStatus 光杆 string + per-path），已按 §3 签名表 D-021 重写：
 * 1. nodeStates: Map<sid, Map<path, NodeState>>（对象化 NodeState，非光杆 string）+ per-session 分桶
 * 2. gitOverlay: Map<sid, Map<path, GitFileStatus>>（per-session 分桶，与 tree 同生命周期）
 * 3. setNodeState 单一原子入口：同步 set status(+reason) 与结构 merge children，消除双源不一致
 *
 * 4 facet per-session（D-019 rehydrate）：tree / expandedPaths / nodeStates / gitOverlay 都按 sessionId
 * 分桶，切回 session 时展开态恢复（graceful 跳过已删路径）。
 *
 * [K-9 反哺] 跨 store 编排在 composable 层：store 暴露 invalidate 接口，不自行 subscribe chat store
 * （stores 间禁止互相 import，见 sidebar.ts:4 约束）。
 *
 * stores 间禁止互相 import（与 chat.ts/sidebar.ts 一致）。
 */
import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { defineStore } from 'pinia'
import type { FileNode, GitFileStatus } from '@xyz-agent/shared'

/** 节点加载态（②§5 状态机：5 态） */
export type LoadStatus = 'unloaded' | 'loading' | 'loaded' | 'error' | 'invalidated'

/**
 * 节点状态对象（D-021：加载态复合对象，单一权威源）。
 * - status：5 态加载状态机
 * - reason：仅 error 态非空，来自 WS error envelope 的 code（routeInbound 透传到 Error.code）
 */
export interface NodeState {
  status: LoadStatus
  /** error code（如 'out_of_cwd' / 'permission_denied' / 'timeout'），仅 status='error' 时有意义 */
  reason?: string
}

/** Map<path, T> 的 per-session 分桶类型别名 */
type PathMap<T> = Map<string, T>
/** Map<sessionId, Map<path, T>> 的 per-session 分桶类型别名（nodeStates/gitOverlay 用） */
type SessionPathMap<T> = Map<string, PathMap<T>>
/** Map<sessionId, T> 的 per-session 单值分桶（tree 用：每 session 一个 FileNode[]） */
type SessionMap<T> = Map<string, T>

export const useFileTreeStore = defineStore('fileTree', () => {
  // ── State（4 facet per-session + showIgnored + selectedPath）──

  /** 文件树缓存：sessionId → 顶层 FileNode[]（dir 的 children 随展开 merge 进去） */
  const tree: Ref<SessionMap<FileNode[]>> = ref(new Map())
  /** 展开态：sessionId → Set<相对路径>（D-019 rehydrate） */
  const expandedPaths: Ref<Map<string, Set<string>>> = ref(new Map())
  /** 节点加载态（D-021 对象化 + per-session）：sessionId → path → NodeState */
  const nodeStates: Ref<SessionPathMap<NodeState>> = ref(new Map())
  /** git 标注 overlay（D-012 树/标注分离 + D-021 per-session）：sessionId → path → GitFileStatus */
  const gitOverlay: Ref<SessionPathMap<GitFileStatus>> = ref(new Map())
  /** 显示忽略项开关（D-020，默认 false） */
  const showIgnored = ref(false)
  /** 当前选中文件路径（全局，非 per-session——单选焦点） */
  const selectedPath = ref<string | null>(null)
  /** 过滤关键词（#4 文件名过滤） */
  const filterText = ref('')

  // ── Getters（per-session 读，默认参数便于 composable 调用）──

  /** 取 session 的文件树（无缓存返回 undefined） */
  function getTree(sessionId: string): FileNode[] | undefined {
    return tree.value.get(sessionId)
  }

  /** 取 session 的展开路径集合（无则空 Set） */
  function getExpanded(sessionId: string): Set<string> {
    return expandedPaths.value.get(sessionId) ?? new Set()
  }

  /** 取节点加载态（无记录默认 unloaded） */
  function getNodeState(sessionId: string, path: string): NodeState {
    return nodeStates.value.get(sessionId)?.get(path) ?? { status: 'unloaded' }
  }

  /** 取节点的 git 标注（无则 undefined） */
  function getGitStatus(sessionId: string, path: string): GitFileStatus | undefined {
    return gitOverlay.value.get(sessionId)?.get(path)
  }

  /**
   * [W2] 统计目录子树内改动文件数（用于目录行的改动数徽章）。
   * 遍历 session 的 gitOverlay，统计 path 以 `dirPath + '/'` 开头的条目数。
   * 精确前缀匹配（'src/'），兄弟目录（如 'src-other/'）不误算。O(n)，n=改动文件数（通常 <100）。
   * 空 overlay / session 不存在 → 0。
   */
  function getDirChangeCount(sessionId: string, dirPath: string): number {
    const map = gitOverlay.value.get(sessionId)
    if (!map || map.size === 0) return 0
    const prefix = `${dirPath}/`
    let count = 0
    for (const path of map.keys()) {
      if (path.startsWith(prefix)) count++
    }
    return count
  }

  /** 当前选中文件节点（computed，跨 tree 查找——selectedPath 全局，tree per-session） */
  const currentFile: ComputedRef<FileNode | null> = computed(() => {
    if (!selectedPath.value) return null
    // 在所有 session 的 tree 中查找选中路径对应的节点（扁平搜索，selectedPath 全局焦点）
    for (const nodes of tree.value.values()) {
      const found = findNodeByPath(nodes, selectedPath.value)
      if (found) return found
    }
    return null
  })

  // ── Actions ──

  /** 设置 session 的文件树（首加载或刷新） */
  function setTree(sessionId: string, nodes: FileNode[]): void {
    tree.value.set(sessionId, nodes)
    // 触发响应式（Map.set 不自动触发，需重新赋值或用 reactive——这里用 new Map 替换触发）
    tree.value = new Map(tree.value)
  }

  /**
   * [D-021] 设置节点加载态——单一原子入口。
   * 同步 set status(+reason) 与结构 merge children（展开成功时），消除「status=loaded 但 children=undefined」
   * 双源不一致态。失败时 set error + reason（code 来自 WS error envelope）。
   *
   * @param sessionId session id
   * @param path 节点相对路径
   * @param state 新状态（status + 可选 reason）
   * @param children 展开成功时的子节点（仅 status='loaded' 时 merge 进 tree；其它状态忽略）
   */
  function setNodeState(
    sessionId: string,
    path: string,
    state: NodeState,
    children?: FileNode[],
  ): void {
    // 1. 更新 nodeStates（per-session 分桶）
    let sessionStates = nodeStates.value.get(sessionId)
    if (!sessionStates) {
      sessionStates = new Map()
      nodeStates.value.set(sessionId, sessionStates)
    }
    sessionStates.set(path, state)
    nodeStates.value = new Map(nodeStates.value)

    // 2. loaded 态时 merge children 进 tree（原子同 step，消除双源不一致）
    if (state.status === 'loaded' && children) {
      mergeChildren(sessionId, path, children)
    }
  }

  /**
   * merge 子节点到 tree 的指定路径下（展开成功的结构更新）。
   * 顶层 path='' 时直接替换 session 的顶层 nodes。
   */
  function mergeChildren(sessionId: string, path: string, children: FileNode[]): void {
    if (path === '') {
      // 顶层：直接 set
      tree.value.set(sessionId, children)
      tree.value = new Map(tree.value)
      return
    }
    const nodes = tree.value.get(sessionId)
    if (!nodes) return
    // 在树中找到 path 对应的 dir 节点，设置其 children
    const target = findNodeByPath(nodes, path)
    if (target && target.type === 'dir') {
      target.children = children
      tree.value = new Map(tree.value) // 触发响应式
    }
  }

  /** 记录展开路径（D-019 rehydrate） */
  function addExpanded(sessionId: string, path: string): void {
    let set = expandedPaths.value.get(sessionId)
    if (!set) {
      set = new Set()
      expandedPaths.value.set(sessionId, set)
    }
    set.add(path)
    expandedPaths.value = new Map(expandedPaths.value)
  }

  /** 移除展开路径（折叠） */
  function removeExpanded(sessionId: string, path: string): void {
    expandedPaths.value.get(sessionId)?.delete(path)
    expandedPaths.value = new Map(expandedPaths.value)
  }

  /** 设置选中文件路径 */
  function selectFile(path: string | null): void {
    selectedPath.value = path
  }

  /** 设置 git overlay（per-session，git.status 变化时只更新 overlay 不触发树重建） */
  function setGitOverlay(sessionId: string, statuses: GitFileStatus[]): void {
    const map: PathMap<GitFileStatus> = new Map()
    for (const s of statuses) {
      map.set(s.path, s)
    }
    gitOverlay.value.set(sessionId, map)
    gitOverlay.value = new Map(gitOverlay.value)
  }

  /** 设置过滤关键词（#4） */
  function setFilter(text: string): void {
    filterText.value = text
  }

  /** 切换 showIgnored 开关（D-020） */
  function toggleShowIgnored(): void {
    showIgnored.value = !showIgnored.value
  }

  /**
   * [K-9] 跨 store 失效接口——标相关节点 loaded→invalidated（D-017）。
   * 供 composable 派发（useFileTree.invalidateOnFileChanges watch chat store 后调此），
   * store 不自行监听（stores 间禁止 import）。
   */
  function invalidate(sessionId: string, paths: string[]): void {
    const sessionStates = nodeStates.value.get(sessionId)
    if (!sessionStates) return
    for (const p of paths) {
      const current = sessionStates.get(p)
      if (current?.status === 'loaded') {
        sessionStates.set(p, { status: 'invalidated' })
      }
    }
    nodeStates.value = new Map(nodeStates.value)
  }

  /** 清理 session 的所有状态（session 删除时） */
  function clearSession(sessionId: string): void {
    tree.value.delete(sessionId)
    expandedPaths.value.delete(sessionId)
    nodeStates.value.delete(sessionId)
    gitOverlay.value.delete(sessionId)
    tree.value = new Map(tree.value)
    expandedPaths.value = new Map(expandedPaths.value)
    nodeStates.value = new Map(nodeStates.value)
    gitOverlay.value = new Map(gitOverlay.value)
  }

  return {
    // state
    tree,
    expandedPaths,
    nodeStates,
    gitOverlay,
    showIgnored,
    selectedPath,
    filterText,
    // getters
    currentFile,
    getTree,
    getExpanded,
    getNodeState,
    getGitStatus,
    getDirChangeCount,
    // actions
    setTree,
    setNodeState,
    mergeChildren,
    addExpanded,
    removeExpanded,
    selectFile,
    setGitOverlay,
    setFilter,
    toggleShowIgnored,
    invalidate,
    clearSession,
  }
})

/** 在 FileNode[] 树中按 path 查找节点（深度优先） */
function findNodeByPath(nodes: FileNode[], path: string): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.children) {
      const found = findNodeByPath(node.children, path)
      if (found) return found
    }
  }
  return null
}
