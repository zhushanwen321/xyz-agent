/**
 * 特权 IPC handler（需 OS 能力）。
 *
 * 对应 spec §4.2 M4「特权 handler」：openExternal / pickDirectory。
 * 每个单独做输入校验（委托 input-validators）。
 *
 * [HISTORICAL] 不变量：
 * - openExternal 校验 http/https（isValidExternalUrl）
 * - pickDirectory 用 BrowserWindow.getFocusedWindow()（无聚焦窗口返回 canceled）
 *
 * 依赖方向：privileged-handlers → electron(dialog/shell/BrowserWindow) + input-validators + interfaces
 */
import { ipcMain, BrowserWindow, dialog, shell } from 'electron'
import type { IpcHandlerDeps } from '../interfaces.js'
import { isValidExternalUrl } from './input-validators.js'

/**
 * 注册特权 IPC handler（open-external / pick-directory）。
 *
 * @param deps 注入的依赖
 */
export function registerPrivilegedHandlers(deps: IpcHandlerDeps): void {
  void deps
  // open-external：校验 http/https 后交给系统浏览器
  ipcMain.handle('open-external', async (_event, url: string): Promise<boolean> => {
    // [HISTORICAL] 安全检查：只允许 http/https 协议（防 file:// / javascript: 等）
    if (!isValidExternalUrl(url)) return false
    try {
      await shell.openExternal(url)
      return true
    } catch (err) {
      // openExternal 失败不致命，返回 false 让调用方降级
      console.error('[ipc] open-external failed:', err)
      return false
    }
  })

  // pick-directory：用聚焦窗口打开目录选择器（无聚焦窗口返回 canceled）
  // [W7] 风格对齐 open-external：dialog 抛异常时 console.error + 返回 {canceled:true, path:null}，
  // 而非依赖 ipcMain.handle 的 invoke rejection 兜底。降级目标对称：无聚焦窗口 / dialog 崩溃都返回 canceled。
  ipcMain.handle('pick-directory', async (_event, options?: { title?: string }) => {
    const focusedWin = BrowserWindow.getFocusedWindow()
    if (!focusedWin) return { canceled: true, path: null }
    try {
      const result = await dialog.showOpenDialog(focusedWin, {
        properties: ['openDirectory'],
        title: options?.title ?? '选择项目目录',
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, path: null }
      }
      return { canceled: false, path: result.filePaths[0] }
    } catch (err) {
      console.error('[ipc] pick-directory failed:', err)
      return { canceled: true, path: null }
    }
  })

  // ── 窗口控制（win/linux 自绘 traffic-light 圆点点击，shell spec §五方案 X）─────
  // mac 红黄绿是系统按钮不走这里。fromWebContents 按 sender 定位调用窗口，多窗口安全。
  ipcMain.handle('window-minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.handle('window-toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window-close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}
