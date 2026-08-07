/**
 * Playwright globalSetup —— 测试启动前确保构建产物存在 + 远程 dist 校验。
 *
 * 产物缺失时自动跑 build:e2e（build:main + build:preload + build:vite with VITE_E2E）。
 * 产物已存在则跳过（增量开发时避免每次重建，节省时间）。
 *
 * 产物路径：
 * - apps/electron/dist/main/main.cjs（main entry）
 * - apps/electron/dist/preload/preload.cjs（preload）
 * - apps/electron/renderer/dist/index.html（renderer，E2E 构建时带 VITE_E2E=true）
 *
 * 远程 E2E 额外校验（spec remote-use G2：非 mock dist）：
 * - packages/runtime/dist/server.cjs（runtime spawn 入口，remote-runtime fixture 依赖）
 * - packages/mobile-renderer/dist/index.html（--serve-web 静态托管入口，launch-mobile-browser 依赖）
 * - renderer dist 含远程代码（非 mock 构建：grep 'xyz-agent:remote-servers' 命中）
 * - main dist 含 XYZ_NO_LOCAL_RUNTIME 处理（spec remote-use 阶段 1：远程模式跳过本地 runtime spawn）
 *
 * 远程 dist 不自动重建（mock/real renderer dist 冲突——同 outDir，重建会覆盖）：
 * 缺失时打印明确构建指引 + 抛错，让用户手动构建（与 verify-mobile-web.cjs 友好降级不同，
 * 远程 E2E 无 dist 必然失败，不如提前 fail-fast）。
 * 设 XYZ_E2E_SKIP_REMOTE_CHECK=1 可跳过远程校验（仅 mock E2E 场景）。
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON_DIR = path.join(REPO_ROOT, 'apps/electron')

const ARTIFACTS = [
  path.join(ELECTRON_DIR, 'dist/main/main.cjs'),
  path.join(ELECTRON_DIR, 'dist/preload/preload.cjs'),
  path.join(ELECTRON_DIR, 'renderer/dist/index.html'),
]

/** 远程 E2E 依赖的产物（runtime + mobile + 非 mock renderer + 含 flag 的 main）。 */
const REMOTE_ARTIFACTS = {
  runtimeServer: path.join(REPO_ROOT, 'packages/runtime/dist/server.cjs'),
  mobileIndex: path.join(REPO_ROOT, 'packages/mobile-renderer/dist/index.html'),
  rendererDir: path.join(ELECTRON_DIR, 'renderer/dist'),
  mainCjs: path.join(ELECTRON_DIR, 'dist/main/main.cjs'),
}

function artifactsMissing(): boolean {
  return ARTIFACTS.some((p) => !fs.existsSync(p))
}

/** renderer dist 是否含远程代码（非 mock 构建）。grep 'xyz-agent:remote-servers' 命中即含。 */
function rendererDistHasRemoteCode(): boolean {
  const assetsDir = path.join(REMOTE_ARTIFACTS.rendererDir, 'assets')
  if (!fs.existsSync(assetsDir)) return false
  for (const f of fs.readdirSync(assetsDir)) {
    if (!f.endsWith('.js')) continue
    try {
      const content = fs.readFileSync(path.join(assetsDir, f), 'utf8')
      if (content.includes('xyz-agent:remote-servers')) return true
    } catch {
      // 读失败跳过（best-effort）
    }
  }
  return false
}

/** main dist 是否含 XYZ_NO_LOCAL_RUNTIME 处理（spec remote-use 阶段 1）。 */
function mainDistHasNoLocalRuntimeFlag(): boolean {
  try {
    const content = fs.readFileSync(REMOTE_ARTIFACTS.mainCjs, 'utf8')
    return content.includes('XYZ_NO_LOCAL_RUNTIME')
  } catch {
    return false
  }
}

/**
 * 远程 E2E dist 校验：缺失/不符时打印明确指引 + 抛错。
 *
 * 不自动重建原因：renderer dist 的 mock/real 构建共用 outDir（apps/electron/renderer/dist），
 * 自动重建会覆盖另一模式（launch-app-real.ts L10 已记录此冲突）。故 fail-fast 让用户手动构建。
 */
function assertRemoteArtifacts(): void {
  const failures: string[] = []

  if (!fs.existsSync(REMOTE_ARTIFACTS.runtimeServer)) {
    failures.push(`runtime dist 缺失：${REMOTE_ARTIFACTS.runtimeServer}`)
  }
  if (!fs.existsSync(REMOTE_ARTIFACTS.mobileIndex)) {
    failures.push(`mobile-renderer dist 缺失：${REMOTE_ARTIFACTS.mobileIndex}`)
  }
  if (!rendererDistHasRemoteCode()) {
    failures.push(
      `renderer dist 不含远程代码（疑似 mock 构建）：${REMOTE_ARTIFACTS.rendererDir}\n` +
        '    remote E2E 需非 mock 构建（无 VITE_MOCK），构建命令：\n' +
        '      pnpm --filter @xyz-agent/frontend run build',
    )
  }
  if (!mainDistHasNoLocalRuntimeFlag()) {
    failures.push(
      `main dist 不含 XYZ_NO_LOCAL_RUNTIME 处理（疑似 stale）：${REMOTE_ARTIFACTS.mainCjs}\n` +
        '    重新构建 main：cd apps/electron && pnpm run build:main',
    )
  }

  if (failures.length === 0) return

  console.error('[e2e global-setup] 远程 E2E dist 校验失败：')
  for (const f of failures) console.error('  - ' + f)
  console.error(
    '\n注意：renderer dist 的 mock/real 构建共用 outDir，自动重建会覆盖另一模式，故需手动构建。\n' +
      '设 XYZ_E2E_SKIP_REMOTE_CHECK=1 可跳过本校验（仅 mock E2E 场景）。',
  )
  throw new Error('[e2e global-setup] 远程 E2E dist 校验失败（见上方详情）')
}

export default async function globalSetup(): Promise<void> {
  if (artifactsMissing()) {
    console.log('[e2e global-setup] 构建产物缺失，跑 build:e2e ...')
    // VITE_E2E=true 必须透传给 renderer 构建（vite.config.ts define 读此注入 sample-project cwd）
    // VITE_MOCK=true 同理（renderer 构建期把 mock 开关打进 bundle）
    execSync('pnpm run build:e2e', {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, VITE_E2E: 'true', VITE_MOCK: 'true' },
      timeout: 180_000,
    })
    if (artifactsMissing()) {
      throw new Error('[e2e global-setup] build:e2e 完成后产物仍缺失：' + ARTIFACTS.filter((p) => !fs.existsSync(p)).join(', '))
    }
    console.log('[e2e global-setup] 构建产物就绪')
  } else {
    console.log('[e2e global-setup] 构建产物已存在，跳过 build')
  }

  // 远程 E2E dist 校验（除非显式跳过）
  if (process.env.XYZ_E2E_SKIP_REMOTE_CHECK === '1') {
    console.log('[e2e global-setup] XYZ_E2E_SKIP_REMOTE_CHECK=1，跳过远程 dist 校验')
  } else {
    assertRemoteArtifacts()
    console.log('[e2e global-setup] 远程 E2E dist 校验通过')
  }
}
