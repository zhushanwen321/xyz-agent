/**
 * Panel store —— PanelTree + activePanelId（P3：单/双 panel 主从）。
 *
 * 依赖方向：无（stores 间禁止互相 import；session 关联由 features 层编排）。
 *
 * 状态机（workspace/spec.md）：默认单 panel 撑满 → split 成双 panel（主从）→ close 回单。
 * split 单 session 场景（新建/选择器/禁用）属 G-023 DEFERRED，v1 仅支持把已有 session
 * 载入单 panel；双 panel 的第二 session 来源待联调。但状态机本身（单↔双切换）v1 落地。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { PanelLeaf, PanelTree, SplitNode } from '@xyz-agent/shared'

/** 初始单 panel 根节点（v1 默认单 panel） */
export const ROOT_PANEL_ID = 'panel-root'
const initialLayout: PanelTree = {
  type: 'panel',
  id: ROOT_PANEL_ID,
  sessionId: null,
}

/** split 默认比例（双 panel 各占一半，workspace/spec.md 主从等宽） */
const DEFAULT_RATIO = 0.5

export const usePanelStore = defineStore('panel', () => {
  const layout = ref<PanelTree>(initialLayout)
  const activePanelId = ref<string>(ROOT_PANEL_ID)

  /** 当前是否双 panel（layout 为 split 节点） */
  const isDual = computed(() => layout.value.type === 'split')

  /** 收集所有 panel 叶子节点（单 panel 返回 1 个，双返回 2 个） */
  const panels = computed<PanelLeaf[]>(() => collectLeaves(layout.value))

  /** 找到承载指定 session 的 panel 叶子（无则 null） */
  function findPanelBySession(sessionId: string): PanelLeaf | null {
    return panels.value.find((p) => p.sessionId === sessionId) ?? null
  }

  /** 把 session 载入 active panel（单 panel 默认载入根节点） */
  function loadSession(panelId: string, sessionId: string): void {
    layout.value = updateLeaf(layout.value, panelId, (leaf) => ({ ...leaf, sessionId }))
  }

  /** 设为 active panel（主从焦点切换，workspace/spec.md 四层激活标识联动） */
  function setActive(panelId: string): void {
    if (panels.value.some((p) => p.id === panelId)) {
      activePanelId.value = panelId
    }
  }

  /**
   * Split 成双 panel：当前单 panel → horizontal split（左右主从）。
   * 原单 panel 保留为左侧（active），右侧新建空 panel（standby）。
   * G-023 DEFERRED：第二 session 的具体来源（新建/选择）待联调，这里只立结构。
   */
  function split(): void {
    if (layout.value.type !== 'panel') return
    const left = layout.value
    const right: PanelLeaf = {
      type: 'panel',
      id: `panel-${crypto.randomUUID()}`,
      sessionId: null,
    }
    const node: SplitNode = {
      type: 'split',
      id: `split-${crypto.randomUUID()}`,
      direction: 'horizontal',
      children: [left, right],
      ratio: DEFAULT_RATIO,
    }
    layout.value = node
    activePanelId.value = left.id
  }

  /**
   * 关闭 panel 回单：双 panel → 关闭指定侧，保留另一侧为单 panel。
   * 单 panel 关闭主会话需确认流（G-013 DEFERRED），v1 不处理。
   */
  function close(panelId: string): void {
    if (layout.value.type !== 'split') return
    const [a, b] = layout.value.children
    const kept = a.id === panelId ? b : a
    layout.value = kept
    activePanelId.value = kept.id
  }

  return {
    layout,
    activePanelId,
    isDual,
    panels,
    findPanelBySession,
    loadSession,
    setActive,
    split,
    close,
  }
})

/** 深度优先收集所有 panel 叶子（split → 左右子树） */
function collectLeaves(node: PanelTree): PanelLeaf[] {
  if (node.type === 'panel') return [node]
  return [...collectLeaves(node.children[0]), ...collectLeaves(node.children[1])]
}

/** 不可变更新指定 id 的叶子节点（递归重建树，保证 Vue 响应式触发） */
function updateLeaf(
  node: PanelTree,
  panelId: string,
  updater: (leaf: PanelLeaf) => PanelLeaf,
): PanelTree {
  return rewriteLeaf(node, panelId, updater)
}

function rewriteLeaf(
  node: PanelTree,
  panelId: string,
  updater: (leaf: PanelLeaf) => PanelLeaf,
): PanelTree {
  if (node.type === 'panel') {
    return node.id === panelId ? updater(node) : node
  }
  return {
    ...node,
    children: [
      rewriteLeaf(node.children[0], panelId, updater),
      rewriteLeaf(node.children[1], panelId, updater),
    ],
  }
}
