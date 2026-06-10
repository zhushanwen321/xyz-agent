/**
 * ConfigService — facade for Provider/Skill/Agent CRUD.
 *
 * Delegates Provider CRUD to pi-config-bridge (reads/writes pi's native
 * models.json), Skill discovery to pi's skill paths + skill-scanner,
 * Agent discovery to pi's agents/ directory, and tool permissions to
 * config-store.
 */
import { dirname } from 'node:path'

import type {
  ProviderInfo,
  SkillInfo,
  AgentInfo,
  ScannedSkillInfo,
  ScannedAgentInfo,
} from '@xyz-agent/shared'
import type { IConfigService } from '../interfaces.js'
import * as piBridge from '../pi-config-bridge.js'
import type { PiModelDefinition } from '../pi-config-bridge.js'
import { updateToolPermissions } from '../config-store.js'
import { scanSkills, loadSkillFromDir } from '../skill-scanner.js'
import { scanAgents } from '../agent-scanner.js'

// ── Helpers ─────────────────────────────────────────────────────

/** Map xyz-agent provider type strings to pi's api identifiers. */
function mapTypeToApi(type: string): string {
  const map: Record<string, string> = {
    anthropic: 'anthropic-messages',
    openai: 'openai-completions',
    'openai-compatible': 'openai-completions',
    google: 'openai-completions',
    deepseek: 'openai-completions',
    ollama: 'openai-completions',
  }
  return map[type] ?? type
}

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
  constructor(private projectRoot: string) {}

  // ── Provider CRUD ──────────────────────────────────────────────

  getDefaultModel(): { provider: string; modelId: string } | null {
    return piBridge.getDefaultModel()
  }

  setDefaultModel(provider: string, modelId: string): void {
    piBridge.setDefaultModel(provider, modelId)
  }

  listProviders(): ProviderInfo[] {
    const models = piBridge.readModels()
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
  }): void {
    const existing = piBridge.getProviderConfig(providerId) ?? {}
    const merged = { ...existing }
    if (data.apiKey !== undefined) merged.apiKey = data.apiKey as string
    if (data.baseUrl !== undefined) merged.baseUrl = data.baseUrl as string
    if (data.type !== undefined) merged.api = mapTypeToApi(data.type as string)
    if (data.name !== undefined) merged.name = data.name as string
    if (data.models !== undefined) {
      const rawModels = data.models as Array<Record<string, unknown>>
      const existingModels = (existing.models ?? []) as PiModelDefinition[]
      merged.models = rawModels.map(m => {
        const id = String(m.id ?? '')
        const base = existingModels.find(em => em.id === id) ?? {} as Partial<PiModelDefinition>
        const model: Record<string, unknown> = { ...base, id }
        if (m.name) model.name = String(m.name)
        if (typeof m.contextWindow === 'number') model.contextWindow = m.contextWindow
        if (isValidThinkingLevelMap(m.thinkingLevelMap)) {
          model.thinkingLevelMap = m.thinkingLevelMap
        } else if (m.thinkingLevelMap === undefined && base.thinkingLevelMap) {
          // buildMap() returned undefined (all passthrough) → remove from model
          delete model.thinkingLevelMap
        }
        return model as unknown as PiModelDefinition
      })
    }
    piBridge.upsertProvider(providerId, merged)
  }

  deleteProvider(providerId: string): boolean {
    return piBridge.removeProvider(providerId)
  }

  getProvider(providerId: string): { apiKey?: string; name?: string; type?: string; baseUrl?: string; models?: unknown[]; enabled?: boolean } | undefined {
    return piBridge.getProviderConfig(providerId)
  }

  // ── Tool permissions ───────────────────────────────────────────

  updateToolPermissions(permissions: Record<string, string>): void {
    updateToolPermissions(permissions)
  }

  // ── Skill CRUD ─────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface requires projectRoot param
  loadSkills(_projectRoot: string): SkillInfo[] {
    const skillPaths = piBridge.getSkillPaths()
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
      piBridge.addSkillPath(dir)
    }
  }

  /** Remove a skill directory from pi's settings.json. */
  deleteSkill(skillId: string): void {
    const skills = this.loadSkills(this.projectRoot)
    const skill = skills.find(s => s.id === skillId)
    if (skill?.sourcePath) {
      const dir = dirname(skill.sourcePath)
      piBridge.removeSkillPath(dir)
    }
  }

  // ── Agent CRUD ─────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface requires projectRoot param
  loadAgents(_projectRoot: string): AgentInfo[] {
    const files = piBridge.listAgentFiles()
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
      piBridge.writeAgentFile(agent.name || agent.id, agent.content)
    }
  }

  /** Delete an agent .md file from pi's agents directory. */
  deleteAgent(agentId: string): void {
    piBridge.deleteAgentFile(agentId)
  }

  // ── Scanning ───────────────────────────────────────────────────

  scanSkills(sources: string[], existingIds: Set<string>): ScannedSkillInfo[] {
    return scanSkills(sources, existingIds)
  }

  scanAgents(sources: string[], existingIds: Set<string>): ScannedAgentInfo[] {
    return scanAgents(sources, existingIds)
  }
}
