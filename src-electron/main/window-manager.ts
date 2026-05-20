import { BrowserWindow } from 'electron'
import type { WindowState, PanelTree } from '@xyz-agent/shared'

interface ManagedWindow {
  windowId: string
  win: BrowserWindow
  state: WindowState
}

/**
 * 多窗口管理器。
 * 负责窗口注册、状态追踪与生命周期清理。
 * 不直接创建 BrowserWindow（创建由工厂函数负责）。
 */
export class WindowManager {
  private windows = new Map<string, ManagedWindow>()
  private nextId = 1
  private onWindowListChanged?: () => void

  /** Set callback for when window list changes (create/close) */
  setOnWindowListChanged(cb: () => void): void {
    this.onWindowListChanged = cb
  }

  generateId(): string {
    return `win-${this.nextId++}`
  }

  register(windowId: string, win: BrowserWindow, initialState: WindowState): void {
    this.windows.set(windowId, { windowId, win, state: initialState })
    win.on('closed', () => {
      this.windows.delete(windowId)
      this.onWindowListChanged?.()
    })
  }

  unregister(windowId: string): void {
    this.windows.delete(windowId)
  }

  get(windowId: string): BrowserWindow | undefined {
    return this.windows.get(windowId)?.win
  }

  getAll(): WindowState[] {
    return Array.from(this.windows.values()).map(w => w.state)
  }

  updateState(windowId: string, state: Partial<WindowState>): void {
    const managed = this.windows.get(windowId)
    if (managed) {
      managed.state = { ...managed.state, ...state }
    }
  }

  focus(windowId: string): void {
    const managed = this.windows.get(windowId)
    if (managed && !managed.win.isDestroyed()) {
      managed.win.focus()
    }
  }

  close(windowId: string): void {
    const managed = this.windows.get(windowId)
    if (managed && !managed.win.isDestroyed()) {
      managed.win.close()
    }
  }

  get windowCount(): number {
    return this.windows.size
  }

  /**
   * 在所有窗口的 pane 树中查找已绑定指定 sessionId 的窗口。
   * 返回 { windowId, paneId } 或 null。
   */
  findSessionBySessionId(sessionId: string): { windowId: string; paneId: string } | null {
    for (const { windowId, state } of this.windows.values()) {
      const paneId = findPaneBySessionId(state.panelTree, sessionId)
      if (paneId) return { windowId, paneId }
    }
    return null
  }
}

// 递归遍历 pane 树，找到 sessionId 对应的 pane leaf id
function findPaneBySessionId(node: PanelTree, sessionId: string): string | null {
  if (node.type === 'pane') return node.sessionId === sessionId ? node.id : null
  if (!node.children || node.children.length < 2) return null
  return findPaneBySessionId(node.children[0], sessionId) ?? findPaneBySessionId(node.children[1], sessionId)
}

export function initialWindowState(windowId: string): WindowState {
  return {
    windowId,
    panelTree: {
      type: 'pane',
      id: `pane-${windowId}`,
      sessionId: null,
    },
    focusedPanelId: `pane-${windowId}`,
    sessionIds: [],
  }
}
