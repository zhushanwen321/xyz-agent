/**
 * 窗口工厂。
 *
 * 对应 spec §4.2 M2/M3：WindowManager 不直接创建 BrowserWindow，
 * 创建职责由此模块承担。含 dev 模式 Vite 就绪轮询。
 *
 * [HISTORICAL] 不变量：
 * - dev 模式 waitForVite 轮询（解决 concurrently 下 Electron 比 Vite 先启动白屏）
 * - preload 路径：dist/preload/preload.cjs（electron-builder files 白名单对应）
 * - contextIsolation: true / nodeIntegration: false（Electron 安全默认）
 * - windowId 注入到 URL query，renderer 读取后用于注册到 WindowManager
 *
 * 依赖方向：window-factory → electron + main/interfaces（type-only）
 */
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { WindowOptions } from '../interfaces.js'

/** Dev 模式 Vite URL */
export const VITE_DEV_URL = 'http://localhost:1420'

/** 等待 Vite dev server 就绪的总超时 */
export const VITE_READY_TIMEOUT_MS = 30_000

/** Vite 轮询间隔 */
export const VITE_POLL_INTERVAL_MS = 300

/**
 * 等待 Vite dev server 就绪（轮询直到连接成功）。
 * 解决 concurrently 下 Electron 比 Vite 先启动导致白屏。
 *
 * @param url Vite 地址
 * @param timeoutMs 总超时
 * @throws 超时抛 Error
 */
export async function waitForVite(url: string, timeoutMs = VITE_READY_TIMEOUT_MS): Promise<void> {
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

/**
 * 创建 BrowserWindow 并加载内容（dev: Vite URL / prod: index.html）。
 *
 * @param options.windowId 指定窗口 id（不传由调用方生成）
 * @param options.sessionId 可选，携带 session 迁移
 * @param deps.isDev 是否开发模式
 * @param deps.generateId windowManager 引用（用于分配 id）
 */
export async function createWindow(
  options: WindowOptions | undefined,
  deps: { isDev: boolean; generateId: () => string },
): Promise<{ win: BrowserWindow; windowId: string }> {
  const windowId = options?.windowId ?? deps.generateId()

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: 'xyz-agent',
    // 跨平台窗口装饰（shell spec §五方案 X）
    // mac：hiddenInset 让系统画红黄绿浮 sidebar 左上；win/linux：frame:false 应用自绘圆点 mimic mac
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : { frame: false }),
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist/preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  if (deps.isDev) {
    const params = new URLSearchParams({ windowId })
    if (options?.sessionId) params.set('sessionId', options.sessionId)
    await waitForVite(VITE_DEV_URL)
    win.loadURL(`${VITE_DEV_URL}?${params.toString()}`)
    win.webContents.openDevTools()
  } else {
    const query: Record<string, string> = { windowId }
    if (options?.sessionId) query.sessionId = options.sessionId
    win.loadFile(path.join(app.getAppPath(), 'renderer/dist/index.html'), { query })
  }

  return { win, windowId }
}
