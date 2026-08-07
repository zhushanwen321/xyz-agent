/**
 * 移动端连接旅程 E2E（spec P4 移动 Web 连接 AC）。
 *
 * 覆盖 testid 锚点（packages/mobile-renderer/src/components/remote/MobileConnectScreen.vue）：
 *  - mobile-connect-screen / mobile-connect-input / mobile-connect-button
 *  - mobile-connect-hint（解析格式错误）/ mobile-connect-failure（连接失败 auth/network/replaced）
 *  - mobile-shell / mobile-header（连接成功标志）
 *  - mobile-tab-sessions / mobile-tab-settings（底部 tab）
 *  - mobile-settings-disconnect（断开按钮）
 *
 * 连接串格式（parseConnectionInfo，packages/mobile-renderer/src/lib/remote/parse-connect-info.ts）：
 *  四格式短路：deep-link → http-url → ws-url → url-token-lines。
 *  本 spec 用 http-url 格式（`${httpUrl}/#token=${token}`）作为「合法连接串」——
 *  parseConnectionInfo 走 http-url 分支：http→ws 推导、token 取 hash 参数。
 *  这与 App.vue onMounted 的 hash 直达走同一分支，保证「手动粘贴」与「hash 直达」行为一致。
 *
 * 失败文案（packages/mobile-renderer/src/i18n/locales/zh-CN/connection.ts）：
 *  - failedAuth: '认证失败：token 错误或已被重置'
 *  - failedRemoteNetwork: '无法连接服务器：检查 Tailscale/服务器是否在线'
 *  - failedReplaced: '此设备已在其他窗口连接'
 *
 * 运行：npx playwright test e2e/remote/mobile-connect.spec.ts --project=remote
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { chromium } from '@playwright/test'
import { startRemoteRuntime, type RemoteRuntimeInfo } from '../fixtures/remote-runtime'
import { launchMobileBrowser, type LaunchedMobileBrowser } from '../fixtures/launch-mobile-browser'

/** iPhone 12 viewport（与 launch-mobile-browser fixture 对齐）。 */
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const

/** 连接成功标志选择器（mobile-shell 或 mobile-header，与 fixture waitForMobileConnected 同源）。 */
const CONNECTED_SELECTOR = '[data-testid="mobile-shell"], [data-testid="mobile-header"]'

/** 连接页选择器。 */
const CONNECT_SCREEN_SELECTOR = '[data-testid="mobile-connect-screen"]'

/** 连接失败等待超时（network 场景需等退避重连超限 failed，给足余量）。 */
const FAILURE_TIMEOUT_MS = 90_000

/** clientId localStorage key（connection-config.ts KEY_CLIENT_ID）。TC8 注入共享 clientId 用。 */
const CLIENT_ID_STORAGE_KEY = 'xyz-agent:client-id'

// i18n 文案常量（断言用，与 locales/zh-CN/connection.ts 同步）
const TEXT_FAILED_AUTH = '认证失败：token 错误或已被重置'
const TEXT_FAILED_NETWORK = '无法连接服务器：检查 Tailscale/服务器是否在线'
const TEXT_FAILED_REPLACED = '此设备已在其他窗口连接'

