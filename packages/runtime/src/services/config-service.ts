/**
 * ConfigService — facade for Provider/Skill/Agent/Preferences CRUD.
 *
 * Delegates Provider CRUD to IConfigStore (injected port; impl wraps pi's
 * models.json), Skill/Agent discovery to discovery.json SSOT + scanners
 * (ADR-0020 §1：强制目录 ∪ discovery 目录，按优先级合并去重).
 * Tool permissions are persisted to ~/.xyz-agent/config.json (xyz-agent own config).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type {
  ProviderInfo,
  SkillInfo,
  AgentInfo,
  ScannedSkillInfo,
  ScannedAgentInfo,
} from '@xyz-agent/shared'
import type { IConfigService } from '../interfaces.js'
import type { IConfigStore, ConfigModelDefinition } from './ports/config.js'
import { atomicWrite } from '../utils/fs-utils.js'
import { extractFrontmatter, extractDescription } from '../utils/frontmatter.js'
import { expandHome } from '../utils/path-utils.js'
import { scanSkills, loadSkillFromDir } from './scanners/skill-scanner.js'
import { scanAgents } from './scanners/agent-scanner.js'
import { pickModelCapabilityFields } from './model-mapper.js'

// ── ADR-0020 §1.1 强制目录（桥接层硬编码注入，不进 discovery.json）──
// 强制·项目（最高优先）> 强制·全局 > 可选（discovery 数组顺序）。
//
// ⚠️ 路径修正：ADR 文档写的逻辑路径是 ~/.xyz-agent/skills 等，但 pi 桥接层把 agentDir
// 重定向到 ~/.xyz-agent/pi/agent/，pi 实际扫的是 <piAgentDir>/skills 与 <piAgentDir>/agents。
// 故强制目录用 pi 实际路径（getPiAgentDir 拼出），而非 ADR 文档的逻辑路径——后者不存在，
// 会导致强制目录扫描落空（agent 页扫不到任何 agent）。
// 项目级强制目录（.xyz-agent/skills 等）保留 ADR 逻辑路径（项目相对路径，存在则扫）。
const FORCED_PROJECT_SKILL_DIR = '.xyz-agent/skills'
const FORCED_GLOBAL_SKILL_DIR = '~/.xyz-agent/skills'
const FORCED_PROJECT_AGENT_DIR = '.xyz-agent/agents'
const FORCED_GLOBAL_AGENT_DIR = '~/.xyz-agent/agents'

// ── Helpers ─────────────────────────────────────────────────────

/** Extract name and description from agent markdown frontmatter. */
function parseAgentMd(content: string): { name: string; description: string } {
  const { frontmatter } = extractFrontmatter(content)
  // name 是简单单行键值，inline 提取（不进通用 helper——name 是 agent 专属字段）
  let name = ''
  for (const fl of frontmatter.split('\n')) {
    if (fl.startsWith('name:')) name = fl.slice('name:'.length).trim()
  }
  const description = extractDescription(frontmatter)
  return { name, description }
}

/** Runtime type guard for thinkingLevelMap values. */
function isValidThinkingLevelMap(v: unknown): v is Record<string, string | null> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return Object.values(v as Record<string, unknown>).every(val => val === null || typeof val === 'string')
}

// ── Service ─────────────────────────────────────────────────────

export class ConfigService implements IConfigService {
  constructor(
    private projectRoot: string,
    private configStore: IConfigStore,
  ) {}

  // ── Provider CRUD ──────────────────────────────────────────────

  getDefaultModel(): { provider: string; modelId: string } | null {
    return this.configStore.getDefaultModel()
  }

  setDefaultModel(provider: string, modelId: string): void {
    this.configStore.setDefaultModel(provider, modelId)
  }

  listProviders(): ProviderInfo[] {
    const models = this.configStore.readModels()
    // eslint-disable-next-line taste/no-unsafe-object-entries -- providers is a known schema Record<string, PiProviderConfig>, not arbitrary user input
    return Object.entries(models.providers).map(([id, config]) => ({
      id,
      name: config.name || id,
      // W2：回填 provider 级 api 字段，修复前端编辑 provider 时 type 下拉丢失（P0-1）
      api: config.api,
      baseUrl: config.baseUrl,
      apiKeySet: !!config.apiKey,
      status: config.apiKey ? 'connected' as const : 'not_configured' as const,
      models: (config.models ?? []).map(m => ({
        id: m.id,
        name: m.name,
        api: m.api,
        baseUrl: m.baseUrl,
        input: m.input,
        compat: m.compat,
        // W2：model 级 enabled 透传（默认 true 向上兼容存量无此字段的 model）
        enabled: m.enabled !== false,
        ...pickModelCapabilityFields(m),
      })),
      // W2：从 config.enabled 读，undefined/true 视为启用（向上兼容存量无此字段的 provider）
      enabled: config.enabled !== false,
    }))
  }

