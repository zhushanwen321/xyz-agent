import path from 'node:path'
import { ipcMain, BrowserWindow, app } from 'electron'
import { SidecarManager } from './sidecar-manager.js'

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
  sidecarManager: SidecarManager
  isDev: boolean
}): void {
  const { getSettingsWindow, setSettingsWindow, sidecarManager, isDev } = deps

  ipcMain.handle('open-settings-window', (): OpenSettingsWindowResult => {
    const existing = getSettingsWindow()
    if (existing && !existing.isDestroyed()) {
      existing.focus()
      return { type: 'focused-existing' }
    }

    const mainWindow = deps.getMainWindow()
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

  ipcMain.handle('get-sidecar-port', (): number | null => {
    return sidecarManager.port
  })
}
