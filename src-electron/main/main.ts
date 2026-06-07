import path from 'node:path'
import { homedir } from 'node:os'
import { app, BrowserWindow, protocol, net } from 'electron'
import { RuntimeManager } from './runtime-manager.js'
import { WindowManager, initialWindowState } from './window-manager.js'
import { registerShortcuts, unregisterShortcuts } from './shortcuts.js'
import { registerIpcHandlers } from './ipc-handlers.js'

// EPIPE 兜底：concurrently / 终端关闭后 pipe 断开，console 写入会触发 uncaught exception
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.stdout.destroy()
})
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.stderr.destroy()
})

// ── 路径 & 模式 ──────────────────────────────────────────────────
const isDev = !app.isPackaged

// Dev 模式：自动隔离数据目录和端口，防止与 prod 实例冲突
if (isDev) {
  process.env.XYZ_AGENT_DATA_DIR = process.env.XYZ_AGENT_DATA_DIR
    ?? path.join(homedir(), '.xyz-agent-dev')
  process.env.XYZ_AGENT_PORT_OFFSET = process.env.XYZ_AGENT_PORT_OFFSET ?? '100'
  console.log(
    '[main] dev mode: isolated data dir =', process.env.XYZ_AGENT_DATA_DIR,
    ', port offset =', process.env.XYZ_AGENT_PORT_OFFSET,
  )
}

const VITE_DEV_URL = 'http://localhost:1420'

/**
 * 等待 Vite dev server 就绪（轮询直到连接成功）
 * 解决 concurrently 下 Electron 比 Vite 先启动导致白屏的问题
 */
const VITE_READY_TIMEOUT_MS = 30_000
const VITE_POLL_INTERVAL_MS = 300

async function waitForVite(url: string, timeoutMs = VITE_READY_TIMEOUT_MS): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    // eslint-disable-next-line taste/no-silent-catch -- Vite dev server not yet ready, retry expected
    } catch {
      // Vite 还没启动，继续等待
    }
    await new Promise((r) => setTimeout(r, VITE_POLL_INTERVAL_MS))
  }
  throw new Error(`Vite dev server at ${url} did not become ready within ${timeoutMs}ms`)
}

function getProductionIndexPath(): string {
  return path.join(app.getAppPath(), 'renderer/dist/index.html')
}

// ── 全局状态 ─────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
const runtimeManager = new RuntimeManager()
const windowManager = new WindowManager()

// ── 窗口工厂 ─────────────────────────────────────────────────────
async function createWindow(options?: { windowId?: string; sessionId?: string }): Promise<BrowserWindow> {
  const windowId = options?.windowId ?? windowManager.generateId()

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: 'xyz-agent',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist/preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  if (isDev) {
    const params = new URLSearchParams({ windowId })
    if (options?.sessionId) params.set('sessionId', options.sessionId)
    await waitForVite(VITE_DEV_URL)
    win.loadURL(`${VITE_DEV_URL}?${params.toString()}`)
    win.webContents.openDevTools()
  } else {
    const query: Record<string, string> = { windowId }
    if (options?.sessionId) query.sessionId = options.sessionId
    win.loadFile(getProductionIndexPath(), { query })
  }

  return win
}

// ── 注册 IPC ─────────────────────────────────────────────────────
registerIpcHandlers({
  getMainWindow: () => mainWindow,
  getSettingsWindow: () => settingsWindow,
  setSettingsWindow: (win) => { settingsWindow = win },
  runtimeManager,
  isDev,
  createWindow,
  windowManager,
})

// ── App 生命周期 ─────────────────────────────────────────────────
app.whenReady().then(async () => {
  // 注册 local-file:// 协议，用于渲染进程加载本地文件（如图片）
  protocol.handle('local-file', (request) => {
    const filePath = decodeURIComponent(new URL(request.url).pathname)
    return net.fetch(`file://${filePath}`)
  })

  mainWindow = await createWindow({ windowId: 'win-1' })
  mainWindow.on('closed', () => { mainWindow = null })
  windowManager.register('win-1', mainWindow, initialWindowState('win-1'))

  // 1. 注册全局快捷键
  registerShortcuts(mainWindow)

  // 2. 启动 runtime（mock 模式跳过）
  if (process.env.XYZ_MOCK === '1') {
    console.log('[main] Mock mode — skipping runtime start')
  } else {
    try {
      const port = await runtimeManager.start()
      // 3. 通知渲染进程 runtime 端口
      mainWindow.webContents.send('runtime-port', port)
    } catch (err) {
      console.error('[main] Failed to start runtime, notifying renderer:', err)
      mainWindow.webContents.send('runtime-error', { message: (err as Error).message })
    }
  }
})

// 主窗口关闭时停止 runtime 并注销快捷键
app.on('window-all-closed', () => {
  // macOS 保留 runtime：activate 会复用它，避免不必要的重启
  if (process.platform !== 'darwin') {
    runtimeManager.stop()
    unregisterShortcuts()
    app.quit()
  }
})

// macOS: 点击 dock 图标时重建窗口
app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = await createWindow({ windowId: 'win-1' })
    mainWindow.on('closed', () => { mainWindow = null })
    windowManager.register('win-1', mainWindow, initialWindowState('win-1'))
    registerShortcuts(mainWindow)

    // 确保 runtime 可用（可能被 window-all-closed 或之前异常停止）
    if (process.env.XYZ_MOCK !== '1') {
      try {
        const port = await runtimeManager.start()
        mainWindow.webContents.send('runtime-port', port)
      } catch (err) {
        console.error('[main] Failed to restart runtime on activate:', err)
        mainWindow.webContents.send('runtime-error', { message: (err as Error).message })
      }
    }
  }
})

// 应用退出前清理：确保 sidecar 进程完全退出再 quit
let isQuitting = false
app.on('before-quit', (event) => {
  if (isQuitting) return // 第二次进入（app.quit() 触发），放行
  isQuitting = true
  event.preventDefault()
  runtimeManager.stop().finally(() => {
    unregisterShortcuts()
    app.quit()
  })
})
