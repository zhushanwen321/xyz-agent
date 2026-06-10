/**
 * Config Bridge — xyz-agent 的 xyz-pi 配置文件读写层。
 *
 * xyz-pi 的目录结构等价于系统 pi 的 ~/.pi/，但完全独立：
 *
 *   ~/.xyz-agent/                    ← xyz-agent 配置根目录
 *     config.json                    ← xyz-agent 自身配置（temperature、toolPermissions）
 *     pi/                            ← xyz-pi 的根目录（等价于系统 pi 的 ~/.pi/）
 *       agent/                       ← xyz-pi 的 agent 目录（等价于 ~/.pi/agent/）
 *         models.json                ← Provider & Model 定义
 *         settings.json              ← xyz-pi 设置（默认模型、thinking level 等）
 *         agents/                    ← Agent markdown 文件
 *         extensions/                ← bundled extensions（subagent, goal, todo 等）
 *         skills/                    ← bundled skills
 *       sessions/                    ← Session jsonl 文件
 *
 * 设计原则：
 * - 读操作有内存缓存 + TTL，避免每次请求穿透到磁盘
 * - 写操作使用原子写入 + JSON 校验
 * - 不使用文件锁（写入频率极低，用户手动操作 Settings，冲突概率可忽略）
 * - 不读取、不修改、不使用系统 pi 的 ~/.pi/ 目录
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, statSync, unlinkSync, renameSync, rmdirSync, cpSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { atomicWrite } from './scanner-base.js'
import { parseSessionHeader, extractSessionName } from './session-file-utils.js'

// Re-export session file utilities for backward compatibility
export { ensureSessionFile, persistSessionName, patchSessionCwd } from './session-file-utils.js'

// ── 路径函数（env-var-aware，支持实例隔离）──────────────────────
// 所有路径从 XYZ_AGENT_DATA_DIR 推导。未设置时回退 ~/.xyz-agent/

function getConfigDir_(): string {
  return process.env.XYZ_AGENT_DATA_DIR ?? join(homedir(), '.xyz-agent')
}

function getPiRoot_(): string {
  return join(getConfigDir_(), 'pi')
}

function getPiAgentDir_(): string {
  return join(getPiRoot_(), 'agent')
}

function getModelsPath_(): string {
  return join(getPiAgentDir_(), 'models.json')
}

function getSettingsPath_(): string {
  return join(getPiAgentDir_(), 'settings.json')
}

function getSessionsDir_(): string {
  return join(getPiRoot_(), 'sessions')
}

function getAgentsDir_(): string {
  return join(getPiAgentDir_(), 'agents')
}


const JSON_INDENT = 2

/**
 * 首次加载时执行一次性迁移：将旧路径下的文件移动到新的 xyz-pi 目录结构。
 * 幂等：如果新路径已存在文件，跳过迁移。
 */
