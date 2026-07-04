export interface PanelLeaf {
  type: 'panel'
  id: string
  sessionId: string | null
}

export interface SplitNode {
  type: 'split'
  id: string
  direction: 'horizontal' | 'vertical'
  children: [PanelTree, PanelTree]
  ratio: number // 0.0~1.0，拖拽可调
}

export type PanelTree = PanelLeaf | SplitNode

export interface WindowState {
  windowId: string
  panelTree: PanelTree
  focusedPanelId: string
  sessionIds: string[]
}