test.describe.serial('移动端连接旅程（P4 移动 Web 连接 AC）', () => {
  // 每个用例自行管理 runtime + browser 生命周期（串行，remote 项目 workers=1）。

  /**
   * 启动一个「不带 token」的移动浏览器：导航到 runtime.httpUrl（无 #token），
   * App.vue onMounted 检测无 hash + 无存档 → 渲染 MobileConnectScreen（手动粘贴首屏）。
   *
   * 与 launch-mobile-browser fixture 的区别：fixture 默认带 #token 自动连接；
   * 这里需要首屏停留在连接页，故直接用 chromium.launch + 手动导航。
   */
  async function launchMobileWithoutToken(
    runtime: RemoteRuntimeInfo,
  ): Promise<LaunchedMobileBrowser & { page: Page; context: BrowserContext }> {
    const browser = await chromium.launch()
    const context = await browser.newContext({ viewport: MOBILE_VIEWPORT })
    const page = await context.newPage()
    await page.goto(runtime.httpUrl, { waitUntil: 'domcontentloaded' })
    // 等连接页渲染（App.vue 无 hash 无存档 → MobileConnectScreen）
    await page.waitForSelector(CONNECT_SCREEN_SELECTOR, { timeout: 15_000 })
    const cleanup = async (): Promise<void> => {
      try { await context.close() } catch { /* best-effort */ }
      try { await browser.close() } catch { /* best-effort */ }
    }
    return { page, context, browser, cleanup }
  }

  /**
   * 启动一个浏览器并导航到任意 URL（用于 TC5 错误 token hash 直达）。
   */
  async function launchMobileNavTo(targetUrl: string): Promise<
    LaunchedMobileBrowser & { page: Page; context: BrowserContext }
  > {
    const browser = await chromium.launch()
    const context = await browser.newContext({ viewport: MOBILE_VIEWPORT })
    const page = await context.newPage()
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' })
    const cleanup = async (): Promise<void> => {
      try { await context.close() } catch { /* best-effort */ }
      try { await browser.close() } catch { /* best-effort */ }
    }
    return { page, context, browser, cleanup }
  }

  // ── TC1: 无 token 首屏渲染粘贴框 ──────────────────────────────
  test('TC1: 无 token 首屏渲染粘贴框', async () => {
    const runtime = await startRemoteRuntime()
    try {
      const mobile = await launchMobileWithoutToken(runtime)
      try {
        // 首屏三要素可见
        await expect(mobile.page.locator('[data-testid="mobile-connect-screen"]')).toBeVisible()
        await expect(mobile.page.locator('[data-testid="mobile-connect-input"]')).toBeVisible()
        await expect(mobile.page.locator('[data-testid="mobile-connect-button"]')).toBeVisible()
        // 未进入 shell
        await expect(mobile.page.locator(CONNECTED_SELECTOR)).toHaveCount(0)
      } finally {
        await mobile.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })

  // ── TC2: 粘贴合法连接串 → 连接成功 ──────────────────────────
  test('TC2: 粘贴合法连接串 → 连接成功', async () => {
    const runtime = await startRemoteRuntime()
    try {
      const mobile = await launchMobileWithoutToken(runtime)
      try {
        // 合法连接串：http-url 格式（parseConnectionInfo 走 http-url 分支推导 ws + 取 hash token）
        const connStr = `${runtime.httpUrl}/#token=${encodeURIComponent(runtime.token)}`
        await mobile.page.locator('[data-testid="mobile-connect-input"]').fill(connStr)
        await mobile.page.locator('[data-testid="mobile-connect-button"]').click()

        // 进入 mobile-shell（连接成功）
        await mobile.page.waitForSelector(CONNECTED_SELECTOR, { timeout: 30_000, state: 'attached' })
        await expect(mobile.page.locator(CONNECTED_SELECTOR).first()).toBeAttached()

        // 底部 tab 可见（sessions 默认渲染）
        await expect(mobile.page.locator('[data-testid="mobile-tab-sessions"]')).toBeVisible()
      } finally {
        await mobile.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })

  // ── TC3: 粘贴非法串 → hint ──────────────────────────────────
  test('TC3: 粘贴非法串 → hint', async () => {
    const runtime = await startRemoteRuntime()
    try {
      const mobile = await launchMobileWithoutToken(runtime)
      try {
        // 垃圾文本：parseConnectionInfo 全不命中 → {error:'unrecognized'} → parseError=true
        await mobile.page.locator('[data-testid="mobile-connect-input"]').fill('this is not a valid connection string')
        await mobile.page.locator('[data-testid="mobile-connect-button"]').click()

        // hint 出现（mobile-connect-hint，parseError 分支）
        const hint = mobile.page.locator('[data-testid="mobile-connect-hint"]')
        await expect(hint).toBeVisible()
        await expect(hint).not.toBeEmpty()

        // 仍在连接页（未进入 shell）
        await expect(mobile.page.locator('[data-testid="mobile-connect-screen"]')).toBeVisible()
        await expect(mobile.page.locator(CONNECTED_SELECTOR)).toHaveCount(0)
      } finally {
        await mobile.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })

  // ── TC4: hash token 直达自动连接 ─────────────────────────────
  test('TC4: hash token 直达自动连接', async () => {
    const runtime = await startRemoteRuntime()
    try {
      // launchMobileBrowser 默认导航 httpUrl + '#token=' + token → App.vue onMounted 自动连接
      const mobile = await launchMobileBrowser(runtime, { connectTimeoutMs: 40_000 })
      try {
        // fixture 内部已 waitForMobileConnected；这里固化断言 mobile-shell 已渲染
        await expect(mobile.page.locator(CONNECTED_SELECTOR).first()).toBeAttached()
        // 不经过手动粘贴：连接页不应出现
        await expect(mobile.page.locator(CONNECT_SCREEN_SELECTOR)).toHaveCount(0)
      } finally {
        await mobile.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })

  // ── TC5: 连接失败 - auth 错误提示 ────────────────────────────
  test('TC5: 连接失败 - auth 错误提示（错误 token）', async () => {
    const runtime = await startRemoteRuntime()
    try {
      // 导航到 httpUrl + '#token=wrong-token'：parseConnectionInfo 解析成功（http-url 分支），
      // 但 WS auth 握手 token 不匹配 → server close 4001 → ws-client setFailed('auth')
      // → App.vue state='failed' 渲染 MobileConnectScreen，failReason='auth' 显示 failedAuth 文案。
      const targetUrl = `${runtime.httpUrl}/#token=wrong-token`
      const mobile = await launchMobileNavTo(targetUrl)
      try {
        const failure = mobile.page.locator('[data-testid="mobile-connect-failure"]')
        await expect(failure).toBeVisible({ timeout: FAILURE_TIMEOUT_MS })
        await expect(failure).toContainText(TEXT_FAILED_AUTH)

        // 仍在连接页（未进入 shell）
        await expect(mobile.page.locator(CONNECT_SCREEN_SELECTOR)).toBeVisible()
        await expect(mobile.page.locator(CONNECTED_SELECTOR)).toHaveCount(0)
      } finally {
        await mobile.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })

  // ── TC6: 连接失败 - network 错误提示 ─────────────────────────
  test('TC6: 连接失败 - network 错误提示（死端口）', async () => {
    // 真实 network 失败场景：移动端页面加载时已有远程存档（isRemoteMode=true），
    // App.vue onMounted → init() → ws-client connect 存档 profile.url（此处指向死端口）
    // → 退避重连超限（MAX_RECONNECT_DURATION_MS=60s）→ setFailed('network') → failReason='network'。
    //
    // 为何不在「手动粘贴死端口 ws-url」后断言失败：
    //   MobileConnectScreen 的 hideFailure 设计（spec §四 D9）——用户开始输入/粘贴时清空失败提示，
    //   onInputChange 设 hideFailure=true 并保留至下次连接成功。
    //   手动粘贴路径下 hideFailure 已 true，连接失败后 showFailure=false（失败提示被本地隐藏），
    //   无法断言文案。故走「存档自动连接」路径——页面加载即连接，MobileConnectScreen 挂载时
    //   hideFailure=false，连接失败后 showFailure=true 正确显示文案（与单元测试
    //   MobileConnectScreen.test.ts「failReason=network → 显示」分支同路径）。
    //
    // 实现：addInitScript 注入 localStorage 存档（remote-servers profile + connection-mode=remote
    // + active-server-id），指向死端口 ws url。然后导航到 runtime httpUrl（页面能加载，WS 连死端口）。
    const runtime = await startRemoteRuntime()
    try {
      const deadWsUrl = 'ws://127.0.0.1:13999'
      const deadProfile = {
        id: 'e2e-dead-profile',
        name: '127.0.0.1:13999',
        url: deadWsUrl,
        token: 'foo',
        networkKind: 'public',
      }
      const browser = await chromium.launch()
      const context = await browser.newContext({ viewport: MOBILE_VIEWPORT })
      try {
        // 注入存档：让 App.vue onMounted isRemoteMode()=true → init() → connect 死端口
        await context.addInitScript((profile: typeof deadProfile) => {
          try {
            window.localStorage.setItem('xyz-agent:remote-servers', JSON.stringify([profile]))
            window.localStorage.setItem('xyz-agent:connection-mode', 'remote')
            window.localStorage.setItem('xyz-agent:active-server-id', profile.id)
          } catch { /* ignore */ }
        }, deadProfile)
        const page = await context.newPage()
        await page.goto(runtime.httpUrl, { waitUntil: 'domcontentloaded' })

        const failure = page.locator('[data-testid="mobile-connect-failure"]')
        await expect(failure).toBeVisible({ timeout: FAILURE_TIMEOUT_MS })
        await expect(failure).toContainText(TEXT_FAILED_NETWORK)

        // 仍在连接页（未进入 shell）
        await expect(page.locator(CONNECT_SCREEN_SELECTOR)).toBeVisible()
        await expect(page.locator(CONNECTED_SELECTOR)).toHaveCount(0)
      } finally {
        try { await context.close() } catch { /* best-effort */ }
        try { await browser.close() } catch { /* best-effort */ }
      }
    } finally {
      await runtime.stop()
    }
  })

  // ── TC7: 断开 → 回连接页 ─────────────────────────────────────
  test('TC7: 断开 → 回连接页', async () => {
    // 注意：必须经「手动粘贴」连接而非 hash 直达。
    // hash 直达连接后点 disconnect → location.reload() 重载同一 URL（仍带 #token=...）→
    // App.vue onMounted 读 hash → 再次自动连接（disconnect 形同虚设，是 App 与 settings 的已知交互）。
    // 手动粘贴连接时页面 URL 无 hash → reload 后 onMounted 无 hash + isRemoteMode()=false
    // （disconnect 已写 connection-mode=local）→ 渲染 MobileConnectScreen（回到连接页）。
    const runtime = await startRemoteRuntime()
    try {
      const mobile = await launchMobileWithoutToken(runtime)
      try {
        const connStr = `${runtime.httpUrl}/#token=${encodeURIComponent(runtime.token)}`
        await mobile.page.locator('[data-testid="mobile-connect-input"]').fill(connStr)
        await mobile.page.locator('[data-testid="mobile-connect-button"]').click()
        // 确认已连接
        await mobile.page.waitForSelector(CONNECTED_SELECTOR, { timeout: 30_000, state: 'attached' })

        // 切到 Settings tab
        await mobile.page.locator('[data-testid="mobile-tab-settings"]').click()
        await expect(mobile.page.locator('[data-testid="mobile-settings"]')).toBeVisible()

        // 点断开（deactivateRemote + location.reload → 回连接页）
        await mobile.page.locator('[data-testid="mobile-settings-disconnect"]').click()

        // reload 后回到连接页（URL 无 hash → 不自动重连）
        await mobile.page.waitForSelector(CONNECT_SCREEN_SELECTOR, { timeout: 30_000 })
        await expect(mobile.page.locator('[data-testid="mobile-connect-screen"]')).toBeVisible()
        await expect(mobile.page.locator(CONNECTED_SELECTOR)).toHaveCount(0)
      } finally {
        await mobile.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })

  // ── TC8: replaced 挤占提示（共享 clientId）──────────────────
  test('TC8: replaced 挤占提示（两个客户端共享 clientId）', async () => {
    // reviewer R3：replaced 需要两个客户端用相同 clientId。
    // 用 context.addInitScript 在每个 browser context 注入相同的 localStorage['xyz-agent:client-id']，
    // getClientId() 读到共享值 → 两个客户端 auth 携带相同 clientId → server 判定后者挤占前者（close 4002）。
    const runtime = await startRemoteRuntime()
    const cleanups: Array<() => Promise<void>> = []
    try {
      const sharedClientId = `e2e-replaced-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      // 客户端 A：注入共享 clientId，hash 直达连接。
      // 注意 addInitScript 参数必须用数组形式传递（Playwright 对单个原始字符串 arg 序列化不稳定，
      // 实测注入后 getClientId 读不到共享值、退化成自生成 uuid；数组形式稳定可靠）。
      const browserA = await chromium.launch()
      cleanups.push(async () => { try { await browserA.close() } catch { /* ignore */ } })
      const contextA = await browserA.newContext({ viewport: MOBILE_VIEWPORT })
      cleanups.push(async () => { try { await contextA.close() } catch { /* ignore */ } })
      await contextA.addInitScript(
        ([k, id]: [string, string]) => {
          try { window.localStorage.setItem(k, id) } catch { /* ignore */ }
        },
        [CLIENT_ID_STORAGE_KEY, sharedClientId] as [string, string],
      )
      const pageA = await contextA.newPage()
      const urlA = `${runtime.httpUrl}/#token=${encodeURIComponent(runtime.token)}`
      await pageA.goto(urlA, { waitUntil: 'domcontentloaded' })
      // 等客户端 A 连接成功
      await pageA.waitForSelector(CONNECTED_SELECTOR, { timeout: 40_000, state: 'attached' })

      // 客户端 B：注入相同 clientId，连同一 runtime
      const browserB = await chromium.launch()
      cleanups.push(async () => { try { await browserB.close() } catch { /* ignore */ } })
      const contextB = await browserB.newContext({ viewport: MOBILE_VIEWPORT })
      cleanups.push(async () => { try { await contextB.close() } catch { /* ignore */ } })
      await contextB.addInitScript(
        ([k, id]: [string, string]) => {
          try { window.localStorage.setItem(k, id) } catch { /* ignore */ }
        },
        [CLIENT_ID_STORAGE_KEY, sharedClientId] as [string, string],
      )
      const pageB = await contextB.newPage()
      await pageB.goto(urlA, { waitUntil: 'domcontentloaded' })
      // 等客户端 B 也连上（B 的 auth 触发 server kick A）
      await pageB.waitForSelector(CONNECTED_SELECTOR, { timeout: 40_000, state: 'attached' })

      // 客户端 B 连接后，server 用相同 clientId 挤占客户端 A → A 收到 close 4002 → failed('replaced')
      const failureA = pageA.locator('[data-testid="mobile-connect-failure"]')
      await expect(failureA).toBeVisible({ timeout: 40_000 })
      await expect(failureA).toContainText(TEXT_FAILED_REPLACED)

      // 客户端 A 回到连接页
      await expect(pageA.locator(CONNECT_SCREEN_SELECTOR)).toBeVisible()
    } finally {
      // 反向 cleanup（后启动先关）
      for (const fn of cleanups.reverse()) {
        try { await fn() } catch { /* best-effort */ }
      }
      await runtime.stop()
    }
  })
})
