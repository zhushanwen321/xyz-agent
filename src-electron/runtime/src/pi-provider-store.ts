/**
 * Pi Provider/Model/Settings Store — xyz-pi 配置文件读写层
 *
 * 负责 models.json 和 settings.json 的原子读写、内存缓存、
 * defaultModel 校验/修复、provider CRUD 同步。
 *
 * 不包含：路径解析（pi-paths）、session 扫描（pi-config-bridge）、agent 管理（pi-config-bridge）
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, renameSync, rmdirSync, cpSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWrite } from './scanner-base.js'
import { getConfigDir, getModelsPath, getSettingsPath, getPiAgentDir, getSessionsDir, getAgentsDir } from './pi-paths.js'

// ── 类型定义（对齐 pi models.json / settings.json 的 schema）────

export interface PiModelDefinition {
  id: string
  name?: string
  api?: string
  baseUrl?: string
  reasoning?: boolean
  input?: Array<'text' | 'image'>
  contextWindow?: number
  maxTokens?: number
  headers?: Record<string, string>
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  compat?: Record<string, unknown>
  thinkingLevelMap?: Record<string, string | null>
}

export interface PiProviderConfig {
  name?: string
  baseUrl?: string
  apiKey?: string
  api?: string
  headers?: Record<string, string>
  authHeader?: boolean
  models?: PiModelDefinition[]
  modelOverrides?: Record<string, Record<string, unknown>>
}

export interface PiModelsConfig {
  providers: Record<string, PiProviderConfig>
}

export interface PiSettings {
  defaultProvider?: string
  defaultModel?: string
  defaultThinkingLevel?: string
  enabledModels?: string[]
  hideThinkingBlock?: boolean
  skills?: string[]
  extensions?: string[]
  [key: string]: unknown
}

// ── 缓存 ─────────────────────────────────────────────────────

const CACHE_TTL_MS = 3_000

interface CacheEntry<T> {
  data: T
  timestamp: number
}

let modelsCache: CacheEntry<PiModelsConfig> | null = null
let settingsCache: CacheEntry<PiSettings> | null = null

function isExpired(entry: { timestamp: number } | null): boolean {
  return !entry || Date.now() - entry.timestamp > CACHE_TTL_MS
}

// ── 原子读写 ─────────────────────────────────────────────────

const JSON_INDENT = 2

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(`[provider-store] 读取 ${filePath} 失败:`, err)
    }
    return fallback
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const json = JSON.stringify(data, null, JSON_INDENT) + '\n'
  atomicWrite(filePath, json)
}

// ── Models.json 操作 ──────────────────────────────────────────

export function readModels(): PiModelsConfig {
  if (!isExpired(modelsCache)) return modelsCache!.data
  const data = readJsonFile<PiModelsConfig>(getModelsPath(), { providers: {} })
  if (!data || typeof data !== 'object' || typeof data.providers !== 'object') {
    console.warn(`[provider-store] ${getModelsPath()} schema 不匹配，使用 fallback`)
    return { providers: {} }
  }
  modelsCache = { data, timestamp: Date.now() }
  return data
}

export function writeModels(config: PiModelsConfig): void {
  writeJsonFile(getModelsPath(), config)
  modelsCache = { data: JSON.parse(JSON.stringify(config)), timestamp: Date.now() }
}

export function getProviderNames(): string[] {
  return Object.keys(readModels().providers)
}

export function getProviderConfig(providerId: string): PiProviderConfig | undefined {
  const config = readModels().providers[providerId]
  return config ? JSON.parse(JSON.stringify(config)) : undefined
}

/**
 * 更新 provider 配置并同步校验 defaultModel。
 * 全程同步（无 await），避免竞态窗口。
 */
