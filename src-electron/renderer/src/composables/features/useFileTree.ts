/**
 * useFileTree —— 文件树前端编排（#3，K-9 跨 store 编排入口）。
 *
 * 职责（单一变化轴「文件树用户交互编排」）：
 * - loadTree：首加载（api/domains/file.tree + git.status overlay 并行）+ 展开态 rehydrate（D-019）
 * - expandNode：展开/折叠（loaded 复用缓存 / loading 幂等去重 / error 重试 / stale 丢弃）
 * - selectFile / setFilter / toggleShowIgnored：薄包装 store action
 *
 * [K-9] 跨 store 失效编排（W6）：invalidateOnFileChanges watch chat store 的 file_changes ready 事件
 * → 按 sessionId 过滤 → store.invalidate。store 不自行监听（stores 间禁止 import）。
 *
 * 依赖方向：useFileTree → fileTreeStore + api/domains（file/git）。不直接 import chat store
 * （W6 的 invalidateOnFileChanges 经 composable 层 watch，不违反 stores 间禁 import）。
 */
import { watch, type Ref } from 'vue'
import { useFileTreeStore } from '@/stores/fileTree'
import { useChatStore } from '@/stores/chat'
import { file as fileApi, git as gitApi } from '@/api'
import type { FileNode } from '@xyz-agent/shared'

/** 在途请求追踪（expandNode 幂等去重：同 path loading 时不重发） */
const inFlight = new Map<string, Set<string>>() // sessionId → Set<path>

function isInFlight(sessionId: string, path: string): boolean {
  return inFlight.get(sessionId)?.has(path) ?? false
}

function markInFlight(sessionId: string, path: string): void {
  let set = inFlight.get(sessionId)
  if (!set) {
    set = new Set()
    inFlight.set(sessionId, set)
  }
  set.add(path)
}

function clearInFlight(sessionId: string, path: string): void {
  inFlight.get(sessionId)?.delete(path)
}

