import { describe, it, expect, beforeEach } from 'vitest'
import {
  markUnread,
  clearUnread,
  isUnread,
  toggleMarkedDone,
  isMarkedDone,
  clearAll,
  __registerCleanupForTest,
} from '../useSessionMarkers'
import { triggerSessionCleanups, __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'

const STORAGE_KEY = 'xyz-agent:session-markers'

beforeEach(() => {
  localStorage.clear()
  __clearSessionCleanupRegistryForTest()
  __registerCleanupForTest()
})

describe('useSessionMarkers', () => {
  it('markUnread + isUnread', () => {
    expect(isUnread('s1')).toBe(false)
    markUnread('s1')
    expect(isUnread('s1')).toBe(true)
  })

  it('clearUnread', () => {
    markUnread('s1')
    clearUnread('s1')
    expect(isUnread('s1')).toBe(false)
  })

  it('toggleMarkedDone 双向切换', () => {
    expect(isMarkedDone('s1')).toBe(false)
    toggleMarkedDone('s1')
    expect(isMarkedDone('s1')).toBe(true)
    toggleMarkedDone('s1')
    expect(isMarkedDone('s1')).toBe(false)
  })

  it('标记完成时自动清除 unread', () => {
    markUnread('s1')
    expect(isUnread('s1')).toBe(true)
    toggleMarkedDone('s1')
    expect(isMarkedDone('s1')).toBe(true)
    expect(isUnread('s1')).toBe(false)
  })

  it('数据写入 localStorage，可读回', () => {
    markUnread('s1')
    toggleMarkedDone('s2')
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored.s1?.unread).toBe(true)
    expect(stored.s2?.markedDone).toBe(true)
  })

  it('triggerSessionCleanups 清除该 sid 条目', () => {
    markUnread('s1')
    toggleMarkedDone('s1')
    triggerSessionCleanups('s1')
    expect(isUnread('s1')).toBe(false)
    expect(isMarkedDone('s1')).toBe(false)
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored.s1).toBeUndefined()
  })

  it('clearAll 直接清除', () => {
    markUnread('s1')
    toggleMarkedDone('s1')
    clearAll('s1')
    expect(isUnread('s1')).toBe(false)
    expect(isMarkedDone('s1')).toBe(false)
  })

  it('两个标记都清空后移除整个条目（不残留空对象）', () => {
    markUnread('s1')
    clearUnread('s1')
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored.s1).toBeUndefined()
  })

  it('storage 事件触发后内存缓存更新', () => {
    expect(isUnread('s1')).toBe(false)
    const newData = JSON.stringify({ s1: { unread: true } })
    window.dispatchEvent(new StorageEvent('storage', {
      key: STORAGE_KEY,
      newValue: newData,
    }))
    expect(isUnread('s1')).toBe(true)
  })
})