function migrateToPiSubdir(): void {
  const piAgentDir = getPiAgentDir_()
  const sessionsDir = getSessionsDir_()
  const agentsDir = getAgentsDir_()
  const configDir = getConfigDir_()

  // 旧路径：迁移用
  const oldModelsPath = join(configDir, 'models.json')
  const oldSettingsPath = join(configDir, 'settings.json')
  const oldSessionsDir = join(configDir, 'sessions')
  const oldAgentsDir = join(configDir, 'agents')

  // 确保新目录存在
  mkdirSync(piAgentDir, { recursive: true })
  mkdirSync(sessionsDir, { recursive: true })
  mkdirSync(agentsDir, { recursive: true })

  const modelsPath = getModelsPath_()
  const settingsPath = getSettingsPath_()

  // 迁移 models.json
  if (existsSync(oldModelsPath) && !existsSync(modelsPath)) {
    renameSync(oldModelsPath, modelsPath)
    console.log('[config-bridge] migrated models.json → pi/agent/models.json')
  }

  // 迁移 settings.json
  if (existsSync(oldSettingsPath) && !existsSync(settingsPath)) {
    renameSync(oldSettingsPath, settingsPath)
    console.log('[config-bridge] migrated settings.json → pi/agent/settings.json')
  }

  // 迁移 sessions/ 目录下的文件
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
          console.log(`[config-bridge] migrated ${migrated} session files → pi/sessions/`)
        }
        try {
          const remaining = readdirSync(oldSessionsDir)
          if (remaining.length === 0) {
            rmdirSync(oldSessionsDir)
          }
        // eslint-disable-next-line taste/no-silent-catch -- migration cleanup: error logged, non-critical
        } catch (e) {
          console.warn('[config-bridge] failed to remove old sessions dir:', e instanceof Error ? e.message : e)
        }
      }
      // eslint-disable-next-line taste/no-silent-catch -- migration: error logged, non-critical
    } catch (e) {
      console.warn('[config-bridge] failed to migrate sessions dir:', e instanceof Error ? e.message : e)
    }
  }

  // 迁移 agents/ 目录下的文件
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
          console.log(`[config-bridge] migrated ${migrated} agent files → pi/agent/agents/`)
        }
        try {
          const remaining = readdirSync(oldAgentsDir)
          if (remaining.length === 0) {
            rmdirSync(oldAgentsDir)
          }
        // eslint-disable-next-line taste/no-silent-catch -- migration cleanup: error logged, non-critical
        } catch (e) {
          console.warn('[config-bridge] failed to remove old agents dir:', e instanceof Error ? e.message : e)
        }
      }
      // eslint-disable-next-line taste/no-silent-catch -- migration: error logged, non-critical
    } catch (e) {
      console.warn('[config-bridge] failed to migrate agents dir:', e instanceof Error ? e.message : e)
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
          console.log(`[config-bridge] synced bundled ${subDir} → ${dest}`)
        // eslint-disable-next-line taste/no-silent-catch -- bundled sync: error logged, non-critical
        } catch (e) {
          console.error(`[config-bridge] failed to sync bundled ${subDir}:`, e)
        }
      }
    }
  }
}

// 模块加载时执行一次性迁移
migrateToPiSubdir()

// ── 类型定义（对齐 pi models.json 的 schema）───────────────────────

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

// ── 缓存 ─────────────────────────────────────────────────────────

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

function invalidateModelsCache(): void {
  modelsCache = null
}

function invalidateSettingsCache(): void {
  settingsCache = null
}

function invalidateAllCaches(): void {
  invalidateModelsCache()
  invalidateSettingsCache()
}

// ── 原子读写 ─────────────────────────────────────────────────────

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(`[config-bridge] 读取 ${filePath} 失败:`, err)
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

// ── Models.json 操作 ──────────────────────────────────────────────

export function readModels(): PiModelsConfig {
  if (!isExpired(modelsCache)) return modelsCache!.data
  const data = readJsonFile<PiModelsConfig>(getModelsPath_(), { providers: {} })
  if (!data || typeof data !== 'object' || typeof data.providers !== 'object') {
    console.warn(`[config-bridge] ${getModelsPath_()} schema 不匹配，使用 fallback`)
    return { providers: {} }
  }
  modelsCache = { data, timestamp: Date.now() }
  return data
}

