/**
 * 远程 E2E —— 断线重连（spec remote-use reconnect）。
 *
 * 覆盖 TC1-TC4：网络抖动重连 / 重连后消息不丢不重 / seqReset(reload) 全量恢复 / 退避超限 failed。
 *
 * ── 断网模拟方案（关键决策）──
 * 原计划用 Playwright context.setOffline(true/false)（方案 B），但实测发现：
 *  setOffline 对「已建立的 WS 连接」不生效——Chromium 离线模拟只阻断新建连接/HTTP 请求，
 *  已 OPEN 的 WS 在 TCP 层仍存活，ws-client 收不到 onclose（实测 25s+ 仍 connected）。
 *  故 setOffline 无法可靠触发断线（移动端 ws-client 不暴露 WS 实例，page.evaluate 也拿不到 ws.close）。
 *
 * 改用「WS 注入 hook」方案（方案 A，可靠 + 不改生产代码）：
 *  - context.addInitScript 在页面脚本前 patch window.WebSocket，捕获所有 WS 实例到 window.__e2eWsInstances。
 *  - 暴露 window.__e2eCloseAllWs()：close 所有 OPEN 的 WS（触发 ws-client onclose → scheduleReconnect）。
 *  - 暴露 window.__e2eSetBlockReconnect(true)：让后续新建 WS 立即 close（模拟「持久断网」供 TC4 测退避超限）。
 *  优点：精确控制 WS 断开时机、不依赖 Chromium 离线模拟的不确定行为、不污染生产 ws-client 代码。
 *
 * 移动端连接态 UI 映射（App.vue 门控）：
 *  - state==='connected' → MobileShell（[data-testid="mobile-shell"] / mobile-header）
 *  - 其他态（connecting/reconnecting/disconnected/failed）→ MobileConnectScreen（mobile-connect-screen）
 *  故断 WS 后 UI 切到 MobileConnectScreen（reconnecting 态），重连成功后回 MobileShell（connected）。
 *  这是断线重连的可观测信号——无需额外重连指示器组件。
 *
 * TC3 seqReset/reload（fixture restart 能力）：
 *  - remote-runtime.ts 已扩展 restart()：kill runtime 进程 + 用相同 port+token+dataDir 重新 spawn。
 *  - 重启后 server 新 bootId → client 重连同页面生命周期带旧 bootId → server 比对不一致 → 回 seqReset=true
 *    → client window.location.reload() → 冷启动全量 initial state 恢复（session 列表重新出现）。
 *  - 触发重连：runtime 重启后用 __e2eCloseAllWs() 强制 client 断当前死连接 → scheduleReconnect 连新进程。
 *
 * TC4 退避超限 failed：
 *  - ws-client MAX_RECONNECT_DURATION_MS=60_000：断网超 60s 后 setFailed('network') → state='failed'。
 *  - 移动端 failed 态渲染 MobileConnectScreen + failure 提示（mobile-connect-failure，文案 failedRemoteNetwork）。
 *  - 持久断网用 __e2eSetBlockReconnect(true) 让每次重连尝试的 WS 立即 close（模拟无法连上）。
 *  - 等 60s+ 较慢但可控（70s 观测窗口）。
 *
 * 前置条件：
 *  - TC2/TC3 创建 session 需 pi 二进制 + 可预置模型配置，缺一则相关 TC skip。
 *  - TC1/TC4 只验证连接态门控，不依赖 session，无需 pi。
 *
 * cleanup：每用例独立 runtime + browser，finally 双层 cleanup（browser + runtime）。
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startRemoteRuntime } from '../fixtures/remote-runtime'
import { launchMobileBrowser } from '../fixtures/launch-mobile-browser'

/** 重连测试用的临时 cwd（TC2/TC3 创建 session 用）。 */
const TEST_CWD = join(tmpdir(), 'xyz-e2e-reconnect-' + process.pid)
const TEST_FILE_NAME = 'README.md'
const TEST_FILE_PATH = join(TEST_CWD, TEST_FILE_NAME)
const TEST_FILE_CONTENT = 'reconnect e2e fixture'

