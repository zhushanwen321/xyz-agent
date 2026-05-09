import { BrowserWindow, globalShortcut } from 'electron'

type ShortcutType = 'standard' | 'focus' | 'settings'

const SHORTCUTS: Record<string, ShortcutType> = {
  'CommandOrControl+1': 'standard',
  'CommandOrControl+3': 'focus',
  'CommandOrControl+,': 'settings',
}

/**
 * 注册全局快捷键，通过主窗口 webContents.send('shortcut', type) 发送给渲染进程。
 * 移植自 src-tauri/src/shortcuts.rs
 */
export function registerShortcuts(mainWindow: BrowserWindow): void {
  for (const [accelerator, type] of Object.entries(SHORTCUTS)) {
    globalShortcut.register(accelerator, () => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('shortcut', type)
      }
    })
  }
}

/** 注销所有全局快捷键 */
export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll()
}
