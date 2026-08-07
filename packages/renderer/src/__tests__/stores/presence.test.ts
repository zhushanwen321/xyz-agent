/**
 * Presence store 测试（P5 lease/presence）。
 *
 * 覆盖：
 * - setConnections 全量替换 connections
 * - 初始空数组
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/presence.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { usePresenceStore } from '@/stores/presence'
import type { PresenceConnection } from '@xyz-agent/shared'

describe('presence store（P5 全量替换）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('初始 connections 为空数组', () => {
    const store = usePresenceStore()
    expect(store.connections).toEqual([])
  })

  it('setConnections 全量替换', () => {
    const store = usePresenceStore()
    const list: PresenceConnection[] = [
      { clientId: 'A', deviceName: 'Mac', activeSessionId: 's1', isOperating: true },
      { clientId: 'B', deviceName: 'Phone', activeSessionId: null, isOperating: false },
    ]
    store.setConnections(list)
    expect(store.connections).toEqual(list)

    // 再次替换（非合并）
    const list2: PresenceConnection[] = [
      { clientId: 'C', deviceName: 'Tablet', activeSessionId: null, isOperating: false },
    ]
    store.setConnections(list2)
    expect(store.connections).toEqual(list2)
  })
})