/** 普通 UI 等待超时。 */
const UI_TIMEOUT_MS = 15_000
/** pi 相关等待超时（session.create 触发 pi spawn 冷启 + 首条消息往返）。 */
const PI_ACTION_TIMEOUT_MS = 90_000
/** 远程连接首屏超时（WS auth + sendInitialState）。 */
const CONNECT_TIMEOUT_MS = 40_000
/**
 * ws-client 退避重连总时长上限（MAX_RECONNECT_DURATION_MS=60_000，见 ws-client.ts）。
 * TC4 断网后需等超此值才进 failed 态。给 70s 观测窗口（60s 上限 + 余量）。
 */
const BACKOFF_EXHAUST_LIMIT_OBSERVE_MS = 70_000

/**
 * 注入到页面（addInitScript，在任何页面脚本前执行）：patch window.WebSocket 捕获实例 + 暴露测试控制函数。
 *
 * 设计：
 *  - 子类化 WebSocket：构造时把实例 push 到 window.__e2eWsInstances（供测试 close）。
 *  - __e2eCloseAllWs()：close 所有 readyState=OPEN 的 WS（触发 ws-client onclose → scheduleReconnect）。
 *  - __e2eSetBlockReconnect(block)：block=true 时记录标志，后续新建的 WS 在 onopen 前立即 close
 *    （模拟「持久断网」——重连尝试永远连不上，供 TC4 测退避超限）。block=false 解除。
 *  - __e2eClearWsInstances()：清空捕获列表（reload/重连后旧实例失效，避免误操作）。
 */
const WS_HOOK_INIT_SCRIPT = `
(() => {
  if (window.__e2eWsPatched) return;
  window.__e2eWsPatched = true;
  window.__e2eWsInstances = [];
  window.__e2eBlockReconnect = false;
  const OrigWS = window.WebSocket;
  window.WebSocket = class extends OrigWS {
    constructor(...args) {
      super(...args);
      window.__e2eWsInstances.push(this);
      // 持久断网模式：新建 WS 立即 close（模拟连不上 server）
      if (window.__e2eBlockReconnect) {
        // 异步 close：构造函数中 super() 已完成，readyState=CONNECTING，close() 转 CLOSING/CLOSED
        // 用 setTimeout(0) 确保在 ws-client 绑定 onopen/onclose 后再 close（触发其 onclose 分支）
        // 用 4000（应用自定义 code）而非 1006：1006 是 WS 协议保留码（浏览器为异常关闭自动设置，
        // 禁止在 close() 调用中使用），调用 ws.close(1006) 会被忽略不触发 onclose。
        setTimeout(() => { try { this.close(4000, 'e2e-block'); } catch (e) {} }, 0);
      }
    }
  };
  window.__e2eCloseAllWs = function() {
    for (const w of window.__e2eWsInstances) {
      // 用 4000（应用自定义 code）而非 1006：1006 是 WS 协议保留码（禁止在 close() 调用中使用，
      // 调用 ws.close(1006) 会被忽略不触发 onclose）。4000 触发 ws-client onclose 默认分支 → scheduleReconnect。
      try { if (w.readyState === 1) w.close(4000, 'e2e-force-close'); } catch (e) {}
    }
  };
  window.__e2eSetBlockReconnect = function(block) {
    window.__e2eBlockReconnect = block;
  };
  window.__e2eClearWsInstances = function() {
    window.__e2eWsInstances = [];
  };
})();
`

/**
 * 探测 pi 是否可用（与 mobile-session.spec probePiAvailable 同源）。
 * @returns pi 二进制路径（可用）或 null（不可用）
 */
