/**
 * Renderer 本地类型（非 shared 协议类型）。
 *
 * - NavEntry: 导航历史栈条目（D1 状态驱动路由）
 * - DerivedStatus: SessionStatus 前端派生 5 态（D6，shared 只有 'active'|'idle'）
 * - PanelTreeNode: Panel 树节点（P3），复用 shared.PanelTree，不重复 union
 */
import type { PanelTree } from '@xyz-agent/shared'

/** 导航历史栈条目（plan-frontend §4） */
export type NavEntry = {
  view: 'chat' | 'overview' | 'settings'
  sessionId?: string
  activeTab?: string
}

/** SessionStatus 前端派生 5 态（D6） */
export type DerivedStatus = 'running' | 'waiting' | 'done' | 'stopped' | 'error'

/** Panel 树节点（单/双 panel），复用 shared.PanelTree（PanelLeaf | SplitNode） */
export type PanelTreeNode = PanelTree
