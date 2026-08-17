/**
 * createSessionStore 单测（IF1）。
 *
 * 覆盖 plan TC-1..TC-6：list 派生 / appendSession 归组 / removeFromList 回退与空组移除 /
 * updateLabel+updateSessionState patch 语义 / markDead+revive / listLoadError+active 派生。
 * node 环境实测 vue reactivity（ref/computed），零 mock。
 */
import { describe, expect, it } from 'vitest'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'
import { createSessionStore } from '../store'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    label: overrides.id,
    cwd: '/work/a',
    status: 'idle',
    lastActiveAt: 0,
    modelId: '',
    tokenCount: 0,
    ...overrides,
  }
}

describe('createSessionStore', () => {
  it('TC-1: setGroups → list 派生（flatMap 展平、顺序保持、跟随更新）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', cwd: '/a' })
    const s2 = makeSession({ id: 's2', cwd: '/a' })
    const s3 = makeSession({ id: 's3', cwd: '/b' })

    store.setGroups([
      { cwd: '/a', sessions: [s1, s2] },
      { cwd: '/b', sessions: [s3] },
    ])
    expect(store.list.value.map((s) => s.id)).toEqual(['s1', 's2', 's3'])

    // setGroups 换新数组后 list 同步变化（响应性，非一次性快照）
    store.setGroups([{ cwd: '/b', sessions: [s3] }])
    expect(store.list.value.map((s) => s.id)).toEqual(['s3'])
  })

  it('TC-2: appendSession 按 cwd 归组（命中入尾 / 新建组在末尾）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', cwd: '/a' })
    const s2 = makeSession({ id: 's2', cwd: '/a' })
    const s3 = makeSession({ id: 's3', cwd: '/c' })

    store.setGroups([{ cwd: '/a', sessions: [s1] }])
    store.appendSession(s2)
    expect(store.groups.value).toEqual([{ cwd: '/a', sessions: [s1, s2] }])

    // 未命中 cwd → 新建组追加在末尾，原组顺序不变
    store.appendSession(s3)
    expect(store.groups.value.map((g) => g.cwd)).toEqual(['/a', '/c'])
    expect(store.groups.value[1].sessions.map((s) => s.id)).toEqual(['s3'])
  })

  it('TC-3: removeFromList 删 active 回退 list[0]、空组移除、删非 active 不影响 activeId', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', cwd: '/a' })
    const s2 = makeSession({ id: 's2', cwd: '/a' })
    const s3 = makeSession({ id: 's3', cwd: '/b' })
    store.setGroups([
      { cwd: '/a', sessions: [s1, s2] },
      { cwd: '/b', sessions: [s3] },
    ])
    store.activeId.value = 's2'

    // 删 active → 回退删除后 list[0]（s1）
    store.removeFromList('s2')
    expect(store.activeId.value).toBe('s1')
    expect(store.groups.value).toEqual([{ cwd: '/a', sessions: [s1] }, { cwd: '/b', sessions: [s3] }])

    // 删非 active → activeId 不变
    store.removeFromList('s3')
    expect(store.activeId.value).toBe('s1')

    // 删空组：删 s1 后 /a 组清空 → 组移除，仅剩 /b 空组？/b 已删 s3 为空——应被整体移除
    store.removeFromList('s1')
    expect(store.groups.value).toEqual([])
    expect(store.activeId.value).toBeNull()
  })

  it('TC-4: updateLabel / updateSessionState patch 语义（undefined 跳过、未知 id 静默）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', label: 'old', modelId: 'm1', thinkingLevel: 'medium' })
    store.setGroups([{ cwd: '/a', sessions: [s1] }])

    store.updateLabel('s1', '新名')
    expect(store.list.value[0].label).toBe('新名')

    // patch undefined 跳过：只更新 modelId，thinkingLevel 不变
    store.updateSessionState('s1', { modelId: 'm2' })
    expect(store.list.value[0].modelId).toBe('m2')
    expect(store.list.value[0].thinkingLevel).toBe('medium')

    store.updateSessionState('s1', { thinkingLevel: 'low' })
    expect(store.list.value[0].modelId).toBe('m2')
    expect(store.list.value[0].thinkingLevel).toBe('low')

    // 未知 id 静默无副作用
    store.updateLabel('nope', 'x')
    store.updateSessionState('nope', { modelId: 'm3' })
    expect(store.list.value[0].modelId).toBe('m2')
    expect(store.list.value[0].label).toBe('新名')
  })

  it('TC-5: markDead / revive 状态切换（revive 仅 dead→idle）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', status: 'idle' })
    const s2 = makeSession({ id: 's2', status: 'active' })
    store.setGroups([{ cwd: '/a', sessions: [s1, s2] }])

    store.markDead('s1')
    expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('dead')
    // 已是 dead 再 markDead 保持 dead
    store.markDead('s1')
    expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('dead')

    store.revive('s1')
    expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('idle')

    // 非 dead（active）revive 无副作用
    store.revive('s2')
    expect(store.list.value.find((s) => s.id === 's2')?.status).toBe('active')

    // 未知 id 静默
    store.markDead('nope')
    store.revive('nope')
    expect(store.list.value.length).toBe(2)
  })

  it('TC-6: listLoadError set/清空 + active 按 activeId 派生', () => {
    const store = createSessionStore()
    expect(store.listLoadError.value).toBeNull()

    store.setListLoadError('加载失败，点击重试')
    expect(store.listLoadError.value).toBe('加载失败，点击重试')

    store.setListLoadError(null)
    expect(store.listLoadError.value).toBeNull()

    // active 派生
    const s1 = makeSession({ id: 's1' })
    store.setGroups([{ cwd: '/a', sessions: [s1] }])
    expect(store.active.value).toBeNull() // activeId 未设

    store.activeId.value = 's1'
    expect(store.active.value?.id).toBe('s1')

    store.activeId.value = 'ghost'
    expect(store.active.value).toBeNull() // 未命中
  })
})
