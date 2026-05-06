import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG_DIR = join(homedir(), '.xyz-agent')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

export interface ProviderConfig {
  name: string
  apiKey: string
  baseUrl?: string
  models?: string[]
}

export interface AppConfig {
  defaults: {
    model: string
    thinkingMode: string
    temperature: number
  }
  providers: Record<string, ProviderConfig>
}

const DEFAULTS: Readonly<AppConfig> = {
  defaults: {
    model: 'anthropic/claude-sonnet',
    thinkingMode: 'high',
    temperature: 0.7,
  },
  providers: {},
}

export function loadConfig(): AppConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, 'utf-8')
      const parsed = JSON.parse(raw)
      return {
        defaults: { ...DEFAULTS.defaults, ...parsed.defaults },
        providers: { ...DEFAULTS.providers, ...parsed.providers },
      }
    }
  } catch (e) {
    console.error('[config] load error:', e)
  }
  return { defaults: { ...DEFAULTS.defaults }, providers: {} }
}

export function saveConfig(config: AppConfig): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
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

export function getDefaultModel(): string {
  return loadConfig().defaults.model
}
