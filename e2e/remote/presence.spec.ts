/**
 * 远程 E2E —— presence 多设备在线状态（spec remote-use P5 presence）。
 *
 * 覆盖 TC1-TC3：两客户端（桌面 Electron + 移动 Chrome）连同一 runtime，验证 PresenceList
 * 在多设备时渲染、一端断开后另一端 presence 更新、deviceName 文本正确显示。
 *
 * 核心实现要点（reviewer R4 指出 + 源码核实）：
 *  - PresenceList.vue:14 渲染条件 v-if="connections.length > 1"（严格大于 1）。
 *    单客户端（只有自己）不渲染。故 TC1 必须先连第二客户端再断言 presence-list 出现。
 *  - PresenceList.vue 无每项 testid：每个 <li> 仅渲染 {{ conn.deviceName || conn.clientId }} 文本
 *    （PresenceList.vue:30）。断 deviceName 走 getByText / locator('text=...')，非 testid。
 *  - presence-list 容器有 data-testid="presence-list"（PresenceList.vue:14），可见性断言用它。
 *  - deviceName 来源：localStorage key 'xyz-agent:device-name'（renderer/mobile-renderer 共用，
 *    getDeviceName() 读此 key）。launchMobileBrowser 不支持注入 deviceName，
 *    故用 page.addInitScript 在首次导航前 setItem。
 *
 * 断线检测时序（connection-manager.ts:591 attachLifecycleHandlers ws.on('close')）：
 *  - page.close() / context.close() 触发 WS close 事件 → runtime 立即 delete client +
 *    broadcastPresence()（无心跳超时等待，close 是即时事件）。
 *  - 故 TC2 等 presence 收敛用 expect.poll 轮询（短间隔），无需长 sleep；给足余量防 WS close
 *    事件传播抖动（默认 10s deadline）。
 *
 * 前置条件：presence 仅依赖 WS 连接（auth + sendInitialState），不依赖 pi/模型配置
 *  （不创建 session）。故无需 probePiAvailable / probeModelConfigAvailable，无条件运行。
 *
 * 多客户端 cleanup：desktop + mobile 逆序 cleanup；runtime stop 清 dataDir + token。
 * 串行（serial）：每用例独立 runtime + 双客户端，防并行串扰。
 */
import { test, expect, type Page } from '@playwright/test'
import { startRemoteRuntime, type RemoteRuntimeInfo } from '../fixtures/remote-runtime'
import {
  launchRemoteElectron,
  type LaunchedRemoteElectron,
} from '../fixtures/launch-remote-electron'
import {
  launchMobileBrowser,
  type LaunchedMobileBrowser,
} from '../fixtures/launch-mobile-browser'

/** 普通 UI 等待超时（presence 广播传播 + 渲染）。 */
const UI_TIMEOUT_MS = 15_000
/** 远程连接首屏超时（WS auth + sendInitialState，多客户端更慢）。 */
const CONNECT_TIMEOUT_MS = 60_000
/** presence 收敛轮询 deadline（WS close 事件传播 + 广播 + 渲染抖动余量）。 */
const PRESENCE_CONVERGE_TIMEOUT_MS = 10_000

/** TC3 注入的移动端 deviceName（addInitScript 写 localStorage）。 */
const MOBILE_DEVICE_NAME = 'Mobile-Test-Device'

/**
 * 在 page 首次导航前注入 deviceName（addInitScript 在每个 navigation 前执行，
 * 早于 mobile App.vue onMounted 读 getDeviceName()）。
 *
 * 为何需要：launchMobileBrowser 导航到 httpUrl#token 后 mobile App.vue 立即 onMounted →
 * init → auth{deviceName: getDeviceName()}。getDeviceName() 读 localStorage
 * 'xyz-agent:device-name'，无则 UA 推导兜底。故必须在首次 goto 前 setItem。
 *
 * 注意：addInitScript 必须在 launchMobileBrowser 之前调用——但 fixture 内部已 goto，
 * 无法在 fixture goto 前 inject。故 TC3 不能直接用 launchMobileBrowser，需用
 * 等价的 manual 启动（chromium.launch + newContext + addInitScript + goto + 等 connected）。
 */