  setProvider(providerId: string, data: {
    name?: string
    type?: string
    apiKey?: string
    baseUrl?: string
    models?: Array<string | { id: string; name?: string; contextWindow?: number; input?: Array<'text' | 'image'>; thinkingLevelMap?: Record<string, string | null> }>
    enabled?: boolean
  }): { newDefault?: { provider: string; modelId: string } } {
    const existing = this.configStore.getProviderConfig(providerId) ?? {}
    const merged = { ...existing }
    if (data.apiKey !== undefined) merged.apiKey = data.apiKey as string
    if (data.baseUrl !== undefined) merged.baseUrl = data.baseUrl as string
    if (data.type !== undefined) merged.api = this.configStore.applyTypeTranslation(data.type as string)
    if (data.name !== undefined) merged.name = data.name as string
    // W2：provider 级 enabled 透传到合并结果（data 类型已声明 enabled，原合并逻辑漏处理）
    if (data.enabled !== undefined) merged.enabled = data.enabled
    if (data.models !== undefined) {
      const rawModels = data.models as Array<Record<string, unknown>>
      const existingModels = (existing.models ?? []) as ConfigModelDefinition[]
      merged.models = rawModels.map(m => {
        const id = String(m.id ?? '')
        const base = existingModels.find(em => em.id === id) ?? {} as Partial<ConfigModelDefinition>
        const model: Record<string, unknown> = { ...base, id }
        if (m.name) model.name = String(m.name)
        if (typeof m.contextWindow === 'number') model.contextWindow = m.contextWindow
        if (Array.isArray(m.input)) {
          model.input = (m.input as unknown[]).filter(
            (v): v is 'text' | 'image' => v === 'text' || v === 'image',
          )
        }
        if (isValidThinkingLevelMap(m.thinkingLevelMap)) {
          model.thinkingLevelMap = m.thinkingLevelMap
        } else if (m.thinkingLevelMap === undefined && base.thinkingLevelMap) {
          // buildMap() returned undefined (all passthrough) → remove from model
          delete model.thinkingLevelMap
        }
        return model as unknown as ConfigModelDefinition
      })
    }
    return this.configStore.upsertProvider(providerId, merged)
  }

  deleteProvider(providerId: string): { removed: boolean; newDefault?: { provider: string; modelId: string } } {
    return this.configStore.removeProvider(providerId)
  }

  getProvider(providerId: string): { apiKey?: string; name?: string; type?: string; baseUrl?: string; models?: unknown[]; enabled?: boolean } | undefined {
    return this.configStore.getProviderConfig(providerId)
  }

  // ── Tool permissions (persisted to ~/.xyz-agent/config.json) ───

  getPiAgentDir(): string {
    return this.configStore.getPiAgentDir()
  }

  getConfigDir(): string {
    return this.configStore.getConfigDir()
  }

  private appConfigPath(): string {
    return join(this.configStore.getConfigDir(), 'config.json')
  }

  private loadAppConfig(): Record<string, unknown> {
    try {
      const cp = this.appConfigPath()
      if (existsSync(cp)) {
        const raw = readFileSync(cp, 'utf-8')
        const parsed = JSON.parse(raw)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
        console.error('[config-service] config.json is not a valid object, ignoring')
      }
    // eslint-disable-next-line taste/no-silent-catch -- intentional: config file missing/corrupt is handled by fallback
    } catch (e) {
      console.error('[config-service] load config.json error:', e)
    }
    return {}
  }

  private saveAppConfig(config: Record<string, unknown>): void {
    try {
      const cd = this.configStore.getConfigDir()
      if (!existsSync(cd)) mkdirSync(cd, { recursive: true })
      // eslint-disable-next-line no-magic-numbers -- standard JSON indent
      atomicWrite(this.appConfigPath(), JSON.stringify(config, null, 2))
    // eslint-disable-next-line taste/no-silent-catch -- intentional: save failure is best-effort
    } catch (e) {
      console.error('[config-service] save config.json error:', e)
    }
  }

  updateToolPermissions(permissions: Record<string, string>): void {
    const config = this.loadAppConfig()
    config['toolPermissions'] = permissions
    this.saveAppConfig(config)
  }

  // ── Skill CRUD ─────────────────────────────────────────────────

