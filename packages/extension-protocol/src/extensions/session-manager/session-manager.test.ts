import { describe, it, expect } from 'vitest'
import { SESSION_MANAGER_MARKER } from './marker'
import { ASK_USER_MARKER } from '../ask-user/marker'
import { GUI_WIDGET_MARKER } from '../../core/markers'
import type {
  SessionManagerAction,
  SessionManagerRequest,
  SessionManagerResult,
  SessionManagerError,
  SessionManagerIntent,
  CreateSessionParams,
  SendToSessionParams,
  ReadSessionHistoryParams,
  GetSessionStatusParams,
  ListMySessionsParams,
  AbortSessionParams,
  CreateSessionResult,
  SendToSessionResult,
  ReadSessionHistoryResult,
  GetSessionStatusResult,
  ListMySessionsResult,
  AbortSessionResult,
} from './types'

/**
 * U1-A2: marker 精确值 \x00XYZ_SESSION_MANAGER + 类型覆盖完整
 */
describe('U1-A2 marker 精确值 + 类型覆盖', () => {
  it('U1-A2 SESSION_MANAGER_MARKER 精确值为 \\x00XYZ_SESSION_MANAGER', () => {
    expect(SESSION_MANAGER_MARKER).toBe('\x00XYZ_SESSION_MANAGER')
  })

  it('U1-A2 SESSION_MANAGER_MARKER 以 NUL 字符开头', () => {
    expect(SESSION_MANAGER_MARKER.charCodeAt(0)).toBe(0)
  })

  it('U1-A2 SESSION_MANAGER_MARKER 不等于 ASK_USER_MARKER', () => {
    expect(SESSION_MANAGER_MARKER).not.toBe(ASK_USER_MARKER)
  })

  it('U1-A2 SESSION_MANAGER_MARKER 不等于 GUI_WIDGET_MARKER', () => {
    expect(SESSION_MANAGER_MARKER).not.toBe(GUI_WIDGET_MARKER)
  })

  it('U1-A2 SessionManagerAction 包含全部 6 个 action', () => {
    const actions: SessionManagerAction[] = [
      'create',
      'send',
      'history',
      'status',
      'list',
      'abort',
    ]
    expect(actions).toHaveLength(6)
  })

  it('U1-A2 请求类型联合覆盖全部 6 种', () => {
    const requests: SessionManagerRequest[] = [
      { action: 'create', label: 'l', prompt: 'p' },
      { action: 'send', sessionId: 's', content: 'c' },
      { action: 'history', sessionId: 's' },
      { action: 'status', sessionId: 's' },
      { action: 'list' },
      { action: 'abort', sessionId: 's' },
    ]
    expect(requests).toHaveLength(6)
  })

  it('U1-A2 结果类型联合覆盖全部 6 种', () => {
    const results: SessionManagerResult[] = [
      { sessionId: 's', status: 'created' },
      { blocked: false },
      { messages: [], truncated: false },
      { status: 'active' },
      { sessions: [] },
      { success: true },
    ]
    expect(results).toHaveLength(6)
  })

  it('U1-A2 SessionManagerIntent 审计 entry 含 action + 额外 params', () => {
    const intent: SessionManagerIntent = {
      action: 'create',
      label: 'test',
      prompt: 'do something',
    }
    expect(intent.action).toBe('create')
    expect(intent.label).toBe('test')
  })
})

describe('U1-A2 各 action 请求类型结构', () => {
  it('U1-A2 CreateSessionParams 必含 action/label/prompt', () => {
    const req: CreateSessionParams = {
      action: 'create',
      label: 'test',
      prompt: 'do something',
    }
    expect(req.action).toBe('create')
  })

  it('U1-A2 SendToSessionParams 必含 action/sessionId/content', () => {
    const req: SendToSessionParams = {
      action: 'send',
      sessionId: 'abc',
      content: 'hello',
    }
    expect(req.action).toBe('send')
  })

  it('U1-A2 ReadSessionHistoryParams 必含 action/sessionId，tailTurns 可选', () => {
    const req: ReadSessionHistoryParams = {
      action: 'history',
      sessionId: 'abc',
    }
    expect(req.action).toBe('history')
    expect(req.tailTurns).toBeUndefined()
  })

  it('U1-A2 GetSessionStatusParams 必含 action/sessionId', () => {
    const req: GetSessionStatusParams = {
      action: 'status',
      sessionId: 'abc',
    }
    expect(req.action).toBe('status')
  })

  it('U1-A2 ListMySessionsParams 仅含 action', () => {
    const req: ListMySessionsParams = { action: 'list' }
    expect(req.action).toBe('list')
  })

  it('U1-A2 AbortSessionParams 必含 action/sessionId', () => {
    const req: AbortSessionParams = {
      action: 'abort',
      sessionId: 'abc',
    }
    expect(req.action).toBe('abort')
  })
})

describe('U1-A2 各 action 结果类型结构', () => {
  it('U1-A2 CreateSessionResult 必含 sessionId/status', () => {
    const res: CreateSessionResult = {
      sessionId: 'abc',
      status: 'created',
    }
    expect(res.status).toBe('created')
  })

  it('U1-A2 SendToSessionResult 必含 blocked', () => {
    const res: SendToSessionResult = { blocked: false }
    expect(res.blocked).toBe(false)
  })

  it('U1-A2 ReadSessionHistoryResult 必含 messages/truncated', () => {
    const res: ReadSessionHistoryResult = {
      messages: [{ role: 'user', content: 'hi' }],
      truncated: false,
    }
    expect(res.messages).toHaveLength(1)
  })

  it('U1-A2 GetSessionStatusResult status 为 active 或 idle', () => {
    const active: GetSessionStatusResult = { status: 'active', modelId: 'p/m' }
    const idle: GetSessionStatusResult = { status: 'idle' }
    expect(active.status).toBe('active')
    expect(idle.modelId).toBeUndefined()
  })

  it('U1-A2 ListMySessionsResult sessions 数组', () => {
    const res: ListMySessionsResult = {
      sessions: [{ id: 'abc', spawnSource: 'agent' }],
    }
    expect(res.sessions[0].spawnSource).toBe('agent')
  })

  it('U1-A2 AbortSessionResult 必含 success', () => {
    const res: AbortSessionResult = { success: true }
    expect(res.success).toBe(true)
  })

  it('U1-A2 SessionManagerError 必含 error，hint 和 sessionId 可选', () => {
    const err: SessionManagerError = { error: 'failed' }
    expect(err.error).toBe('failed')
    expect(err.hint).toBeUndefined()
    expect(err.sessionId).toBeUndefined()

    const errWithHint: SessionManagerError = {
      error: 'prompt failed',
      hint: 'use send_to_session',
      sessionId: 'abc',
    }
    expect(errWithHint.hint).toBe('use send_to_session')
  })
})
