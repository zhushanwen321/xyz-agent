import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { PanelTree, PanelLeaf, SplitNode } from '@xyz-agent/shared'

// --- 辅助函数 ---

function flattenTree(node: PanelTree): PanelLeaf[] {
  if (node.type === 'pane') return [node]
  return [...flattenTree(node.children[0]), ...flattenTree(node.children[1])]
}

/**
 * 在树中查找 targetId 的父 SplitNode 及孩子索引。
 * 若 targetId 是根节点（唯一 panel）则返回 null。
 */
function findParent(root: PanelTree, targetId: string): { parent: SplitNode, index: 0 | 1 } | null {
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
function replaceInTree(root: PanelTree, targetId: string, replacement: PanelTree): PanelTree {
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
function updateRatioInTree(root: PanelTree, nodeId: string, ratio: number): PanelTree {
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

export const usePanelStore = defineStore('panel', () => {
  const defaultPanel: PanelLeaf = { type: 'pane', id: crypto.randomUUID(), sessionId: null }
  const tree = ref<PanelTree>(defaultPanel)
  const focusedPanelId = ref<string>(defaultPanel.id)

  // --- Getters ---

  const panels = computed(() => flattenTree(tree.value))
  const panelCount = computed(() => panels.value.length)
  const focusedPanel = computed(() => panels.value.find(p => p.id === focusedPanelId.value))
  const MAX_PANELS = 4
  const canSplit = computed(() => panelCount.value < MAX_PANELS)

  // --- Actions ---

  function splitPanel(panelId: string, direction: 'horizontal' | 'vertical'): boolean {
    if (!canSplit.value) return false

    const existingPanel = panels.value.find(p => p.id === panelId)
    if (!existingPanel) return false

    const newPanel: PanelLeaf = { type: 'pane', id: crypto.randomUUID(), sessionId: null }
    const splitNode: SplitNode = {
      type: 'split',
      id: crypto.randomUUID(),
      direction,
      children: [existingPanel, newPanel],
      ratio: 0.5,
    }

    tree.value = replaceInTree(tree.value, panelId, splitNode)
    focusedPanelId.value = newPanel.id
    return true
  }

  function unbindSession(panelId: string): void {
    const panel = panels.value.find(p => p.id === panelId)
    if (!panel || panel.sessionId === null) return
    const updated: PanelLeaf = { ...panel, sessionId: null }
    tree.value = replaceInTree(tree.value, panelId, updated)
  }

  function closeEmptyPanel(panelId: string): void {
    if (panelCount.value <= 1) return

    const parent = findParent(tree.value, panelId)
    if (!parent) return

    const siblingIndex = parent.index === 0 ? 1 : 0
    const sibling = parent.parent.children[siblingIndex]

    // 用兄弟节点替换父 SplitNode
    tree.value = replaceInTree(tree.value, parent.parent.id, sibling)

    // 若被关闭的是焦点 panel，聚焦到兄弟节点的第一个后代 panel
    if (focusedPanelId.value === panelId) {
      const siblingPanels = flattenTree(sibling)
      focusedPanelId.value = siblingPanels[0].id
    }
  }

  function bindSession(panelId: string, sessionId: string): void {
    const panel = panels.value.find(p => p.id === panelId)
    if (!panel) return
    const updated: PanelLeaf = { ...panel, sessionId }
    tree.value = replaceInTree(tree.value, panelId, updated)
    focusedPanelId.value = panelId
  }

  function updateRatio(nodeId: string, ratio: number): void {
    tree.value = updateRatioInTree(tree.value, nodeId, ratio)
  }

  function navigateToPanel(panelId: string): void {
    focusedPanelId.value = panelId
  }

  function navigateNext(): void {
    const idx = panels.value.findIndex(p => p.id === focusedPanelId.value)
    if (idx === -1) return
    const nextIdx = (idx + 1) % panelCount.value
    focusedPanelId.value = panels.value[nextIdx].id
  }

  function navigatePrev(): void {
    const idx = panels.value.findIndex(p => p.id === focusedPanelId.value)
    if (idx === -1) return
    const prevIdx = (idx - 1 + panelCount.value) % panelCount.value
    focusedPanelId.value = panels.value[prevIdx].id
  }

  function mergeToSingle(): void {
    // 保留当前聚焦 panel 的 sessionId，若无聚焦则取第一个 panel 的
    const sessionId = focusedPanel.value?.sessionId ?? panels.value[0]?.sessionId ?? null
    const newPanel: PanelLeaf = { type: 'pane', id: crypto.randomUUID(), sessionId }
    tree.value = newPanel
    focusedPanelId.value = newPanel.id
  }

  /**
   * 智能打开 session：
   * 1. 已在当前 window 的某个 panel 中 → 导航到该 panel
   * 2. 已在其他 window 中 → 聚焦该 window
   * 3. 只有一个空 panel → 直接绑定
   * 4. 只有一个有内容的 panel → split 后绑定到新 panel
   * 5. panel 数 >= 2 → 创建新窗口
   */
  async function openSessionSmart(sessionId: string): Promise<boolean> {
    // 1. 已在当前 window 的某个 panel 中
    const existingPanel = panels.value.find(p => p.sessionId === sessionId)
    if (existingPanel) {
      navigateToPanel(existingPanel.id)
      return true
    }

    // 2. 检查是否在其他 window 中打开
    const { useWindowStore } = await import('./window')
    const windowStore = useWindowStore()
    const existing = await windowStore.findSessionWindow(sessionId)
    if (existing) {
      windowStore.focusWindow(existing.windowId)
      return true
    }

    // 3. 只有一个空 panel
    if (panelCount.value === 1 && panels.value[0].sessionId === null) {
      bindSession(focusedPanelId.value, sessionId)
      return true
    }

    // 4. 只有一个有内容的 panel → split
    if (panelCount.value === 1) {
      splitPanel(focusedPanelId.value, 'horizontal')
      bindSession(focusedPanelId.value, sessionId)
      return true
    }

    // 5. 已有 >= 2 个 panel → 创建新窗口
    if (panelCount.value < MAX_PANELS) {
      void windowStore.createWindow(sessionId)
      return true
    }

    return false
  }

  return {
    // state
    tree, focusedPanelId,
    // getters
    panels, panelCount, focusedPanel, canSplit,
    // actions
    splitPanel, unbindSession, closeEmptyPanel, bindSession,
    updateRatio, navigateToPanel, navigateNext, navigatePrev, mergeToSingle,
    openSessionSmart,
  }
})
