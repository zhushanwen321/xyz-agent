import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url))

/**
 * Playwright config —— xyz-agent Electron E2E。
 *
 * E2E 策略（见 execution-plan W0）：
 * - 测试前确保 main/preload/renderer 构建产物存在（globalSetup 跑 build:e2e）
 * - 用 _electron.launch 启动 app（不走 webServer，Electron 不是 web server）
 * - workers: 1（Electron 多实例会争抢 userData/端口，串行最稳）
 *
 * 项目划分：
 * - electron：本地 mock E2E（renderer mock 构建，launch-app.ts 范式）
 * - remote：远程 E2E（真实 runtime + 非 mock renderer，launchRemoteElectron / launchMobileBrowser）
 *   桌面 spec 用 _electron.launch（自带 Electron，忽略项目 use.browser）；
 *   移动 spec 用 chromium.launch（fixture 内显式起 chromium）。
 *   故 remote 项目 use.devices 仅作 context 默认，不干扰 fixture 自管的浏览器/Electron 启动。
 *   超时 120s：真实 runtime spawn + pi 进程 + WS 握手 + 首屏较 mock 慢。
 *
 * CI 跨平台配置列后续迭代（本轮本地优先，见 execution-plan §待确认）。
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',

  // Electron 多实例会争抢 Chromium userData LOCK + 端口，强制串行
  fullyParallel: false,
  workers: 1,

  // Electron app 启动 + renderer mock 初始化较慢，给足超时
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // 失败时保留 trace + screenshot（W8 验收调试用）
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // 构建产物存在性校验（已构建则跳过，CI 本地都安全）
  globalSetup: path.resolve(REPO_ROOT, 'e2e/fixtures/global-setup.ts'),

  // 报告（本地默认 list，CI 可加 html）
  reporter: process.env.CI ? 'html' : 'list',

  projects: [
    {
      name: 'electron',
      testMatch: '**/*.spec.ts',
      // 排除 e2e/remote/（remote spec 由 remote 项目跑，避免双重执行）
      testIgnore: ['e2e/remote/**/*.spec.ts'],
      use: {},
    },
    {
      // 远程 E2E：真实 runtime + 非 mock renderer（桌面 Electron + 移动 chromium）
      name: 'remote',
      testDir: './e2e/remote',
      testMatch: '**/*.spec.ts',
      // 远程 E2E 更慢（真实 runtime spawn + pi 子进程 + WS 握手 + 首屏渲染）
      timeout: 120_000,
      use: {
        ...devices['Desktop Chrome'],
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
      },
    },
  ],
})