export function upsertProvider(providerId: string, config: PiProviderConfig): {
  newDefault?: { provider: string; modelId: string }
} {
  const models: PiModelsConfig = JSON.parse(JSON.stringify(readModels()))
  models.providers[providerId] = config
  writeModels(models)

  // 同步校验 defaultModel
  const settings: PiSettings = JSON.parse(JSON.stringify(readSettings()))
  if (settings.defaultProvider === providerId) {
    const newModelList = config.models ?? []
    if (newModelList.length === 0) {
      delete settings.defaultProvider
      delete settings.defaultModel
      writeSettings(settings)
      const { result } = findValidDefaultModel()
      if (result) {
        const fixed: PiSettings = JSON.parse(JSON.stringify(readSettings()))
        fixed.defaultProvider = result.provider
        fixed.defaultModel = result.modelId
        writeSettings(fixed)
        return { newDefault: result }
      }
      return {}
    }
    const currentModelId = settings.defaultModel
    if (currentModelId && !newModelList.find(m => m.id === currentModelId)) {
      const fallback = newModelList[0]
      settings.defaultModel = fallback.id
      writeSettings(settings)
      console.warn(`[provider-store] defaultModel "${currentModelId}" no longer in provider "${providerId}", falling back to "${fallback.id}"`)
      return { newDefault: { provider: providerId, modelId: fallback.id } }
    }
  }
  return {}
}

/**
 * 删除 provider 并同步清理 defaultProvider/defaultModel。
 * 全程同步（无 await），避免竞态窗口。
 */
export function removeProvider(providerId: string): {
  removed: boolean
  newDefault?: { provider: string; modelId: string }
} {
  const models: PiModelsConfig = JSON.parse(JSON.stringify(readModels()))
  if (!(providerId in models.providers)) return { removed: false }
  delete models.providers[providerId]
  writeModels(models)

  const settings: PiSettings = JSON.parse(JSON.stringify(readSettings()))
  if (settings.defaultProvider === providerId) {
    delete settings.defaultProvider
    delete settings.defaultModel
    writeSettings(settings)
    const { result } = findValidDefaultModel()
    if (result) {
      const fixed: PiSettings = JSON.parse(JSON.stringify(readSettings()))
      fixed.defaultProvider = result.provider
      fixed.defaultModel = result.modelId
      writeSettings(fixed)
      return { removed: true, newDefault: result }
    }
  }
  return { removed: true }
}

export function getAllModels(): Array<PiModelDefinition & { providerId: string }> {
  const result: Array<PiModelDefinition & { providerId: string }> = []
  const models = readModels()
  for (const [providerId, providerConfig] of Object.entries(models.providers)) {
    for (const model of providerConfig.models ?? []) {
      result.push({ ...model, providerId })
    }
  }
  return result
}

export function getApiKeyForProvider(providerId: string): string | undefined {
  return readModels().providers[providerId]?.apiKey
}

// ── Settings.json 操作 ───────────────────────────────────────

export function readSettings(): PiSettings {
  if (!isExpired(settingsCache)) return settingsCache!.data
  const data = readJsonFile<PiSettings>(getSettingsPath(), {})
  if (!data || typeof data !== 'object') {
    console.warn(`[provider-store] ${getSettingsPath()} schema 不匹配，使用 fallback`)
    return {}
  }
  settingsCache = { data, timestamp: Date.now() }
  return data
}

export function writeSettings(settings: PiSettings): void {
  writeJsonFile(getSettingsPath(), settings)
  settingsCache = { data: JSON.parse(JSON.stringify(settings)), timestamp: Date.now() }
}

/**
 * 纯校验：检查 defaultProvider/defaultModel 在 models.json 中是否有效。
 * 无副作用，不修改任何文件。
 */
