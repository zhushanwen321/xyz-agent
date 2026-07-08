/**
 * sessionStore.markDead / revive 单测 —— 进程退出后的 dead 态管理。
 *
 * 锁定 R7（退出的 session 仍可点击，触发 restore→再崩溃循环）。
 * dead 态约束：
 *   - markDead：status 置 'dead'，侧栏置灰，panel 显示占位
 *   - revive：仅 dead→idle，非 dead 态不受影响（防止误改 active 态）
 *   - 未知 sessionId 为 no-op（不抛错）
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/stores/session-store-dead-revive.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionGroup } from '@xyz-agent/shared'

import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
})

function seedIdleStore(): ReturnType<typeof useSessionStore> {
  const store = useSessionStore()
  const group: SessionGroup = {
    cwd: '/repo',
    sessions: [
      { id: 's1', label: 'idle-session', cwd: '/repo', status: 'idle', lastActiveAt: 100, modelId: 'm/x', tokenCount: 0 },
      { id: 's2', label: 'active-session', cwd: '/repo', status: 'active', lastActiveAt: 200, modelId: 'm/y', tokenCount: 0 },
    ],
  }
  store.setGroups([group])
  return store
}

describe('sessionStore.markDead', () => {
  it('idle session 标记为 dead', () => {
    const store = seedIdleStore()
    store.markDead('s1')
    expect(store.list.find((s) => s.id === 's1')?.status).toBe('dead')
  })

  it('active session 标记为 dead（流式中进程崩溃的场景）', () => {
    const store = seedIdleStore()
    store.markDead('s2')
    expect(store.list.find((s) => s.id === 's2')?.status).toBe('dead')
  })

  it('未知 sessionId 为 no-op（不抛错，列表不变）', () => {
    const store = seedIdleStore()
    expect(() => store.markDead('ghost')).not.toThrow()
    expect(store.list.length).toBe(2)
    expect(store.list.every((s) => s.status !== 'dead')).toBe(true)
  })

  it('只改目标 session，其余 session 状态不变', () => {
    const store = seedIdleStore()
    store.markDead('s1')
    expect(store.list.find((s) => s.id === 's1')?.status).toBe('dead')
    expect(store.list.find((s) => s.id === 's2')?.status).toBe('active')
  })
})

describe('sessionStore.revive', () => {
  it('dead session 重置为 idle', () => {
    const store = seedIdleStore()
    store.markDead('s1')
    expect(store.list.find((s) => s.id === 's1')?.status).toBe('dead')

    store.revive('s1')
    expect(store.list.find((s) => s.id === 's1')?.status).toBe('idle')
  })

  it('非 dead 态不受 revive 影响（防止误改 active）', () => {
    const store = seedIdleStore()
    // s2 是 active，revive 应 no-op
    store.revive('s2')
    expect(store.list.find((s) => s.id === 's2')?.status).toBe('active')
  })

  it('未知 sessionId 为 no-op', () => {
    const store = seedIdleStore()
    expect(() => store.revive('ghost')).not.toThrow()
    expect(store.list.length).toBe(2)
  })
})
