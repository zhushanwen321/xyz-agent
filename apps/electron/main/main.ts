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
 * 3. local-file:// 协议路径白名单 = computeLocalFilePrefixes 纯函数
 *    （app.getAppPath/getDataDir/tmpdir/用户内容子目录 + path.sep 后缀；dev 含 cwd，打包态剔除）
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
 *     3. windowManager.register('win-1', mainWindow)
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
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { app, protocol, net, BrowserWindow } from 'electron'
import { DEV_PORT_OFFSET } from '@xyz-agent/shared'
import { getDataDir } from '@xyz-agent/shared/paths'
import { createMainContext } from './context.js'
import type { MainContext } from './interfaces.js'
import { RuntimeSupervisor } from './supervisor/runtime-supervisor.js'
import { WindowManager } from './window/window-manager.js'
import { createWindow } from './window/window-factory.js'
import { ShortcutRegistry } from './shortcuts/shortcut-registry.js'
import { BrowserViewManager } from './browser/browser-view-manager.js'
import { ReleaseChecker } from './release-checker.js'
import { MockReleaseChecker, DEV_MOCK_UPDATE_ENABLED } from './dev/mock-release-checker.js'
import { updateOrchestrator } from './update/orchestrator.js'
import { maybeRollbackInterruptedUpdate, cleanupCompletedUpdate } from './update/update-self-healer.js'
import { registerIpcHandlers } from './gateway/ipc-handlers.js'
import { isPathInAllowedPrefixes } from './gateway/input-validators.js'
import { fixPathEnv } from './supervisor/shell-env.js'
import { flushStderrSink } from './supervisor/process-control.js'
import { expandLocalFilePath } from './utils/path.js'
import { computeLocalFilePrefixes } from './utils/local-file-prefixes.js'

// ── PATH 修复（GUI 启动时补全用户级 bin 目录）──────────────────────
// macOS LaunchServices 给 GUI 进程的 PATH 是最小值（/usr/bin:/bin:...），
// 缺 ~/.local/bin、~/.cargo/bin、/opt/homebrew/bin 等。此处从登录 shell 读取
// 完整 PATH 补全，后续 buildSafeEnv 自然传递到 pi，pi 的 bash 工具才能找到 uv 等用户 CLI。
// 必须在 buildSafeEnv / spawn 之前执行。
fixPathEnv()

// ── EPIPE 兜底 ───────────────────────────────────────────────────
// concurrently/终端关闭后 pipe 断开，console 写入触发 uncaught exception
process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.stdout.destroy()
})
process.stderr?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.stderr.destroy()
})

// ── 进程级兜底（unhandledRejection / uncaughtException）────────
// [HISTORICAL] E1/W2：main 进程绝不能因一个未捕获异常退出。
// 选择「log + 不 exit」而非 process.exit：
//   - exit 会让 supervisor 启动的 runtime 子进程成孤儿（PPID 变 1），
//     runtime 失去监管继续运行但无人能 stop，资源泄漏更危险
//   - 仅记录日志，状态可能不一致，但靠后续 supervisor/liveness 兜底；
//     日志已落盘供事后诊断。
// 注意：uncaughtException 后 Node 默认行为已改为不退出（Node 15+），
//       此处显式注册仅为统一日志格式、避免 stderr 被默认 handler 抢占。
process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception:', err)
  // dev 模式（!app.isPackaged）直接 exit(1) 暴露问题——dev 下没有 supervisor/liveness 兜底，
  // 静默吞会让开发者在不知不觉中带病继续开发。prod 保持「不 exit，靠 supervisor/liveness 兜底」
  // （exit 会让 runtime 子进程成孤儿，资源泄漏更危险）。
  if (!app.isPackaged) process.exit(1)
})

// ── 路径 & 模式 ──────────────────────────────────────────────────
const isDev = !app.isPackaged

// getDataDir（shared SSOT）：读 XYZ_AGENT_DATA_DIR，缺省 ~/.xyz-agent。
// dev 模式下方块会把它覆盖为 ~/.xyz-agent-dev（隔离 prod 实例）。

// Dev 模式：自动隔离数据目录和端口，防止与 prod 实例冲突
if (isDev) {
  process.env.XYZ_AGENT_DATA_DIR = process.env.XYZ_AGENT_DATA_DIR
    ?? path.join(homedir(), '.xyz-agent-dev')
  process.env.XYZ_AGENT_PORT_OFFSET = process.env.XYZ_AGENT_PORT_OFFSET ?? String(DEV_PORT_OFFSET)
  // 隔离 Electron userData，防止与 prod 实例共享 Chromium 存储（LevelDB LOCK 竞争）
  app.setPath('userData', path.join(homedir(), '.xyz-agent-dev', 'electron'))
}

