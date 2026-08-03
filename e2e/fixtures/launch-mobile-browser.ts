/**
 * launch-mobile-browser fixture —— 移动端浏览器（Playwright chromium）连接远程 runtime。
 *
 * 设计依据（spec remote-use R4 + mobile App.vue 连接流程）：
 *  - 移动端部署模型 = 页面与 WS 同源托管（runtime --serve-web <mobileDist> 同时 serve 静态 + WS）。
 *  - 连接方式（mobile App.vue onMounted）：
 *    1. location.hash 非空 → parseConnectionInfo(window.location.href) 走 http-url 分支
 *       （http→ws 推导、token 取 hash 参数）→ saveProfile + activateRemote → init（WS connect）
 *    2. 无 hash：检查 isRemoteMode（已有存档 profile）→ init
 *    3. 无存档：渲染 MobileConnectScreen（用户手动粘贴）
 *  - 故默认导航 httpUrl + '#token=' + token → 自动连接（D9 hash 直达）。
 *  - opts.manualConnect=true 时导航到 mobile-renderer dev server（1421）测手动粘贴流程（未实现，
 *    需额外起 vite dev server；当前仅支持 hash 直达 + 存档自动连接两种）。
 *
 * viewport 用 iPhone 12 尺寸（390x844），与 mobile-renderer 响应式断点对齐。
 *
 * 用法：
 *   const mobile = await launchMobileBrowser(runtime)
 *   try { /* 用 mobile.page 操作移动端 UI *\/ }
 *   finally { await mobile.cleanup() }
 */
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import type { RemoteRuntimeInfo } from './remote-runtime'

/** iPhone 12 viewport（与 mobile-renderer 移动端断点对齐，确保渲染移动布局非桌面布局）。 */
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const

/** 等待移动端「已连接」标志出现的 deadline（WS auth + sendInitialState 较慢，给足余量）。 */
const CONNECTED_TIMEOUT_MS = 30_000

export interface LaunchMobileBrowserOptions {
  /**
   * true = 不自动带 token，导航到 mobile-renderer dev server（1421）测手动粘贴流程。
   * 默认 false = hash 直达自动连接（httpUrl + '#token=' + token）。
   *
   * 注意：manualConnect=true 需要额外起 mobile-renderer vite dev server（1421），
   * 本 fixture 不负责启动 dev server（由 spec 或 webServer config 提供）。
   */
  manualConnect?: boolean
  /** 手动连接模式的 dev server base URL（默认 http://127.0.0.1:1421）。 */
  devServerUrl?: string
  /** 覆盖等待 connected 的超时（默认 30s）。 */
  connectTimeoutMs?: number
}

export interface LaunchedMobileBrowser {
  page: Page
  context: BrowserContext
  browser: Browser
  cleanup: () => Promise<void>
}

/**
 * 启动 Playwright chromium + 导航到 mobile-renderer + 等待连接成功。
 *
 * @param runtime startRemoteRuntime() 的返回值（提供 httpUrl + token）
 * @param opts manualConnect / devServerUrl / connectTimeoutMs
 * @returns page + context + browser + cleanup
 * @throws 若 connected 标志（mobile-shell / mobile-header）在超时内未出现
 */
export async function launchMobileBrowser(
  runtime: RemoteRuntimeInfo,
  opts: LaunchMobileBrowserOptions = {},
): Promise<LaunchedMobileBrowser> {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT })
  const page = await context.newPage()

  // 构造目标 URL：
  //  - 默认（hash 直达）：runtime.httpUrl + '#token=' + runtime.token
  //    → mobile App.vue onMounted 读 location.hash → parseConnectionInfo(href) 走 http-url 分支
  //      → host=httpUrl 的 host、token=hash 参数 → saveProfile + activateRemote → init
  //  - manualConnect：导航到 dev server（无 token，渲染 MobileConnectScreen 供手动粘贴）
  const targetUrl = opts.manualConnect
    ? (opts.devServerUrl ?? 'http://127.0.0.1:1421')
    : `${runtime.httpUrl}/#token=${encodeURIComponent(runtime.token)}`

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' })

  // 等待「已连接」标志：mobile App.vue state==='connected' 时渲染 MobileShell（含 mobile-header）。
  // mobile-shell 包裹层 / mobile-header 头部，任一出现即说明 WS auth + sendInitialState 通过。
  await waitForMobileConnected(page, opts.connectTimeoutMs ?? CONNECTED_TIMEOUT_MS)

  const cleanup = async (): Promise<void> => {
    try {
      await context.close()
    } catch {
      // best-effort
    }
    try {
      await browser.close()
    } catch {
      // best-effort
    }
  }

  return { page, context, browser, cleanup }
}

/**
 * 等待移动端「已连接」标志出现（mobile-shell 或 mobile-header 任一）。
 *
 * mobile App.vue 连接门控：state==='connected' → <MobileShell>（含 mobile-header）。
 * state='connecting'/'disconnected'/'failed' → <MobileConnectScreen>（无 mobile-shell）。
 * 故 mobile-shell / mobile-header 出现 = 连接成功。
 */
async function waitForMobileConnected(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForSelector('[data-testid="mobile-shell"], [data-testid="mobile-header"]', {
    timeout: timeoutMs,
    state: 'attached',
  })
}
