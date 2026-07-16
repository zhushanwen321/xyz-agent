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
    // E2E 模式用 showInactive：窗口渲染但不抢焦点，避免跑 E2E 时打断用户工作
    // （Playwright Electron 不支持 headless，macOS 无 xvfb；showInactive 是不抢焦点的唯一干净方案）
    if (process.env.XYZ_E2E === '1') {
      win.showInactive()
    } else {
      win.show()
    }
  })

  // W7 加载失败 / 渲染进程崩溃监听（webContents 创建后立即挂，覆盖 loadFile/loadURL 全过程）：
  //   - did-fail-load：loadURL/loadFile 失败（如 Vite 重启中、构建产物损坏）。打 error 日志。
  //   - render-process-gone：渲染进程崩溃（OOM / 崩溃）。打 error 日志。
  // 两者目前只打日志便于诊断；此处不持有 windowManager 引用，windows Map 的清理由
  //   win 'closed' 事件（window-manager.register 已绑定）兜底，崩溃窗口最终会触发 closed。
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.error(
      `[window] did-fail-load: windowId=${windowId} url=${validatedURL} ` +
        `code=${errorCode} desc=${errorDescription}`,
    )
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(
      `[window] render-process-gone: windowId=${windowId} reason=${details?.reason} exitCode=${details?.exitCode}`,
    )
  })

  // E2E 是一类部署形态（已构建产物 + mock 注入），架构正确归位是独立分支而非 hack isDev：
  //   - 跳过 Vite dev server 轮询（E2E 不起 dev server，否则 waitForVite 30s 超时）
  //   - 加载构建产物 index.html（与 prod 同源，验证真实渲染链路）
  //   - mock 数据由 renderer 侧 import.meta.env.VITE_E2E 注入（main 不参与）
  const isE2E = process.env.XYZ_E2E === '1'
  try {
    if (isE2E) {
      const query: Record<string, string> = { windowId }
      if (options?.sessionId) query.sessionId = options.sessionId
      win.loadFile(path.join(app.getAppPath(), 'renderer/dist/index.html'), { query })
    } else if (deps.isDev) {
      const params = new URLSearchParams({ windowId })
      if (options?.sessionId) params.set('sessionId', options.sessionId)
      // W7 幽灵窗口清理：BrowserWindow 已在 show:false 状态下创建，若 Vite dev server
      // 在超时内未就绪（waitForVite 抛错），必须 destroy 已创建的窗口，否则泄漏一个隐藏窗口。
      await waitForVite(VITE_DEV_URL)
      win.loadURL(`${VITE_DEV_URL}?${params.toString()}`)
      // DevTools 默认关闭：需要时显式 XYZ_DEVTOOLS=1 npm run dev 打开
      if (process.env.XYZ_DEVTOOLS === '1') {
        win.webContents.openDevTools()
      }
    } else {
      const query: Record<string, string> = { windowId }
      if (options?.sessionId) query.sessionId = options.sessionId
      win.loadFile(path.join(app.getAppPath(), 'renderer/dist/index.html'), { query })
    }
  } catch (err) {
    // W7 E3 幽灵窗口清理：waitForVite 超时或加载阶段抛错时，destroy 已创建的 BrowserWindow，
    // 避免泄漏隐藏窗口（show:false 的窗口用户感知不到，资源却已占用）。
    if (!win.isDestroyed()) {
      win.destroy()
    }
    throw err
  }

  return { win, windowId }
}
