/**
 * Main 进程入口（纯编排脚本）。
 *
 * 对应 spec §4.2 M1「应用生命周期编排」。重构后 main.ts 只做两件事：
 *   ① 注册子系统（构造 MainContext + registerIpcHandlers）
 *   ② 串联 Electron 生命周期事件（whenReady / window-all-closed / activate / before-quit）
 *
 * 所有具体能力委托给 M2/M3/M4/M5。全局状态下沉到 MainContext（替代散落的 let）。
 *
 * [HISTORICAL] 不变量（必须在实现中守护）：
 *
 * 1. EPIPE 兜底：concurrently/终端关闭后 pipe 断开，console 写入触发 uncaught exception
 *    → process.stdout/stderr.on('error', EPIPE → destroy())
 *
 * 2. Dev 模式隔离：
 *    - XYZ_AGENT_DATA_DIR ?? ~/.xyz-agent-dev
 *    - XYZ_AGENT_PORT_OFFSET ?? DEV_PORT_OFFSET
 *    - app.setPath('userData', 隔离目录)  ← 防 Chromium LevelDB LOCK 竞争
 *
 * 3. local-file:// 协议路径白名单（app.getAppPath/getConfigDir/homedir/tmpdir + path.sep 后缀）
 *
 * 4. Runtime 启动时序（D1 决策）：createWindow 先于 spawn runtime
 *    - whenReady: createWindow → register → registerShortcuts → runtime.startAndNotify
 *    - activate: 同上（window-all-closed 在 macOS 不 stop runtime，activate 复用）
 *
 * 5. before-quit 二段式：event.preventDefault() → stop runtime → app.quit()
 *    （isQuitting flag 防第二次进入死循环）
 *
 * 6. window-all-closed：macOS 不 quit（activate 会复用 runtime），其他平台 stop+quit
 *
 * 生命周期时序：
 * ```
 *   app.whenReady:
 *     1. protocol.handle('local-file', 路径白名单校验)
 *     2. mainWindow = createWindow({windowId:'win-1'})
 *     3. windowManager.register('win-1', mainWindow, initialWindowState)
 *     4. shortcutRegistry.registerGlobal(mainWindow)
 *     5. if !mock: runtime.startAndNotify(mainWindow)
 *
 *   app.window-all-closed:
 *     - darwin: 保留（不 quit，activate 复用 runtime）
 *     - 其他:   runtime.stop() → shortcuts.unregisterAll() → app.quit()
 *
 *   app.activate (darwin):
 *     - 若无窗口: 重复 whenReady 的 2-5 步
 *
 *   app.before-quit:
 *     - if isQuitting: 放行
 *     - else: preventDefault → runtime.stop().finally(unregisterAll + quit)
 * ```
 *
 * 依赖方向：main.ts → context + interfaces + gateway + window-factory + 三个 Facade 实现
 */
import path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { app, protocol, net, BrowserWindow } from 'electron'
import { DEV_PORT_OFFSET } from '@xyz-agent/shared'
import { createMainContext } from './context.js'
import type { MainContext } from './interfaces.js'
import { RuntimeSupervisor } from './supervisor/runtime-supervisor.js'
import { WindowManager } from './window/window-manager.js'
import { initialWindowState } from './window/panel-tree-utils.js'
import { createWindow } from './window/window-factory.js'
import { ShortcutRegistry } from './shortcuts/shortcut-registry.js'
import { registerIpcHandlers } from './gateway/ipc-handlers.js'

// ── EPIPE 兜底 ───────────────────────────────────────────────────
// concurrently/终端关闭后 pipe 断开，console 写入触发 uncaught exception
process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.stdout.destroy()
})
process.stderr?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.stderr.destroy()
})

// ── 路径 & 模式 ──────────────────────────────────────────────────
const isDev = !app.isPackaged

/** Mirror of runtime's getConfigDir — reads XYZ_AGENT_DATA_DIR with fallback to ~/.xyz-agent/ */
function getConfigDir(): string {
  return process.env.XYZ_AGENT_DATA_DIR ?? path.join(homedir(), '.xyz-agent')
}