export function findValidDefaultModel(): {
  result: { provider: string; modelId: string } | null
  wasFixed: boolean
} { // eslint-disable-line indent -- standard TS function signature with multi-line return type
  const settings = readSettings()
  const models = readModels()
  const { defaultProvider, defaultModel } = settings

  if (defaultProvider && defaultModel) {
    const providerConfig = models.providers[defaultProvider]
    if (providerConfig?.models?.length) {
      const found = providerConfig.models.find(m => m.id === defaultModel)
      if (found) {
        return { result: { provider: defaultProvider, modelId: defaultModel }, wasFixed: false }
      }
      console.warn(`[provider-store] defaultModel "${defaultModel}" not found in provider "${defaultProvider}", falling back to "${providerConfig.models[0].id}"`)
      return { result: { provider: defaultProvider, modelId: providerConfig.models[0].id }, wasFixed: true }
    }
    console.warn(`[provider-store] defaultProvider "${defaultProvider}" not found in models.json`)
  }

  for (const [providerId, providerConfig] of Object.entries(models.providers)) {
    if (providerConfig.models && providerConfig.models.length > 0) {
      return { result: { provider: providerId, modelId: providerConfig.models[0].id }, wasFixed: true }
    }
  }
  return { result: null, wasFixed: false }
}

/**
 * 获取默认模型，带有效性校验和自动修复。
 */
export function getDefaultModel(): { provider: string; modelId: string } | null {
  const { result, wasFixed } = findValidDefaultModel()
  if (wasFixed && result) {
    const settings: PiSettings = JSON.parse(JSON.stringify(readSettings()))
    settings.defaultProvider = result.provider
    settings.defaultModel = result.modelId
    writeSettings(settings)
    console.log(`[provider-store] auto-fixed defaultModel: ${result.provider}/${result.modelId}`)
  }
  return result
}

export function setDefaultModel(provider: string, modelId: string): void {
  const settings: PiSettings = JSON.parse(JSON.stringify(readSettings()))
  settings.defaultProvider = provider
  settings.defaultModel = modelId
  writeSettings(settings)
}

export function getEnabledModels(): string[] {
  return readSettings().enabledModels ?? []
}

export function setEnabledModels(patterns: string[]): void {
  const settings: PiSettings = JSON.parse(JSON.stringify(readSettings()))
  settings.enabledModels = patterns
  writeSettings(settings)
}

export function getDefaultThinkingLevel(): string {
  return readSettings().defaultThinkingLevel ?? 'high'
}

export function setDefaultThinkingLevel(level: string): void {
  const settings: PiSettings = JSON.parse(JSON.stringify(readSettings()))
  settings.defaultThinkingLevel = level
  writeSettings(settings)
}

// ── Skill 路径管理（读写 settings.json 的 skills 字段）───────────

export function getSkillPaths(): string[] {
  return readSettings().skills ?? []
}

export function setSkillPaths(paths: string[]): void {
  const settings: PiSettings = JSON.parse(JSON.stringify(readSettings()))
  settings.skills = paths
  writeSettings(settings)
}

export function addSkillPath(path: string): void {
  const paths = getSkillPaths()
  if (!paths.includes(path)) {
    paths.push(path)
    setSkillPaths(paths)
  }
}

export function removeSkillPath(path: string): void {
  const paths = getSkillPaths().filter(p => p !== path)
  setSkillPaths(paths)
}

// ── 缓存控制 ─────────────────────────────────────────────────

export function refreshModels(): void {
  modelsCache = null
}

export function refreshSettings(): void {
  settingsCache = null
}

export function refreshAll(): void {
  refreshModels()
  refreshSettings()
}

// ── 迁移 ─────────────────────────────────────────────────────

/**
 * 首次加载时执行一次性迁移：将旧路径下的文件移动到新的 xyz-pi 目录结构。
 * 幂等：如果新路径已存在文件，跳过迁移。
 */
