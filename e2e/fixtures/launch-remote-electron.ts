/**
 * launch-remote-electron fixture —— 桌面 Electron 连接远程 runtime（spec remote-use）。
 *
 * 设计依据（参照 e2e/fixtures/launch-app.ts 范式 + remote-use 阶段 1 的 XYZ_NO_LOCAL_RUNTIME）：
 *  - 与 launch-app.ts 的差异：
 *    - 不设 VITE_MOCK → renderer bundle 走 real transport/ws-client（连远程 runtime）
 *    - 不设 XYZ_MOCK，改设 XYZ_NO_LOCAL_RUNTIME=1 → main 跳过本地 runtime spawn + 端口 IPC 广播
 *      （renderer 不会误连 dev runtime 3310；改由 localStorage remote profile 连指定远程 runtime）
 *    - 保留 XYZ_E2E=1 → window-factory 跳过 vite 轮询直接 loadFile 构建产物
 *    - 独立临时 dataDir（XYZ_AGENT_DATA_DIR，隔离 + 防 Chromium LevelDB LOCK 竞争）
 *  - 远程连接注入：launch 后通过 page.evaluate 注入 localStorage 5 key（connection-mode/client-id/
 *    active-server-id/remote-servers），reload 触发 useConnection 走远程分支 connect。
 *
 * 注意：renderer dist 必须是非 mock 构建（无 VITE_MOCK，含 remote lib）。
 * mock 构建（VITE_MOCK=true）会在 useConnection.init 走 mock 分支提前 return，永不触达远程分支。
 * global-setup 会校验 renderer dist 含远程代码（grep 'xyz-agent:remote-servers'）。
 *
 * 用法：
 *   const runtime = await startRemoteRuntime()
 *   const desktop = await launchRemoteElectron(runtime)
 *   try { /* 用 desktop.page 操作桌面 UI *\/ }
 *   finally { await desktop.cleanup(); await runtime.stop() }
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import type { RemoteRuntimeInfo } from './remote-runtime'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON_DIR = path.join(REPO_ROOT, 'apps/electron')

// pnpm hoisted 模式下 electron 包提升到 root node_modules/electron，
// createRequire 需以 workspace 子包目录为起点才能正确解析（与 launch-app.ts 同范式）。
const requireFromElectronDir = createRequire(path.join(ELECTRON_DIR, 'noop.js'))
const ELECTRON_EXECUTABLE = requireFromElectronDir('electron') as string

/** 等待桌面「已连接」标志的 deadline（WS auth + sendInitialState + 首屏渲染较慢）。 */
const CONNECTED_TIMEOUT_MS = 45_000

export interface LaunchRemoteElectronOptions {
  /** 覆盖等待 connected 的超时（默认 45s）。 */
  connectTimeoutMs?: number
  /**
   * 强制 clientId（replaced 场景需桌面/移动用同一 clientId 触发 replaced 事件，spec R3）。
   * 默认 = 随机 uuid（每次启动独立客户端身份）。
   */
  clientId?: string
}

export interface LaunchedRemoteElectron {
  app: ElectronApplication
  page: Page
  /** 注入的 clientId（replaced 测试断言用）。 */
  clientId: string
  cleanup: () => Promise<void>
}

/**
 * 启动桌面 Electron（远程模式）+ 注入 localStorage + reload + 等待连接。
 *
 * @param runtime startRemoteRuntime() 的返回值（提供 wsUrl + token）
 * @returns app + page + clientId + cleanup
 * @throws 若 connected 标志（new-task-landing）在超时内未出现
 */
export async function launchRemoteElectron(
  runtime: RemoteRuntimeInfo,
  opts: LaunchRemoteElectronOptions = {},
): Promise<LaunchedRemoteElectron> {
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xyz-e2e-remote-electron-'))

  const app = await electron.launch({
    executablePath: ELECTRON_EXECUTABLE,
    cwd: ELECTRON_DIR,
    env: {
      ...process.env,
      // 不设 VITE_MOCK（renderer 已非 mock 构建，含 remote lib）
      // 跳过本地 runtime spawn + 端口 IPC 广播（spec remote-use 阶段 1）
      XYZ_NO_LOCAL_RUNTIME: '1',
      // 跳过 vite 轮询直接 loadFile 构建产物（与 launch-app.ts 同范式）
      XYZ_E2E: '1',
      // 隔离数据目录（防 Chromium LevelDB LOCK 竞争 + 不污染 dev/prod）
      XYZ_AGENT_DATA_DIR: tmpDataDir,
    },
    args: ['.'],
  })

  // 等首个窗口（firstWindow 拿渲染页 page）
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // ── 注入 localStorage 5 key（remote connection profile）──────────
  // useConnection.init 读 connection-config（localStorage SSOT）决定走本地/远程分支：
  //   - connection-mode='remote' + active-server-id 指向存在的 profile → 远程分支 connect(wsUrl, token)
  //   - 否则 → 本地分支（连 main 广播的 runtime-port）
  // XYZ_NO_LOCAL_RUNTIME=1 时 main 不广播 runtime-port，本地分支会失败；
  // 故必须注入完整 remote profile 让 renderer 走远程分支。
  const clientId = opts.clientId ?? cryptoRandomUuid()
  const profile = {
    id: clientId,
    name: 'E2E Test',
    url: runtime.wsUrl,
    token: runtime.token,
    networkKind: 'localhost' as const,
  }
  await page.evaluate(
    ({ clientId, profile }) => {
      // crypto.randomUUID 在 renderer（Chromium）可用
      localStorage.setItem('xyz-agent:connection-mode', 'remote')
      localStorage.setItem('xyz-agent:client-id', clientId)
      localStorage.setItem('xyz-agent:active-server-id', profile.id)
      localStorage.setItem('xyz-agent:remote-servers', JSON.stringify([profile]))
    },
    { clientId, profile },
  )

  // reload 触发 useConnection 重新 init（读新注入的 localStorage remote profile → 连远程 runtime）
  await page.reload({ waitUntil: 'domcontentloaded' })

  // ── 等待「已连接」标志 ────────────────────────────────────────────
  // new-task-landing = 桌面 renderer 连接成功后的 landing 页（Landing.vue data-testid）。
  // 出现即说明 WS auth + sendInitialState 通过 + 首屏渲染完成。
  await page.waitForSelector('[data-testid="new-task-landing"]', {
    timeout: opts.connectTimeoutMs ?? CONNECTED_TIMEOUT_MS,
    state: 'attached',
  })

  const cleanup = async (): Promise<void> => {
    try {
      await app.close()
    } finally {
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    }
  }

  return { app, page, clientId, cleanup }
}

/**
 * 生成 uuid（优先 crypto.randomUUID，Node 上下文无 crypto 时降级 Date+Math.random）。
 * 与 connection-config.generateUuid 同语义（renderer 侧 getClientId 惰性生成用同一逻辑）。
 */
function cryptoRandomUuid(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