// Dev 模式：自动隔离数据目录和端口，防止与 prod 实例冲突
if (isDev) {
  process.env.XYZ_AGENT_DATA_DIR = process.env.XYZ_AGENT_DATA_DIR
    ?? path.join(homedir(), '.xyz-agent-dev')
  process.env.XYZ_AGENT_PORT_OFFSET = process.env.XYZ_AGENT_PORT_OFFSET ?? String(DEV_PORT_OFFSET)
  // 隔离 Electron userData，防止与 prod 实例共享 Chromium 存储（LevelDB LOCK 竞争）
  app.setPath('userData', path.join(homedir(), '.xyz-agent-dev', 'electron'))
}

// ── 全局状态容器 ─────────────────────────────────────────────────
// 构造三个 Facade + MainContext（替代旧代码散落的 let mainWindow / let settingsWindow）
const runtime = new RuntimeSupervisor()
const windows = new WindowManager()
const shortcuts = new ShortcutRegistry()
const ctx: MainContext = createMainContext({ runtime, windows, shortcuts, isDev })

/** createWindow 适配器：把 ctx.windows.generateId 注入 window-factory */
const createWindowFn = (options?: { windowId?: string; sessionId?: string }) =>
  createWindow(options, { isDev, generateId: () => ctx.windows.generateId() })
    .then(({ win }) => win)

// ── 注册 IPC ─────────────────────────────────────────────────────
registerIpcHandlers({
  getMainWindow: () => ctx.mainWindow,
  getSettingsWindow: () => ctx.settingsWindow,
  setSettingsWindow: (win) => { ctx.settingsWindow = win },
  runtime: ctx.runtime,
  isDev,
  createWindow: createWindowFn,
  windowManager: ctx.windows,
})

// ── App 生命周期编排 ─────────────────────────────────────────────

/**
 * 初始化主窗口 + 快捷键 + runtime（mock 模式跳过 runtime）。
 * whenReady 和 activate 共用此逻辑（消除重复）。
 */
async function bootstrapMainWindow(): Promise<void> {
  const win = await createWindowFn({ windowId: 'win-1' })
  win.on('closed', () => { ctx.mainWindow = null })
  ctx.mainWindow = win
  ctx.windows.register('win-1', win, initialWindowState('win-1'))

  // 注册全局快捷键
  shortcuts.registerGlobal(win)

  // 启动 runtime（mock 模式跳过）
  if (process.env.XYZ_MOCK === '1') {
    console.log('[main] Mock mode — skipping runtime start')
  } else {
    await ctx.runtime.startAndNotify(win)
  }
}

app.whenReady().then(async () => {
  // 注册 local-file:// 协议，用于渲染进程加载本地文件（如图片）
  protocol.handle('local-file', (request) => {
    const filePath = decodeURIComponent(new URL(request.url).pathname)
    // Restrict to safe directories: project cwd, config dir, home, temp
    // Append path.sep to prevent prefix false-positives (e.g. /Users/foo matching /Users/foobar)
    const sep = path.sep
    const allowedPrefixes = [app.getAppPath(), getConfigDir(), homedir(), tmpdir()]
      .map(p => p.endsWith(sep) ? p : p + sep)
    const resolved = path.resolve(filePath)
    // Reject if not under any allowed prefix (check both with and without trailing sep for exact match)
    if (!allowedPrefixes.some(p => resolved.startsWith(p)) && !allowedPrefixes.some(p => resolved + sep === p)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(`file://${resolved}`)
  })

  await bootstrapMainWindow()
})

app.on('window-all-closed', () => {
  // macOS 保留 runtime：activate 会复用它，避免不必要的重启
  if (process.platform !== 'darwin') {
    void ctx.runtime.stop()
    shortcuts.unregisterAll()
    app.quit()
  }
})

// macOS: 点击 dock 图标时重建窗口
app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await bootstrapMainWindow()
  }
})

let isQuitting = false
// 应用退出前清理：确保 sidecar 进程完全退出再 quit
app.on('before-quit', (event) => {
  if (isQuitting) return // 第二次进入（app.quit() 触发），放行
  isQuitting = true
  event.preventDefault()
  ctx.runtime.stop().finally(() => {
    shortcuts.unregisterAll()
    app.quit()
  })
})
