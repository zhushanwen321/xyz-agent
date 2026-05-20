import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { PaneTree, PaneLeaf, SplitNode } from '@xyz-agent/shared'

// --- 辅助函数 ---

function flattenTree(node: PaneTree): PaneLeaf[] {
  if (node.type === 'pane') return [node]
  return [...flattenTree(node.children[0]), ...flattenTree(node.children[1])]
}

/**
 * 在树中查找 targetId 的父 SplitNode 及孩子索引。
 * 若 targetId 是根节点（唯一 pane）则返回 null。
 */
function findParent(root: PaneTree, targetId: string): { parent: SplitNode, index: 0 | 1 } | null {
  if (root.type === 'pane') return null
  for (let i = 0 as 0 | 1; i <= 1; i++) {
    const child = root.children[i]
    if (child.type === 'pane' && child.id === targetId) return { parent: root, index: i }
    if (child.type === 'split') {
      const found = findParent(child, targetId)
      if (found) return found
    }
  }
  return null
}

/**
 * 不可变替换：在 tree 中找到 id === targetId 的节点，替换为 replacement。
 * 递归创建新对象，未受影响的分支保持原引用。
 */
function replaceInTree(root: PaneTree, targetId: string, replacement: PaneTree): PaneTree {
  if (root.type === 'pane') return root.id === targetId ? replacement : root
  if (root.id === targetId) return replacement
  return {
    ...root,
    children: [
      replaceInTree(root.children[0], targetId, replacement),
      replaceInTree(root.children[1], targetId, replacement),
    ],
  }
}

/**
 * 按 SplitNode.id 更新 ratio，clamp 到 [0.1, 0.9]。
 */
function updateRatioInTree(root: PaneTree, nodeId: string, ratio: number): PaneTree {
  if (root.type === 'pane') return root
  if (root.id === nodeId) return { ...root, ratio: clampRatio(ratio) }
  return {
    ...root,
    children: [
      updateRatioInTree(root.children[0], nodeId, ratio),
      updateRatioInTree(root.children[1], nodeId, ratio),
    ],
  }
}

const RATIO_MIN = 0.1
const RATIO_MAX = 0.9

function clampRatio(v: number): number {
  return Math.max(RATIO_MIN, Math.min(RATIO_MAX, v))
}

// --- Store ---

export const usePaneStore = defineStore('pane', () => {
  const defaultPane: PaneLeaf = { type: 'pane', id: crypto.randomUUID(), sessionId: null }
  const tree = ref<PaneTree>(defaultPane)
  const focusedPaneId = ref<string>(defaultPane.id)

  // --- Getters ---

  const panes = computed(() => flattenTree(tree.value))
  const paneCount = computed(() => panes.value.length)
  const focusedPane = computed(() => panes.value.find(p => p.id === focusedPaneId.value))
  const MAX_PANES = 4
  const canSplit = computed(() => paneCount.value < MAX_PANES)

  // --- Actions ---

  function splitPane(paneId: string, direction: 'horizontal' | 'vertical'): boolean {
    if (!canSplit.value) return false

    const existingPane = panes.value.find(p => p.id === paneId)
    if (!existingPane) return false

    const newPane: PaneLeaf = { type: 'pane', id: crypto.randomUUID(), sessionId: null }
    const splitNode: SplitNode = {
      type: 'split',
      id: crypto.randomUUID(),
      direction,
      children: [existingPane, newPane],
      ratio: 0.5,
    }

    tree.value = replaceInTree(tree.value, paneId, splitNode)
    focusedPaneId.value = newPane.id
    return true
  }

  function unbindSession(paneId: string): void {
    const pane = panes.value.find(p => p.id === paneId)
    if (!pane || pane.sessionId === null) return
    const updated: PaneLeaf = { ...pane, sessionId: null }
    tree.value = replaceInTree(tree.value, paneId, updated)
  }

  function closeEmptyPane(paneId: string): void {
    if (paneCount.value <= 1) return

    const parent = findParent(tree.value, paneId)
    if (!parent) return

    const siblingIndex = parent.index === 0 ? 1 : 0
    const sibling = parent.parent.children[siblingIndex]

    // 用兄弟节点替换父 SplitNode
    tree.value = replaceInTree(tree.value, parent.parent.id, sibling)

    // 若被关闭的是焦点 pane，聚焦到兄弟节点的第一个后代 pane
    if (focusedPaneId.value === paneId) {
      const siblingPanes = flattenTree(sibling)
      focusedPaneId.value = siblingPanes[0].id
    }
  }

  function bindSession(paneId: string, sessionId: string): void {
    const pane = panes.value.find(p => p.id === paneId)
    if (!pane) return
    const updated: PaneLeaf = { ...pane, sessionId }
    tree.value = replaceInTree(tree.value, paneId, updated)
    focusedPaneId.value = paneId
  }

  function updateRatio(nodeId: string, ratio: number): void {
    tree.value = updateRatioInTree(tree.value, nodeId, ratio)
  }

  function navigateToPane(paneId: string): void {
    focusedPaneId.value = paneId
  }

  function navigateNext(): void {
    const idx = panes.value.findIndex(p => p.id === focusedPaneId.value)
    if (idx === -1) return
    const nextIdx = (idx + 1) % paneCount.value
    focusedPaneId.value = panes.value[nextIdx].id
  }

  function navigatePrev(): void {
    const idx = panes.value.findIndex(p => p.id === focusedPaneId.value)
    if (idx === -1) return
    const prevIdx = (idx - 1 + paneCount.value) % paneCount.value
    focusedPaneId.value = panes.value[prevIdx].id
  }

  function mergeToSingle(): void {
    // 保留当前聚焦 pane 的 sessionId，若无聚焦则取第一个 pane 的
    const sessionId = focusedPane.value?.sessionId ?? panes.value[0]?.sessionId ?? null
    const newPane: PaneLeaf = { type: 'pane', id: crypto.randomUUID(), sessionId }
    tree.value = newPane
    focusedPaneId.value = newPane.id
  }

  /**
   * 智能打开 session：
   * 1. 已在某个 pane 中 → 导航到该 pane
   * 2. 只有一个空 pane → 直接绑定
   * 3. 只有一个有内容的 pane → split 后绑定到新 pane
   * 4. pane 数 2-3 → split 后绑定到新 pane
   * 5. 4 个 pane 已达上限 → 返回 false
   */
  async function openSessionSmart(sessionId: string): Promise<boolean> {
    const existingPane = panes.value.find(p => p.sessionId === sessionId)
    if (existingPane) {
      navigateToPane(existingPane.id)
      return true
    }

    if (paneCount.value === 1 && panes.value[0].sessionId === null) {
      bindSession(focusedPaneId.value, sessionId)
      return true
    }

    if (paneCount.value === 1) {
      splitPane(focusedPaneId.value, 'horizontal')
      bindSession(focusedPaneId.value, sessionId)
      return true
    }

    // 已有 2-3 个面板 → 创建新窗口进行分流
    const MIN_PANES_FOR_NEW_WINDOW = 2
    if (paneCount.value >= MIN_PANES_FOR_NEW_WINDOW && paneCount.value < MAX_PANES) {
      const { useWindowStore } = await import('./window')
      const windowStore = useWindowStore()
      void windowStore.createWindow(sessionId)
      return true
    }

    return false
  }

  return {
    // state
    tree, focusedPaneId,
    // getters
    panes, paneCount, focusedPane, canSplit,
    // actions
    splitPane, unbindSession, closeEmptyPane, bindSession,
    updateRatio, navigateToPane, navigateNext, navigatePrev, mergeToSingle,
    openSessionSmart,
  }
})