function probePiAvailable(): string | null {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const repoRoot = join(here, '..', '..')
  if (process.env.XYZ_PI_BIN && existsSync(process.env.XYZ_PI_BIN)) {
    return process.env.XYZ_PI_BIN
  }
  const platform = process.platform
  const arch = process.arch
  const binaryName = platform === 'win32' ? `pi-windows-${arch}.exe` : `pi-${platform}-${arch}`
  const devPi = join(repoRoot, 'apps', 'electron', 'resources', 'pi', binaryName)
  if (existsSync(devPi)) return devPi
  try {
    const result = spawnSync('pi', ['--version'], { timeout: 5_000, stdio: 'pipe' })
    if (result.status === 0 || (result.stdout && result.stdout.toString().trim().length > 0)) {
      return 'pi'
    }
  } catch {
    // pi 不在 PATH
  }
  return null
}

/**
 * 探测可预置的模型配置（session.create 校验 getDefaultModel() 必需，与 mobile-session.spec 同源）。
 * @returns 可用源 dataDir 或 null
 */
function probeModelConfigAvailable(): string | null {
  const candidates: string[] = []
  if (process.env.XYZ_AGENT_DATA_DIR) candidates.push(process.env.XYZ_AGENT_DATA_DIR)
  candidates.push(join(homedir(), '.xyz-agent-dev'))
  candidates.push(join(homedir(), '.xyz-agent'))
  for (const c of candidates) {
    if (
      existsSync(join(c, 'pi', 'agent', 'settings.json')) &&
      existsSync(join(c, 'pi', 'agent', 'models.json'))
    ) {
      return c
    }
  }
  return null
}

/** 会话前置条件（TC2/TC3 创建 session 依赖）。 */
const piAvailable: string | null = probePiAvailable()
const modelConfigAvailable: string | null = probeModelConfigAvailable()
const sessionPrereqReady: boolean = piAvailable !== null && modelConfigAvailable !== null

/**
 * 启动 runtime + mobile browser 并注入 WS hook（reconnect spec 通用前置）。
 *
 * 与 launchMobileBrowser 的差异：在 context.newPage 前调 addInitScript 注入 WS hook，
 * 确保 hook 在页面任何脚本（含 ws-client new WebSocket）前生效。
 * 故不用 launchMobileBrowser（其内部已 newPage），改用同范式手动 launch + addInitScript + 导航。
 *
 * @returns page + context + browser + cleanup（与 launchMobileBrowser 返回结构对齐）
 */
async function launchMobileBrowserWithWsHook(
  runtime: { port: number; token: string; httpUrl: string },
  opts: { connectTimeoutMs?: number } = {},
): Promise<{
  page: Page
  context: BrowserContext
  cleanup: () => Promise<void>
}> {
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })

  // 注入 WS hook（在任何页面脚本前）
  await context.addInitScript(WS_HOOK_INIT_SCRIPT)

  const page = await context.newPage()
  const targetUrl = `${runtime.httpUrl}/#token=${encodeURIComponent(runtime.token)}`
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' })

  // 等已连接（mobile-shell 出现）
  await page.waitForSelector('[data-testid="mobile-shell"], [data-testid="mobile-header"]', {
    timeout: opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
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
  return { page, context, cleanup }
}

/**
 * 强制断开所有 WS（通过注入 hook），触发 ws-client onclose → scheduleReconnect。
 */
async function forceWsClose(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __e2eCloseAllWs: () => void }).__e2eCloseAllWs())
}

/**
 * 设置/解除持久断网（block=true 时后续新建 WS 立即 close，模拟无法连上 server）。
 */
async function setBlockReconnect(page: Page, block: boolean): Promise<void> {
  await page.evaluate(
    (b) => (window as unknown as { __e2eSetBlockReconnect: (v: boolean) => void }).__e2eSetBlockReconnect(b),
    block,
  )
}

