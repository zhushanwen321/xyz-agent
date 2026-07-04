/**
 * PanelTree 纯函数工具。
 *
 * 对应 spec §4.2 M3：Main 不解析 PanelTree 内部，只做跨窗口 session 查询。
 *
 * 依赖方向：无下游依赖（纯函数，type-only import shared）。
 * 这类纯函数文件不深化骨架——签名即设计（methodology §1）。
 *
 * [HISTORICAL] MAX_PANE_DEPTH=16：防畸形 payload 导致 stack overflow。
 */
import type { PanelTree, WindowState } from '@xyz-agent/shared'

/** 递归深度上限，防畸形 payload 导致 stack overflow */
export const MAX_PANEL_DEPTH = 16

/**
 * 在 pane 树中递归查找已绑定指定 sessionId 的 panel leaf id。
 * 限制递归深度防止畸形 payload。
 *
 * @param node 树根
 * @param sessionId 目标 session
 * @param depth 当前深度（外部调用传 0）
 * @returns 命中的 panel id，或 null
 */
export function findPanelBySessionId(node: PanelTree, sessionId: string, depth = 0): string | null {
  if (depth > MAX_PANEL_DEPTH) return null
  // [HISTORICAL] W4：判别 key 是 'panel'（非 'pane'）。叶子匹配 sessionId，分叉递归双子节点。
  if (node.type === 'panel') return node.sessionId === sessionId ? node.id : null
  return findPanelBySessionId(node.children[0], sessionId, depth + 1)
    ?? findPanelBySessionId(node.children[1], sessionId, depth + 1)
}

/**
 * 生成窗口的初始 WindowState（单 panel 空叶子）。
 *
 * @param windowId 窗口 id（用于生成 panel id）
 */
export function initialWindowState(windowId: string): WindowState {
  // [HISTORICAL] W4：panel id 前缀 'panel-'（非 'pane-'）。
  const panelId = `panel-${windowId}`
  return {
    windowId,
    panelTree: {
      type: 'panel',
      id: panelId,
      sessionId: null,
    },
    focusedPanelId: panelId,
    sessionIds: [],
  }
}
