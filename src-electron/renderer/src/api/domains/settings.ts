/**
 * Settings API —— 真实实现（走 transport/ws-client）。
 * 骨架阶段：与 mock 同签名，内部 throw（等 WS 联调）。
 */
import type { ProviderInfo, SkillInfo, AgentInfo } from '@xyz-agent/shared'

interface SystemSettings {
  locale: 'zh-CN' | 'en-US'
  theme: 'light' | 'dark' | 'system'
  themePreset: string
}

interface ExtensionItem {
  name: string
  version: string
  description: string
  enabled: boolean
  tools: string[]
}

// ponytail: stub — throw until WS transport is wired
const unimplemented = () => { throw new Error('settings API: not wired to transport yet') }

export async function getProviders(): Promise<ProviderInfo[]> { unimplemented(); return [] }
export async function getSkills(): Promise<SkillInfo[]> { unimplemented(); return [] }
export async function getAgents(): Promise<AgentInfo[]> { unimplemented(); return [] }
export async function getExtensions(): Promise<ExtensionItem[]> { unimplemented(); return [] }
export async function getSystem(): Promise<SystemSettings> { unimplemented(); return { locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue' } }
export async function updateSystem(_patch: Partial<SystemSettings>): Promise<void> { unimplemented() }
