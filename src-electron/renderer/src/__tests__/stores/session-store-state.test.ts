/**
 * sessionStore.updateSessionState 单测（W3）。
 *
 * 覆盖 model.switch 后 session.state_changed 广播驱动的 store 局部更新。
 * 不含订阅路由（见 session-state-changed-sync.test.ts）。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/stores/session-store-state.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionGroup } from '@xyz-agent/shared'

import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
})

function seedSession(): ReturnType<typeof useSessionStore> {
  const store = useSessionStore()
  const group: SessionGroup = {
    cwd: '/repo',
    sessions: [
      { id: 's1', label: 'test', cwd: '/repo', status: 'idle', lastActiveAt: 100, modelId: 'old/x', thinkingLevel: 'medium', tokenCount: 0 },
      { id: 's2', label: 'other', cwd: '/repo', status: 'idle', lastActiveAt: 100, modelId: 'openai/gpt-4', tokenCount: 0 },
    ],
  }
  store.setGroups([group])
  return store
}

describe('sessionStore.updateSessionState', () => {
  it('U11: 更新 modelId，其余字段不变', () => {
    const store = seedSession()
    store.updateSessionState('s1', { modelId: 'anthropic/claude-4' })
    const s1 = store.list.find((s) => s.id === 's1')
    expect(s1?.modelId).toBe('anthropic/claude-4')
    expect(s1?.thinkingLevel).toBe('medium') // 不变
    expect(s1?.label).toBe('test') // 不变
  })

  it('U12: 未知 sessionId 不抛错，groups 不变', () => {
    const store = seedSession()
    expect(() => store.updateSessionState('ghost', { modelId: 'x/y' })).not.toThrow()
    expect(store.list.length).toBe(2)
    expect(store.list.find((s) => s.id === 's1')?.modelId).toBe('old/x')
  })

  it('U13: 只更新 thinkingLevel，modelId 不变', () => {
    const store = seedSession()
    store.updateSessionState('s1', { thinkingLevel: 'max' })
    const s1 = store.list.find((s) => s.id === 's1')
    expect(s1?.thinkingLevel).toBe('max')
    expect(s1?.modelId).toBe('old/x') // 不变
  })

  it('thinkingLevel 为 undefined 时不更新（保留旧值）', () => {
    const store = seedSession()
    store.updateSessionState('s1', { modelId: 'anthropic/claude-4', thinkingLevel: undefined })
    const s1 = store.list.find((s) => s.id === 's1')
    expect(s1?.modelId).toBe('anthropic/claude-4')
    expect(s1?.thinkingLevel).toBe('medium') // undefined 跳过，保留旧值
  })
})
