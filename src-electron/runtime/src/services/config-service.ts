/**
 * ConfigService — facade for Provider/Skill/Agent CRUD.
 *
 * Delegates to provider-store, skill-store, agent-store, skill-scanner,
 * agent-scanner, and config-store. Extracted from server.ts
 * handleSettingsMessage() logic.
 *
 * Also encapsulates the findIdx→splice→save CRUD patterns that were
 * previously inline in handleSettingsMessage.
 */
import type {
  ProviderInfo,
  SkillInfo,
  AgentInfo,
  ScannedSkillInfo,
  ScannedAgentInfo,
} from '@xyz-agent/shared'
import type { IConfigService } from '../interfaces.js'
import * as providerStore from '../provider-store.js'
import { updateToolPermissions, getProvider } from '../config-store.js'
import { loadSkills, saveSkills } from '../skill-store.js'
import { loadAgents, saveAgents } from '../agent-store.js'
import { scanSkills } from '../skill-scanner.js'
import { scanAgents } from '../agent-scanner.js'

export class ConfigService implements IConfigService {
  constructor(private projectRoot: string) {}

  // ── Provider CRUD ──────────────────────────────────────────────

  listProviders(): ProviderInfo[] {
    return providerStore.listProviders()
  }

  setProvider(providerId: string, data: {
    name?: string
    type?: string
    apiKey?: string
    baseUrl?: string
    models?: Array<string | { id: string; name?: string; ctx?: number; tags?: string[]; enabled?: boolean }>
    enabled?: boolean
  }): void {
    providerStore.setProvider(providerId, data)
  }

  deleteProvider(providerId: string): boolean {
    return providerStore.deleteProvider(providerId)
  }

  getProvider(providerId: string): { apiKey?: string; name?: string; type?: string; baseUrl?: string; models?: unknown[]; enabled?: boolean } | undefined {
    return getProvider(providerId)
  }

  // ── Tool permissions ───────────────────────────────────────────

  updateToolPermissions(permissions: Record<string, string>): void {
    updateToolPermissions(permissions)
  }

  // ── Skill CRUD ─────────────────────────────────────────────────

  loadSkills(projectRoot: string): SkillInfo[] {
    return loadSkills(projectRoot)
  }

  saveSkills(projectRoot: string, skills: SkillInfo[]): void {
    saveSkills(projectRoot, skills)
  }

  /** Upsert a single skill into the persisted list. */
  upsertSkill(skill: SkillInfo): void {
    const skills = loadSkills(this.projectRoot)
    const idx = skills.findIndex(s => s.id === skill.id)
    if (idx >= 0) skills[idx] = skill; else skills.push(skill)
    saveSkills(this.projectRoot, skills)
  }

  /** Delete a skill by id from the persisted list. */
  deleteSkill(skillId: string): void {
    saveSkills(this.projectRoot, loadSkills(this.projectRoot).filter(s => s.id !== skillId))
  }

  // ── Agent CRUD ─────────────────────────────────────────────────

  loadAgents(projectRoot: string): AgentInfo[] {
    return loadAgents(projectRoot)
  }

  saveAgents(projectRoot: string, agents: AgentInfo[]): void {
    saveAgents(projectRoot, agents)
  }

  /** Upsert a single agent into the persisted list. */
  upsertAgent(agent: AgentInfo): void {
    const agents = loadAgents(this.projectRoot)
    const aIdx = agents.findIndex(a => a.id === agent.id)
    if (aIdx >= 0) agents[aIdx] = agent; else agents.push(agent)
    saveAgents(this.projectRoot, agents)
  }

  /** Delete an agent by id from the persisted list. */
  deleteAgent(agentId: string): void {
    saveAgents(this.projectRoot, loadAgents(this.projectRoot).filter(a => a.id !== agentId))
  }

  // ── Scanning ───────────────────────────────────────────────────

  scanSkills(sources: string[], existingIds: Set<string>): ScannedSkillInfo[] {
    return scanSkills(sources, existingIds)
  }

  scanAgents(sources: string[], existingIds: Set<string>): ScannedAgentInfo[] {
    return scanAgents(sources, existingIds)
  }
}
