/**
 * Pi Provider/Model/Settings Store — xyz-pi 配置文件读写层
 *
 * 负责 models.json 和 settings.json 的原子读写、内存缓存、
 * defaultModel 校验/修复、provider CRUD 同步。
 *
 * 不包含：路径解析（pi-paths）、session 扫描（session-file-utils）、agent 管理（agent-crud）
 */

import { existsSync, readdirSync, mkdirSync, renameSync, rmdirSync, cpSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { toErrorMessage } from '../../utils/errors.js'
import { isPackaged } from '../../utils/runtime-env.js'
import { JsonStore } from '../../utils/json-store.js'
import { normalizeToHome } from '../../utils/path-utils.js'
import { getConfigDir, getModelsPath, getSettingsPath, getPiAgentDir, getSessionsDir, getAgentsDir } from './pi-paths.js'
// settings.json 的唯一读写层（D17 收口）：readSettings/updateSettingsSync/PiSettings/缓存/原子写
// 都收敛到 pi-settings-store，model 域（本文件）与 extension 域共享同一所有者 + 缓存。
import {
  readSettings,
  updateSettingsSync,
  invalidateSettingsCache,
} from './pi-settings-store.js'
// discovery.json 是 skill/agent 加载路径的 SSOT（ADR-0020 §1）。
// skill 路径函数代理 discovery-store，settings.json.skills 仅作派生投影（pi 原生读此加载 skill）。
import {
  getSkillDirs as getDiscoverySkillDirs,
  setSkillDirs as setDiscoverySkillDirs,
  readDiscovery,
} from './discovery-store.js'

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

  // 同步校验 defaultModel：经 updateSettingsSync 单次 RMW。
  // 结果通过外层变量捕获（mutator 不返回值）。
  let outcome: { newDefault?: { provider: string; modelId: string } } = {}
  updateSettingsSync(s => {
    if (s.defaultProvider !== providerId) { outcome = {}; return }

    const newModelList = config.models ?? []
    if (newModelList.length === 0) {
      delete s.defaultProvider
      delete s.defaultModel
      const fallback = pickFirstModelProvider(models.providers)
      if (fallback) {
        s.defaultProvider = fallback.provider
        s.defaultModel = fallback.modelId
      }
      outcome = s.defaultProvider
        ? { newDefault: { provider: s.defaultProvider, modelId: s.defaultModel! } }
        : {}
      return
    }

    const currentModelId = s.defaultModel
    if (currentModelId && !newModelList.find(m => m.id === currentModelId)) {
      s.defaultModel = newModelList[0].id
      console.warn(`[provider-store] defaultModel "${currentModelId}" no longer in provider "${providerId}", falling back to "${newModelList[0].id}"`)
    }
    outcome = { newDefault: { provider: providerId, modelId: s.defaultModel! } }
  })
  return outcome
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

  // 同步清理 defaultProvider/defaultModel：经 updateSettingsSync 单次 RMW。
  let outcome: { removed: boolean; newDefault?: { provider: string; modelId: string } } = { removed: true }
  updateSettingsSync(s => {
    if (s.defaultProvider !== providerId) { outcome = { removed: true }; return }
    delete s.defaultProvider
    delete s.defaultModel
    const fallback = pickFirstModelProvider(models.providers)
    if (fallback) {
      s.defaultProvider = fallback.provider
      s.defaultModel = fallback.modelId
    }
    outcome = s.defaultProvider
      ? { removed: true, newDefault: { provider: s.defaultProvider, modelId: s.defaultModel! } }
      : { removed: true }
  })
  return outcome
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
// readSettings/updateSettingsSync 的实现收敛到 pi-settings-store（D17 唯一读写层）。
// 本文件 re-export，供 pi-config-store 等直接消费。
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

  const fallback = pickFirstModelProvider(models.providers)
  if (fallback) {
    return { result: { provider: fallback.provider, modelId: fallback.modelId }, wasFixed: true }
  }
  return { result: null, wasFixed: false }
}

/**
 * 获取默认模型，带有效性校验和自动修复。
 */
export function getDefaultModel(): { provider: string; modelId: string } | null {
  const { result, wasFixed } = findValidDefaultModel()
  if (wasFixed && result) {
    updateSettingsSync(s => {
      s.defaultProvider = result.provider
      s.defaultModel = result.modelId
    })
    console.log(`[provider-store] auto-fixed defaultModel: ${result.provider}/${result.modelId}`)
  }
  return result
}

export function setDefaultModel(provider: string, modelId: string): void {
  updateSettingsSync(s => {
    s.defaultProvider = provider
    s.defaultModel = modelId
  })
}

export function getEnabledModels(): string[] {
  return readSettings().enabledModels ?? []
}

export function setEnabledModels(patterns: string[]): void {
  updateSettingsSync(s => { s.enabledModels = patterns })
}

export function getDefaultThinkingLevel(): string {
  return readSettings().defaultThinkingLevel ?? 'high'
}