// ── 单实例锁（integrity-hardening §3.2 D2d）───────────────────────
// 双开 = 两个实例并发 spawn runtime、并发读写同一数据目录，会命中「pi session 文件
// EEXIST 永久卡死」历史事故区（AGENTS.md 规则 6）。锁必须晚于上面 isDev 块的
// app.setPath('userData')：Electron 单实例锁按 userData 路径区分，dev 隔离目录
// 让 dev 实例与 prod 实例互不误伤。第二实例 app.quit() 后模块级代码仍会同步执行
// （quit 流程触发 before-quit，其清理链对未启动状态幂等），whenReady guard
// 阻止其创建窗口 / spawn runtime。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

// ── 全局状态容器 ─────────────────────────────────────────────────
// 构造三个 Facade + MainContext（替代旧代码散落的 let mainWindow / let settingsWindow）
const runtime = new RuntimeSupervisor()
const windows = new WindowManager()
const shortcuts = new ShortcutRegistry()
const ctx: MainContext = createMainContext({ runtime, windows, shortcuts, isDev })
/**
 * 启动结果缓存（D5 决策）：cleanupCompletedUpdate 返回的终态上下文，
 * renderer 启动时通过 update:getLaunchResult 一次性读取后清空（consumed 语义）。
 * 生命周期 = 进程内一次性（app 不重启则不再重复 toast）。
 */
let launchResultCache: { status: string; version: string } | null = null
// Browser drawer 的 WebContentsView 管理器（依赖 windows Facade 取窗口引用）。
// W2：注入 onStateChange 回调，webContents 事件触发时把 state 推给主窗口 renderer（BrowserPane），
// 用于地址栏回填真实 URL（防钓鱼）+ loading/error 态切换。win 在 ctx.mainWindow 设置后才有值，
// 故此处读 ctx.mainWindow（bootstrap 后非 null）。
const browserViewManager = new BrowserViewManager(windows, (sid, state) => {
  const win = ctx.mainWindow
  if (win && !win.isDestroyed()) {
    win.webContents.send('browser:state', { sessionId: sid, ...state })
  }
})

/** createWindow 适配器：把 ctx.windows.generateId 注入 window-factory */
const createWindowFn = (options?: { windowId?: string; sessionId?: string }) =>
  createWindow(options, { isDev, generateId: () => ctx.windows.generateId() })
    .then(({ win }) => win)

// ── 注册 IPC ─────────────────────────────────────────────────────
// Release 检测器（自动升级检测后端）：1h 缓存 GitHub /releases/latest
// dev mock 注入（XYZ_DEV_MOCK_UPDATE=1）：P2 半 E2E 验证用。
// 返回伪造 LatestReleaseInfo，让前端 UpdateButton 显示「可升级」态供 Playwright 截图。
// isDev && 双重保护：prod 构建即使环境变量被误设也不会用 mock（MockReleaseChecker 永不实例化）。
const releaseChecker = isDev && DEV_MOCK_UPDATE_ENABLED
  ? new MockReleaseChecker()
  : new ReleaseChecker()
registerIpcHandlers({
  getMainWindow: () => ctx.mainWindow,
  runtime: ctx.runtime,
  isDev,
  createWindow: createWindowFn,
  windowManager: ctx.windows,
  browserViewManager,
  releaseChecker,
  updateOrchestrator,
  getLaunchResult: async () => {
    const result = launchResultCache
    launchResultCache = null // consumed 一次性
    return result
  },
})

// ── App 生命周期编排 ─────────────────────────────────────────────

// D2d：主实例收到 second-instance（Windows/Linux 双击图标再次启动；macOS `open -n`）
// 时聚焦既有主窗口——用户意图是「把 app 带到前台」而非开新实例。
if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    const win = ctx.mainWindow
    if (win && !win.isDestroyed()) {
      // 最小化（Windows 常见）先还原再聚焦，Electron 官方 second-instance 模板语义
      if (win.isMinimized()) win.restore()
      win.focus()
      return
    }
    // macOS 窗口全关但 app 存活的边角（open -n 触发）：重建主窗口，对齐 activate 行为
    if (BrowserWindow.getAllWindows().length === 0) {
      void bootstrapMainWindow()
    }
  })
}

/**
 * 初始化主窗口 + 快捷键 + runtime（mock 模式跳过 runtime）。
 * whenReady 和 activate 共用此逻辑（消除重复）。
 */
