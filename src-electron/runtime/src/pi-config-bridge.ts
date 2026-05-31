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

import { existsSync, readFileSync, readdirSync, mkdirSync, statSync, unlinkSync, renameSync, rmdirSync, cpSync, openSync, writeSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { atomicWrite } from './scanner-base.js'

// ── 路径常量 ─────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), '.xyz-agent')
const PI_ROOT = join(CONFIG_DIR, 'pi')
const PI_AGENT_DIR = join(PI_ROOT, 'agent')
const MODELS_PATH = join(PI_AGENT_DIR, 'models.json')
const SETTINGS_PATH = join(PI_AGENT_DIR, 'settings.json')
const SESSIONS_DIR = join(PI_ROOT, 'sessions')
const AGENTS_DIR = join(PI_AGENT_DIR, 'agents')

// ── 旧路径常量（用于迁移）─────────────────────────────────────────
const OLD_MODELS_PATH = join(CONFIG_DIR, 'models.json')
const OLD_SETTINGS_PATH = join(CONFIG_DIR, 'settings.json')
const OLD_SESSIONS_DIR = join(CONFIG_DIR, 'sessions')
const OLD_AGENTS_DIR = join(CONFIG_DIR, 'agents')

const JSON_INDENT = 2

/**
 * 首次加载时执行一次性迁移：将旧路径下的文件移动到新的 xyz-pi 目录结构。
 * 幂等：如果新路径已存在文件，跳过迁移。
 */
function migrateToPiSubdir(): void {
  // 确保新目录存在
  mkdirSync(PI_AGENT_DIR, { recursive: true })
  mkdirSync(SESSIONS_DIR, { recursive: true })
  mkdirSync(AGENTS_DIR, { recursive: true })

  // 迁移 models.json
  if (existsSync(OLD_MODELS_PATH) && !existsSync(MODELS_PATH)) {
    renameSync(OLD_MODELS_PATH, MODELS_PATH)
    console.log('[config-bridge] migrated models.json → pi/agent/models.json')
  }

  // 迁移 settings.json
  if (existsSync(OLD_SETTINGS_PATH) && !existsSync(SETTINGS_PATH)) {
    renameSync(OLD_SETTINGS_PATH, SETTINGS_PATH)
    console.log('[config-bridge] migrated settings.json → pi/agent/settings.json')
  }

  // 迁移 sessions/ 目录下的文件
  if (existsSync(OLD_SESSIONS_DIR)) {
    try {
      const entries = readdirSync(OLD_SESSIONS_DIR)
      if (entries.length > 0) {
        let migrated = 0
        for (const entry of entries) {
          const oldPath = join(OLD_SESSIONS_DIR, entry)
          const newPath = join(SESSIONS_DIR, entry)
          if (!existsSync(newPath)) {
            renameSync(oldPath, newPath)
            migrated++
          }
        }
        if (migrated > 0) {
          console.log(`[config-bridge] migrated ${migrated} session files → pi/sessions/`)
        }
        // 如果旧目录已空，尝试删除
        try {
          const remaining = readdirSync(OLD_SESSIONS_DIR)
          if (remaining.length === 0) {
            rmdirSync(OLD_SESSIONS_DIR)
          }
          // eslint-disable-next-line taste/no-silent-catch -- migration: failure to remove old dir must not block startup
        } catch (e) {
          console.warn('[config-bridge] failed to remove old sessions dir:', e instanceof Error ? e.message : e)
        }
      }
      // eslint-disable-next-line taste/no-silent-catch -- migration: failure to migrate sessions must not block startup
    } catch (e) {
      console.warn('[config-bridge] failed to migrate sessions dir:', e instanceof Error ? e.message : e)
    }
  }

  // 迁移 agents/ 目录下的文件
  if (existsSync(OLD_AGENTS_DIR)) {
    try {
      const entries = readdirSync(OLD_AGENTS_DIR)
      if (entries.length > 0) {
        let migrated = 0
        for (const entry of entries) {
          const oldPath = join(OLD_AGENTS_DIR, entry)
          const newPath = join(AGENTS_DIR, entry)
          if (!existsSync(newPath)) {
            renameSync(oldPath, newPath)
            migrated++
          }
        }
        if (migrated > 0) {
          console.log(`[config-bridge] migrated ${migrated} agent files → pi/agent/agents/`)
        }
        // 如果旧目录已空，尝试删除
        try {
          const remaining = readdirSync(OLD_AGENTS_DIR)
          if (remaining.length === 0) {
            rmdirSync(OLD_AGENTS_DIR)
          }
          // eslint-disable-next-line taste/no-silent-catch -- migration: failure to remove old dir must not block startup
        } catch (e) {
          console.warn('[config-bridge] failed to remove old agents dir:', e instanceof Error ? e.message : e)
        }
      }
      // eslint-disable-next-line taste/no-silent-catch -- migration: failure to migrate agents must not block startup
    } catch (e) {
      console.warn('[config-bridge] failed to migrate agents dir:', e instanceof Error ? e.message : e)
    }
  }

  // 打包模式：从 bundled 资源同步 extensions 和 skills 到 xyz-pi agent 目录
  if (process.env.XYZ_AGENT_PACKAGED === '1') {
    const bundledAgentDir = join(process.cwd(), 'pi', 'agent')
    for (const subDir of ['extensions', 'skills'] as const) {
      const src = join(bundledAgentDir, subDir)
      const dest = join(PI_AGENT_DIR, subDir)
      if (existsSync(src) && !existsSync(dest)) {
        try {
          cpSync(src, dest, { recursive: true })
          console.log(`[config-bridge] synced bundled ${subDir} → ${dest}`)
          // eslint-disable-next-line taste/no-silent-catch -- bundled sync: failure must not block startup
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
  const data = readJsonFile<PiModelsConfig>(MODELS_PATH, { providers: {} })
  if (!data || typeof data !== 'object' || typeof data.providers !== 'object') {
    console.warn(`[config-bridge] ${MODELS_PATH} schema 不匹配，使用 fallback`)
    return { providers: {} }
  }
  modelsCache = { data, timestamp: Date.now() }
  return data
}

export function writeModels(config: PiModelsConfig): void {
  writeJsonFile(MODELS_PATH, config)
  modelsCache = { data: JSON.parse(JSON.stringify(config)), timestamp: Date.now() }
}

export function getProviderNames(): string[] {
  return Object.keys(readModels().providers)
}

export function getProviderConfig(providerId: string): PiProviderConfig | undefined {
  const config = readModels().providers[providerId]
  return config ? JSON.parse(JSON.stringify(config)) : undefined
}

export function upsertProvider(providerId: string, config: PiProviderConfig): void {
  const models: PiModelsConfig = JSON.parse(JSON.stringify(readModels()))
  models.providers[providerId] = config
  writeModels(models)
}

export function removeProvider(providerId: string): boolean {
  const models: PiModelsConfig = JSON.parse(JSON.stringify(readModels()))
  if (!(providerId in models.providers)) return false
  delete models.providers[providerId]
  writeModels(models)
  return true
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
  const data = readJsonFile<PiSettings>(SETTINGS_PATH, {})
  if (!data || typeof data !== 'object') {
    console.warn(`[config-bridge] ${SETTINGS_PATH} schema 不匹配，使用 fallback`)
    return {}
  }
  settingsCache = { data, timestamp: Date.now() }
  return data
}

export function writeSettings(settings: PiSettings): void {
  writeJsonFile(SETTINGS_PATH, settings)
  settingsCache = { data: JSON.parse(JSON.stringify(settings)), timestamp: Date.now() }
}

export function getDefaultModel(): { provider: string; modelId: string } | null {
  const settings = readSettings()
  if (!settings.defaultProvider || !settings.defaultModel) {
    // fallback: 取 models.json 里第一个 provider 的第一个 model
    const models = readModels()
    for (const [providerId, providerConfig] of Object.entries(models.providers)) {
      if (providerConfig.models && providerConfig.models.length > 0) {
        return { provider: providerId, modelId: providerConfig.models[0].id }
      }
    }
    return null
  }
  return { provider: settings.defaultProvider, modelId: settings.defaultModel }
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
  return AGENTS_DIR
}

export function listAgentFiles(): Array<{ name: string; path: string; content: string }> {
  if (!existsSync(AGENTS_DIR)) return []
  const results: Array<{ name: string; path: string; content: string }> = []
  const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'))
  for (const file of files) {
    const filePath = join(AGENTS_DIR, file)
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
  if (!existsSync(AGENTS_DIR)) mkdirSync(AGENTS_DIR, { recursive: true })
  const fileName = name.endsWith('.md') ? name : `${name}.md`
  const filePath = join(AGENTS_DIR, fileName)
  atomicWrite(filePath, content)
}

export function deleteAgentFile(name: string): boolean {
  const fileName = name.endsWith('.md') ? name : `${name}.md`
  const filePath = join(AGENTS_DIR, fileName)
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
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true })
  }
  return SESSIONS_DIR
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
  if (!existsSync(SESSIONS_DIR)) return []

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
  const entries = readdirSync(SESSIONS_DIR)

  for (const entry of entries) {
    const entryPath = join(SESSIONS_DIR, entry)
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

// ── 内部工具函数 ─────────────────────────────────────────────────

interface SessionHeader {
  id: string
  cwd: string
  timestamp: string
}

function parseSessionHeader(filePath: string): SessionHeader | null {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const firstLine = content.split('\n')[0]
    if (!firstLine) return null
    const entry = JSON.parse(firstLine)
    if (entry.type !== 'session') return null
    return { id: entry.id, cwd: entry.cwd, timestamp: entry.timestamp }
  } catch {
    return null
  }
}

/**
 * 确保 session 文件存在。如果 pi 延迟写入导致文件不存在，
 * 创建一个包含 session header 的最小 jsonl 文件。
 * 这样 scanPiSessions() 总能找到该 session，避免空对话 session 重启后消失。
 */
export function ensureSessionFile(filePath: string, id: string, cwd: string, label?: string): void {
  if (!filePath) return
  if (existsSync(filePath)) return

  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id,
    timestamp: new Date().toISOString(),
    cwd,
  }) + '\n'
  const entries = [header]
  if (label) {
    entries.push(JSON.stringify({ type: 'session_info', name: label, timestamp: new Date().toISOString() }) + '\n')
  }
  try {
    const fd = openSync(filePath, 'wx')
    writeSync(fd, entries.join(''))
    closeSync(fd)
    console.log(`[config-bridge] ensured session file: ${filePath}`)
  } catch (e) {
    // 文件可能已被 pi 进程创建（竞态），忽略 EEXIST
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') {
      console.error(`[config-bridge] failed to ensure session file: ${filePath}`, e)
    }
  }
}

/**
 * 将 session 名称持久化到 .jsonl 文件。
 *
 * 追加一条 `session_info` entry（pi 的标准格式），使 extractSessionName
 * 和 pi 进程都能读到新名称。如果文件不存在则静默跳过。
 */
export function persistSessionName(filePath: string, name: string, id?: string, cwd?: string): void {
  if (!filePath) return
  if (!existsSync(filePath)) {
    // 文件不存在时，写完整 header + name 确保 scanPiSessions 能找到
    // （空 session 重命名场景：pi 延迟写入导致文件未创建）
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const timestamp = new Date().toISOString()
    const entries = []
    if (id && cwd) {
      entries.push(JSON.stringify({ type: 'session', version: 3, id, timestamp, cwd }) + '\n')
    }
    entries.push(JSON.stringify({ type: 'session_info', name, timestamp }) + '\n')
    try {
      const fd = openSync(filePath, 'wx')
      writeSync(fd, entries.join(''))
      closeSync(fd)
      console.log(`[config-bridge] persistSessionName: created file with name: ${filePath}`)
    } catch (e) {
      console.error(`[config-bridge] persistSessionName: failed to create file: ${filePath}`, e)
    }
    return
  }
  const entry = JSON.stringify({ type: 'session_info', name, timestamp: new Date().toISOString() }) + '\n'
  try {
    const fd = openSync(filePath, 'a')
    writeSync(fd, entry)
    closeSync(fd)
  } catch (e) {
    console.error(`[config-bridge] persistSessionName: failed to write: ${filePath}`, e)
  }
}

/**
 * 从 .jsonl 文件提取最后一个 session_info 的 name 字段。
 * pi 的 session 会 append 多条 session_info，取最后一条作为当前名称。
 */
function extractSessionName(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    // 倒序查找最后一条 session_info
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue
      try {
        const entry = JSON.parse(lines[i])
        if (entry.type === 'session_info' && entry.name) {
          return entry.name as string
        }
        // eslint-disable-next-line taste/no-silent-catch -- parsing: skip malformed session line, continue parsing
      } catch {
        // skip malformed line
      }
    }
    return null
  } catch {
    return null
  }
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
  return CONFIG_DIR
}

/** xyz-pi agent 目录：~/.xyz-agent/pi/agent/ */
export function getPiAgentDir(): string {
  return PI_AGENT_DIR
}

export function getModelsPath(): string {
  return MODELS_PATH
}

export function getSettingsPath(): string {
  return SETTINGS_PATH
}
