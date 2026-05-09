/* eslint-disable no-magic-numbers */
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import { emit } from '../lib/event-bus'
import { useProviderStore } from '../stores/provider'
import {
  mockSessionGroups, mockMessages, mockProviders, mockModels,
  mockSkills, mockAgents,
  DEFAULT_SESSION_ID, toModelInfos,
} from './data'

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

let stateCallback: ((state: ConnectionState) => void) | null = null

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
          label: '新会话',
          cwd: '/Users/mock/project',
          status: 'idle',
          lastActiveAt: Date.now(),
          modelId: 'claude-sonnet',
          tokenCount: 0,
        }
      })
      break
    case 'session.delete':
      respond('session.deleted', { sessionId: msg.payload.id })
      break
    case 'session.compact':
      respond('session.compacting', { sessionId: msg.payload.sessionId, status: 'compacting' })
      setTimeout(() => {
        respond('message.status', { sessionId: msg.payload.sessionId as string, status: 'compacted' })
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
        id: p.id, name: p.name, status: p.status, models: p.models, apiKeySet: p.apiKeySet, baseUrl: p.baseUrl
      })) })
      break
    case 'config.setProvider': {
      const pId = msg.payload.providerId as string | undefined
      const pName = msg.payload.name as string | undefined
      const pBaseUrl = msg.payload.url as string | undefined
      const pKey = msg.payload.key as string | undefined
      const pModelsRaw = msg.payload.models as unknown
      const pType = msg.payload.type as string | undefined
      const pStatus = msg.payload.status as string | undefined

      // 将 model 对象数组转为 name 字符串数组
      const toModelNames = (raw: unknown): string[] => {
        if (!Array.isArray(raw)) return []
        return raw.map(m => (typeof m === 'string' ? m : (m as { name: string }).name))
      }
      const pModels = toModelNames(pModelsRaw)

      if (pId && pName) {
        let existing = mockProviders.find(p => p.id === pId)
        if (existing) {
          existing.name = pName
          if (pType) existing.type = pType
          if (pBaseUrl !== undefined) existing.baseUrl = pBaseUrl
          if (pKey && pKey !== '••••••••') existing.apiKeySet = true
          if (pModels.length) existing.models = pModels
        } else {
          mockProviders.push({
            id: pId,
            name: pName,
            type: pType ?? 'openai-compatible',
            status: 'not_configured',
            models: pModels,
            apiKeySet: !!pKey && pKey !== '••••••••',
            baseUrl: pBaseUrl ?? '',
            icon: pName.charAt(0).toUpperCase(),
          })
        }
      } else if (pId && pStatus) {
        const target = mockProviders.find(p => p.id === pId)
        if (target) target.status = pStatus as typeof target.status
      }

      respond('config.providerUpdated', { providerId: pId })
      respond('config.providers', { providers: mockProviders.map(p => ({
        id: p.id, name: p.name, type: p.type, status: p.status, models: p.models, apiKeySet: p.apiKeySet, baseUrl: p.baseUrl
      })) })
      break
    }
    case 'config.deleteProvider': {
      const delId = msg.payload.providerId as string | undefined
      if (delId) {
        const idx = mockProviders.findIndex(p => p.id === delId)
        if (idx >= 0) mockProviders.splice(idx, 1)
      }
      respond('config.providerUpdated', { providerId: delId })
      respond('config.providers', { providers: mockProviders.map(p => ({
        id: p.id, name: p.name, type: p.type, status: p.status, models: p.models, apiKeySet: p.apiKeySet, baseUrl: p.baseUrl
      })) })
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
    id: p.id, name: p.name, type: p.type, status: p.status, models: p.models, apiKeySet: p.apiKeySet, baseUrl: p.baseUrl
  })) })
  respond('model.list', { models: toModelInfos(mockModels) })

  // Push skills and agents into the provider store directly
  const providerStore = useProviderStore()
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
  const sessionId = msg.payload.sessionId as string
  const content = msg.payload.content as string

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
