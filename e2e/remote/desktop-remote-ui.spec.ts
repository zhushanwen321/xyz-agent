/**
 * 桌面端远程 UI E2E —— P1 远程连接 AC（spec §七 modal / §八 状态条 / DirSelectPopover 入口）。
 *
 * 依赖（已就绪）：
 *  - startRemoteRuntime：隔离 runtime（动态端口 + 独立 token + 临时 dataDir）
 *  - launchRemoteElectron：注入 remote localStorage profile → reload → 等 new-task-landing 出现
 *
 * 覆盖用例（每个用例独立 runtime + 独立 Electron，结束 cleanup 防僵尸进程）：
 *  - TC1: DirSelectPopover 远程连接入口可见（action-remote-connect）
 *  - TC2: RemoteConnectModal 三 tab 切换（paste/manual/saved）+ cancel 关闭
 *  - TC3: 粘贴合法连接串 → parse-result 预览 + paste-connect-btn 解禁 → 连接成功
 *  - TC4: 粘贴非法串 → unrecognized-hint + paste-connect-btn disabled
 *  - TC5: 手填字段校验（空 host / 非法 port / 合法填入 → manual-url-preview + 按钮 enabled）
 *  - TC6: 连接成功 → Landing remote-status-bar + 断开回本地
 *  - TC7: failed(auth) 屏 [需手工]（probeConnect 拦截错 token，failed 态难以稳定触发，标注跳过）
 *
 * 连接串格式（parseConnectionInfo，parse-connect-info.ts）：
 *  - ws-url：`ws://host:port`（单行，token 缺失不报 error，paste-connect-btn 因 parsed.url 存在而 enabled）
 *  - http-url：`http://host:port#token=xxx`（推导 ws + 取 hash token）
 *  - url-token-lines：多行含 `URL: ws://...` + `Token: ...`
 * TC3 用 http-url 格式（含 token，probeConnect 才能真正握手成功触发 reload）。
 *
 * 串行：remote 项目 workers=1；test.describe.serial 显式标注意图（Electron + runtime 不宜并发）。
 */
import { test, expect, type Page } from '@playwright/test'
import { startRemoteRuntime, type RemoteRuntimeInfo } from '../fixtures/remote-runtime'
import { launchRemoteElectron } from '../fixtures/launch-remote-electron'

