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
    void cb
    throw new Error('not implemented: setOnWindowListChanged')
  }

  /** 生成下一个窗口 id（win-1, win-2, ...） */
  generateId(): string {
    throw new Error('not implemented: generateId')
  }

  /** 注册窗口 + 绑定 fullscreen/closed 事件 */
  register(windowId: string, win: BrowserWindow, initialState: WindowState): void {
    void windowId; void win; void initialState
    throw new Error('not implemented: register')
  }

  /** 注销窗口（仅从 Map 移除，不关闭 BrowserWindow） */
  unregister(windowId: string): void {
    void windowId
    throw new Error('not implemented: unregister')
  }

  /** 取窗口 BrowserWindow 引用 */
  get(windowId: string): BrowserWindow | undefined {
    void windowId
    throw new Error('not implemented: get')
  }

  /** 取所有窗口的 WindowState 投影（供桥接 handler） */
  getAll(): WindowState[] {
    throw new Error('not implemented: getAll')
  }

  /** 合并更新窗口状态（Partial，供 renderer 推送投影） */
  updateState(windowId: string, patch: Partial<WindowState>): void {
    void windowId; void patch
    throw new Error('not implemented: updateState')
  }

  /** 聚焦窗口 */
  focus(windowId: string): void {
    void windowId
    throw new Error('not implemented: focus')
  }

  /** 关闭窗口 */
  close(windowId: string): void {
    void windowId
    throw new Error('not implemented: close')
  }

  /** 当前窗口数 */
  get windowCount(): number {
    throw new Error('not implemented: windowCount getter')
  }

  /**
   * 在所有窗口的 panel 树中查找已绑定指定 sessionId 的窗口。
   * 委托给纯函数 findPanelBySessionId（panel-tree-utils）。
   */
  findSessionBySessionId(sessionId: string): { windowId: string; paneId: string } | null {
    void sessionId
    // findPanelBySessionId 当前为骨架占位，实际实现会遍历 this.windows 调用它
    void findPanelBySessionId
    throw new Error('not implemented: findSessionBySessionId')
  }
}