/**
 * 等待移动端进入「已连接」态（MobileShell 出现 = state==='connected'）。
 * reconnect spec 频繁用：断网恢复后 / reload 后需等重新 connected。
 */
async function waitForConnected(page: Page, timeoutMs: number = CONNECT_TIMEOUT_MS): Promise<void> {
  await page.waitForSelector('[data-testid="mobile-shell"], [data-testid="mobile-header"]', {
    timeout: timeoutMs,
    state: 'attached',
  })
}

/**
 * 等待移动端进入「未连接」态（MobileConnectScreen 出现 = state != connected）。
 * 断 WS 后 ws-client 转 reconnecting/disconnected → App.vue 渲染 MobileConnectScreen。
 */
async function waitForDisconnected(page: Page, timeoutMs: number = UI_TIMEOUT_MS): Promise<void> {
  await page.waitForSelector('[data-testid="mobile-connect-screen"]', {
    timeout: timeoutMs,
    state: 'attached',
  })
}

/**
 * 通过 UI 新建 session（TC2/TC3 复用，与 mobile-session.spec createSessionViaUi 同源）。
 */
async function createSessionViaUi(page: Page, prompt: string, cwd: string): Promise<void> {
  await page.locator('[data-testid="mobile-tab-sessions"]').click()
  await page.waitForSelector('[data-testid="mobile-tab-content-sessions"]', { timeout: UI_TIMEOUT_MS })
  await page.locator('[data-testid="mobile-new-session-btn"]').click()
  await page.waitForSelector('[data-testid="mobile-new-session"]', { timeout: UI_TIMEOUT_MS })
  await page.locator('[data-testid="mobile-new-session-prompt"]').fill(prompt)
  await page.locator('[data-testid="mobile-new-session-cwd"]').fill(cwd)
  const submitBtn = page.locator('[data-testid="mobile-new-session-submit"]')
  await expect(submitBtn).toBeEnabled({ timeout: UI_TIMEOUT_MS })
  await submitBtn.click()
  await page.waitForSelector('[data-testid="mobile-chat-view"]', { timeout: PI_ACTION_TIMEOUT_MS })
}

