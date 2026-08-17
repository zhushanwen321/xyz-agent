import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url))

/**
 * Playwright config —— xyz-agent E2E（Electron 行为 + visual chromium 像素 diff）。
 *
 * 双 project 架构（W3 新增 visual-chromium，与 electron 共存互斥）：
 * - electron        : 行为 E2E（_electron.launch + mock 构建产物），testIgnore visual/**
 * - visual-chromium : 像素 diff（chromium.launch + spawn vite dev server @ VITE_MOCK=true），
 *                     testMatch visual/**。baseline 锚定 e2e/visual-baselines/（git tracked）
 *
 * E2E 策略（见 execution-plan W0 + slice v6-ui-refactor-test-infra IF3）：
 * - globalSetup 跑 build:e2e 确保 Electron 构建产物存在（已构建则跳过；visual project 共享此 setup，
 *   产物缺失时会先 build，属正常）
 * - workers: 1（Electron 多实例争抢 userData LOCK + 端口，强制串行；visual 也串行保证 baseline 稳定）
 *
 * visual project 的 vite 由 e2e/visual/fixtures/visual-server.ts 的 worker-scoped fixture 管理
 *（复用 W1/W2 spawnVite 范式），不用全局 webServer——避免 visual 的 vite 依赖拖累 electron project。
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',

  // Electron 多实例会争抢 Chromium userData LOCK + 端口，强制串行；visual baseline 也需串行稳定
  fullyParallel: false,
  workers: 1,

  // Electron app 启动 + renderer mock 初始化较慢，给足超时；visual spawn vite 也需余量
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // 失败时保留 trace + screenshot（调试用）
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
      // 行为 E2E：_electron.launch + mock 构建产物。排除 visual/ 目录（由 visual-chromium 接管）
      name: 'electron',
      testIgnore: '**/visual/**/*.spec.ts',
      use: {},
    },
    {
      // 像素 diff：chromium.launch + spawn vite dev server（fixture 管理）。
      // viewport 固定保证 baseline 跨次稳定；snapshotDir 锚定 e2e/visual-baselines/（git tracked，Q3/D3）；
      // snapshotPathTemplate 按 spec 文件名分目录（shell.spec.ts → e2e/visual-baselines/shell.spec/shell-default.png）
      // snapshotDir / snapshotPathTemplate 是 TestProject 直接属性（非 use），见 Playwright test.d.ts TestProject
      name: 'visual-chromium',
      testMatch: '**/visual/**/*.spec.ts',
      snapshotDir: path.resolve(REPO_ROOT, 'e2e', 'visual-baselines'),
      snapshotPathTemplate: '{snapshotDir}/{testFileBaseName}/{arg}{ext}',
      use: {
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
})
