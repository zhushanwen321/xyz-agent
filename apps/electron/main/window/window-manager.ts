/**
 * WindowManager Facade（implements IWindowManager）。
 *
 * 对应 spec §4.2 M2/M3「Window Manager」：窗口注册表 + 跨窗口 session 查询。
 *
 * [HISTORICAL] 不变量：
 * - Main 只保留跨窗口查询所需的 WindowState 投影（完整 PanelTree 由 Renderer 推送，Main 不解析内部）
 * - 不直接创建 BrowserWindow（创建委托 window-factory）
 * - fullscreen 状态变化通过 webContents.send 通知 renderer
 * - onWindowListChanged 回调：窗口 close 时触发，用于广播 window-list-updated
 *
 * 依赖方向：window-manager → interfaces + panel-tree-utils + electron
 */
import { BrowserWindow } from 'electron'
import type { WindowState } from '@xyz-agent/shared'
import type { IWindowManager } from '../interfaces.js'
import { findPanelBySessionId } from './panel-tree-utils.js'

/** 内部托管的窗口条目 */
interface ManagedWindow {
  windowId: string
  win: BrowserWindow
  state: WindowState
}

/**
 * WindowManager 实现。
 *
 * 使用方法：
 * ```ts
 * const wm = new WindowManager()
 * wm.register('win-1', win, initialWindowState('win-1'))
 * wm.findSessionBySessionId(sid)
 * ```
 */
export class WindowManager implements IWindowManager {
  private windows = new Map<string, ManagedWindow>()
  private nextId = 1
  private onWindowListChanged?: () => void

  /** 设置窗口列表变化回调（create/close 触发） */
  setOnWindowListChanged(cb: () => void): void {
    this.onWindowListChanged = cb
  }

  /** 生成下一个窗口 id（win-1, win-2, ...） */
  generateId(): string {
    return `win-${this.nextId++}`
  }

  /** 注册窗口 + 绑定 fullscreen/closed 事件 */
  register(windowId: string, win: BrowserWindow, initialState: WindowState): void {
    this.windows.set(windowId, { windowId, win, state: initialState })

    // Notify renderer when macOS fullscreen state changes
    win.on('enter-full-screen', () => {
      win.webContents.send('fullscreen-changed', { isFullscreen: true })
    })
    win.on('leave-full-screen', () => {
      win.webContents.send('fullscreen-changed', { isFullscreen: false })
    })

    win.on('closed', () => {
      this.windows.delete(windowId)
      this.onWindowListChanged?.()
    })
  }

  /** 注销窗口（仅从 Map 移除，不关闭 BrowserWindow） */
  unregister(windowId: string): void {
    this.windows.delete(windowId)
  }

  /** 取窗口 BrowserWindow 引用 */
  get(windowId: string): BrowserWindow | undefined {
    return this.windows.get(windowId)?.win
  }

  /** 取所有窗口的 WindowState 投影（供桥接 handler） */
  getAll(): WindowState[] {
    return Array.from(this.windows.values()).map(w => w.state)
  }

  /** 聚焦窗口 */
  focus(windowId: string): void {
    const managed = this.windows.get(windowId)
    if (managed && !managed.win.isDestroyed()) {
      managed.win.focus()
    }
  }

  /** 关闭窗口 */
  close(windowId: string): void {
    const managed = this.windows.get(windowId)
    if (managed && !managed.win.isDestroyed()) {
      managed.win.close()
    }
  }

  /** 当前窗口数 */
  get windowCount(): number {
    return this.windows.size
  }

  /**
   * 在所有窗口的 panel 树中查找已绑定指定 sessionId 的窗口。
   * 委托给纯函数 findPanelBySessionId（panel-tree-utils）。
   *
   * [HISTORICAL] 返回字段名 paneId 是接口契约（interfaces.ts），值是 panel leaf id。
   * renderer window domain 透传此字段，改名需同步 renderer 侧，本次不动。
   */
  findSessionBySessionId(sessionId: string): { windowId: string; paneId: string } | null {
    for (const { windowId, state } of this.windows.values()) {
      const panelId = findPanelBySessionId(state.panelTree, sessionId)
      if (panelId) return { windowId, paneId: panelId }
    }
    return null
  }
}