  /**
   * 扫描已加载 skill：强制目录（§1.1 层 1-2）∪ discovery.json.skillDirs（层 3）。
   * 按 ADR §1.1 优先级合并去重，填 effective（最高优先那条）+ sources（多来源 badge 链）。
   * 强制目录靠桥接层重定向注入 pi 原生扫描；可选目录靠 discovery→settings 投影 + argv 注入。
   */
   
  loadSkills(_projectRoot: string): SkillInfo[] {
    // 优先级从高到低的目录列表（pi 实际路径 > 强制项目 > 强制全局 > discovery 可选，靠前覆盖靠后）
    // pi 实际路径 <piAgentDir>/skills 是 pi 重定向后的真实 skill 落点（与 loadAgents 对称）。
    const orderedDirs = [
      join(this.configStore.getPiAgentDir(), 'skills'),
      FORCED_PROJECT_SKILL_DIR,
      FORCED_GLOBAL_SKILL_DIR,
      ...this.configStore.getSkillPaths(),
    ]

    // name → 按 priority 收集的所有来源（用于合并去重 + sources badge 链）
    const byName = new Map<string, Array<{ dir: string; scanned: ScannedSkillInfo }>>()

    for (const dir of orderedDirs) {
      const expanded = expandHome(dir)
      if (!existsSync(expanded)) continue
      // discovery 目录可能含多个 skill 子目录，强制目录同理——用 loadSkillFromDir 处理单目录（含 SKILL.md），
      // 但外部目录（~/.agents/skills 等）是「含多个 skill 子目录的容器」，需遍历子目录。
      // 复用 skill-scanner 的 forEachScannedDir 语义：对容器目录遍历子目录找 SKILL.md。
      this.collectSkillsFromDir(dir, byName)
    }

    // 合并去重：每个 name 取最高优先来源为 effective，其余进 sources badge 链
    const results: SkillInfo[] = []
    for (const [, entries] of byName) {
      const primary = entries[0] // 数组按优先级顺序，第一个为最高优先
      const scanned = primary.scanned
      const sources = entries.length > 1
        ? entries.map(e => ({ source: e.scanned.sourceType, sourcePath: e.scanned.sourcePath }))
        : undefined
      results.push({
        id: scanned.id,
        name: scanned.name,
        description: scanned.description,
        enabled: true, // ADR §5：目录在 = 启用，恒 true
        source: scanned.sourceType,
        triggers: scanned.triggers,
        argumentHint: scanned.argumentHint,
        sourcePath: scanned.sourcePath,
        content: scanned.content,
        fileSize: scanned.fileSize,
        tools: scanned.tools,
        effective: true, // 最高优先来源标生效
        sources,
      })
    }
    return results
  }

  /**
   * 从单个目录收集 skill。dir 可能是：
   * - 含 SKILL.md 的单 skill 目录（强制目录的典型）→ loadSkillFromDir
   * - 含多个 skill 子目录的容器（~/.agents/skills 等）→ 遍历子目录
   */
  private collectSkillsFromDir(dir: string, byName: Map<string, Array<{ dir: string; scanned: ScannedSkillInfo }>>): void {
    const expanded = expandHome(dir)
    // 先尝试 dir 本身含 SKILL.md（单 skill 目录）
    const direct = loadSkillFromDir(dir)
    if (direct) {
      this.pushSkillSource(byName, dir, direct)
      return
    }
    // 否则当作容器，遍历子目录
    if (!existsSync(expanded)) return
    try {
      const names = readdirSync(expanded)
      for (const name of names) {
        const childDir = join(expanded, name)
        try {
          if (!statSync(childDir).isDirectory()) continue
        } catch { continue }
        const childScanned = loadSkillFromDir(join(dir, name))
        if (childScanned) this.pushSkillSource(byName, join(dir, name), childScanned)
      }
    // eslint-disable-next-line taste/no-silent-catch -- 容器不可读则跳过
    } catch {
      // dir 不可读，跳过
    }
  }

  /** 把一个 skill 来源按优先级顺序追加进 byName（靠前目录 = 高优先，先入为主）。 */
  private pushSkillSource(
    byName: Map<string, Array<{ dir: string; scanned: ScannedSkillInfo }>>,
    dir: string,
    scanned: ScannedSkillInfo,
  ): void {
    const list = byName.get(scanned.name) ?? []
    list.push({ dir, scanned })
    byName.set(scanned.name, list)
  }

  /** No-op: skills are discovered from discovery.json + forced dirs, not independently persisted. */
   
  saveSkills(_projectRoot: string, _skills: SkillInfo[]): void {
    // no-op — skill persistence is managed by discovery.json SSOT (ADR-0020 §1)
  }

