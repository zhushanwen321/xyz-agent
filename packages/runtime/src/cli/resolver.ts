/**
 * CLI 路径解析：dev 模式用 tsup 输出，packaged 模式用 extraResources 路径。
 * Skill 引用此模块获取 CLI 绝对路径。
 * 支持 XYZ_SETTINGS_CLI 环境变量覆盖（测试/CI 场景）。
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// tsup CJS bundle 下 __dirname 是 Node 注入的模块变量（正常）；
// vitest ESM 下未定义 → 用 typeof guard 兜底，undefined 时跳过 dev 候选路径。
const cliDir = typeof __dirname !== 'undefined' ? __dirname : undefined

/**
 * 获取 xyz-settings CLI 的绝对路径。
 * 优先级：XYZ_SETTINGS_CLI 环境变量 > packaged 路径 > dev 路径
 */
export function getCliPath(): string {
  // 环境变量覆盖（测试/CI）
  const envPath = process.env.XYZ_SETTINGS_CLI
  if (envPath && existsSync(envPath)) {
    return resolve(envPath)
  }

  // packaged 模式：extraResources bin/xyz-settings
  if (process.resourcesPath) {
    const packagedPath = join(process.resourcesPath, 'bin', 'xyz-settings')
    if (existsSync(packagedPath)) {
      return packagedPath
    }
  }

  // dev 模式：tsup 输出。cliDir 在 ESM（vitest）下可能 undefined → 跳过候选。
  const devCandidates = cliDir
    ? [
        // 从 tsup 输出的 cli.cjs（bundle 后 __dirname = apps/electron/dist/runtime/）
        join(cliDir, 'cli.cjs'),
        // 从 src 源码（vitest 测试时 __dirname = packages/runtime/src/cli/）
        resolve(cliDir, '..', '..', '..', '..', 'apps', 'electron', 'dist', 'runtime', 'cli.cjs'),
      ]
    : []

  for (const candidate of devCandidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(
    'xyz-settings CLI not found. Set XYZ_SETTINGS_CLI env var or run "npx tsup" in packages/runtime.'
  )
}