export function writeModels(config: PiModelsConfig): void {
  writeJsonFile(getModelsPath_(), config)
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
      // 新 models 列表为空 → 清空 default
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
      // defaultModel 不在新列表中 → fallback 到第一个 model
      const fallback = newModelList[0]
      settings.defaultModel = fallback.id
      writeSettings(settings)
      console.warn(`[config-bridge] defaultModel "${currentModelId}" no longer in provider "${providerId}", falling back to "${fallback.id}"`)
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

  // 同步清理 settings.json 中的 defaultProvider/defaultModel
  const settings: PiSettings = JSON.parse(JSON.stringify(readSettings()))
  if (settings.defaultProvider === providerId) {
    // 清空旧值，重新查找 fallback
    delete settings.defaultProvider
    delete settings.defaultModel
    writeSettings(settings)
    // findValidDefaultModel 读刚写入的 settings（无 defaultProvider），返回 fallback
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

// ── Settings.json 操作 ───────────────────────────────────────────

export function readSettings(): PiSettings {
  if (!isExpired(settingsCache)) return settingsCache!.data
  const data = readJsonFile<PiSettings>(getSettingsPath_(), {})
  if (!data || typeof data !== 'object') {
    console.warn(`[config-bridge] ${getSettingsPath_()} schema 不匹配，使用 fallback`)
    return {}
  }
  settingsCache = { data, timestamp: Date.now() }
  return data
}

export function writeSettings(settings: PiSettings): void {
  writeJsonFile(getSettingsPath_(), settings)
  settingsCache = { data: JSON.parse(JSON.stringify(settings)), timestamp: Date.now() }
}

/**
 * 纯校验：检查 settings.json 的 defaultProvider/defaultModel 在 models.json 中是否有效。
 * 无副作用，不修改任何文件。
 */
export function findValidDefaultModel(): {
  result: { provider: string; modelId: string } | null
  wasFixed: boolean
} {
  const settings = readSettings()
  const models = readModels()
  const { defaultProvider, defaultModel } = settings

  // 尝试匹配 settings 中配置的 default
  if (defaultProvider && defaultModel) {
    const providerConfig = models.providers[defaultProvider]
    if (providerConfig?.models?.length) {
      const found = providerConfig.models.find(m => m.id === defaultModel)
      if (found) {
        return { result: { provider: defaultProvider, modelId: defaultModel }, wasFixed: false }
      }
      // provider 存在但 model 不存在 → fallback 到该 provider 的第一个 model
      console.warn(`[config-bridge] defaultModel "${defaultModel}" not found in provider "${defaultProvider}", falling back to "${providerConfig.models[0].id}"`)
      return { result: { provider: defaultProvider, modelId: providerConfig.models[0].id }, wasFixed: true }
    }
    // provider 不存在
    console.warn(`[config-bridge] defaultProvider "${defaultProvider}" not found in models.json`)
  }

  // fallback: 取第一个有 model 的 provider
  for (const [providerId, providerConfig] of Object.entries(models.providers)) {
    if (providerConfig.models && providerConfig.models.length > 0) {
      return { result: { provider: providerId, modelId: providerConfig.models[0].id }, wasFixed: true }
    }
  }
  return { result: null, wasFixed: false }
}

/**
 * 获取默认模型，带有效性校验和自动修复。
 * 如果 settings.json 中的值无效，自动修正并持久化。
 */
export function getDefaultModel(): { provider: string; modelId: string } | null {
  const { result, wasFixed } = findValidDefaultModel()
  if (wasFixed && result) {
    // 自动修正 settings.json
    const settings: PiSettings = JSON.parse(JSON.stringify(readSettings()))
    settings.defaultProvider = result.provider
    settings.defaultModel = result.modelId
    writeSettings(settings)
    console.log(`[config-bridge] auto-fixed defaultModel: ${result.provider}/${result.modelId}`)
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

// ── Agent 管理（读写 ~/.xyz-agent/agents/ 目录）───────────────────

export function getAgentsDir(): string {
  return getAgentsDir_()
}

export function listAgentFiles(): Array<{ name: string; path: string; content: string }> {
  if (!existsSync(getAgentsDir_())) return []
  const results: Array<{ name: string; path: string; content: string }> = []
  const files = readdirSync(getAgentsDir_()).filter(f => f.endsWith('.md'))
  for (const file of files) {
    const filePath = join(getAgentsDir_(), file)
    try {
      const content = readFileSync(filePath, 'utf-8')
      results.push({ name: file.replace(/\.md$/, ''), path: filePath, content })
    // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable agent files, continue scanning
    } catch {
      // skip unreadable files
    }
  }
  return results
}

export function writeAgentFile(name: string, content: string): void {
  const agentsDir = getAgentsDir_()
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true })
  const fileName = name.endsWith('.md') ? name : `${name}.md`
  const filePath = join(agentsDir, fileName)
  atomicWrite(filePath, content)
}

export function deleteAgentFile(name: string): boolean {
  const agentsDir = getAgentsDir_()
  const fileName = name.endsWith('.md') ? name : `${name}.md`
  const filePath = join(agentsDir, fileName)
  if (!existsSync(filePath)) return false
  try {
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

// ── Session 相关 ─────────────────────────────────────────────────

export function getSessionsDir(): string {
  const dir = getSessionsDir_()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/**
 * 扫描 pi 的 sessions 目录（按 cwd 分组的子目录结构）。
 * 返回扁平化的 session 列表。
 */
export function scanPiSessions(): Array<{
  id: string
  filePath: string
  cwd: string
  timestamp: string
  name: string | null
  lastModified: number
  size: number
}> {
  if (!existsSync(getSessionsDir_())) return []

  const results: Array<{
    id: string
    filePath: string
    cwd: string
    timestamp: string
    name: string | null
    lastModified: number
    size: number
  }> = []

  // pi 的 sessions 目录结构: sessions/<cwd-hash-dir>/*.jsonl
  // 也可能是 flat 的 *.jsonl（兼容两种）
  const sessionsDir = getSessionsDir_()
  const entries = readdirSync(sessionsDir)

  for (const entry of entries) {
    const entryPath = join(sessionsDir, entry)
    let stat
    try {
      stat = statSync(entryPath)
    } catch {
      continue
    }

    if (stat.isDirectory()) {
      // 子目录：扫描里面的 .jsonl 文件
      try {
        const files = readdirSync(entryPath).filter(f => f.endsWith('.jsonl'))
        for (const file of files) {
          const filePath = join(entryPath, file)
          const header = parseSessionHeader(filePath)
          if (!header) continue
          try {
            const fstat = statSync(filePath)
            const sessionName = extractSessionName(filePath)
            results.push({
              id: header.id,
              filePath,
              cwd: header.cwd,
              timestamp: header.timestamp,
              name: sessionName,
              lastModified: fstat.mtimeMs,
              size: fstat.size,
            })
            // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable session entries, continue scanning
          } catch {
            // skip
          }
        }
        // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable session subdirectory
      } catch {
        // skip unreadable dir
      }
    } else if (entry.endsWith('.jsonl')) {
      // flat 结构（兼容 xyz-agent 旧格式）
      const header = parseSessionHeader(entryPath)
      if (!header) continue
      try {
        const sessionName = extractSessionName(entryPath)
        results.push({
          id: header.id,
          filePath: entryPath,
          cwd: header.cwd,
          timestamp: header.timestamp,
          name: sessionName,
          lastModified: stat.mtimeMs,
          size: stat.size,
        })
        // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable session entry, continue scanning
      } catch {
        // skip
      }
    }
  }

  // 按 lastModified 降序排列
  results.sort((a, b) => b.lastModified - a.lastModified)
  return results
}

// ── 缓存控制（用于测试和手动刷新）─────────────────────────────────

export function refreshAll(): void {
  invalidateAllCaches()
}

export function refreshModels(): void {
  invalidateModelsCache()
}

export function refreshSettings(): void {
  invalidateSettingsCache()
}

export function getConfigDir(): string {
  return getConfigDir_()
}

/** xyz-pi agent 目录：~/.xyz-agent/pi/agent/ */
export function getPiAgentDir(): string {
  return getPiAgentDir_()
}

export function getModelsPath(): string {
  return getModelsPath_()
}

export function getSettingsPath(): string {
  return getSettingsPath_()
}
