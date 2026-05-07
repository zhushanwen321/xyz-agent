/* eslint-disable no-magic-numbers */
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import { emit } from '../lib/event-bus'
import {
  mockSessionGroups, mockMessages, mockProviders, mockModels,
  DEFAULT_SESSION_ID,
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
    case 'message.send':
      handleMockMessageSend(msg)
      break
    case 'message.abort':
      // No-op in mock
      break
    case 'config.getProviders':
      respond('config.providers', { providers: mockProviders })
      break
    case 'config.setProvider':
      respond('config.providerUpdated', { providerId: msg.payload.providerId })
      break
    case 'config.deleteProvider':
      respond('config.providerUpdated', { providerId: msg.payload.providerId })
      break
    case 'model.list':
      respond('model.list', { models: mockModels })
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
  respond('config.providers', { providers: mockProviders })
  respond('model.list', { models: mockModels })
}

function handleMockMessageSend(msg: ClientMessage): void {
  // In static mock mode, just respond with a canned bot message
  const sessionId = msg.payload.sessionId as string
  const content = msg.payload.content as string

  // Simulate a brief thinking + response
  setTimeout(() => {
    respond('message.thinking_delta', { sessionId, delta: '思考中...' })

    setTimeout(() => {
      respond('message.text_delta', {
        sessionId,
        delta: `收到您的消息：「${content.slice(0, 20)}...」。这是一个 mock 响应，当前为静态演示模式。`
      })

      setTimeout(() => {
        respond('message.complete', { sessionId })
      }, 300)
    }, 500)
  }, 300)
}
