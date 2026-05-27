// Client → Sidecar message types

import type { SkillInfo, AgentInfo } from './provider'

// ── ClientMessageType（保持向后兼容）──────────────────────────

export type ClientMessageType =
  | 'session.create' | 'session.delete' | 'session.list' | 'session.switch' | 'session.history'
  | 'session.compact' | 'session.clear' | 'session.restore' | 'session.rename'
  | 'message.send' | 'message.abort'
  | 'config.getProviders' | 'config.setProvider' | 'config.deleteProvider' | 'config.setToolPermissions'
  | 'config.discoverModels'
  | 'config.scanSkills' | 'config.setSkill' | 'config.deleteSkill'
  | 'config.scanAgents' | 'config.setAgent' | 'config.deleteAgent'
  | 'model.list' | 'model.switch'
  | 'tool.approve' | 'tool.deny' | 'tool.always_allow'
  | 'extension.ui_response' | 'extension.toggle' | 'extension.list'
  | 'ping'
  | 'session.tree-data' | 'session.tree-navigate' | 'session.tree-fork' | 'session.tree-clone' | 'session.tree-capability'

// ── Payload 类型定义 ────────────────────────────────────────────

/** config.setProvider 除 providerId 外的透传字段，与 IConfigService.setProvider 参数对齐 */
export interface SetProviderData {
  name?: string
  type?: string
  apiKey?: string
  baseUrl?: string
  models?: Array<string | { id: string; name?: string; contextWindow?: number }>
  enabled?: boolean
}

// ── ClientMessage discriminated union ───────────────────────────

/** 每个 type 对应的 payload 类型映射 */
export interface ClientMessageMap {
  'ping': Record<string, never>
  'session.create': { cwd?: string; label?: string }
  'session.delete': { sessionId: string }
  'session.list': Record<string, never>
  'session.switch': { sessionId: string }
  'session.history': { sessionId: string }
  'session.compact': { sessionId: string }
  'session.clear': { sessionId: string }
  'session.restore': { sessionId: string }
  'session.rename': { sessionId: string; name: string }
  'message.send': { sessionId: string; content: string; subagent?: { agent: string; task: string } }
  'message.abort': { sessionId: string }
  'session.tree-data': { sessionId: string }
  'session.tree-navigate': { sessionId: string; targetEntryId: string }
  'session.tree-fork': { sessionId: string; entryId: string }
  'session.tree-clone': { sessionId: string }
  'session.tree-capability': { sessionId: string }
  'config.getProviders': Record<string, never>
  'config.setProvider': { providerId: string } & SetProviderData
  'config.deleteProvider': { providerId: string }
  'config.setToolPermissions': { permissions: Record<string, string> }
  'config.discoverModels': { baseUrl: string; apiKey?: string; providerType?: string; providerId?: string }
  'config.scanSkills': { sources: string[] }
  'config.setSkill': { skill: SkillInfo }
  'config.deleteSkill': { skillId: string }
  'config.scanAgents': { sources: string[] }
  'config.setAgent': { agent: AgentInfo }
  'config.deleteAgent': { agentId: string }
  'model.list': Record<string, never>
  'model.switch': { sessionId: string; provider: string; modelId: string }
  'tool.approve': { sessionId: string; toolCallId?: string }
  'tool.deny': { sessionId: string; toolCallId?: string; reason?: string }
  'tool.always_allow': { sessionId: string; toolName?: string }
  'extension.ui_response': { sessionId: string; requestId: string; result: boolean | string | null }
  'extension.toggle': { name: string; enabled: boolean }
  'extension.list': Record<string, never>
}