export function setDefaultThinkingLevel(level: string): void {
  updateSettingsSync(s => { s.defaultThinkingLevel = level })
}

// ── Skill 路径管理（ADR-0020：discovery.json 是 SSOT，settings.json 是派生投影）──
//
// 数据流（方案 C 决策）：
//   UI 读写 → discovery.json.skillDirs（SSOT，有序数组 = 优先级）
//   discovery.json 变更 → syncSkillDirsToSettings() 同步投影到 settings.json.skills
//   pi 启动 → collectSettingsSkillPaths 读 settings.json.skills 加载 skill（pi 官方扩展点）
//
// 这保证 xyz-agent 完全控制优先级（discovery 数组顺序），同时复用 pi 原生 skill 加载链路。

/**
 * 把 discovery.json.skillDirs 投影到 settings.json.skills（pi 原生读此加载 skill）。
 * 在 setSkillPaths/addSkillPath/removeSkillPath 写入 discovery 后调用，保持派生缓存一致。
 */
function syncSkillDirsToSettings(): void {
  updateSettingsSync(s => { s.skills = getDiscoverySkillDirs() })
}

/**
 * 判断目录是否是「skill 容器」（含 ≥1 个带 SKILL.md 的子目录）。
 * 用于迁移时区分容器目录（如 ~/.pi/agent/skills）与单 skill 目录（如 .../skills/anysearch）。
 * ADR-0020 §1：discovery.json 存容器目录粒度，目录内资源全开。
 */
function isSkillContainer(dirPath: string): boolean {
  if (!existsSync(dirPath)) return false
  let entries: string[]
  try {
    entries = readdirSync(dirPath)
  } catch {
    return false
  }
  for (const name of entries) {
    try {
      if (statSync(join(dirPath, name)).isDirectory() && existsSync(join(dirPath, name, 'SKILL.md'))) {
        return true
      }
    } catch {
      continue
    }
  }
  return false
}

/**
 * 一次性迁移：把旧版本 settings.json.skills（粒度错误：存的是单 skill 目录）
 * 归并为 ADR-0020 §1 的容器目录粒度，提升为 discovery.json SSOT。
 *
 * 旧数据问题：旧 addSkillPath(dirname(skill.sourcePath)) 把每个 skill 的父目录
 * 单独塞进 settings.json.skills（如 ~/.pi/agent/skills/anysearch），而非容器目录
 * （~/.pi/agent/skills）。44 条单 skill 路径去重父目录后只有 2 个容器。
 *
 * 归并策略：对每条旧路径取父目录 → 去重 → 仅保留确实是容器（含 ≥1 个 SKILL.md 子目录）的。
 * 幂等：discovery 已有容器目录数据则 no-op。
 * 由 ConfigService 初始化时调用。
 */
export function migrateSettingsSkillsToDiscovery(): void {
  const discovery = readDiscovery()
  // discovery 已有「有效容器」数据则 no-op（幂等）。
  // 注意：不能仅凭 skillDirs.length>0 判定——可能存有脏数据（/path/a 等测试残留），
  // 故用 isSkillContainer 校验每条；全无效则继续迁移覆盖。
  if (discovery.skillDirs.length > 0 && discovery.skillDirs.some(c => isSkillContainer(c))) return
  const legacy = readSettings().skills ?? []
  if (legacy.length === 0) return

  // 取父目录去重（旧路径是 <container>/<skillName>，父目录才是容器）
  const containers = new Set<string>()
  for (const p of legacy) {
    const idx = p.lastIndexOf('/')
    const parent = idx > 0 ? p.slice(0, idx) : p
    containers.add(parent)
  }

  // 仅保留确实是容器的父目录（含 ≥1 个带 SKILL.md 的子目录）
  const validContainers = [...containers].filter(c => isSkillContainer(c))
  if (validContainers.length === 0) return
  // 归一化为 ~ 形式（家目录下的路径用 ~ 前缀），与预设候选 ~/.pi/agent/skills 等保持一致，
  // 避免 buildDirConfigs 的字符串匹配因 ~ vs 绝对路径失配而重复显示。
  const normalized = validContainers.map(normalizeToHome)
  setDiscoverySkillDirs(normalized)
  syncSkillDirsToSettings()
  console.log(`[provider-store] migrated ${legacy.length} legacy skill paths → ${normalized.length} container dirs in discovery.json`)
}

export function getSkillPaths(): string[] {
  return getDiscoverySkillDirs()
}

export function setSkillPaths(paths: string[]): void {
  setDiscoverySkillDirs(paths)
  syncSkillDirsToSettings()
}

export function addSkillPath(path: string): void {
  const paths = getDiscoverySkillDirs()
  if (!paths.includes(path)) {
    setSkillPaths([...paths, path])
  }
}

export function removeSkillPath(path: string): void {
  setSkillPaths(getDiscoverySkillDirs().filter(p => p !== path))
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


