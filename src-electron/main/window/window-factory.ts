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
    // mac：hidden + trafficLightPosition 精确控制红黄绿位置（对齐 chrome 按钮中线 + 侧边栏左缘）。
    //   不用 hiddenInset：inset 模式强制红黄绿水平内缩，trafficLightPosition.x 被系统忽略。
    //   hidden 模式下红黄绿仍由 OS 绘制（点击/全屏 hover 行为不变），但位置完全可控。
    //   三处 chrome（红黄绿 / AppNavControls 浮层 / PanelHeader 内按钮）统一对齐到 header 中线 y=32px：
    //     PanelHeader 高 38px，顶 y=13（12 pad + 1 MainPanel border），items-center → 中线 y=32；
    //     红黄绿高 12 → y=26（32-6），与 header chrome 按钮同一条水平中线。
    //   x=16 → 红黄绿左缘（侧边栏左缘 12 + 4 呼吸），右缘 16+52=68；header pl-[88px]（chrome 按钮从 x100 起，与红黄绿拉开 32px）。
    // win/linux：frame:false 应用自绘圆点 mimic mac（位置由 renderer TrafficLight.vue 控制，同步 x16/y26）。
    ...(process.platform === 'darwin'
      ? {
        titleBarStyle: 'hidden' as const,
        trafficLightPosition: { x: 16, y: 26 },
      }
      : { frame: false }),
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist/preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // [HISTORICAL] W16 UC-2：renderer 后台化时 chromium background timer throttling
      // 把 setTimeout 拉到 ~1s（50ms→980-1000ms 实测），mock 流式（70ms×N setTimeout 链）
      // 被拖到 20s+，采样窗口内看不到完成。agent 工作台用户发消息后切窗口是核心场景，
      // renderer 不应被节流（WS onmessage 事件驱动不受影响，但 setTimeout 基础设施会）。
      // 与 VSCode/Cursor 一致：禁用 backgroundThrottling。
      backgroundThrottling: false,
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