export type ClientMessage =
  | { type: 'ping'; id?: string; payload: Record<string, never> }
  | { type: 'session.create'; id?: string; payload: ClientMessageMap['session.create'] }
  | { type: 'session.delete'; id?: string; payload: ClientMessageMap['session.delete'] }
  | { type: 'session.list'; id?: string; payload: Record<string, never> }
  | { type: 'session.switch'; id?: string; payload: ClientMessageMap['session.switch'] }
  | { type: 'session.history'; id?: string; payload: ClientMessageMap['session.history'] }
  | { type: 'session.compact'; id?: string; payload: ClientMessageMap['session.compact'] }
  | { type: 'session.clear'; id?: string; payload: ClientMessageMap['session.clear'] }
  | { type: 'session.restore'; id?: string; payload: ClientMessageMap['session.restore'] }
  | { type: 'session.rename'; id?: string; payload: ClientMessageMap['session.rename'] }
  | { type: 'message.send'; id?: string; payload: ClientMessageMap['message.send'] }
  | { type: 'message.abort'; id?: string; payload: ClientMessageMap['message.abort'] }
  | { type: 'session.tree-data'; id?: string; payload: ClientMessageMap['session.tree-data'] }
  | { type: 'session.tree-navigate'; id?: string; payload: ClientMessageMap['session.tree-navigate'] }
  | { type: 'session.tree-fork'; id?: string; payload: ClientMessageMap['session.tree-fork'] }
  | { type: 'session.tree-clone'; id?: string; payload: ClientMessageMap['session.tree-clone'] }
  | { type: 'session.tree-capability'; id?: string; payload: ClientMessageMap['session.tree-capability'] }
  | { type: 'config.getProviders'; id?: string; payload: Record<string, never> }
  | { type: 'config.setProvider'; id?: string; payload: ClientMessageMap['config.setProvider'] }
  | { type: 'config.deleteProvider'; id?: string; payload: ClientMessageMap['config.deleteProvider'] }
  | { type: 'config.setToolPermissions'; id?: string; payload: ClientMessageMap['config.setToolPermissions'] }
  | { type: 'config.discoverModels'; id?: string; payload: ClientMessageMap['config.discoverModels'] }
  | { type: 'config.scanSkills'; id?: string; payload: ClientMessageMap['config.scanSkills'] }
  | { type: 'config.setSkill'; id?: string; payload: ClientMessageMap['config.setSkill'] }
  | { type: 'config.deleteSkill'; id?: string; payload: ClientMessageMap['config.deleteSkill'] }
  | { type: 'config.scanAgents'; id?: string; payload: ClientMessageMap['config.scanAgents'] }
  | { type: 'config.setAgent'; id?: string; payload: ClientMessageMap['config.setAgent'] }
  | { type: 'config.deleteAgent'; id?: string; payload: ClientMessageMap['config.deleteAgent'] }
  | { type: 'model.list'; id?: string; payload: Record<string, never> }
  | { type: 'model.switch'; id?: string; payload: ClientMessageMap['model.switch'] }
  | { type: 'tool.approve'; id?: string; payload: ClientMessageMap['tool.approve'] }
  | { type: 'tool.deny'; id?: string; payload: ClientMessageMap['tool.deny'] }
  | { type: 'tool.always_allow'; id?: string; payload: ClientMessageMap['tool.always_allow'] }
  | { type: 'extension.ui_response'; id?: string; payload: ClientMessageMap['extension.ui_response'] }
  | { type: 'extension.toggle'; id?: string; payload: ClientMessageMap['extension.toggle'] }
  | { type: 'extension.list'; id?: string; payload: ClientMessageMap['extension.list'] }

// ── 辅助类型 ────────────────────────────────────────────────────

/** 根据 type 提取对应的 payload 类型 */
export type ExtractPayload<T extends ClientMessageType> = T extends keyof ClientMessageMap ? ClientMessageMap[T] : never

/** 构造特定 type 的 ClientMessage */
export type SpecificClientMessage<T extends ClientMessageType> = Extract<ClientMessage, { type: T }>

// ── Sidecar → Client message types（保持不变）──────────────────

export type ServerMessageType =
  | 'session.created' | 'session.deleted' | 'session.list' | 'session.history'
  | 'session.compacting' | 'session.compacted' | 'session.restored' | 'session.renamed'
  | 'message.message_start' | 'message.text_delta' | 'message.thinking_delta'
  | 'message.thinking_start' | 'message.thinking_end'
  | 'message.tool_call_start' | 'message.tool_call_end' | 'message.tool_call_pending'
  | 'message.complete' | 'message.error' | 'message.status'
  | 'context.update'
  | 'config.providers' | 'config.providerUpdated' | 'config.discoveredModels'
  | 'config.scannedSkills' | 'config.skillUpdated' | 'config.skillDeleted'
  | 'config.scannedAgents' | 'config.agentUpdated' | 'config.agentDeleted'
  | 'config.skills' | 'config.agents'
  | 'model.list' | 'model.switched'
  | 'pong' | 'error'
  | 'extension.ui_request' | 'extension.ui_timeout' | 'extension.error'
  | 'message.tool_call_update' | 'config.extensions'
  | 'session.commands'
  | 'session.tree-data' | 'session.tree-navigate-result' | 'session.tree-fork-result' | 'session.tree-clone-result' | 'session.tree-capability'

export interface ServerMessage {
  type: ServerMessageType
  id?: string
  payload: Record<string, unknown>
}

// ── Extension payload interfaces ────────────────────────────────

export interface ExtensionUIRequestPayload {
  sessionId: string
  requestId: string
  method: 'confirm' | 'select' | 'input' | 'notify'
  title?: string
  message?: string
  options?: string[]
  default?: string
  level?: 'info' | 'warn' | 'error'
}

export interface ExtensionUIResponsePayload {
  sessionId: string
  requestId: string
  result: boolean | string | null
}

export interface ExtensionErrorPayload {
  sessionId: string
  extensionName: string
  error: string
}

export interface ToolCallUpdatePayload {
  sessionId: string
  toolCallId: string
  progress?: number
  detail?: string
}

export interface ExtensionInfo {
  name: string
  version: string
  description: string
  path: string
  enabled: boolean
}