test.describe.serial('桌面端远程 UI（P1 AC）', () => {
  // 共用超时常量（远程连接首屏较慢，给足余量）
  const CONNECT_TIMEOUT = 60_000

  /**
   * 打开 DirSelectPopover（landing 态点 directory chip），返回 popover 根 locator。
   * popover 经 PopoverPortal 挂到 body，用全局 getByTestId 锚定。
   */
  async function openDirPopover(page: Page): Promise<void> {
    // 等 landing composer 卡片渲染（chip-directory 在 meta-row slot）
    await expect(page.getByTestId('chip-directory')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('chip-directory').click()
    // popover 入场动画，等根可见
    await expect(page.getByTestId('dir-select-popover')).toBeVisible({ timeout: 5_000 })
  }

  /**
   * 在 landing 态打开 RemoteConnectModal（经 DirSelectPopover 的 action-remote-connect）。
   * 用 popover 入口而非状态条 remote-switch-btn，因 TC1 需先验证 popover 入口本身。
   * modal 经 Dialog teleport 到 body，等 tab-content-paste 可见。
   */
  async function openConnectModal(page: Page): Promise<void> {
    await openDirPopover(page)
    await page.getByTestId('action-remote-connect').click()
    // modal 默认 paste tab，等 tab-content-paste 挂载稳定
    await expect(page.getByTestId('tab-content-paste')).toBeVisible({ timeout: 5_000 })
  }

  test('TC1: DirSelectPopover 远程连接入口可见（action-remote-connect）', async () => {
    const runtime = await startRemoteRuntime()
    try {
      const desktop = await launchRemoteElectron(runtime, { connectTimeoutMs: CONNECT_TIMEOUT })
      try {
        await openDirPopover(desktop.page)
        // 远程连接动作项两种模式都渲染（spec §九:236），landing 已 connected（远程模式）必然存在
        await expect(desktop.page.getByTestId('action-remote-connect')).toBeVisible()
      } finally {
        await desktop.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })

  test('TC2: RemoteConnectModal 三 tab 切换 + cancel 关闭', async () => {
    const runtime = await startRemoteRuntime()
    try {
      const desktop = await launchRemoteElectron(runtime, { connectTimeoutMs: CONNECT_TIMEOUT })
      try {
        const page = desktop.page
        await openConnectModal(page)

        // 默认 paste tab 高亮：tab-trigger-paste 的 reka-ui data-state=active
        await expect(page.getByTestId('tab-trigger-paste')).toHaveAttribute('data-state', 'active')
        await expect(page.getByTestId('tab-content-paste')).toBeVisible()

        // 切 manual tab
        await page.getByTestId('tab-trigger-manual').click()
        await expect(page.getByTestId('tab-trigger-manual')).toHaveAttribute('data-state', 'active')
        await expect(page.getByTestId('tab-content-manual')).toBeVisible()

        // 切 saved tab
        await page.getByTestId('tab-trigger-saved').click()
        await expect(page.getByTestId('tab-trigger-saved')).toHaveAttribute('data-state', 'active')
        await expect(page.getByTestId('tab-content-saved')).toBeVisible()

        // cancel 关闭 modal（@close 设 showRemoteModal=false，modal 摘除）
        await page.getByTestId('modal-cancel-btn').click()
        await expect(page.getByTestId('tab-content-paste')).toHaveCount(0)
      } finally {
        await desktop.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })

  test('TC3: 粘贴合法连接串 → 预览 + 按钮解禁 → 连接成功', async () => {
    const runtime = await startRemoteRuntime()
    try {
      const desktop = await launchRemoteElectron(runtime, { connectTimeoutMs: CONNECT_TIMEOUT })
      try {
        const page = desktop.page
        await openConnectModal(page)

        // 合法连接串：http-url 格式含 token（推导 ws + hash token，probeConnect 能真正握手成功）
        const validStr = `${runtime.httpUrl}#token=${runtime.token}`
        await page.getByTestId('paste-textarea').fill(validStr)

        // parse-result 出现（host/port + networkKind chip 预览）
        await expect(page.getByTestId('parse-result')).toBeVisible({ timeout: 3_000 })
        // 预览含推导出的 ws url
        await expect(page.getByTestId('parse-result')).toContainText(runtime.wsUrl)

        // paste-connect-btn 解禁（parsed.url 存在 → !disabled）
        await expect(page.getByTestId('paste-connect-btn')).toBeEnabled()

        // 点连接 → probeConnect 成功 → saveProfile + activateRemote + location.reload()
        // reload 后新页面重建，等 new-task-landing 重新出现确认连接成功
        await page.getByTestId('paste-connect-btn').click()
        await page.waitForLoadState('domcontentloaded')
        await expect(page.getByTestId('new-task-landing')).toBeAttached({ timeout: 30_000 })
        // 连接成功后 remote-status-bar 出现（getActiveProfile 命中新保存的 profile）
        await expect(page.getByTestId('remote-status-bar')).toBeVisible({ timeout: 10_000 })
      } finally {
        await desktop.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })

  test('TC4: 粘贴非法串 → unrecognized-hint + 按钮 disabled', async () => {
    const runtime = await startRemoteRuntime()
    try {
      const desktop = await launchRemoteElectron(runtime, { connectTimeoutMs: CONNECT_TIMEOUT })
      try {
        const page = desktop.page
        await openConnectModal(page)

        // 垃圾文本：全不命中四格式 → { error: 'unrecognized' }
        await page.getByTestId('paste-textarea').fill('garbage')

        // unrecognized-hint 出现（raw.trim() && !isRecognized）
        await expect(page.getByTestId('unrecognized-hint')).toBeVisible({ timeout: 3_000 })

        // paste-connect-btn disabled（parsed.url 缺失）
        await expect(page.getByTestId('paste-connect-btn')).toBeDisabled()
      } finally {
        await desktop.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })

  test('TC5: 手填字段校验（空 host / 非法 port / 合法填入）', async () => {
    const runtime = await startRemoteRuntime()
    try {
      const desktop = await launchRemoteElectron(runtime, { connectTimeoutMs: CONNECT_TIMEOUT })
      try {
        const page = desktop.page
        await openConnectModal(page)

        // 切 manual tab
        await page.getByTestId('tab-trigger-manual').click()
        await expect(page.getByTestId('tab-content-manual')).toBeVisible()

        // 默认 host 空 + port='3210' → manual-connect-btn disabled（host 必填）
        await expect(page.getByTestId('manual-connect-btn')).toBeDisabled()

        // 填 host，port 填非数字（"abc"）→ isPortValid=false → disabled
        await page.getByTestId('manual-host').fill('127.0.0.1')
        await page.getByTestId('manual-port').fill('abc')
        await expect(page.getByTestId('manual-connect-btn')).toBeDisabled()
        // 非法 port 时 url 拼接仍发生（host 非空），但按钮 disabled。manual-url-preview 显示拼接结果
        await expect(page.getByTestId('manual-url-preview')).toBeVisible()

        // 填合法 host + port → url 预览 + 按钮 enabled
        await page.getByTestId('manual-port').fill(String(runtime.port))
        await expect(page.getByTestId('manual-url-preview')).toContainText(
          `ws://127.0.0.1:${runtime.port}`,
        )
        await expect(page.getByTestId('manual-connect-btn')).toBeEnabled()
      } finally {
        await desktop.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })

  test('TC6: 连接成功 → Landing remote-status-bar + 断开回本地', async () => {
    const runtime = await startRemoteRuntime()
    try {
      const desktop = await launchRemoteElectron(runtime, { connectTimeoutMs: CONNECT_TIMEOUT })
      try {
        const page = desktop.page
        // launchRemoteElectron 已 connected，landing + remote-status-bar 应已渲染
        await expect(page.getByTestId('remote-status-bar')).toBeVisible({ timeout: 15_000 })
        // remote-host 显示正确 host（wsUrl 的 hostname = 127.0.0.1）
        await expect(page.getByTestId('remote-host')).toContainText('127.0.0.1')
        // remote-disconnect-btn 存在
        await expect(page.getByTestId('remote-disconnect-btn')).toBeVisible()

        // 点断开 → deactivateRemote + location.reload() → 切回本地模式
        await page.getByTestId('remote-disconnect-btn').click()
        await page.waitForLoadState('domcontentloaded')
        // reload 后 isRemoteMode=false → remote-status-bar 不再渲染
        await expect(page.getByTestId('remote-status-bar')).toHaveCount(0)
      } finally {
        await desktop.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })

  test.skip('TC7: failed(auth) 屏 [需手工]', () => {
    // probeConnect 在 paste/manual 连接阶段会先探测错 token，返 auth 失败，
    // UI 显示 probe-error 而非 App.vue failed(auth) 屏（failed 屏仅在 WS 握手 auth 失败时触发）。
    // 稳定触发 failed(auth) 需绕过 probeConnect 直接注入错 token profile + reload，
    // 但 XYZ_NO_LOCAL_RUNTIME=1 下本地分支无 runtime-port，错 token 远程连接的 WS 握手时序不稳定。
    // 标注 [需手工]：手工验证 failed-reconnect-btn / failed-edit-connection-btn 存在。
  })
})
