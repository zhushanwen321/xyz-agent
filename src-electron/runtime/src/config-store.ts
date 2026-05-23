import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite } from './scanner-base.js'

const CONFIG_DIR = join(homedir(), '.xyz-agent')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

export interface ProviderConfig {
  name: string
  apiKey: string
  type?: string
  baseUrl?: string
  models?: Array<string | { id: string; name?: string; ctx?: number; tags?: string[]; enabled?: boolean }>
  enabled?: boolean
}

export interface AppConfig {
  defaults: {
    model: string
    thinkingMode: string
    temperature: number
  }
  providers: Record<string, ProviderConfig>
  toolPermissions?: Record<string, string>
}


const DEFAULT_TEMPERATURE = 0.7

const DEFAULTS: Readonly<AppConfig> = {
  defaults: {
    model: '',  // Will be resolved from pi config at runtime
    thinkingMode: 'high',
    temperature: DEFAULT_TEMPERATURE,
  },
  providers: {},
}

function loadPiConfig(): Record<string, ProviderConfig> | null {
  // Packaged mode: skip reading from ~/.pi (not bundled)
  if (process.env.XYZ_AGENT_PACKAGED === '1') return null

  try {
    const piJsonPath = join(homedir(), '.pi', 'config.json')
    if (existsSync(piJsonPath)) {
      const raw = readFileSync(piJsonPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed.providers && typeof parsed.providers === 'object') {
        return parsed.providers as Record<string, ProviderConfig>
      }
    }
  // eslint-disable-next-line taste/no-silent-catch -- intentional: pi config not available is acceptable
  } catch (e) {
    console.error('[config] pi config not available:', e)
  }
  return null
}

export function loadConfig(): AppConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, 'utf-8')
      const parsed = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        console.error('[config] config.json is not a valid object, using defaults')
      } else {
        return {
          defaults: { ...DEFAULTS.defaults, ...(typeof parsed.defaults === 'object' && parsed.defaults ? parsed.defaults : {}) },
          providers: { ...DEFAULTS.providers, ...(typeof parsed.providers === 'object' && parsed.providers ? parsed.providers : {}) },
          ...(parsed.toolPermissions && typeof parsed.toolPermissions === 'object' ? { toolPermissions: parsed.toolPermissions } : {}),
        }
      }
    }
  // eslint-disable-next-line taste/no-silent-catch -- intentional: config file missing/corrupt is handled by fallback
  } catch (e) {
    console.error('[config] load error:', e)
  }

  // Fallback: try pi config
  const piProviders = loadPiConfig()
  if (piProviders) {
    console.log('[config] using pi config as fallback')
    return { defaults: { ...DEFAULTS.defaults }, providers: piProviders }
  }

  return { defaults: { ...DEFAULTS.defaults }, providers: { ...DEFAULTS.providers } }
}

const JSON_INDENT = 2

export function saveConfig(config: AppConfig): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
    atomicWrite(CONFIG_PATH, JSON.stringify(config, null, JSON_INDENT))
  // eslint-disable-next-line taste/no-silent-catch -- intentional: save failure is best-effort
  } catch (e) {
    console.error('[config] save error:', e)
  }
}

export function updateProvider(providerId: string, data: Partial<ProviderConfig>): void {
  const config = loadConfig()
  const existing = config.providers[providerId] ?? { name: providerId, apiKey: '' }
  config.providers[providerId] = { ...existing, ...data }
  saveConfig(config)
}

export function removeProvider(providerId: string): boolean {
  const config = loadConfig()
  if (!(providerId in config.providers)) return false
  delete config.providers[providerId]
  saveConfig(config)
  return true
}

export function updateToolPermissions(permissions: Record<string, string>): void {
  const config = loadConfig()
  config.toolPermissions = permissions
  saveConfig(config)
}

export function getToolPermissions(): Record<string, string> {
  return loadConfig().toolPermissions ?? {}
}

export function getProvider(providerId: string): ProviderConfig | undefined {
  return loadConfig().providers[providerId]
}

export function updateDefaults(defaults: Partial<AppConfig['defaults']>): void {
  const config = loadConfig()
  config.defaults = { ...config.defaults, ...defaults }
  saveConfig(config)
}

export function buildProviderEnv(providerId: string): Record<string, string> {
  const config = loadConfig()
  const provider = config.providers[providerId]
  if (!provider) return {}

  const envPrefix = providerId.toUpperCase().replace(/-/g, '_')
  const env: Record<string, string> = {}
  if (provider.apiKey) {
    env[`${envPrefix}_API_KEY`] = provider.apiKey
  }
  if (provider.baseUrl) {
    env[`${envPrefix}_BASE_URL`] = provider.baseUrl
  }
  return env
}

/**
 * Read available models from pi's models.json and return the first one
 * in "provider/modelId" format. Falls back to config defaults.
 */
function readPiDefaultModel(): string | null {
  // Packaged mode: skip reading from ~/.pi (not bundled)
  if (process.env.XYZ_AGENT_PACKAGED === '1') return null

  try {
    const piModelsPath = join(homedir(), '.pi', 'agent', 'models.json')
    if (!existsSync(piModelsPath)) return null
    const raw = readFileSync(piModelsPath, 'utf-8')
    const parsed = JSON.parse(raw)
    const providers = parsed?.providers
    if (!providers || typeof providers !== 'object') return null
    // Take the first provider with models
    for (const [providerId, prov] of Object.entries(providers)) {
      const p = prov as { models?: Array<{ id: string }> }
      if (Array.isArray(p.models) && p.models.length > 0) {
        return `${providerId}/${p.models[0].id}`
      }
    }
    return null
  } catch (e) {
    console.error('[config] pi model read error:', e)
    return null
  }
}

export function getDefaultModel(): string {
  const configDefault = loadConfig().defaults.model
  // Only use config default if it's a non-empty, non-anthropically-hardcoded value
  if (configDefault && configDefault !== 'anthropic/claude-sonnet') return configDefault
  // Fallback: read from pi's models.json
  const piModel = readPiDefaultModel()
  if (piModel) return piModel
  // Last resort
  return configDefault || 'anthropic/claude-sonnet'
}