export function useFileTree() {
  const store = useFileTreeStore()

  /**
   * 文件树首加载（UC-1）。
   * - 已缓存（store.getTree 有值）→ rehydrate 展开态（graceful 跳过已删路径）
   * - 未缓存 → 并行拉 file.tree + git.status（overlay），store 更新
   */
  async function loadTree(sessionId: string): Promise<void> {
    // 已缓存 → rehydrate（D-019，graceful：展开态中的路径若已删则跳过，NFR-AC-D1）
    if (store.getTree(sessionId)) {
      rehydrateExpanded(sessionId)
      return
    }

    // 未缓存 → 并行拉取（file.tree + git.status overlay 独立，Promise.allSettled）
    store.setNodeState(sessionId, '', { status: 'loading' })
    const [treeResult, overlayResult] = await Promise.allSettled([
      fileApi.tree(sessionId, store.showIgnored),
      gitApi.status(sessionId),
    ])

    // file.tree 失败 → setNodeState error（T2.5 error 重试依赖此态）
    if (treeResult.status === 'rejected') {
      const code = (treeResult.reason as { code?: string })?.code ?? 'unknown'
      store.setNodeState(sessionId, '', { status: 'error', reason: code })
      return
    }

    // file.tree 成功 → setTree + setNodeState loaded（原子，T2.2 缓存复用）
    store.setTree(sessionId, treeResult.value)
    store.setNodeState(sessionId, '', { status: 'loaded' })

    // overlay：先到后挂载（T2.6）——file.tree 先到则树渲染，overlay 后到更新；反之 overlay 缓存等树
    if (overlayResult.status === 'fulfilled' && overlayResult.value.isRepo) {
      // T2.7 git.status 失败 → overlay 空，树仍渲染（allSettled fulfilled 但 isRepo=false 时跳过）
      store.setGitOverlay(sessionId, overlayResult.value.files)
    }
  }

  /**
   * 展开目录节点（UC-3）。
   * - loaded → 复用缓存（不重请求，AC-3.3）
   * - loading → 幂等去重（不发新请求，AC-3.8）
   * - error → 重试（AC-3.9）
   * - unloaded/invalidated → 发请求
   * 在途切 session → 响应回来校验 sessionId 不匹配则丢弃 stale（AC-3.7）
   */
  async function expandNode(sessionId: string, path: string): Promise<void> {
    const state = store.getNodeState(sessionId, path)

    // loaded → 复用缓存（折叠再展开不重请求，T2.2）
    if (state.status === 'loaded') {
      store.addExpanded(sessionId, path)
      return
    }
    // [D-009] 树首加载已带 children 的目录（顶层 dir 的一级子）→ 视为 loaded 复用，不重发 expand
    // （首加载 file.tree 返回顶层+一级子，src 等已含 children，展开时直接复用避免被空响应覆盖）
    if (state.status === 'unloaded') {
      const nodes = store.getTree(sessionId)
      if (nodes) {
        const node = findNodeByPath(nodes, path)
        if (node && node.children && node.children.length > 0) {
          store.setNodeState(sessionId, path, { status: 'loaded' })
          store.addExpanded(sessionId, path)
          return
        }
      }
    }
    // loading → 幂等去重（T2.3）
    if (state.status === 'loading' || isInFlight(sessionId, path)) {
      return
    }
    // error/invalidated/unloaded（无缓存 children）→ 发请求（T2.5 error 重试也走此分支）

    store.setNodeState(sessionId, path, { status: 'loading' })
    markInFlight(sessionId, path)
    try {
      const children = await fileApi.expand(sessionId, path, store.showIgnored)
      // 在途切 session 丢弃 stale（AC-3.7）——校验当前 store 的 session 上下文仍一致
      // （此处 sessionId 是闭包捕获的请求发起时的值，store 状态可能已变；setNodeState 仍写原 sessionId 分桶）
      store.setNodeState(sessionId, path, { status: 'loaded' }, children)
      store.addExpanded(sessionId, path)
    } catch (e) {
      const code = (e as { code?: string })?.code ?? 'unknown'
      store.setNodeState(sessionId, path, { status: 'error', reason: code })
    } finally {
      clearInFlight(sessionId, path)
    }
  }

  /** 折叠目录 */
  function collapseNode(sessionId: string, path: string): void {
    store.removeExpanded(sessionId, path)
  }

  /** 选中文件（#6 预览触发） */
  function selectFile(path: string): void {
    store.selectFile(path)
  }

  /** 设置过滤关键词（#4，debounce 由调用方或组件处理） */
  function setFilter(text: string): void {
    store.setFilter(text)
  }

  /** 切换 showIgnored（D-020，W7 UI 接此） */
  function toggleShowIgnored(): void {
    store.toggleShowIgnored()
  }

  /**
   * rehydrate 展开态（D-019）。
   * 切回 session 时，对 expandedPaths 中记录的路径，若节点已是 loaded 则保持展开；
   * 若路径已删（树中找不到）则 graceful 移除（NFR-AC-D1，T1.7）。
   */
  function rehydrateExpanded(sessionId: string): void {
    const expanded = store.getExpanded(sessionId)
    const nodes = store.getTree(sessionId)
    if (!nodes) return
    const valid = new Set<string>()
    for (const path of expanded) {
      // 在树中查找该路径，存在则保留展开，不存在（已删）则跳过
      if (findNodePath(nodes, path)) {
        valid.add(path)
      }
    }
    // graceful 移除已删路径（T1.7）
    if (valid.size !== expanded.size) {
      // 通过 removeExpanded 逐个清理（store 无批量 set，逐个调）
      for (const path of expanded) {
        if (!valid.has(path)) {
          store.removeExpanded(sessionId, path)
        }
      }
    }
  }

  /**
   * [K-9/W6 #3.11] 跨 store 失效编排：watch chat store 该 session 的 fileChanges 变化
   * → 提取最新 filePaths → store.invalidate（loaded→invalidated）。
   *
   * composable 层 watch（stores 间禁止 import，但 composable 可 watch 多个 store）。
   * file_changes ready 帧由 chat-chunk-processor 合并进 message.fileChanges，
   * 此处 watch 其变化触发失效。 invalidated 节点下次展开时重发请求（expandNode 的 invalidated 分支）。
   *
   * @param sessionIdRef session id 的 ref（变化时重订阅）
   * @returns unwatch 函数（组件 onBeforeUnmount 调用，避免泄漏）
   */
  function setupInvalidation(sessionIdRef: Ref<string>): () => void {
    const chatStore = useChatStore()
    // 上次处理的 fileChanges paths 快照（去重：仅 paths 集合变化时才 invalidate）
    let lastPaths = new Set<string>()

    const unwatch = watch(
      [() => sessionIdRef.value, () => chatStore.messages],
      () => {
        const sid = sessionIdRef.value
        if (!sid) {
          lastPaths = new Set()
          return
        }
        // 提取该 session 所有 assistant message 的 fileChanges paths
        const msgs = chatStore.getMessages(sid)
        const currentPaths = new Set<string>()
        for (const m of msgs) {
          if (m.role !== 'assistant') continue
          for (const fc of m.fileChanges ?? []) {
            currentPaths.add(fc.filePath)
          }
        }
        // 仅当 paths 集合变化时 invalidate（避免每帧重复）
        const changed = [...currentPaths].filter((p) => !lastPaths.has(p))
        if (changed.length > 0) {
          store.invalidate(sid, changed)
        }
        lastPaths = currentPaths
      },
      { deep: true, immediate: true },
    )

    return unwatch
  }

  return {
    loadTree,
    expandNode,
    collapseNode,
    selectFile,
    setFilter,
    toggleShowIgnored,
    setupInvalidation,
  }
}

/** 在 FileNode[] 树中查找路径是否存在（深度优先，rehydrate 用） */
function findNodePath(nodes: FileNode[], path: string): boolean {
  for (const node of nodes) {
    if (node.path === path) return true
    if (node.children && findNodePath(node.children, path)) return true
  }
  return false
}

/** 在 FileNode[] 树中按 path 查找节点（深度优先，expandNode 复用 children 用） */
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
