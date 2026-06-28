/**
 * code-skeleton/renderer/stores/fileTree.ts — FileTreeState store（⑤code-arch §3，#3，K-9 反哺）
 *
 * 4 facet（树缓存/展开态/选中态/GitOverlay）+ nodeStatus 每节点独立加载态 + showIgnored 开关。
 * 同生命周期（随 sessionId 切换 rehydrate，D-019）。
 *
 * 📌 K-9 反哺落地：store 暴露 `invalidate(sessionId, paths)` 接口供 composable 派发，
 *    **不自行 subscribe chat store**（违反 stores/chat.ts「stores 间禁止互相 import」）。
 *    跨 store 失效编排由 useFileTree composable（watch chat store file_changes）完成。
 *
 * D-012 树/标注分离：FileNode 不含 gitStatus，gitOverlay 是独立 ref（Map<path,GitFileStatus>），
 *   git.status 变化只更新 overlay，不触发树重建。
 *
 * 接线层级：[L1-接线] state + actions（Pinia defineStore）。
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { FileNode } from '@shared/file-tree'
import type { GitFileStatus } from '@xyz-agent/shared'

/** 每节点独立加载态（②§5 状态机，D-011 宽松 + D-017 invalidated 失效转移）。 */
export type LoadStatus = 'unloaded' | 'loading' | 'loaded' | 'error' | 'invalidated'

export const useFileTreeStore = defineStore('fileTree', () => {
  // ── 4 facet state（按 sessionId 缓存，D-019 rehydrate）──
  const tree = ref<Map<string, FileNode[]>>(new Map()) // 树缓存
  const expandedPaths = ref<Map<string, Set<string>>>(new Map()) // 展开态（D-019 切回恢复）
  const selectedPath = ref<string | null>(null) // 选中态
  const gitOverlay = ref<Map<string, GitFileStatus>>(new Map()) // 独立 ref（D-012）
  const nodeStatus = ref<Map<string, LoadStatus>>(new Map()) // 每节点加载态
  const showIgnored = ref<boolean>(false) // 显示忽略项开关（#16，默认 false AC-16.1）

  // ── computed ──
  /** 当前选中文件（由 selectedPath 派生，NFR ④跨阶段审计#7，供 #4 FileView 高亮 AC-4.12）。 */
  const currentFile = computed<FileNode | null>(() => {
    if (!selectedPath.value) return null
    for (const nodes of tree.value.values()) {
      const found = nodes.find(n => n.path === selectedPath.value)
      if (found) return found
    }
    return null
  })

  // ── actions ──
  function setTree(sessionId: string, nodes: FileNode[]): void {
    tree.value.set(sessionId, nodes)
  }
  function setNodeStatus(path: string, status: LoadStatus): void {
    nodeStatus.value.set(path, status)
  }
  function setGitOverlay(map: Map<string, GitFileStatus>): void {
    gitOverlay.value = map // D-012：只更新 overlay，不触发树重建
  }

  /**
   * 失效相关节点（D-017 loaded→invalidated→loading）。
   * **K-9**：供 useFileTree composable 派发（store 不自行监听 chat store）。
   * 触发：agent_end / file_changes ready 帧（agent 新建/删除文件后）。
   */
  function invalidate(sessionId: string, paths: string[]): void {
    for (const p of paths) {
      const cur = nodeStatus.value.get(p)
      if (cur === 'loaded') nodeStatus.value.set(p, 'invalidated') // D-017 失效转移
    }
  }

  return {
    tree, expandedPaths, selectedPath, gitOverlay, nodeStatus, showIgnored,
    currentFile,
    setTree, setNodeStatus, setGitOverlay, invalidate,
  }
})
