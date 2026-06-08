import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './scanner-base.js'
import { getDefaultModel as getPiDefaultModel, getConfigDir } from './pi-config-bridge.js'

function configPath(): string {
  return join(getConfigDir(), 'config.json')
}

export interface AppConfig {
  defaults: {
    temperature: number
  }
  toolPermissions?: Record<string, string>
}

const DEFAULT_TEMPERATURE = 0.7

const DEFAULTS: Readonly<AppConfig> = {
  defaults: {
    temperature: DEFAULT_TEMPERATURE,
  },
}

export function loadConfig(): AppConfig {
  try {
    const cp = configPath()
    if (existsSync(cp)) {
      const raw = readFileSync(cp, 'utf-8')
      const parsed = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        console.error('[config] config.json is not a valid object, using defaults')
      } else {
        return {
          defaults: { ...DEFAULTS.defaults, ...(typeof parsed.defaults === 'object' && parsed.defaults ? parsed.defaults : {}) },
          ...(parsed.toolPermissions && typeof parsed.toolPermissions === 'object' ? { toolPermissions: parsed.toolPermissions } : {}),
        }
      }
    }
  // eslint-disable-next-line taste/no-silent-catch -- intentional: config file missing/corrupt is handled by fallback
  } catch (e) {
    console.error('[config] load error:', e)
  }

  return { defaults: { ...DEFAULTS.defaults } }
}

const JSON_INDENT = 2

export function saveConfig(config: AppConfig): void {
  try {
    const cd = getConfigDir()
    if (!existsSync(cd)) mkdirSync(cd, { recursive: true })
    atomicWrite(configPath(), JSON.stringify(config, null, JSON_INDENT))
  // eslint-disable-next-line taste/no-silent-catch -- intentional: save failure is best-effort
  } catch (e) {
    console.error('[config] save error:', e)
  }
}

export function updateToolPermissions(permissions: Record<string, string>): void {
  const config = loadConfig()
  config.toolPermissions = permissions
  saveConfig(config)
}

export function getToolPermissions(): Record<string, string> {
  return loadConfig().toolPermissions ?? {}
}

export function getDefaultModel(): string {
  const result = getPiDefaultModel()
  if (result) {
    return `${result.provider}/${result.modelId}`
  }
  return 'anthropic/claude-sonnet'
}
