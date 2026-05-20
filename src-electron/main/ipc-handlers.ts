import path from 'node:path'
import { ipcMain, BrowserWindow, app, dialog } from 'electron'
import { RuntimeManager } from './runtime-manager.js'
import { WindowManager, initialWindowState } from './window-manager.js'
import type { WindowState } from '@xyz-agent/shared'

export interface OpenSettingsWindowResult {
  type: 'focused-existing' | 'created-new'
}

/**
 * 注册所有 IPC handlers。
 * 移植自 src-tauri/src/commands/settings_window.rs + lib.rs 中的 invoke_handler。
 */
export function registerIpcHandlers(deps: {
  getMainWindow: () => BrowserWindow | null
  getSettingsWindow: () => BrowserWindow | null
  setSettingsWindow: (win: BrowserWindow | null) => void
  sidecarManager: RuntimeManager
  isDev: boolean
  createWindow: (options?: { windowId?: string; sessionId?: string }) => BrowserWindow
  windowManager: WindowManager
}): void {
  const { getSettingsWindow, setSettingsWindow, sidecarManager, isDev, createWindow, windowManager } = deps

  ipcMain.handle('open-settings-window', (): OpenSettingsWindowResult => {
    const existing = getSettingsWindow()
    if (existing && !existing.isDestroyed()) {
      existing.focus()
      return { type: 'focused-existing' }
    }

    const settingsWin = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false,
      title: 'xyz-agent - Settings',
    })

    settingsWin.once('ready-to-show', () => {
      settingsWin.maximize()
      settingsWin.show()
    })

    if (isDev) {
      settingsWin.loadURL('http://localhost:1420/settings.html')
    } else {
      // 生产模式：从渲染进程产物加载
      settingsWin.loadFile(path.join(app.getAppPath(), 'renderer/dist/settings.html'))
    }

    settingsWin.on('closed', () => {
      setSettingsWindow(null)
    })

    setSettingsWindow(settingsWin)
    return { type: 'created-new' }
  })

  ipcMain.handle('get-runtime-port', (): number | null => {
    return sidecarManager.port
  })

  // ── 窗口管理 ─────────────────────────────────────────────────────
  ipcMain.handle('create-window', async (_event, options?: { sessionId?: string }) => {
    const windowId = windowManager.generateId()
    const win = createWindow({ windowId, sessionId: options?.sessionId })
    windowManager.register(windowId, win, initialWindowState(windowId))
    // Notify all existing windows about the new window
    broadcastWindowList()
    return { windowId }
  })

  ipcMain.handle('get-windows', () => {
    return windowManager.getAll()
  })

  ipcMain.handle('focus-window', (_event, windowId: string) => {
    windowManager.focus(windowId)
  })

  ipcMain.handle('update-window-state', (_event, windowId: string, state: Partial<WindowState>) => {
    windowManager.updateState(windowId, state)
  })

  // ── 目录选择器 ──────────────────────────────────────────────────
  ipcMain.handle('pick-directory', async (_event, options?: { title?: string }) => {
    const focusedWin = BrowserWindow.getFocusedWindow()
    if (!focusedWin) return { canceled: true, path: null }
    const result = await dialog.showOpenDialog(focusedWin, {
      properties: ['openDirectory'],
      title: options?.title ?? '选择项目目录',
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: null }
    }
    return { canceled: false, path: result.filePaths[0] }
  })

  // Broadcast current window list to all renderer processes
  function broadcastWindowList() {
    const allWindows = BrowserWindow.getAllWindows()
    for (const win of allWindows) {
      if (!win.isDestroyed()) {
        win.webContents.send('window-list-updated')
      }
    }
  }

  // Set up window list change callback on WindowManager
  windowManager.setOnWindowListChanged(() => {
    broadcastWindowList()
  })
}
