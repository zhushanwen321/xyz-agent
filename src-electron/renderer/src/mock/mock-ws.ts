/* eslint-disable no-magic-numbers */
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import { emit } from '../lib/event-bus'
import { useProviderStore } from '../stores/provider'
import { useChatStore } from '../stores/chat'
import {
  mockSessionGroups, mockMessages, mockProviders, mockModels,
  mockSkills, mockAgents, mockDoneItems, mockAlertItems,
  DEFAULT_SESSION_ID, toModelInfos,
} from './data'

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

let stateCallback: ((state: ConnectionState) => void) | null = null

const DISCOVERY_DELAY_MS = 1500

const typeModelMap: Record<string, Array<{ id: string; name: string; ctx?: number }>> = {
  'anthropic-messages': [
    { id: 'claude-sonnet-4', name: 'claude-sonnet-4', ctx: 200000 },
    { id: 'claude-opus-4', name: 'claude-opus-4', ctx: 200000 },
    { id: 'claude-haiku-4', name: 'claude-haiku-4', ctx: 200000 },
  ],
  'openai-completions': [
    { id: 'gpt-4o', name: 'gpt-4o', ctx: 128000 },
    { id: 'gpt-4o-mini', name: 'gpt-4o-mini', ctx: 128000 },
    { id: 'o3', name: 'o3', ctx: 200000 },
    { id: 'deepseek-v4', name: 'deepseek-v4', ctx: 1000000 },
    { id: 'gemini-2.5-pro', name: 'gemini-2.5-pro', ctx: 1000000 },
  ],
}

export function mockConnect(
  onStateChange: (state: ConnectionState) => void
): void {
  stateCallback = onStateChange
  onStateChange('connecting')

  // Simulate brief connection delay
  setTimeout(() => {
    onStateChange('connected')

    // Fire initial data after connection
    setTimeout(() => fireInitialData(), 100)
  }, 200)
}

export function mockDisconnect(): void {
  stateCallback?.('disconnected')
  stateCallback = null
}

export function mockSend(msg: ClientMessage): void {
  switch (msg.type) {
    case 'session.list':
      respond('session.list', { groups: mockSessionGroups })
      break
    case 'session.switch':
      respond('session.list', { groups: mockSessionGroups })
      respond('session.history', {
        sessionId: msg.payload.sessionId || DEFAULT_SESSION_ID,
        messages: mockMessages,
      })
      break
    case 'session.history':
      respond('session.history', {
        sessionId: msg.payload.sessionId || DEFAULT_SESSION_ID,
        messages: mockMessages,
      })
      break
    case 'session.create':
      respond('session.created', {
        session: {
          id: 'mock-new-' + Date.now(),
          label: msg.payload.label || '新会话',
          cwd: msg.payload.cwd || '/Users/mock/project',
          status: 'idle',
          lastActiveAt: Date.now(),
          modelId: 'claude-sonnet',
          tokenCount: 0,
        }
      })
      break
    case 'session.delete': {
      const delId = msg.payload.sessionId
      // 从 mock 数据中真正移除
      for (const group of mockSessionGroups) {
        const idx = group.sessions.findIndex(s => s.id === delId)
        if (idx >= 0) { group.sessions.splice(idx, 1); break }
      }
      respond('session.deleted', { sessionId: delId })
      respond('session.list', { groups: mockSessionGroups })
      break
    }
    case 'session.compact':
      respond('session.compacting', { sessionId: msg.payload.sessionId, status: 'compacting' })
      setTimeout(() => {
        respond('session.compacted', { sessionId: msg.payload.sessionId, status: 'compacted' })
      }, 500)
      break
    case 'session.clear':
      respond('session.history', { sessionId: msg.payload.sessionId, messages: [] })
      break
    case 'message.send':
      handleMockMessageSend(msg)
      break
    case 'message.abort':
      // No-op in mock
      break
    case 'config.getProviders':
      respond('config.providers', { providers: mockProviders.map(p => ({
        id: p.id, name: p.name, api: p.api, status: p.status, models: p.models, apiKeySet: p.apiKeySet, baseUrl: p.baseUrl, enabled: p.enabled
      })) })
      break
    case 'config.setProvider': {
      const pId = msg.payload.providerId
      const pName = msg.payload.name
      const pBaseUrl = msg.payload.baseUrl
      const pKey = msg.payload.apiKey
      const pModelsRaw = msg.payload.models as unknown
      const pType = msg.payload.type
      const pEnabled = msg.payload.enabled

      if (pId && pName) {
        const existing = mockProviders.find(p => p.id === pId)
        if (existing) {
          existing.name = pName
          if (pType) existing.api = pType
          if (pBaseUrl !== undefined) existing.baseUrl = pBaseUrl
          if (pKey && pKey !== '••••••••') existing.apiKeySet = true
          if (pModelsRaw && Array.isArray(pModelsRaw)) existing.models = pModelsRaw as typeof existing.models
        } else {
          mockProviders.push({
            id: pId,
            name: pName,
            api: pType ?? 'openai-completions',
            status: 'not_configured',
            models: Array.isArray(pModelsRaw) ? pModelsRaw as typeof mockProviders[0]['models'] : [],
            apiKeySet: !!pKey && pKey !== '••••••••',
            baseUrl: pBaseUrl ?? '',
            icon: pName.charAt(0).toUpperCase(),
          })
        }
      } else if (pId && pEnabled !== undefined) {
        const target = mockProviders.find(p => p.id === pId)
        if (target) target.enabled = !target.enabled
      }

      respond('config.providerUpdated', { providerId: pId })
      respond('config.providers', { providers: mockProviders.map(p => ({
        id: p.id, name: p.name, api: p.api, status: p.status, models: p.models, apiKeySet: p.apiKeySet, baseUrl: p.baseUrl
      })) })
      break
    }
    case 'config.deleteProvider': {
      const delId = msg.payload.providerId
      if (delId) {
        const idx = mockProviders.findIndex(p => p.id === delId)
        if (idx >= 0) mockProviders.splice(idx, 1)
      }
      respond('config.providerUpdated', { providerId: delId })
      respond('config.providers', { providers: mockProviders.map(p => ({
        id: p.id, name: p.name, api: p.api, status: p.status, models: p.models, apiKeySet: p.apiKeySet, baseUrl: p.baseUrl
      })) })
      break
    }
    case 'config.discoverModels': {
      // Mock: 使用硬编码数据模拟发现结果
      setTimeout(() => {
        const discType = msg.payload.providerType
        const discModels = typeModelMap[discType ?? ''] ?? []
        respond('config.discoveredModels', {
          models: discModels,
          success: true,
        })
      }, DISCOVERY_DELAY_MS)
      break
    }
    case 'config.setToolPermissions':
      // No-op in mock, would persist to config store
      break
    case 'model.list':
      respond('model.list', { models: toModelInfos(mockModels) })
      break
    case 'model.switch':
      respond('model.switched', { modelId: msg.payload.modelId })
      break
    case 'tool.approve':
    case 'tool.deny':
    case 'tool.always_allow':
      // No-op in mock
      break
    case 'ping':
      respond('pong', {})
      break
    default:
      console.log('[mock] unhandled message type:', msg.type)
  }
}

