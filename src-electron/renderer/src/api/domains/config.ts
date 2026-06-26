/**
 * Config 域 —— provider / skill / agent / defaults（请求 + 订阅 + 动作 混合）。
 *
 * 形态分类（契约见 .xyz-harness/2026-06-23-render-runtime-integration/contract.md §2.3）：
 * - 请求-响应：listProviders / scanSkills / scanAgents / discoverModels
 * - 订阅-推送：onProviders / onSkills / onAgents / onDefaults
 * - 动作-ack：setProvider / deleteProvider / setSkill / deleteSkill / setAgent / deleteAgent
 *
 * 动作触发后状态变更由对应订阅通道推回（单一数据源，避免竞态）。
 *
 * 依赖方向：transport + pending（请求/动作）+ events（订阅，走全局通道）。
 */
import type {
  ProviderInfo,
  SkillInfo,
  AgentInfo,
  SetProviderData,
} from '@xyz-agent/shared'
import * as transport from '../transport'
import * as pending from '../pending'
import * as events from '../events'

// ── 请求-响应 ──
// runtime 请求-响应 reply 均为命名 envelope（settings-message-handler.ts），
// 此处统一解包对应字段，与 session.list 解包 `.groups` 同构。mock 门面有独立实现不受影响。
export async function listProviders(): Promise<ProviderInfo[]> {
  const id = pending.create()
  const result = pending.register<{ providers: ProviderInfo[] }>(id)
  transport.send({ type: 'config.getProviders', id, payload: {} })
  return (await result).providers
}

export async function scanSkills(sources: string[]): Promise<SkillInfo[]> {
  const id = pending.create()
  const result = pending.register<{ skills: SkillInfo[]; success: boolean }>(id)
  transport.send({ type: 'config.scanSkills', id, payload: { sources } })
  return (await result).skills
}

export async function scanAgents(sources: string[]): Promise<AgentInfo[]> {
  const id = pending.create()
  const result = pending.register<{ agents: AgentInfo[]; success: boolean }>(id)
  transport.send({ type: 'config.scanAgents', id, payload: { sources } })
  return (await result).agents
}

/** discoverModels 的响应载荷（config.discoveredModels reply，settings-message-handler） */
export interface DiscoveredModelsResult {
  models: Array<{ id: string; name?: string; contextWindow?: number }>
  success: boolean
  error?: string
}

export function discoverModels(req: {
  baseUrl: string
  apiKey?: string
  providerType?: string
  providerId?: string
}): Promise<DiscoveredModelsResult> {
  const id = pending.create()
  const result = pending.register<DiscoveredModelsResult>(id)
  transport.send({ type: 'config.discoverModels', id, payload: req })
  return result
}

// ── 订阅-推送（sendInitialState 主动推 + 运行时广播）──
export function onProviders(handler: (providers: ProviderInfo[]) => void): () => void {
  return events.onGlobalType('config.providers', (msg) => {
    handler(msg.payload.providers)
  })
}

export function onSkills(handler: (skills: SkillInfo[]) => void): () => void {
  return events.onGlobalType('config.skills', (msg) => {
    handler(msg.payload.skills)
  })
}

export function onAgents(handler: (agents: AgentInfo[]) => void): () => void {
  return events.onGlobalType('config.agents', (msg) => {
    handler(msg.payload.agents)
  })
}

export function onDefaults(handler: (defaultModel: string) => void): () => void {
  return events.onGlobalType('config.defaults', (msg) => {
    handler(msg.payload.defaultModel)
  })
}

// ── 动作-ack（状态变更由对应订阅通道推回）──
export function setProvider(providerId: string, data: SetProviderData): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'config.setProvider', id, payload: { providerId, ...data } })
  return result
}

export function deleteProvider(providerId: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'config.deleteProvider', id, payload: { providerId } })
  return result
}

export function setSkill(skill: SkillInfo): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'config.setSkill', id, payload: { skill } })
  return result
}

export function deleteSkill(skillId: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'config.deleteSkill', id, payload: { skillId } })
  return result
}

export function setAgent(agent: AgentInfo): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'config.setAgent', id, payload: { agent } })
  return result
}

export function deleteAgent(agentId: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'config.deleteAgent', id, payload: { agentId } })
  return result
}
