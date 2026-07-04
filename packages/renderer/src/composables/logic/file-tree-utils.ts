/**
 * file-tree-utils —— FileNode 树遍历纯函数（F4 去重）。
 *
 * 抽取自 stores/fileTree.ts 与 composables/features/useFileTree.ts 两处复制粘贴的同一
 * 深度优先遍历算法（findNodeByPath 返回节点 / findNodePath 仅判存在）。findNodePath 本是
 * findNodeByPath 的布尔版（`findNodeByPath(...) !== null`），现归一为单一实现，调用方按需取节点或布尔。
 *
 * 纯函数 + 无副作用：不依赖 vue 响应式 / pinia store，可被 store 与 composable 安全复用。
 */
import type { FileNode } from '@xyz-agent/shared'

/**
 * 在 FileNode[] 树中按 path 深度优先查找节点。
 * @param nodes 顶层节点数组（或某 dir 的 children）
 * @param path 目标节点的相对路径（node.path 字段比对）
 * @returns 命中节点；未找到返回 null
 */
export function findNodeByPath(nodes: FileNode[], path: string): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.children) {
      const found = findNodeByPath(node.children, path)
      if (found) return found
    }
  }
  return null
}

/**
 * 判断 FileNode[] 树中是否存在指定 path 的节点（findNodeByPath 的布尔版）。
 * @param nodes 顶层节点数组（或某 dir 的 children）
 * @param path 目标路径
 * @returns 存在返回 true，否则 false
 */
export function findNodePath(nodes: FileNode[], path: string): boolean {
  return findNodeByPath(nodes, path) !== null
}
