/**
 * Playwright globalSetup —— 测试启动前确保 Electron 构建产物存在。
 *
 * 产物缺失时自动跑 build:e2e（build:main + build:preload + build:vite with VITE_E2E）。
 * 产物已存在则跳过（增量开发时避免每次重建，节省时间）。
 *
 * 产物路径：
 * - apps/electron/dist/main/main.cjs（main entry）
 * - apps/electron/dist/preload/preload.cjs（preload）
 * - apps/electron/renderer/dist/index.html（renderer，E2E 构建时带 VITE_E2E=true）
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC_ELECTRON = path.join(REPO_ROOT, 'apps/electron')

const ARTIFACTS = [
  path.join(SRC_ELECTRON, 'dist/main/main.cjs'),
  path.join(SRC_ELECTRON, 'dist/preload/preload.cjs'),
  path.join(SRC_ELECTRON, 'renderer/dist/index.html'),
]

function artifactsMissing(): boolean {
  return ARTIFACTS.some((p) => !fs.existsSync(p))
}

export default async function globalSetup(): Promise<void> {
  if (artifactsMissing()) {
    console.log('[e2e global-setup] 构建产物缺失，跑 build:e2e ...')
    // VITE_E2E=true 必须透传给 renderer 构建（vite.config.ts define 读此注入 sample-project cwd）
    // VITE_MOCK=true 同理（renderer 构建期把 mock 开关打进 bundle）
    execSync('npm run build:e2e', {
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
}
