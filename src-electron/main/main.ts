import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import { SidecarManager } from './sidecar-manager.js'
import { registerShortcuts, unregisterShortcuts } from './shortcuts.js'
import { registerIpcHandlers } from './ipc-handlers.js'

// ── 路径 & 模式 ──────────────────────────────────────────────────
const isDev = !app.isPackaged

const VITE_DEV_URL = 'http://localhost:1420'

function getProductionIndexPath(): string {
  return path.join(app.getAppPath(), 'renderer/dist/index.html')
}

// ── 全局状态 ─────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
const sidecarManager = new SidecarManager()

// ── 注册 IPC ─────────────────────────────────────────────────────
registerIpcHandlers({
  getMainWindow: () => mainWindow,
  getSettingsWindow: () => settingsWindow,
  setSettingsWindow: (win) => { settingsWindow = win },
  sidecarManager,
  isDev,
})

// ── 窗口创建 ─────────────────────────────────────────────────────
function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: 'xyz-agent',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist/preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.once('ready-to-show', () => {
    win.maximize()
    win.show()
  })

  if (isDev) {
    win.loadURL(VITE_DEV_URL)
  } else {
    win.loadFile(getProductionIndexPath())
  }

  win.on('closed', () => {
    mainWindow = null
  })

  return win
}

// ── App 生命周期 ─────────────────────────────────────────────────
app.whenReady().then(async () => {
  mainWindow = createMainWindow()

  // 1. 注册全局快捷键
  registerShortcuts(mainWindow)

  // 2. 启动 sidecar（mock 模式跳过）
  if (process.env.XYZ_MOCK === '1') {
    console.log('[main] Mock mode — skipping sidecar start')
  } else {
    try {
      const port = await sidecarManager.start()
      // 3. 通知渲染进程 sidecar 端口
      mainWindow.webContents.send('sidecar-port', port)
    } catch (err) {
      console.error('[main] Failed to start sidecar:', err)
    }
  }
})

// 主窗口关闭时停止 sidecar 并注销快捷键
app.on('window-all-closed', () => {
  sidecarManager.stop()
  unregisterShortcuts()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// macOS: 点击 dock 图标时重建窗口
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow()
    registerShortcuts(mainWindow)
  }
})

// 应用退出前清理
app.on('before-quit', () => {
  sidecarManager.stop()
  unregisterShortcuts()
})