function injectDeviceName(page: Page, deviceName: string): void {
  void page.addInitScript((name) => {
    localStorage.setItem('xyz-agent:device-name', name)
  }, deviceName)
}

/**
 * 手动启动移动端浏览器（与 launchMobileBrowser 等价），但在 goto 前注入 deviceName。
 *
 * 复刻 launchMobileBrowser 的内部流程（fixture 未导出可注入 deviceName 的入口）：
 *  chromium.launch → newContext(MOBILE_VIEWPORT) → newPage → addInitScript(deviceName) →
 *  goto(httpUrl#token) → 等 mobile-shell/mobile-header。
 *
 * @returns 与 LaunchedMobileBrowser 等价的 handle（page/context/browser/cleanup）
 */
async function launchMobileBrowserWithDeviceName(
  runtime: RemoteRuntimeInfo,
  deviceName: string,
): Promise<LaunchedMobileBrowser> {
  // 不直接 import chromium（fixture 内部已封装 viewport/connect 逻辑），改用：
  // 先用 fixture 启动拿到 page/context/browser 句柄会触发 goto（已连），deviceName 已定型。
  // 故需独立 chromium 启动。import { chromium } from '@playwright/test'。
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  injectDeviceName(page, deviceName)

  const targetUrl = `${runtime.httpUrl}/#token=${encodeURIComponent(runtime.token)}`
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="mobile-shell"], [data-testid="mobile-header"]', {
    timeout: CONNECT_TIMEOUT_MS,
    state: 'attached',
  })

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
 * 断言桌面端 presence-list 可见（connections.length > 1 时渲染）。
 */
async function expectPresenceListVisible(desktop: Page): Promise<void> {
  await expect(desktop.getByTestId('presence-list')).toBeVisible({
    timeout: PRESENCE_CONVERGE_TIMEOUT_MS,
  })
}

/**
 * 断言桌面端 presence-list 不可见（connections.length <= 1 时 v-if 不渲染）。
 */
async function expectPresenceListHidden(desktop: Page): Promise<void> {
  await expect(desktop.getByTestId('presence-list')).toBeHidden({
    timeout: PRESENCE_CONVERGE_TIMEOUT_MS,
  })
}