test.describe.serial('远程 E2E 断线重连', () => {
  test.beforeAll(() => {
    mkdirSync(TEST_CWD, { recursive: true })
    writeFileSync(TEST_FILE_PATH, TEST_FILE_CONTENT, { encoding: 'utf8' })
  })

  test.afterAll(() => {
    try {
      rmSync(TEST_CWD, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  })

  test('TC1: WS 断开 → 自动重连 → 恢复连接', async () => {
    const runtime = await startRemoteRuntime({ seedModelConfig: true })
    try {
      const mobile = await launchMobileBrowserWithWsHook(runtime)
      try {
        const page = mobile.page

        // 前置：确认已连接（MobileShell 可见）
        await expect(page.locator('[data-testid="mobile-shell"]')).toBeVisible({ timeout: UI_TIMEOUT_MS })

        // ── 断 WS：forceWsClose 触发 ws-client onclose → scheduleReconnect ──
        await forceWsClose(page)

        // 断言：UI 进入未连接态（MobileConnectScreen 出现 = reconnecting）
        await waitForDisconnected(page, UI_TIMEOUT_MS)

        // ── 等自动重连恢复（ws-client scheduleReconnect 退避后 connect 新 WS）──
        await waitForConnected(page, CONNECT_TIMEOUT_MS)
        await expect(page.locator('[data-testid="mobile-shell"]')).toBeVisible({ timeout: UI_TIMEOUT_MS })
      } finally {
        await mobile.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })

  // TC2 依赖 session 创建（pi + 模型配置），缺一则 skip
  ;(sessionPrereqReady ? test : test.skip)('TC2: 重连后消息不丢不重（seq 回放 / 消息仍可见）', async () => {
    const runtime = await startRemoteRuntime({ seedModelConfig: true })
    try {
      const mobile = await launchMobileBrowserWithWsHook(runtime)
      try {
        const page = mobile.page

        // ── 建 session + 发消息（产生 seq 历史 + chat store 消息）──
        await createSessionViaUi(page, 'reconnect tc2 setup', TEST_CWD)
        const outgoingText = 'tc2 message before disconnect'
        await page.locator('[data-testid="mobile-composer-input"]').fill(outgoingText)
        await page.locator('[data-testid="mobile-composer-send"]').click()
        // 等用户消息渲染到消息流（确认 send 成功）
        await expect(
          page.locator('.message-stream').locator(`text=${outgoingText}`),
        ).toBeVisible({ timeout: PI_ACTION_TIMEOUT_MS })

        // ── 断 WS + 等重连 ──
        await forceWsClose(page)
        await waitForDisconnected(page, UI_TIMEOUT_MS)
        await waitForConnected(page, CONNECT_TIMEOUT_MS)

        // ── 断言：重连后用户消息仍可见（不丢）──
        // 降级断言（移动端难以精确计数消息条数）：重连后 chat store 内存态保留（非 reload，仅 reconnect），
        // seq 回放只补缺失段不重置已收消息，故原用户消息应在消息流仍可见。
        // 重连后视图态可能回 Sessions tab（App.vue state 转 connected → MobileShell 重挂载），
        // 需重新进 chat 视图验证消息仍存在。
        const inChat = await page.locator('[data-testid="mobile-chat-view"]').isVisible().catch(() => false)
        if (!inChat) {
          // 回 Sessions tab，从列表重新进 chat
          await page.locator('[data-testid="mobile-tab-sessions"]').click()
          await page.waitForSelector('[data-testid="mobile-tab-content-sessions"]', { timeout: UI_TIMEOUT_MS })
          // 若当前在 chat 视图（需先回 list），点 mobile-chat-back
          const backBtn = page.locator('[data-testid="mobile-chat-back"]')
          if (await backBtn.isVisible().catch(() => false)) {
            await backBtn.click()
            await page.waitForSelector('[data-testid="mobile-session-list"]', { timeout: UI_TIMEOUT_MS })
          }
          const firstItem = page.locator('[data-testid^="mobile-session-item-"]').first()
          await expect(firstItem).toBeVisible({ timeout: UI_TIMEOUT_MS })
          await firstItem.click()
          await expect(page.locator('[data-testid="mobile-chat-view"]')).toBeVisible({
            timeout: PI_ACTION_TIMEOUT_MS,
          })
        }

        // 断言：原用户消息在消息流仍可见（重连不丢消息）
        await expect(
          page.locator('.message-stream').locator(`text=${outgoingText}`),
        ).toBeVisible({ timeout: PI_ACTION_TIMEOUT_MS })
      } finally {
        await mobile.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })

  // TC3 依赖 session 创建 + fixture restart 能力（remote-runtime.ts 已扩展 restart()）
  ;(sessionPrereqReady ? test : test.skip)('TC3: seqReset(reload) → runtime 重启后全量状态恢复', async () => {
    const runtime = await startRemoteRuntime({ seedModelConfig: true })
    try {
      const mobile = await launchMobileBrowserWithWsHook(runtime)
      try {
        const page = mobile.page

        // ── 建 session（确立持久化状态：session 列表 + chat 历史）──
        await createSessionViaUi(page, 'reconnect tc3 setup', TEST_CWD)
        await expect(page.locator('[data-testid="mobile-chat-view"]')).toBeVisible()

        // 记录 reload 前 session 数（列表项数，reload 后比对）
        await page.locator('[data-testid="mobile-chat-back"]').click()
        await page.waitForSelector('[data-testid="mobile-session-list"]', { timeout: UI_TIMEOUT_MS })
        const sessionCountBefore = await page
          .locator('[data-testid^="mobile-session-item-"]')
          .count()

        // ── 等 session 持久化到 dataDir ──
        // session.create 触发 pi spawn（异步）+ session 元数据落盘异步；createSessionViaUi 仅等 chat 视图
        // 渲染（WS 广播到位），不保证 runtime 已 flush 到磁盘。runtime.restart() 用 SIGKILL（模拟崩溃），
        // 任何未 flush 的 session 状态会丢失 → reload 后 sendInitialState.config.sessions 为空。
        // 故 restart 前给 runtime 一段 flush 窗口（5s 实测足够 pi spawn + 元数据落盘）。
        await page.waitForTimeout(5_000)

        // ── runtime 重启（新 bootId 触发 client seqReset → reload）──
        // restart() kill 旧进程 + 同 port+token+dataDir 重新 spawn。新进程新 bootId。
        await runtime.restart()

        // client 当前 WS 连的是已死旧进程 → 触发 onclose（TCP RST）→ scheduleReconnect → 连新进程 →
        // auth 携带旧 bootId（同页面生命周期）→ server 比对不一致 → seqReset=true → reload。
        // 注：旧 WS 的 onclose 可能在 restart 后需要短暂时间触发（TCP 探测）；为加速 + 确定性，
        // 显式 forceWsClose 断开当前 WS（即便已断也无副作用），驱动 ws-client 立即重连新进程。
        await forceWsClose(page)

        // ── 等 reload 完成 + 全量状态恢复 ──
        // reload 触发 page navigation。等 mobile-shell 重新出现 = 冷启动 + 新 bootId 握手 + 全量恢复。
        // reload 后 page 仍是同 page 对象（同 context），selector 重新生效。
        await waitForConnected(page, CONNECT_TIMEOUT_MS)

        // ── 断言：全量状态恢复（session 列表重新出现，数量一致）──
        await page.locator('[data-testid="mobile-tab-sessions"]').click()
        await page.waitForSelector('[data-testid="mobile-tab-content-sessions"]', { timeout: UI_TIMEOUT_MS })
        await expect(page.locator('[data-testid="mobile-session-items"]')).toBeVisible({
          timeout: PI_ACTION_TIMEOUT_MS,
        })
        const sessionCountAfter = await page
          .locator('[data-testid^="mobile-session-item-"]')
          .count()
        expect(sessionCountAfter).toBe(sessionCountBefore)
      } finally {
        await mobile.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })

  test('TC4: 长断线后退避重连超限 → failed 态（mobile-connect-failure 提示）', async () => {
    const runtime = await startRemoteRuntime({ seedModelConfig: true })
    try {
      const mobile = await launchMobileBrowserWithWsHook(runtime)
      try {
        const page = mobile.page

        // 前置：已连接
        await expect(page.locator('[data-testid="mobile-shell"]')).toBeVisible({ timeout: UI_TIMEOUT_MS })

        // ── 持久断网：block 重连（后续新建 WS 立即 close）+ 断当前 WS ──
        await setBlockReconnect(page, true)
        await forceWsClose(page)

        // 断当前 WS 后 ws-client 转 reconnecting；scheduleReconnect 的 connect 新建 WS 被 block 立即 close
        // → 持续 onclose → 持续退避重连。超 MAX_RECONNECT_DURATION_MS(60s) 后 setFailed('network')。
        await waitForDisconnected(page, UI_TIMEOUT_MS)

        // ── 等退避超限 → failed 态 ──
        // failed 态：App.vue 渲染 MobileConnectScreen + MobileConnectScreen 读 failReason='network'
        // → 显示 mobile-connect-failure（文案 connection.failedRemoteNetwork）。
        await expect(page.locator('[data-testid="mobile-connect-failure"]')).toBeVisible({
          timeout: BACKOFF_EXHAUST_LIMIT_OBSERVE_MS,
        })

        // 解除 block（防残留影响后续用例）
        await setBlockReconnect(page, false)
      } finally {
        await mobile.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })
})
