import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG_DIR = join(homedir(), '.xyz-agent')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

export interface ProviderConfig {
  name: string
  apiKey: string
  type?: string
  baseUrl?: string
  models?: Array<string | { id: string; name?: string; ctx?: number; tags?: string[] }>
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
  try {
    const piJsonPath = join(homedir(), '.pi', 'config.json')
    if (existsSync(piJsonPath)) {
      const raw = readFileSync(piJsonPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed.providers && typeof parsed.providers === 'object') {
        return parsed.providers as Record<string, ProviderConfig>
      }
    }
  } catch {
    // pi config not available, that's fine
  }
  return null
}

export function loadConfig(): AppConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, 'utf-8')
      const parsed = JSON.parse(raw)
      return {
        defaults: { ...DEFAULTS.defaults, ...parsed.defaults },
        providers: { ...DEFAULTS.providers, ...parsed.providers },
        ...(parsed.toolPermissions && { toolPermissions: parsed.toolPermissions }),
      }
    }
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

import type { SkillInfo, AgentInfo } from '@xyz-agent/shared'

const JSON_INDENT = 2

export function saveConfig(config: AppConfig): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, JSON_INDENT))
  // eslint-disable-next-line taste/no-silent-catch -- save failure is best-effort, config persists on next successful save
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
  } catch {
    return null
  }
}

export function loadSkills(projectRoot: string): SkillInfo[] {
  const dir = join(projectRoot, '.xyz-agent')
  const path = join(dir, 'skills.json')
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8')
      return JSON.parse(raw) as SkillInfo[]
    }
  } catch (e) {
    console.error('[config] load skills error:', e)
  }
  return []
}

export function saveSkills(projectRoot: string, skills: SkillInfo[]): void {
  try {
    const dir = join(projectRoot, '.xyz-agent')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'skills.json'), JSON.stringify(skills, null, JSON_INDENT))
  } catch (e) {
    console.error('[config] save skills error:', e)
  }
}

export function loadAgents(projectRoot: string): AgentInfo[] {
  const dir = join(projectRoot, '.xyz-agent')
  const path = join(dir, 'agents.json')
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8')
      return JSON.parse(raw) as AgentInfo[]
    }
  } catch (e) {
    console.error('[config] load agents error:', e)
  }
  return []
}

export function saveAgents(projectRoot: string, agents: AgentInfo[]): void {
  try {
    const dir = join(projectRoot, '.xyz-agent')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agents.json'), JSON.stringify(agents, null, JSON_INDENT))
  } catch (e) {
    console.error('[config] save agents error:', e)
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
