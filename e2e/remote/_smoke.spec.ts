/**
 * 远程 E2E 冒烟测试 —— 验证三个 fixture（runtime / mobile / electron）能独立工作。
 *
 * 验收（spec remote-use G1/G2/G3 + 冒烟门禁）：
 *  - S1: startRemoteRuntime → /health 200（runtime spawn + WS server 就绪）
 *  - S2: launchMobileBrowser → mobile-shell/mobile-header 出现（chromium 连 runtime，hash 直达）
 *  - S3: launchRemoteElectron → new-task-landing 出现（Electron 注入 localStorage + reload 连远程）
 *
 * 每个用例独立 runtime（startRemoteRuntime 各自起一个），用完 stop 清理。
 * 串行（remote 项目 workers=1，Electron + runtime 进程不宜并发）。
 *
 * 若 pi 二进制不可用导致 WS auth 后 session 创建失败（连接可能卡 connecting），
 * S2/S3 的 connected 等待会超时——届时降级标注（见各用例注释）。
 */
import { test, expect } from '@playwright/test'
import { startRemoteRuntime } from '../fixtures/remote-runtime'
import { launchMobileBrowser } from '../fixtures/launch-mobile-browser'
import { launchRemoteElectron } from '../fixtures/launch-remote-electron'

// 串行：remote 项目 workers=1 已串行，但 test.describe.serial 显式标注意图 + 防并行 mode 下串扰
test.describe.serial('远程 E2E fixture 冒烟', () => {

  test('S1: startRemoteRuntime 启动 runtime + /health 200', async () => {
    const runtime = await startRemoteRuntime()
    try {
      // runtime.wsUrl / httpUrl 格式正确
      expect(runtime.port).toBeGreaterThan(0)
      expect(runtime.token.length).toBeGreaterThan(0)
      expect(runtime.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
      expect(runtime.httpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

      // /health 200（fixture 内部已轮询过，这里独立再 GET 一次确认）
      const res = await fetch(`${runtime.httpUrl}/health`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { status?: string }
      expect(body.status).toBe('ok')
    } finally {
      await runtime.stop()
    }
  })

  test('S2: launchMobileBrowser 连上 runtime（mobile-shell 出现）', async () => {
    const runtime = await startRemoteRuntime()
    try {
      // launchMobileBrowser 内部已 waitForMobileConnected（mobile-shell/mobile-header attached）。
      // 走到此处无抛 = 连接成功；再用断言固化「mobile-shell 已渲染」作为可观测证据。
      const mobile = await launchMobileBrowser(runtime, { connectTimeoutMs: 40_000 })
      try {
        await expect(
          mobile.page.locator('[data-testid="mobile-shell"], [data-testid="mobile-header"]').first(),
        ).toBeAttached()
      } finally {
        await mobile.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })

  test('S3: launchRemoteElectron 连上 runtime（new-task-landing 出现）', async () => {
    const runtime = await startRemoteRuntime()
    try {
      // launchRemoteElectron 内部已 waitForSelector(new-task-landing)。
      // 走到此处无抛 = 连接成功；再用断言固化「landing 已渲染」作为可观测证据。
      const desktop = await launchRemoteElectron(runtime, { connectTimeoutMs: 60_000 })
      try {
        await expect(desktop.page.locator('[data-testid="new-task-landing"]')).toBeAttached()
      } finally {
        await desktop.cleanup()
      }
    } finally {
      await runtime.stop()
    }
  })
})