export function migrateToPiSubdir(): void {
  const piAgentDir = getPiAgentDir()
  const sessionsDir = getSessionsDir()
  const agentsDir = getAgentsDir()
  const configDir = getConfigDir()

  const oldModelsPath = join(configDir, 'models.json')
  const oldSettingsPath = join(configDir, 'settings.json')
  const oldSessionsDir = join(configDir, 'sessions')
  const oldAgentsDir = join(configDir, 'agents')

  mkdirSync(piAgentDir, { recursive: true })
  mkdirSync(sessionsDir, { recursive: true })
  mkdirSync(agentsDir, { recursive: true })

  const modelsPath = getModelsPath()
  const settingsPath = getSettingsPath()

  if (existsSync(oldModelsPath) && !existsSync(modelsPath)) {
    renameSync(oldModelsPath, modelsPath)
    console.log('[provider-store] migrated models.json → pi/agent/models.json')
  }

  if (existsSync(oldSettingsPath) && !existsSync(settingsPath)) {
    renameSync(oldSettingsPath, settingsPath)
    console.log('[provider-store] migrated settings.json → pi/agent/settings.json')
  }

  if (existsSync(oldSessionsDir)) {
    try {
      const entries = readdirSync(oldSessionsDir)
      if (entries.length > 0) {
        let migrated = 0
        for (const entry of entries) {
          const oldPath = join(oldSessionsDir, entry)
          const newPath = join(sessionsDir, entry)
          if (!existsSync(newPath)) {
            renameSync(oldPath, newPath)
            migrated++
          }
        }
        if (migrated > 0) {
          console.log(`[provider-store] migrated ${migrated} session files → pi/sessions/`)
        }
        try {
          const remaining = readdirSync(oldSessionsDir)
          if (remaining.length === 0) rmdirSync(oldSessionsDir)
        // eslint-disable-next-line taste/no-silent-catch -- migration cleanup: error logged, non-critical
        } catch (e) {
          console.warn('[provider-store] failed to remove old sessions dir:', e instanceof Error ? e.message : e)
        }
      }
    // eslint-disable-next-line taste/no-silent-catch -- migration: error logged, non-critical
    } catch (e) {
      console.warn('[provider-store] failed to migrate sessions dir:', e instanceof Error ? e.message : e)
    }
  }

  if (existsSync(oldAgentsDir)) {
    try {
      const entries = readdirSync(oldAgentsDir)
      if (entries.length > 0) {
        let migrated = 0
        for (const entry of entries) {
          const oldPath = join(oldAgentsDir, entry)
          const newPath = join(agentsDir, entry)
          if (!existsSync(newPath)) {
            renameSync(oldPath, newPath)
            migrated++
          }
        }
        if (migrated > 0) {
          console.log(`[provider-store] migrated ${migrated} agent files → pi/agent/agents/`)
        }
        try {
          const remaining = readdirSync(oldAgentsDir)
          if (remaining.length === 0) rmdirSync(oldAgentsDir)
        // eslint-disable-next-line taste/no-silent-catch -- migration cleanup: error logged, non-critical
        } catch (e) {
          console.warn('[provider-store] failed to remove old agents dir:', e instanceof Error ? e.message : e)
        }
      }
    // eslint-disable-next-line taste/no-silent-catch -- migration: error logged, non-critical
    } catch (e) {
      console.warn('[provider-store] failed to migrate agents dir:', e instanceof Error ? e.message : e)
    }
  }

  // 打包模式：从 bundled 资源同步
  if (process.env.XYZ_AGENT_PACKAGED === '1') {
    const bundledAgentDir = join(process.cwd(), 'pi', 'agent')
    for (const subDir of ['extensions', 'skills'] as const) {
      const src = join(bundledAgentDir, subDir)
      const dest = join(piAgentDir, subDir)
      if (existsSync(src) && !existsSync(dest)) {
        try {
          cpSync(src, dest, { recursive: true })
          console.log(`[provider-store] synced bundled ${subDir} → ${dest}`)
        // eslint-disable-next-line taste/no-silent-catch -- bundled sync: error logged, non-critical
        } catch (e) {
          console.error(`[provider-store] failed to sync bundled ${subDir}:`, e)
        }
      }
    }
  }
}


