export interface PaneLeaf {
  type: 'pane'
  id: string
  sessionId: string | null
}

export interface SplitNode {
  type: 'split'
  id: string
  direction: 'horizontal' | 'vertical'
  children: [PaneTree, PaneTree]
  ratio: number // 0.0~1.0，拖拽可调
}

export type PaneTree = PaneLeaf | SplitNode

export interface WindowState {
  windowId: string
  paneTree: PaneTree
  focusedPaneId: string
  sessionIds: string[]
}
