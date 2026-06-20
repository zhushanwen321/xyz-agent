/**
 * Panel store —— PanelTree + activePanelId（P3：单/双 panel 主从）。
 *
 * 依赖方向：无（stores 间禁止互相 import）。
 * 骨架阶段：state 合法初始值（单 panel 根节点），getter/action 按需 throw。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PanelTree } from '@xyz-agent/shared'

/** 初始单 panel 根节点（v1 默认单 panel） */
const ROOT_PANEL_ID = 'panel-root'
const initialLayout: PanelTree = {
  type: 'panel',
  id: ROOT_PANEL_ID,
  sessionId: null,
}

export const usePanelStore = defineStore('panel', () => {
  const layout = ref<PanelTree>(initialLayout)
  const activePanelId = ref<string>(ROOT_PANEL_ID)

  return { layout, activePanelId }
})
