/**
 * createSessionStore 单测（IF1）。
 *
 * 覆盖 plan TC-1..TC-6：list 派生 / appendSession 归组 / removeFromList 回退与空组移除 /
 * applySnapshot 合并语义（D1b）/ markDead+revive / listLoadError+active 派生。
 * W13 三写入口（setGroups/updateLabel/updateSessionState）收敛为 applySnapshot 后，
 * 合并规则用例三组：整字段覆盖 / 显式空值覆盖 / 乐观更新形态。
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
  it('TC-1: applySnapshot 整表形态 → list 派生（flatMap 展平、顺序保持、跟随更新）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', cwd: '/a' })
    const s2 = makeSession({ id: 's2', cwd: '/a' })
    const s3 = makeSession({ id: 's3', cwd: '/b' })

    store.applySnapshot({
      groups: [
        { cwd: '/a', sessions: [s1, s2] },
        { cwd: '/b', sessions: [s3] },
      ],
    })
    expect(store.list.value.map((s) => s.id)).toEqual(['s1', 's2', 's3'])

    // 整表快照换新数组后 list 同步变化（响应性，非一次性快照）
    store.applySnapshot({ groups: [{ cwd: '/b', sessions: [s3] }] })
    expect(store.list.value.map((s) => s.id)).toEqual(['s3'])
  })

  it('TC-2: appendSession 按 cwd 归组（命中入尾 / 新建组在末尾）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', cwd: '/a' })
    const s2 = makeSession({ id: 's2', cwd: '/a' })
    const s3 = makeSession({ id: 's3', cwd: '/c' })

    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })
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
    store.applySnapshot({
      groups: [
        { cwd: '/a', sessions: [s1, s2] },
        { cwd: '/b', sessions: [s3] },
      ],
    })
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

  it('TC-4: applySnapshot 单 session 快照 undefined 跳过、未知 id 静默', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', label: 'old', modelId: 'm1', thinkingLevel: 'medium' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    store.applySnapshot('s1', { label: '新名' })
    expect(store.list.value[0].label).toBe('新名')

    // 快照未涉及的字段（undefined）保留现值：只给 modelId，thinkingLevel 不变
    store.applySnapshot('s1', { modelId: 'm2' })
    expect(store.list.value[0].modelId).toBe('m2')
    expect(store.list.value[0].thinkingLevel).toBe('medium')

    store.applySnapshot('s1', { thinkingLevel: 'low' })
    expect(store.list.value[0].modelId).toBe('m2')
    expect(store.list.value[0].thinkingLevel).toBe('low')

    // 未知 id 静默无副作用
    store.applySnapshot('nope', { modelId: 'm3', label: 'x' })
    expect(store.list.value[0].modelId).toBe('m2')
    expect(store.list.value[0].label).toBe('新名')
  })

  it('TC-4a: D1b 合并规则——owner 快照整字段覆盖（多字段一次到位）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', label: 'old', modelId: 'm1', thinkingLevel: 'low', tokenCount: 10 })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    // state_changed 广播形态：modelId + thinkingLevel 同帧整字段覆盖
    store.applySnapshot('s1', { modelId: 'm2', thinkingLevel: 'high' })
    const after = store.list.value[0]
    expect(after.modelId).toBe('m2')
    expect(after.thinkingLevel).toBe('high')
    // 未涉及字段保留
    expect(after.label).toBe('old')
    expect(after.tokenCount).toBe(10)

    // status 也走同一合并路径（session.exited 类状态迁移）
    store.applySnapshot('s1', { status: 'dead' })
    expect(store.list.value[0].status).toBe('dead')
  })

  it('TC-4b: D1b 合并规则——显式空值覆盖（owner 声明空即空，不保留旧真值）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', modelId: 'm1', thinkingLevel: 'high', tokenCount: 100 })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    // owner 快照显式给空串/0 → 覆盖（与旧 patch 语义的差异点即在此：
    // 磁盘扫描占位值的空守卫归 W15 挂点，不在本 wave 合并策略内）
    store.applySnapshot('s1', { modelId: '', thinkingLevel: '', tokenCount: 0 })
    const after = store.list.value[0]
    expect(after.modelId).toBe('')
    expect(after.thinkingLevel).toBe('')
    expect(after.tokenCount).toBe(0)
  })

  it('TC-4c: 乐观更新形态——本地入参只带乐观字段，权威广播回流幂等收敛', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', label: '旧名', modelId: 'm1' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

    // rename 乐观更新：applySnapshot 本地入参只带 label，UI 即时显示
    store.applySnapshot('s1', { label: '乐观名' })
    expect(store.list.value[0].label).toBe('乐观名')

    // config.sessions 权威整表回流：同一入口覆盖为 runtime 真值（重复写入幂等）
    const authoritative = makeSession({ id: 's1', label: '权威名', modelId: 'm1' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [authoritative] }] })
    expect(store.list.value[0].label).toBe('权威名')

    // switchModel 乐观更新：单字段快照立即生效，不依赖 state_changed 广播
    store.applySnapshot('s1', { modelId: 'provider/m9' })
    expect(store.list.value[0].modelId).toBe('provider/m9')
    // state_changed 广播随后到达，同值收敛（幂等）
    store.applySnapshot('s1', { modelId: 'provider/m9', thinkingLevel: 'max' })
    expect(store.list.value[0].modelId).toBe('provider/m9')
    expect(store.list.value[0].thinkingLevel).toBe('max')
  })

  it('TC-5: markDead / revive 状态切换（revive 仅 dead→idle）', () => {
    const store = createSessionStore()
    const s1 = makeSession({ id: 's1', status: 'idle' })
    const s2 = makeSession({ id: 's2', status: 'active' })
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1, s2] }] })

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
    store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })
    expect(store.active.value).toBeNull() // activeId 未设

    store.activeId.value = 's1'
    expect(store.active.value?.id).toBe('s1')

    store.activeId.value = 'ghost'
    expect(store.active.value).toBeNull() // 未命中
  })
})
