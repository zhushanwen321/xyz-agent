/**
 * 桥接 IPC handler（纯转发，无副作用）。
 *
 * 对应 spec §4.2 M4「桥接 handler」：getRuntimePort / getRuntimePortOffset /
 * getWindows / focusWindow / updateWindowState / findSessionWindow / createWindow。
 * 只读 Main 内部状态或委托给 windowManager/runtime，无 OS 副作用。
 *
 * [HISTORICAL] 不变量：
 * - 桥接 handler 不做输入校验（只读/委托，无安全风险）
 * - createWindow 触发 broadcastWindowList（通知所有 renderer 窗口列表变化）
 * - windowManager.setOnWindowListChanged 注册 broadcastWindowList 回调
 *
 * 依赖方向：bridge-handlers → electron(ipcMain) + interfaces
 */
import { ipcMain, BrowserWindow } from 'electron'
import type { WindowState } from '@xyz-agent/shared'
import type { IpcHandlerDeps } from '../interfaces.js'
import { initialWindowState } from '../window/panel-tree-utils.js'

/**
 * 注册桥接 IPC handler（runtime port / 窗口管理系列）。
 *
 * @param deps 注入的依赖（runtime/windowManager/createWindow）
 */
export function registerBridgeHandlers(deps: IpcHandlerDeps): void {
  // ── runtime 端口（只读 supervisor 状态）─────────────────────────
  ipcMain.handle('get-runtime-port', () => deps.runtime.port)
  ipcMain.handle('get-runtime-port-offset', () => deps.runtime.portOffset)

  // ── runtime 手动重启（崩溃重启用尽后，用户从状态条点重试触发）─────────
  // 委托 supervisor.restartRuntime：重置策略 + start + 广播端口/失败
  ipcMain.handle('runtime-restart', async () => {
    await deps.runtime.restartRuntime()
  })

  // ── 窗口管理 ─────────────────────────────────────────────────────
  ipcMain.handle('create-window', async (_event, options?: { sessionId?: string }) => {
    const windowId = deps.windowManager.generateId()
    const win = await deps.createWindow({ windowId, sessionId: options?.sessionId })
    deps.windowManager.register(windowId, win, initialWindowState(windowId))
    // 通知所有已存在窗口：窗口列表变化
    broadcastWindowList()
    return { windowId }
  })

  ipcMain.handle('get-windows', () => {
    return deps.windowManager.getAll()
  })

  ipcMain.handle('focus-window', (_event, windowId: string) => {
    deps.windowManager.focus(windowId)
  })

  ipcMain.handle('update-window-state', (_event, windowId: string, state: Partial<WindowState>) => {
    deps.windowManager.updateState(windowId, state)
  })

  ipcMain.handle('find-session-window', (_event, sessionId: string) => {
    return deps.windowManager.findSessionBySessionId(sessionId)
  })

  // 窗口列表变化回调：create/close 时触发广播
  deps.windowManager.setOnWindowListChanged(() => {
    broadcastWindowList()
  })
}

/**
 * 广播窗口列表变化到所有 renderer 进程。
 * 在 createWindow / window close 时触发。
 */
export function broadcastWindowList(): void {
  const allWindows = BrowserWindow.getAllWindows()
  for (const win of allWindows) {
    if (!win.isDestroyed()) {
      win.webContents.send('window-list-updated')
    }
  }
}
