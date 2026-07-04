/**
 * Playwright _electron launch fixture —— REAL 模式（与 launch-app.ts 的 mock 模式对立）。
 *
 * 与 mock 模式的差异：
 * - 不设 VITE_MOCK → renderer bundle（构建期 VITE_MOCK=false/undefined）走 real transport/ws-client
 * - 不设 XYZ_MOCK → main.ts 启动 runtime（spawn pi 子进程 + WS server）
 * - 保留 XYZ_E2E=1 → window-factory 跳过 vite 轮询 + loadFile 构建产物 + showInactive
 * - 保留 XYZ_AGENT_DATA_DIR → 隔离数据目录（临时）
 *
 * 注意：real E2E 需要单独 build real renderer bundle（VITE_MOCK 不传），
 * 与 mock bundle 输出冲突（同 renderer/dist）→ mock/real E2E 分批 build + 跑。
 */
import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC_ELECTRON = path.join(REPO_ROOT, 'apps/electron')

const requireFromSrcElectron = createRequire(path.join(SRC_ELECTRON, 'noop.js'))
const ELECTRON_EXECUTABLE = requireFromSrcElectron('electron') as string

/** waitForRuntime 默认超时：pi 子进程 spawn 较慢，给 30s */
const RUNTIME_START_TIMEOUT_MS = 30_000
/** waitForRuntime 轮询 runtime.port 文件的间隔 */
const RUNTIME_PORT_POLL_INTERVAL_MS = 300

export interface RealLaunchOptions {
  /** 覆盖数据目录（默认每次临时目录）；用于「重启」场景复用同一目录 */
  dataDir?: string
}

/**
 * 启动 REAL 模式 xyz-agent（runtime + real renderer bundle）。
 *
 * @returns app + page + cleanup + dataDir（供重启场景复用）
 */
export async function launchRealApp(opts: RealLaunchOptions = {}): Promise<{
  app: ElectronApplication
  page: Page
  dataDir: string
  cleanup: () => Promise<void>
}> {
  // 复用传入 dataDir（重启场景）或新建临时目录
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'xyz-real-'))
  fs.mkdirSync(dataDir, { recursive: true })

  const app = await electron.launch({
    executablePath: ELECTRON_EXECUTABLE,
    cwd: SRC_ELECTRON,
    env: {
      ...process.env,
      // 不设 VITE_MOCK（renderer 已 real bundle）+ 不设 XYZ_MOCK（启动 runtime）
      XYZ_E2E: '1',
      XYZ_AGENT_DATA_DIR: dataDir,
    },
    args: ['.'],
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  const cleanup = async (): Promise<void> => {
    try {
      await app.close()
    } finally {
      // 仅清理自建的临时目录（opts.dataDir 传入的由调用方管理）
      if (!opts.dataDir) {
        fs.rmSync(dataDir, { recursive: true, force: true })
      }
    }
  }

  return { app, page, dataDir, cleanup }
}

/**
 * 等 runtime 健康（runtime.port 文件出现 = spawn + waitForHealth + writePortFile 全通过）。
 * @param dataDir 数据目录（runtime.port 所在）
 * @param timeoutMs 默认 30s（pi 子进程 spawn 较慢）
 */
export async function waitForRuntime(dataDir: string, timeoutMs = RUNTIME_START_TIMEOUT_MS): Promise<number> {
  const portFile = path.join(dataDir, 'runtime.port')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const port = parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10)
      if (port > 0) return port
    }
    await new Promise((r) => setTimeout(r, RUNTIME_PORT_POLL_INTERVAL_MS))
  }
  throw new Error(`runtime.port not found in ${dataDir} within ${timeoutMs}ms — runtime failed to start`)
}

export const realTest = base.extend<{ electronApp: ElectronApplication; page: Page }>({
  electronApp: async ({}, use) => {
    const { app, cleanup } = await launchRealApp()
    await use(app)
    await cleanup()
  },
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  },
})

export { expect }
