/**
 * Pi Provider/Model/Settings Store — xyz-pi 配置文件读写层
 *
 * 负责 models.json 和 settings.json 的原子读写、内存缓存、
 * defaultModel 校验/修复、provider CRUD 同步。
 *
 * 不包含：路径解析（pi-paths）、session 扫描（pi-config-bridge）、agent 管理（pi-config-bridge）
 */

import { existsSync, readdirSync, mkdirSync, renameSync, rmdirSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { toErrorMessage } from '../../utils/errors.js'
import { isPackaged } from '../../utils/runtime-env.js'
import { JsonStore } from '../../utils/json-store.js'
import { getConfigDir, getModelsPath, getSettingsPath, getPiAgentDir, getSessionsDir, getAgentsDir } from './pi-paths.js'
// settings.json 的唯一读写层（D17 收口）：readSettings/writeSettings/PiSettings/缓存/原子写
// 都收敛到 pi-settings-store，model 域（本文件）与 extension 域共享同一所有者 + 缓存。
import {
  readSettings,
  writeSettings,
  invalidateSettingsCache,
  type PiSettings,
} from './pi-settings-store.js'

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

export type { PiSettings } from './pi-settings-store.js'

// ── 缓存 ─────────────────────────────────────────────────────
// 注：settings.json 的缓存 + readSettings/writeSettings 收敛到 pi-settings-store（D17）。
// 此处 models.json 的 read-through 缓存 + 原子读写收敛到 JsonStore（P0-1）。

/**
 * models.json 路径。生产用 getModelsPath()（= ~/.xyz-agent/pi/agent/models.json）。
 * 测试可经 setModelsPath() 指向临时目录，与 setSettingsPath 对称。
 */
let modelsFilePath: string = getModelsPath()

/** models.json 存储：read-through（TTL 缓存 + ENOENT 容错）+ atomicWrite。 */
let modelsStore = createModelsStore(modelsFilePath)

function createModelsStore(path: string): JsonStore<PiModelsConfig> {
  return new JsonStore<PiModelsConfig>(path, { providers: {} }, {
    ttlMs: 3_000,
    deserialize: (raw): PiModelsConfig => {
      if (!raw || typeof raw !== 'object' || typeof (raw as PiModelsConfig).providers !== 'object') {
        console.warn(`[provider-store] ${path} schema 不匹配，使用 fallback`)
        return { providers: {} }
      }
      return raw as PiModelsConfig
    },
  })
}

/**
 * 覆盖 models.json 路径（仅测试用）。生产不应调用。
 * 重建 store 实例并清空缓存，确保后续读拿到新路径的文件。
 */
export function setModelsPath(path: string): void {
  modelsFilePath = path
  modelsStore = createModelsStore(path)
}

// ── Models.json 操作 ──────────────────────────────────────────

export function readModels(): PiModelsConfig {
  return modelsStore.read()
}

export function writeModels(config: PiModelsConfig): void {
  modelsStore.write(config)
}

export function getProviderNames(): string[] {
  return Object.keys(readModels().providers)
}

export function getProviderConfig(providerId: string): PiProviderConfig | undefined {
  const config = readModels().providers[providerId]
  return config ? JSON.parse(JSON.stringify(config)) : undefined
}

/**
 * 扫描 providers，返回第一个含 model 的 provider 及其第一个 model id（D10）。
 *
 * upsertProvider / removeProvider 在 default 失效时各内联了一遍同样的「找第一个有
 * models 的 provider」循环。返回 undefined 表示无可用 provider。
 */
function pickFirstModelProvider(
  providers: Record<string, PiProviderConfig>,
): { provider: string; modelId: string } | undefined {
  for (const [pid, pcfg] of Object.entries(providers)) {
    if (pcfg.models && pcfg.models.length > 0) {
      return { provider: pid, modelId: pcfg.models[0].id }
    }
  }
  return undefined
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

  // 同步校验 defaultModel：单次 readSettings → 计算 → 单次 writeSettings
  const settings: PiSettings = JSON.parse(JSON.stringify(readSettings()))
  if (settings.defaultProvider !== providerId) return {}

  const newModelList = config.models ?? []
  if (newModelList.length === 0) {
    delete settings.defaultProvider
    delete settings.defaultModel
    // Try finding a valid default from other providers
    const fallback = pickFirstModelProvider(models.providers)
    if (fallback) {
      settings.defaultProvider = fallback.provider
      settings.defaultModel = fallback.modelId
    }
    writeSettings(settings)
    return settings.defaultProvider
      ? { newDefault: { provider: settings.defaultProvider, modelId: settings.defaultModel! } }
      : {}
  }

  const currentModelId = settings.defaultModel
  if (currentModelId && !newModelList.find(m => m.id === currentModelId)) {
    settings.defaultModel = newModelList[0].id
    console.warn(`[provider-store] defaultModel "${currentModelId}" no longer in provider "${providerId}", falling back to "${newModelList[0].id}"`)
  }
  writeSettings(settings)
  return { newDefault: { provider: providerId, modelId: settings.defaultModel! } }
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
    // Scan remaining providers for a fallback default
    const fallback = pickFirstModelProvider(models.providers)
    if (fallback) {
      settings.defaultProvider = fallback.provider
      settings.defaultModel = fallback.modelId
    }
    writeSettings(settings)
    return settings.defaultProvider
      ? { removed: true, newDefault: { provider: settings.defaultProvider, modelId: settings.defaultModel! } }
      : { removed: true }
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
// readSettings/writeSettings 的实现收敛到 pi-settings-store（D17 唯一读写层）。
// 本文件 re-export 以保持对 pi-config-bridge 的现有导出契约不变。
export { readSettings, writeSettings, updateSettingsSync } from './pi-settings-store.js'

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
  modelsStore.invalidate()
}

export function refreshSettings(): void {
  // settings.json 缓存归属 pi-settings-store（D17），这里委托失效。
  invalidateSettingsCache()
}

export function refreshAll(): void {
  refreshModels()
  refreshSettings()
}

// ── 迁移 ─────────────────────────────────────────────────────

/**
 * 把 oldDir 的内容逐项迁移到 newDir（跳过 newDir 中已存在的同名项），
 * 迁移后若 oldDir 为空则删除。幂等。
 *
 * 抽自 migrateToPiSubdir 的 sessions/agents 两段近乎逐行相同的目录迁移块（D4）。
 */
function migrateDirContents(oldDir: string, newDir: string, label: string): void {
  if (!existsSync(oldDir)) return
  try {
    const entries = readdirSync(oldDir)
    if (entries.length > 0) {
      let migrated = 0
      for (const entry of entries) {
        const newPath = join(newDir, entry)
        if (!existsSync(newPath)) {
          renameSync(join(oldDir, entry), newPath)
          migrated++
        }
      }
      if (migrated > 0) {
        console.log(`[provider-store] migrated ${migrated} ${label}`)
      }
      try {
        const remaining = readdirSync(oldDir)
        if (remaining.length === 0) rmdirSync(oldDir)
      // eslint-disable-next-line taste/no-silent-catch -- migration cleanup: error logged, non-critical
      } catch (e) {
        console.warn(`[provider-store] failed to remove old ${label} dir:`, toErrorMessage(e))
      }
    }
  // eslint-disable-next-line taste/no-silent-catch -- migration: error logged, non-critical
  } catch (e) {
    console.warn(`[provider-store] failed to migrate ${label} dir:`, toErrorMessage(e))
  }
}

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

  migrateDirContents(oldSessionsDir, sessionsDir, 'session files → pi/sessions/')
  migrateDirContents(oldAgentsDir, agentsDir, 'agent files → pi/agent/agents/')

  // 打包模式：从 bundled 资源同步
  if (isPackaged()) {
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


