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
 * 依赖方向：command（请求/动作）+ events（订阅，走全局通道）。
 */
import type {
  ProviderInfo,
  SkillInfo,
  AgentInfo,
  SetProviderData,
  SkillDirConfig,
  SystemPromptConfig,
} from '@xyz-agent/shared'
import { command } from '../request'
import * as events from '../events'

// ── 请求-响应 ──
// runtime 请求-响应 reply 均为命名 envelope（settings-message-handler.ts），
// 此处统一解包对应字段，与 session.list 解包 `.groups` 同构。mock 门面有独立实现不受影响。
export async function listProviders(): Promise<ProviderInfo[]> {
  const reply = await command('config.getProviders', {})
  return reply.providers
}

export async function scanSkills(sources: string[]): Promise<SkillInfo[]> {
  const reply = await command('config.scanSkills', { sources })
  return reply.skills
}

export async function scanAgents(sources: string[]): Promise<AgentInfo[]> {
  const reply = await command('config.scanAgents', { sources })
  return reply.agents
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
  return command('config.discoverModels', req)
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

export function onSkillDirs(handler: (dirs: SkillDirConfig[]) => void): () => void {
  return events.onGlobalType('config.skillDirs', (msg) => {
    handler(msg.payload.dirs)
  })
}

export function onAgentDirs(handler: (dirs: SkillDirConfig[]) => void): () => void {
  return events.onGlobalType('config.agentDirs', (msg) => {
    handler(msg.payload.dirs)
  })
}

export function onDefaults(handler: (defaultModel: string) => void): () => void {
  return events.onGlobalType('config.defaults', (msg) => {
    handler(msg.payload.defaultModel)
  })
}

// ── 动作-ack（状态变更由对应订阅通道推回）──
/**
 * 目录级管道写入（ADR-0020 §1）：覆盖 discovery.json.skillDirs（有序数组 = 优先级，靠前覆盖靠后）。
 * 状态变更经 onSkills + onSkillDirs 订阅推回（后端 setSkillDirs 后广播）。
 */
export function setSkillDirs(dirs: string[]): Promise<void> {
  return command('config.setSkillDirs', { dirs })
}

export function setAgentDirs(dirs: string[]): Promise<void> {
  return command('config.setAgentDirs', { dirs })
}

export function setProvider(providerId: string, data: SetProviderData): Promise<void> {
  return command('config.setProvider', { providerId, ...data })
}

// W3 默认模型持久化：动作-ack，状态变更经 onDefaults 订阅推回（runtime 广播 config.defaults）。
export function setDefaultModel(provider: string, modelId: string): Promise<void> {
  return command('config.setDefaultModel', { provider, modelId })
}

export function deleteProvider(providerId: string): Promise<void> {
  return command('config.deleteProvider', { providerId })
}

export function setSkill(skill: SkillInfo): Promise<void> {
  return command('config.setSkill', { skill })
}

export function deleteSkill(skillId: string): Promise<void> {
  return command('config.deleteSkill', { skillId })
}

export function setAgent(agent: AgentInfo): Promise<void> {
  return command('config.setAgent', { agent })
}

export function deleteAgent(agentId: string): Promise<void> {
  return command('config.deleteAgent', { agentId })
}

// ── System prompt config（FR-4/FR-5）──
// settings-handler reply config.systemPrompt 形状 `{ config, corrupted? }`；
// setSystemPrompt 失败时走 sendError，command reject（前端 catch 提示）。

/** 读取系统提示词配置。corrupted=true 表示磁盘配置损坏已回退默认。 */
export async function getSystemPrompt(): Promise<{ config: SystemPromptConfig; corrupted: boolean }> {
  const reply = await command('config.getSystemPrompt', {})
  return { config: reply.config, corrupted: reply.corrupted ?? false }
}

/** 保存系统提示词配置（replace + append）。失败时 runtime 返回 error envelope，command 会 reject。 */
export async function setSystemPrompt(config: SystemPromptConfig): Promise<{ config: SystemPromptConfig; corrupted: boolean }> {
  const reply = await command('config.setSystemPrompt', { config })
  return { config: reply.config, corrupted: reply.corrupted ?? false }
}

/** 订阅系统提示词配置广播（多 panel 同步）。 */
export function onSystemPrompt(handler: (config: SystemPromptConfig, corrupted: boolean) => void): () => void {
  return events.onGlobalType('config.systemPrompt', (msg) => {
    handler(msg.payload.config, msg.payload.corrupted ?? false)
  })
}
