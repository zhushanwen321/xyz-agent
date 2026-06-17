/**
 * Window domain —— M2 Window Manager IPC（design.md D1）。
 *
 * 封装 preload 的窗口管理 IPC：createWindow/getWindows/focusWindow/findSessionWindow/
 * updateWindowState + 3 个窗口事件订阅。
 * 经 IpcTransport 注入，ipc 为 undefined（web/mock）时方法优雅降级。
 */
import type { WindowState } from '@xyz-agent/shared'
import type { IpcTransport } from '../ipc-transport'

export interface WindowDomain {
  /** 创建新窗口，可选携带 sessionId 迁移。 */
  create: (sessionId?: string) => Promise<{ windowId: string } | undefined>
  /** 获取所有窗口状态列表。 */
  list: () => Promise<WindowState[] | undefined>
  /** 聚焦指定窗口。 */
  focus: (windowId: string) => void
  /** 查找指定 session 所在的窗口，返回 { windowId } 或 null。 */
  findSession: (sessionId: string) => Promise<{ windowId: string } | null>
  /** 更新指定窗口状态（panelTree 等推给 Main 镜像）。 */
  updateState: (windowId: string, state: Record<string, unknown>) => void
  /** 监听窗口创建事件，返回取消函数。 */
  onCreated: (cb: (windowId: string) => void) => () => void
  /** 监听窗口关闭事件，返回取消函数。 */
  onClosed: (cb: (windowId: string) => void) => () => void
  /** 监听窗口列表变化事件，返回取消函数。 */
  onListUpdated: (cb: () => void) => () => void
}

export const windowApi = (t: IpcTransport): WindowDomain => ({
  create: (sessionId) => Promise.resolve(t.ipc?.createWindow(sessionId)),
  list: () => Promise.resolve(t.ipc?.getWindows()),
  focus: (windowId) => {
    t.ipc?.focusWindow?.(windowId)
  },
  findSession: (sessionId) => t.ipc?.findSessionWindow(sessionId) ?? Promise.resolve(null),
  updateState: (windowId, state) => {
    t.ipc?.updateWindowState?.(windowId, state)
  },
  onCreated: (cb) => t.ipc?.onWindowCreated(cb) ?? (() => {}),
  onClosed: (cb) => t.ipc?.onWindowClosed(cb) ?? (() => {}),
  onListUpdated: (cb) => t.ipc?.onWindowListUpdated(cb) ?? (() => {}),
})
