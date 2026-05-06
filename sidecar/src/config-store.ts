import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG_DIR = join(homedir(), '.xyz-agent')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

export interface ProviderConfig {
  apiKey: string
  baseUrl?: string
}

export interface AppConfig {
  defaults: {
    model: string
    thinkingMode: string
    temperature: number
  }
  providers: Record<string, ProviderConfig>
}

const defaults: AppConfig = {
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
      return { ...defaults, ...JSON.parse(raw) }
    }
  } catch (e) {
    console.error('[config] load error:', e)
  }
  return defaults
}

export function saveConfig(config: AppConfig): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
  } catch (e) {
    console.error('[config] save error:', e)
  }
}