function respond(type: string, payload: Record<string, unknown>): void {
  const msg: ServerMessage = { type: type as ServerMessage['type'], payload }
  emit(type, msg)
}

function fireInitialData(): void {
  respond('session.list', { groups: mockSessionGroups })
  respond('session.history', { sessionId: DEFAULT_SESSION_ID, messages: mockMessages })
  respond('config.providers', { providers: mockProviders.map(p => ({
    id: p.id, name: p.name, api: p.api, status: p.status, models: p.models, apiKeySet: p.apiKeySet, baseUrl: p.baseUrl
  })) })
  respond('model.list', { models: toModelInfos(mockModels) })

  // Push skills and agents into the provider store directly
  const providerStore = useProviderStore()
  const chatStore = useChatStore()
  chatStore.setDoneCount(mockDoneItems.length, DEFAULT_SESSION_ID)
  chatStore.setAlertCount(mockAlertItems.length, DEFAULT_SESSION_ID)
  providerStore.setSkills(mockSkills.map(s => ({
    id: s.name,
    name: s.name,
    description: s.description,
    enabled: s.enabled,
    source: s.source,
    triggers: s.triggers,
    sourcePath: s.sourcePath,
    sourceIcon: s.sourceIcon,
    fileSize: s.fileSize,
    tools: s.tools,
    content: s.content,
    tag: s.tag,
  })))
  providerStore.setAgents(mockAgents.map(a => ({
    id: a.name,
    name: a.name,
    description: a.description,
    enabled: a.active,
    modelStrategy: a.modelStrategy ?? 'default',
    icon: a.icon,
    source: a.source,
    sourceType: a.sourceType,
    iconBg: a.iconBg,
    type: a.type,
    tools: a.tools,
    modelBind: a.modelBind,
    modelTags: a.modelTags,
    overrideParams: a.overrideParams,
    params: a.params,
    content: a.content,
  })))
}

function handleMockMessageSend(msg: ClientMessage): void {
  const { sessionId, content } = msg.payload

  setTimeout(() => {
    respond('message.thinking_start', { sessionId })
    setTimeout(() => {
      respond('message.thinking_delta', { sessionId, delta: '分析用户请求...' })
      setTimeout(() => {
        respond('message.thinking_end', { sessionId, content: '分析用户请求...' })
        setTimeout(() => {
          respond('message.text_delta', {
            sessionId,
            delta: `收到：「${content.slice(0, 20)}...」。这是 mock 响应。`
          })
          setTimeout(() => {
            respond('message.complete', { sessionId })
          }, 300)
        }, 500)
      }, 300)
    }, 300)
  }, 300)
}
