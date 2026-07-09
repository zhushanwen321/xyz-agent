/**
 * session.state_changed 事件 → store modelId/thinkingLevel 同步测试（W3）。
 *
 * 锁定：model.switch 后 runtime model-service 广播 session.state_changed（payload 含 sessionId +
 * modelId + thinkingLevel + 重算用量）。useChat.ensureStreamSubscription 的 switch 须消费此事件，
 * 调 sessionStore.updateSessionState 同步，否则切换模型后 Composer 工具条不跟随。
 *
 * 参照 session-renamed-sync.test.ts 同模式（streamSubscribe 捕获回调，手动触发）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/session-state-changed-sync.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

type StreamCb = (msg: { type: string; payload: Record<string, unknown> }) => void

const { streamCbHolder, streamSubscribeMock } = vi.hoisted(() => ({
  streamCbHolder: { current: null as StreamCb | null },
  streamSubscribeMock: vi.fn((_sid: string, cb: StreamCb) => {
    streamCbHolder.current = cb
    return () => {
      streamCbHolder.current = null
    }
  }),
}))

vi.mock('@/api', () => ({
  chat: { send: vi.fn(), streamSubscribe: streamSubscribeMock },
}))

import { useChat } from '@/composables/features/useChat'
import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
  streamCbHolder.current = null
  streamSubscribeMock.mockClear()
})

function seedSession(s: SessionSummary): void {
  const store = useSessionStore()
  const group: SessionGroup = { cwd: s.cwd, sessions: [s] }
  store.setGroups([group])
}

describe('session.state_changed 事件 → store 状态同步', () => {
  it('U14: 正常 state_changed（sessionId + modelId + thinkingLevel）→ store 更新', async () => {
    seedSession({
      id: 's1', label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100, modelId: 'old/model', thinkingLevel: 'medium', tokenCount: 0,
    })
    const chat = useChat()
    await chat.send('s1', '触发订阅')
    expect(streamCbHolder.current).not.toBeNull()

    streamCbHolder.current!({
      type: 'session.state_changed',
      payload: {
        sessionId: 's1',
        modelId: 'anthropic/claude-4',
        thinkingLevel: 'high',
        usagePercent: 6,
        inputTokens: 12000,
        contextLimit: 200000,
      },
    })

    const updated = useSessionStore().list.find((s) => s.id === 's1')
    expect(updated?.modelId).toBe('anthropic/claude-4')
    expect(updated?.thinkingLevel).toBe('high')
  })

  it('thinkingLevel 为 undefined 时只更新 modelId，thinkingLevel 保留旧值', async () => {
    seedSession({
      id: 's2', label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100, modelId: 'old/model', thinkingLevel: 'low', tokenCount: 0,
    })
    const chat = useChat()
    await chat.send('s2', '触发订阅')

    streamCbHolder.current!({
      type: 'session.state_changed',
      payload: {
        sessionId: 's2',
        modelId: 'openai/gpt-4',
        thinkingLevel: undefined,
        usagePercent: 0,
        inputTokens: 0,
        contextLimit: 128000,
      },
    })

    const updated = useSessionStore().list.find((s) => s.id === 's2')
    expect(updated?.modelId).toBe('openai/gpt-4')
    expect(updated?.thinkingLevel).toBe('low') // undefined 跳过，保留旧值
  })

  it('其他 session 的 state_changed 不影响当前 session', async () => {
    seedSession({
      id: 's3', label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100, modelId: 'original', thinkingLevel: 'max', tokenCount: 0,
    })
    const chat = useChat()
    await chat.send('s3', '触发订阅')

    // payload.sessionId 指向另一个 session（streamSubscribe 按 sid 路由，实际不会收到，
    // 但 updateSessionState 内部按 id 查找，不匹配则 no-op）
    streamCbHolder.current!({
      type: 'session.state_changed',
      payload: {
        sessionId: 'other-session',
        modelId: 'should/not/apply',
        thinkingLevel: 'off',
        usagePercent: 0,
        inputTokens: 0,
        contextLimit: 0,
      },
    })

    const updated = useSessionStore().list.find((s) => s.id === 's3')
    expect(updated?.modelId).toBe('original') // 不受影响
    expect(updated?.thinkingLevel).toBe('max')
  })
})

describe('session.thinkingLevelSet 事件 → store thinkingLevel 同步', () => {
  it('U-TLSet-1: payload 含 sessionId + level → updateSessionState 更新 thinkingLevel', async () => {
    // 注：streamSubscriptions 是 useChat 模块级单例，跨用例复用 sid 会跳过订阅，故用唯一 sid。
    const sid = 'tlset-1'
    seedSession({
      id: sid, label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100, modelId: 'm', thinkingLevel: 'low', tokenCount: 0,
    })
    const chat = useChat()
    await chat.send(sid, '触发订阅')
    expect(streamCbHolder.current).not.toBeNull()

    const updateSpy = vi.spyOn(useSessionStore(), 'updateSessionState')
    streamCbHolder.current!({
      type: 'session.thinkingLevelSet',
      payload: { sessionId: sid, level: 'high' },
    })

    expect(updateSpy).toHaveBeenCalledWith(sid, { thinkingLevel: 'high' })
  })

  it('U-TLSet-2: level 缺省时跳过更新', async () => {
    const sid = 'tlset-2'
    seedSession({
      id: sid, label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100, modelId: 'm', thinkingLevel: 'low', tokenCount: 0,
    })
    const chat = useChat()
    await chat.send(sid, '触发订阅')
    expect(streamCbHolder.current).not.toBeNull()

    const updateSpy = vi.spyOn(useSessionStore(), 'updateSessionState')
    streamCbHolder.current!({
      type: 'session.thinkingLevelSet',
      payload: { sessionId: sid, level: undefined },
    })

    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('U-TLSet-3: sessionId 缺省时跳过更新', async () => {
    const sid = 'tlset-3'
    seedSession({
      id: sid, label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100, modelId: 'm', thinkingLevel: 'low', tokenCount: 0,
    })
    const chat = useChat()
    await chat.send(sid, '触发订阅')
    expect(streamCbHolder.current).not.toBeNull()

    const updateSpy = vi.spyOn(useSessionStore(), 'updateSessionState')
    streamCbHolder.current!({
      type: 'session.thinkingLevelSet',
      payload: { sessionId: undefined, level: 'high' },
    })

    expect(updateSpy).not.toHaveBeenCalled()
  })
})
