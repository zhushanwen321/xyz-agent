/**
 * ConfigService — facade for Provider/Skill/Agent/Preferences CRUD.
 *
 * Delegates Provider CRUD to IConfigStore (injected port; impl wraps pi's
 * models.json), Skill discovery to pi's skill paths + skill-scanner,
 * Agent discovery to pi's agents/ directory.
 * Tool permissions are persisted to ~/.xyz-agent/config.json (xyz-agent own config).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type {
  ProviderInfo,
  SkillInfo,
  AgentInfo,
  ScannedSkillInfo,
  ScannedAgentInfo,
} from '@xyz-agent/shared'
import type { IConfigService } from '../interfaces.js'
import type { IConfigStore, ConfigModelDefinition } from './ports.js'
import { atomicWrite } from '../utils/fs-utils.js'
import { scanSkills, loadSkillFromDir } from './scanners/skill-scanner.js'
import { scanAgents } from './scanners/agent-scanner.js'

// ── Helpers ─────────────────────────────────────────────────────

/** Extract name and description from agent markdown frontmatter. */
function parseAgentMd(content: string): { name: string; description: string } {
  const lines = content.split('\n')
  let inFrontmatter = false
  const frontmatterLines: string[] = []
  for (const line of lines) {
    if (line.trim() === '---') {
      if (!inFrontmatter) { inFrontmatter = true; continue }
      else break
    }
    if (inFrontmatter) frontmatterLines.push(line)
  }
  let name = ''
  let description = ''
  const fmText = frontmatterLines.join('\n')
  for (const fl of frontmatterLines) {
    if (fl.startsWith('name:')) name = fl.slice('name:'.length).trim()
  }
  // 支持 YAML 多行 description（>- 或 | 格式，含 chomping indicator -/+）
  const fmDescMatch = fmText.match(/^description:\s*[>\|][-+]?\s*$/m)
  if (fmDescMatch) {
    const startIdx = fmText.indexOf(fmDescMatch[0]) + fmDescMatch[0].length
    const remaining = fmText.slice(startIdx)
    const multilineParts: string[] = []
    for (const line of remaining.split('\n')) {
      if (line && !line.startsWith(' ') && !line.startsWith('\t')) break
      multilineParts.push(line.trim())
    }
    description = multilineParts.join(' ').trim()
  } else {
    const singleLine = fmText.match(/^description:\s*[>\|]?(.+?)\s*$/m)?.[1]?.trim()
    if (singleLine) description = singleLine
  }
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
      baseUrl: config.baseUrl,
      apiKeySet: !!config.apiKey,
      status: config.apiKey ? 'connected' as const : 'not_configured' as const,
      models: (config.models ?? []).map(m => ({
        id: m.id,
        name: m.name,
        api: m.api,
        baseUrl: m.baseUrl,
        reasoning: m.reasoning,
        input: m.input,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        thinkingLevelMap: m.thinkingLevelMap,
        cost: m.cost,
        compat: m.compat,
      })),
      enabled: true,
    }))
  }

  setProvider(providerId: string, data: {
    name?: string
    type?: string
    apiKey?: string
    baseUrl?: string
    models?: Array<string | { id: string; name?: string; contextWindow?: number; thinkingLevelMap?: Record<string, string | null> }>
    enabled?: boolean
  }): { newDefault?: { provider: string; modelId: string } } {
    const existing = this.configStore.getProviderConfig(providerId) ?? {}
    const merged = { ...existing }
    if (data.apiKey !== undefined) merged.apiKey = data.apiKey as string
    if (data.baseUrl !== undefined) merged.baseUrl = data.baseUrl as string
    if (data.type !== undefined) merged.api = this.configStore.applyTypeTranslation(data.type as string)
    if (data.name !== undefined) merged.name = data.name as string
    if (data.models !== undefined) {
      const rawModels = data.models as Array<Record<string, unknown>>
      const existingModels = (existing.models ?? []) as ConfigModelDefinition[]
      merged.models = rawModels.map(m => {
        const id = String(m.id ?? '')
        const base = existingModels.find(em => em.id === id) ?? {} as Partial<ConfigModelDefinition>
        const model: Record<string, unknown> = { ...base, id }
        if (m.name) model.name = String(m.name)
        if (typeof m.contextWindow === 'number') model.contextWindow = m.contextWindow
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface requires projectRoot param
  loadSkills(_projectRoot: string): SkillInfo[] {
    const skillPaths = this.configStore.getSkillPaths()
    const results: SkillInfo[] = []
    for (const path of skillPaths) {
      const scanned = loadSkillFromDir(path)
      if (scanned) {
        results.push({
          id: scanned.id,
          name: scanned.name,
          description: scanned.description,
          enabled: true,
          source: scanned.sourceType,
          triggers: scanned.triggers,
          argumentHint: scanned.argumentHint,
          sourcePath: scanned.sourcePath,
          content: scanned.content,
          fileSize: scanned.fileSize,
          tools: scanned.tools,
        })
      }
    }
    return results
  }

  /** No-op: skills are now discovered from pi's skill paths, not independently persisted. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  saveSkills(_projectRoot: string, _skills: SkillInfo[]): void {
    // no-op — skill persistence is managed by pi's settings.json
  }

  /** Register a skill directory in pi's settings.json. */
  upsertSkill(skill: SkillInfo): void {
    if (skill.sourcePath) {
      const dir = dirname(skill.sourcePath)
      this.configStore.addSkillPath(dir)
    }
  }

  /** Remove a skill directory from pi's settings.json. */
  deleteSkill(skillId: string): void {
    const skills = this.loadSkills(this.projectRoot)
    const skill = skills.find(s => s.id === skillId)
    if (skill?.sourcePath) {
      const dir = dirname(skill.sourcePath)
      this.configStore.removeSkillPath(dir)
    }
  }

  // ── Agent CRUD ─────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface requires projectRoot param
  loadAgents(_projectRoot: string): AgentInfo[] {
    const files = this.configStore.listAgentFiles()
    return files.map(f => {
      const { name, description } = parseAgentMd(f.content)
      return {
        id: f.name,
        name: name || f.name,
        description: description || '',
        enabled: true,
        modelStrategy: 'auto',
        source: 'pi',
        sourceType: 'pi',
        content: f.content,
        tools: [],
      }
    })
  }

  /** No-op: agents are now managed as files in ~/.xyz-agent/pi/agent/agents/. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  saveAgents(_projectRoot: string, _agents: AgentInfo[]): void {
    // no-op — agent persistence is managed as .md files in pi's agents dir
  }

  /** Write agent content to a .md file in pi's agents directory. */
  upsertAgent(agent: AgentInfo): void {
    if (agent.content) {
      this.configStore.writeAgentFile(agent.name || agent.id, agent.content)
    }
  }

  /** Delete an agent .md file from pi's agents directory. */
  deleteAgent(agentId: string): void {
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