async function bootstrapMainWindow(): Promise<void> {
  // bootstrap 也走 generateId() 并用返回值注册，避免与后续 renderer 调 create-window IPC
  // 时 generateId() 首返值 'win-1' 冲突导致 Map 覆盖、跟踪条目丢失。
  const windowId = ctx.windows.generateId()
  const win = await createWindowFn({ windowId })
  win.on('closed', () => { ctx.mainWindow = null })
  ctx.mainWindow = win
  ctx.windows.register(windowId, win)

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
  // D2d 第二实例退出路径：app.quit() 已在模块加载期触发，不再初始化任何子系统
  if (!gotSingleInstanceLock) return
  // dev 模式 Dock 图标：未打包的 Electron 运行时用内置默认图标（蓝色 Electron logo），
  // 不读 electron-builder 的 build/icon.*（那只在打包产物生效）。macOS dock 图标跟随
  // app bundle——dev 无 bundle，必须显式 setIcon 才有新 LOGO（双鱼太极）。
  // 打包版无需此调用：bundle 的 Info.plist + Contents/Resources/icon.icns 自动生效。
  //
  // 跳过条件：dev-electron.mjs 已用自制 Taiji.app bundle（改了 Info.plist 的
  // CFBundleIconFile）启动，dock 启动即显示太极图标，无需再 setIcon（且避免重设闪烁）。
  // 此时 main 进程会收到 XYZ_DEV_BUNDLE_ICON=1 环境变量。fallback 到默认 electron 时
  // 无此变量，走 setIcon 兜底（会闪但至少有图标）。
  if (isDev && process.platform === 'darwin' && !process.env.XYZ_DEV_BUNDLE_ICON) {
    const dockIcon = path.join(app.getAppPath(), 'build', 'icon-1024.png')
    if (existsSync(dockIcon)) {
      app.dock?.setIcon(dockIcon)
    }
  }
  // dev 实例 Dock 角标：与 prod 并存时一眼可辨（app.dock 非 mac 为 undefined）
  if (isDev) app.dock?.setBadge('dev')
  // 注册 local-file:// 协议，用于渲染进程加载本地文件（如图片）
  protocol.handle('local-file', (request) => {
    const rawPath = decodeURIComponent(new URL(request.url).pathname)
    // 渲染进程无法安全展开 ~，主进程统一处理（图片 URL 可能含 ~/）
    const filePath = expandLocalFilePath(rawPath)
    // [HISTORICAL] W3 → D2a：白名单构造收敛到 computeLocalFilePrefixes 纯函数。
    // 打包态剔除 process.cwd()——macOS 打包版从 Finder/Dock 启动时 cwd 是 /，
    // 前缀匹配 startsWith('/') 对任意绝对路径恒真，白名单塌缩为全盘，「绝不放行
    // ~ 本身（含 ~/.ssh）」的注释护栏曾被该运行时环境击穿。不变量守护已移到单测：
    // main/test/local-file-prefixes.test.ts（打包态不含文件系统根 / 不含 homedir 本身）。
    // 各成员的取舍理由见 utils/local-file-prefixes.ts 文件头。
    const allowedPrefixes = computeLocalFilePrefixes({
      isPackaged: app.isPackaged,
      cwd: process.cwd(),
      appPath: app.getAppPath(),
      dataDir: getDataDir(),
      tmpdir: tmpdir(),
    })
    const resolved = path.resolve(filePath)
    // 校验逻辑集中到 input-validators，拒绝不在白名单前缀内的路径（防目录穿越）
    if (!isPathInAllowedPrefixes(resolved, allowedPrefixes)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(`file://${resolved}`)
  })

  // W3：启动自愈——检测上次中断的升级并回滚，必须在 bootstrapMainWindow 之前
  // （确保 .app bundle 已恢复到可用态再创建窗口，避免加载半截 app 崩溃）
  await maybeRollbackInterruptedUpdate()

  // 清理已完成/失败的升级产物（done/failed/rolled-back/no-op 终态）：删除残留的 170MB zip、
  // preloaded/pending 元信息、updater 脚本日志等，避免磁盘占用与下次启动误恢复「已下载」态。
  // 必须在 maybeRollbackInterruptedUpdate 之后（replacing 回滚完成转入终态后再清理）。
  // 返回值缓存供 renderer 启动时通过 update:getLaunchResult 一次性读取（D5 决策：
  // invoke 有构造性送达保证，consumed 标志由 main 单点保证去重）。
  launchResultCache = await cleanupCompletedUpdate()

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
// 应用退出前清理：确保 runtime 子进程完全退出再 quit。
// async handler：Electron 支持 event.preventDefault() + 异步操作 + 延迟 app.quit()。
// 必须等 flushStderrSink 的 'finish' 事件（WriteStream 落盘完成）再 quit，否则丢尾部 stderr。
app.on('before-quit', (event) => {
  if (isQuitting) return // 第二次进入（app.quit() 触发），放行
  isQuitting = true
  event.preventDefault()
  // W-Proc2 + W2：runtime stop 已 end() stderrSink；此处 flush 等 'finish' 落盘后再 quit。
  // stop() 路径未触发（runtime 自然退出）时此 flush 是落盘的唯一保障。
  void ctx.runtime.stop()
    .then(() => flushStderrSink())
    .finally(() => {
      shortcuts.unregisterAll()
      app.quit()
    })
})
