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
import type { IpcHandlerDeps } from '../interfaces.js'

/**
 * 注册桥接 IPC handler（runtime port / 窗口管理系列）。
 *
 * @param deps 注入的依赖（runtime/windowManager/createWindow）
 */
export function registerBridgeHandlers(deps: IpcHandlerDeps): void {
  void deps
  void ipcMain; void BrowserWindow
  throw new Error('not implemented: registerBridgeHandlers')
}

/**
 * 广播窗口列表变化到所有 renderer 进程。
 * 在 createWindow / window close 时触发。
 */
export function broadcastWindowList(): void {
  void BrowserWindow
  throw new Error('not implemented: broadcastWindowList')
}
