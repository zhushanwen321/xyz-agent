import semver from 'semver'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** 使用 process.cwd() 定位 package.json，兼容 CJS bundle */
function getAppVersion(): string {
  try {
    // CJS bundle 时 import.meta.url 为 undefined，用 cwd() + 向上查找代替
    let dir = process.cwd()
    for (let i = 0; i < 10; i++) {
      const pkgPath = path.join(dir, 'package.json')
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }
        return pkg.version
      } catch {
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
    return '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export interface CompatibilityResult {
  compatible: boolean
  reason?: string
}

export function checkPluginCompatibility(engineRange: string): CompatibilityResult {
  if (!engineRange || engineRange === '*') {
    return { compatible: true }
  }

  if (!semver.validRange(engineRange)) {
    return { compatible: false, reason: `Invalid version range: "${engineRange}"` }
  }

  const appVersion = getAppVersion()
  if (!semver.satisfies(appVersion, engineRange)) {
    return { compatible: false, reason: `Requires xyz-agent ${engineRange}, current is v${appVersion}` }
  }

  return { compatible: true }
}