  /** @deprecated ADR-0020 §5 目录级管道：文件级注册已废弃，保留兼容期。新代码用 setSkillDirs。 */
  upsertSkill(skill: SkillInfo): void {
    console.warn('[config-service] upsertSkill is deprecated (ADR-0020 §5). Use setSkillDirs for directory-level config.')
    if (skill.sourcePath) {
      const dir = dirname(skill.sourcePath)
      this.configStore.addSkillPath(dir)
    }
  }

  /** @deprecated ADR-0020 §5 目录级管道：文件级删除已废弃，保留兼容期。新代码用 setSkillDirs。 */
  deleteSkill(skillId: string): void {
    console.warn('[config-service] deleteSkill is deprecated (ADR-0020 §5). Use setSkillDirs for directory-level config.')
    const skills = this.loadSkills(this.projectRoot)
    const skill = skills.find(s => s.id === skillId)
    if (skill?.sourcePath) {
      const dir = dirname(skill.sourcePath)
      this.configStore.removeSkillPath(dir)
    }
  }

  // ── Skill 加载路径（ADR-0020 §1 discovery.json SSOT）──

  setSkillDirs(dirs: string[]): void {
    this.configStore.setSkillPaths(dirs)
  }

  getSkillDirs(): string[] {
    return this.configStore.getSkillPaths()
  }

  getAgentDirs(): string[] {
    return this.configStore.getAgentDirs()
  }

  setAgentDirs(dirs: string[]): void {
    this.configStore.setAgentDirs(dirs)
  }

  migrateSettingsSkillsToDiscovery(): void {
    this.configStore.migrateSettingsSkillsToDiscovery()
  }

  // ── Agent CRUD ─────────────────────────────────────────────────

  /**
   * 扫描已加载 agent：强制目录（§1.1 层 1-2）∪ discovery.json.agentDirs（层 3）。
   * 多目录扫描经 IConfigStore.listAgentFiles(dirs)（同名按数组顺序去重），
   * 转 AgentInfo（目录在 = 启用，ADR §5）。
   *
   * 强制目录含 pi 实际路径 <piAgentDir>/agents（pi 重定向后的真实扫描位置，
   * 旧 listAgentFiles() 默认扫此）+ ADR 项目/全局逻辑路径（存在则扫）。
   */
   
  loadAgents(_projectRoot: string): AgentInfo[] {
    const orderedDirs = [
      join(this.configStore.getPiAgentDir(), 'agents'), // pi 实际路径（最高优先，真实 agent 落点）
      FORCED_PROJECT_AGENT_DIR,
      FORCED_GLOBAL_AGENT_DIR,
      ...this.configStore.getAgentDirs(),
    ].map(expandHome).filter(d => existsSync(d))

    // listAgentFiles(dirs) 已按数组顺序去重（靠前胜出），单来源即生效无需额外 sources
    const files = this.configStore.listAgentFiles(orderedDirs)
    return files.map(f => {
      const { name, description } = parseAgentMd(f.content)
      return {
        id: f.name,
        name: name || f.name,
        description: description || '',
        enabled: true, // ADR §5：目录在 = 启用，恒 true
        modelStrategy: 'auto',
        source: 'pi',
        sourceType: 'pi',
        content: f.content,
        tools: [],
        effective: true,
      }
    })
  }

  /** No-op: agents are discovered from discovery.json + forced dirs, not independently persisted. */
   
  saveAgents(_projectRoot: string, _agents: AgentInfo[]): void {
    // no-op — agent persistence is managed as .md files + discovery.json SSOT (ADR-0020 §1)
  }

  /** @deprecated ADR-0020 §5 目录级管道：文件级写入已废弃，保留兼容期。新代码用 setAgentDirs。 */
  upsertAgent(agent: AgentInfo): void {
    console.warn('[config-service] upsertAgent is deprecated (ADR-0020 §5). Use setAgentDirs for directory-level config.')
    if (agent.content) {
      this.configStore.writeAgentFile(agent.name || agent.id, agent.content)
    }
  }

  /** @deprecated ADR-0020 §5 目录级管道：文件级删除已废弃，保留兼容期。新代码用 setAgentDirs。 */
  deleteAgent(agentId: string): void {
    console.warn('[config-service] deleteAgent is deprecated (ADR-0020 §5). Use setAgentDirs for directory-level config.')
    this.configStore.deleteAgentFile(agentId)
  }

  // ── Scanning ───────────────────────────────────────────────────

  scanSkills(sources: string[], existingIds: Set<string>): ScannedSkillInfo[] {
    return scanSkills(sources, existingIds)
  }

  scanAgents(sources: string[], existingIds: Set<string>): ScannedAgentInfo[] {
    return scanAgents(sources, existingIds)
  }
}