// 串行：每用例独立 runtime + 双客户端；remote 项目 workers=1 已串行，serial 显式标注
// 防并行 mode 下 runtime 端口/进程 + Electron/Chromium 多实例串扰。
test.describe.serial('presence 多设备在线状态 E2E', () => {
  /**
   * TC1: 两设备连接 → 桌面端看到移动端在线（presence-list 出现）。
   *
   * 验证：单客户端时 presence-list 不渲染（connections.length === 1，> 1 条件不满足）；
   * 第二客户端连上后 runtime broadcastPresence → 桌面 presence store 更新为 2 →
   * PresenceList 渲染（length > 1）。
   */
  test('TC1: 两设备连接后桌面端 presence-list 出现', async () => {
    const runtime = await startRemoteRuntime()
    let desktop: LaunchedRemoteElectron | null = null
    let mobile: LaunchedMobileBrowser | null = null
    try {
      desktop = await launchRemoteElectron(runtime, { connectTimeoutMs: CONNECT_TIMEOUT_MS })

      // 单客户端（仅桌面）时 presence-list 不应渲染（connections.length === 1，> 1 不满足）。
      // 给短暂收敛时间防首屏 sendInitialState 含 presence 残态；断 hidden 即足够稳健。
      await expectPresenceListHidden(desktop.page)

      mobile = await launchMobileBrowser(runtime, { connectTimeoutMs: CONNECT_TIMEOUT_MS })

      // 第二客户端连上 → runtime broadcastPresence（onConnect 触发）→ 桌面收 presence.update
      // → connections.length === 2 → PresenceList 渲染。
      await expectPresenceListVisible(desktop.page)
    } finally {
      if (mobile) await mobile.cleanup()
      if (desktop) await desktop.cleanup()
      await runtime.stop()
    }
  })

  /**
   * TC2: 一端断开 → 另一端 presence 更新（presence-list 消失）。
   *
   * 验证：TC1 基础上（两端在线，presence-list 可见）关闭移动端 → runtime ws.on('close')
   * 立即 broadcastPresence（connections.length 降到 1）→ 桌面 presence store 更新为 1 →
   * PresenceList v-if length > 1 不满足 → presence-list 消失。
   *
   * 断线检测：page.close() 触发 WS close（即时事件，非心跳超时），runtime 立即处理。
   * 用 expect.poll 轮询 hidden 状态，deadline 10s 防 close 事件传播抖动。
   */
  test('TC2: 移动端断开后桌面端 presence-list 消失', async () => {
    const runtime = await startRemoteRuntime()
    let desktop: LaunchedRemoteElectron | null = null
    let mobile: LaunchedMobileBrowser | null = null
    try {
      desktop = await launchRemoteElectron(runtime, { connectTimeoutMs: CONNECT_TIMEOUT_MS })
      mobile = await launchMobileBrowser(runtime, { connectTimeoutMs: CONNECT_TIMEOUT_MS })

      // 前置：两端在线时 presence-list 应可见。
      await expectPresenceListVisible(desktop.page)

      // 关闭移动端（page.close 触发 WS close → runtime broadcastPresence）。
      await mobile.page.close()
      // page 已 close，cleanup 幂等（context.close/browser.close best-effort）。
      await mobile.cleanup()
      mobile = null

      // 移动端断开后 connections.length 降到 1 → PresenceList v-if > 1 不满足 → 消失。
      await expectPresenceListHidden(desktop.page)
    } finally {
      if (mobile) await mobile.cleanup()
      if (desktop) await desktop.cleanup()
      await runtime.stop()
    }
  })

  /**
   * TC3: deviceName 显示（presence 列表项含注入的 deviceName 文本）。
   *
   * 验证：移动端用注入的 deviceName（MOBILE_DEVICE_NAME）连上 → 桌面 PresenceList 渲染
   * 该 deviceName 文本（PresenceList.vue:30 {{ conn.deviceName || conn.clientId }}）。
   *
   * deviceName 注入：launchMobileBrowser 不支持注入，用 launchMobileBrowserWithDeviceName
   * （等价 manual 启动 + addInitScript 在 goto 前 setItem localStorage）。
   *
   * 断言方式：PresenceList 无每项 testid，按 deviceName 文本断言（getByText）。
   */
  test('TC3: 桌面端 presence 列表显示移动端 deviceName', async () => {
    const runtime = await startRemoteRuntime()
    let desktop: LaunchedRemoteElectron | null = null
    let mobile: LaunchedMobileBrowser | null = null
    try {
      desktop = await launchRemoteElectron(runtime, { connectTimeoutMs: CONNECT_TIMEOUT_MS })
      mobile = await launchMobileBrowserWithDeviceName(runtime, MOBILE_DEVICE_NAME)

      // presence-list 渲染（length > 1）后，其中应含注入的 deviceName 文本。
      await expectPresenceListVisible(desktop.page)
      await expect(
        desktop.page.getByText(MOBILE_DEVICE_NAME, { exact: true }),
      ).toBeVisible({ timeout: PRESENCE_CONVERGE_TIMEOUT_MS })
    } finally {
      if (mobile) await mobile.cleanup()
      if (desktop) await desktop.cleanup()
      await runtime.stop()
    }
  })
})
