import { createRequire } from 'node:module'
import semver from 'semver'

const require = createRequire(import.meta.url)

/** 当前 xyz-agent runtime 版本 */
function getAppVersion(): string {
  try {
    const pkg = require('../../../package.json') as { version: string }
    return pkg.version
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
