/**
 * createUseSession 行为测试（IF4 / DM2 / ES1-2 语义锁定，w3）。
 *
 * 锁定 createUseSession(deps) factory 产物的纯编排行为（不经 renderer 壳）：
 * selectSession 全编排 / 失败不更新 activeId / hydrate 失败消化、deleteSession S3 全 hooks
 * 调用序 + ES1 fallback、deleteFolder wasActiveInFolder 回退、loadSessions 成功/失败（ES2）、
 * retryHistory 双分支、newSession 延迟 create 三分支、rename/syncSessionToPanel、refCount 订阅去重。
 *
 * 模式（对齐 chat 域 useChat.test.ts）：effectScope + 真实 createSessionStore（w1 交付，
 * 编排终态断言需真实响应式）+ mock deps（api/panel/navigation/chat/hooks/flow 全 vi.fn）。
 * 调用序断言用 invocation log 数组（S3 全序可读）。beforeEach 调 resetSessionListSubForTest()
 * 清模块级订阅计数（跨用例隔离）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { SessionGroup, SessionSummary, BatchDeleteResult } from '@xyz-agent/shared'
import { createSessionStore } from '../store'
import { createUseSession, resetSessionListSubForTest } from '../use-session'
import type { UseSessionDeps, SessionCleanupHooks, ChatHydratePort } from '../use-session'

/** 构造 SessionSummary 最小形状（类型收窄后字段由测试按需给全） */
function summary(id: string, cwd = '/a'): SessionSummary {
  return { id, label: `label-${id}`, cwd, status: 'idle', lastActiveAt: 1, modelId: '' }
}

function makeHooks(log: string[]): SessionCleanupHooks & Record<string, ReturnType<typeof vi.fn>> {
  const names = [
    'clearFileTree', 'clearSubagent', 'clearWorkflow',
    'clearExtensionUI', 'clearExtensionHost', 'evictChat', 'evictVirtualKeys',
    'clearAgentCallMapping', 'disposeChat', 'invalidateStatus',
  ] as const
  const hooks = {} as SessionCleanupHooks & Record<string, ReturnType<typeof vi.fn>>
  for (const n of names) {
    hooks[n] = vi.fn((...args: unknown[]) => log.push(`${n}(${args.join(',')})`))
  }
  return hooks
}

interface Fixture {
  session: ReturnType<typeof createUseSession>
  store: ReturnType<typeof createSessionStore>
  api: {
    list: ReturnType<typeof vi.fn>
    switchSession: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    rename: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
    removeByCwd: ReturnType<typeof vi.fn>
    migrateImage: ReturnType<typeof vi.fn>
    onConfigSessions: ReturnType<typeof vi.fn>
  }
  panel: {
    focusedSessionId: ReturnType<typeof vi.fn>
    activePanelId: ReturnType<typeof vi.fn>
    findPanelBySession: ReturnType<typeof vi.fn>
    loadSession: ReturnType<typeof vi.fn>
    openPanel: ReturnType<typeof vi.fn>
  }
  navigation: { push: ReturnType<typeof vi.fn> }
  chat: {
    getHistory: ReturnType<typeof vi.fn>
    isHydrated: ReturnType<typeof vi.fn>
    hydrate: ReturnType<typeof vi.fn>
    setHistoryTruncated: ReturnType<typeof vi.fn>
    clearHistoryError: ReturnType<typeof vi.fn>
    markHistoryFailed: ReturnType<typeof vi.fn>
  }
  flow: { startFlow: ReturnType<typeof vi.fn>; currentSession: ReturnType<typeof vi.fn> }
  hooks: SessionCleanupHooks & Record<string, ReturnType<typeof vi.fn>>
  log: string[]
  dispose: () => void
}

function makeFixture(opts: { withFlow?: boolean } = {}): Fixture {
  const scope = effectScope(true)
  const log: string[] = []
  const store = scope.run(() => createSessionStore())!
  const api = {
    list: vi.fn().mockResolvedValue([]),
    switchSession: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    rename: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    removeByCwd: vi.fn().mockResolvedValue({ cwd: '/a', deleted: [], failed: [] } as BatchDeleteResult),
    migrateImage: vi.fn(),
    onConfigSessions: vi.fn(() => vi.fn()),
  }
  const panel = {
    focusedSessionId: vi.fn(() => null),
    activePanelId: vi.fn(() => 'p1'),
    findPanelBySession: vi.fn(() => null),
    loadSession: vi.fn(),
    openPanel: vi.fn(),
  }
  const navigation = { push: vi.fn() }
  const chat = {
    getHistory: vi.fn().mockResolvedValue({ messages: [], historyTruncated: false }),
    isHydrated: vi.fn(() => false),
    hydrate: vi.fn(),
    reconcileHistory: vi.fn(),
    setHistoryTruncated: vi.fn(),
    clearHistoryError: vi.fn(),
    markHistoryFailed: vi.fn(),
  }
  const flow = { startFlow: vi.fn().mockResolvedValue(undefined), currentSession: vi.fn(() => null) }
  const hooks = makeHooks(log)
  const deps: UseSessionDeps = {
    store, api, panel, navigation, chat, hooks,
    ...(opts.withFlow ? { flow } : {}),
  }
  const session = scope.run(() => createUseSession(deps))!
  return { session, store, api, panel, navigation, chat, flow, hooks, log, dispose: () => scope.stop() }
}

/** 组装分组（applySnapshot 整表形态后 store.list 派生） */
function seed(store: Fixture['store'], groups: SessionGroup[]): void {
  store.applySnapshot({ groups })
}

describe('selectSession', () => {
  it('TC-1 成功：switchSession→activeId→hydrate→syncSessionToPanel→push', async () => {
    const f = makeFixture()
    const msgs = [{ id: 'm1' } as never]
    f.chat.getHistory.mockResolvedValue({ messages: msgs, historyTruncated: true })
    await f.session.selectSession('sid-1')

    expect(f.api.switchSession).toHaveBeenCalledTimes(1)
    expect(f.api.switchSession).toHaveBeenCalledWith('sid-1')
    expect(f.store.activeId.value).toBe('sid-1')
    // hydrate 链路（后台 session reconcile：未 hydrate 分支走 reconcileHistory，等价 hydrate）
    expect(f.chat.isHydrated).toHaveBeenCalledWith('sid-1')
    expect(f.chat.getHistory).toHaveBeenCalledTimes(1)
    expect(f.chat.reconcileHistory).toHaveBeenCalledWith('sid-1', msgs)
    expect(f.chat.setHistoryTruncated).toHaveBeenCalledWith('sid-1', true)
    expect(f.chat.clearHistoryError).toHaveBeenCalledWith('sid-1')
    // panel 载入（经 activePanelId 端口）
    expect(f.panel.activePanelId).toHaveBeenCalled()
    expect(f.panel.loadSession).toHaveBeenCalledWith('p1', 'sid-1')
    // 导航
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat', sessionId: 'sid-1' })
    f.dispose()
  })

  it('TC-2 失败：switchSession reject → activeId 不更新 + 异常上抛 + 后续编排短路', async () => {
    const f = makeFixture()
    f.api.switchSession.mockRejectedValue(new Error('not found'))
    seed(f.store, [{ cwd: '/a', sessions: [summary('other')] }])
    f.store.activeId.value = 'other'

    await expect(f.session.selectSession('ghost')).rejects.toThrow('not found')
    expect(f.store.activeId.value).toBe('other')
    expect(f.chat.reconcileHistory).not.toHaveBeenCalled()
    expect(f.panel.loadSession).not.toHaveBeenCalled()
    expect(f.navigation.push).not.toHaveBeenCalled()
    f.dispose()
  })

  it('TC-3 hydrate 失败：getHistory reject → markHistoryFailed + 不抛 + activeId 已更新', async () => {
    const f = makeFixture()
    f.chat.getHistory.mockRejectedValue(new Error('io'))
    await expect(f.session.selectSession('sid-1')).resolves.toBeUndefined()
    expect(f.chat.markHistoryFailed).toHaveBeenCalledWith('sid-1')
    expect(f.store.activeId.value).toBe('sid-1')
    expect(f.panel.loadSession).toHaveBeenCalledWith('p1', 'sid-1')
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat', sessionId: 'sid-1' })
    f.dispose()
  })

  it('已 hydrate 的 session 切入时静默刷新（后台 session reconcile，2026-08-22）', async () => {
    const f = makeFixture()
    const msgs = [{ id: 'm2' } as never]
    f.chat.isHydrated.mockReturnValue(true)
    f.chat.getHistory.mockResolvedValue({ messages: msgs, historyTruncated: false })
    await f.session.selectSession('sid-1')
    // 旧幂等守卫已废：后台（agent-managed）session 的 turn 可能在前端不在场时完成，
    // 切入必须刷新到最新 entries；失败静默（旧数据仍在，下次切入重试）
    expect(f.chat.getHistory).toHaveBeenCalledTimes(1)
    expect(f.chat.reconcileHistory).toHaveBeenCalledWith('sid-1', msgs)
    expect(f.chat.markHistoryFailed).not.toHaveBeenCalled()
    expect(f.store.activeId.value).toBe('sid-1')
    f.dispose()
  })
})

describe('deleteSession', () => {
  beforeEach(() => {
    resetSessionListSubForTest()
  })

  it('TC-4 S3 全 hooks 调用序：panel 解绑→removeFromList→10 hooks→triggerSessionCleanups', async () => {
    const f = makeFixture()
    seed(f.store, [{ cwd: '/a', sessions: [summary('del')] }])
    f.store.activeId.value = 'del'
    f.panel.findPanelBySession.mockReturnValue({ type: 'panel', id: 'p1', sessionId: 'del' })

    await f.session.deleteSession('del')

    // panel 解绑（[U7] overlay 兜底清理已随 overlay 移除）
    expect(f.panel.loadSession).toHaveBeenCalledWith('p1', null)
    // removeFromList 生效（列表空）
    expect(f.store.list.value).toHaveLength(0)
    // 删 active 后列表空 → push chat 空态
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat' })
    // S3 全序（log 数组精确顺序断言）
    const expectedOrder = [
      'clearFileTree(del)', 'clearSubagent(del)', 'clearWorkflow(del)',
      'clearExtensionUI(del)', 'clearExtensionHost(del)', 'evictChat(del)',
      'evictVirtualKeys(del)', 'clearAgentCallMapping(del)', 'disposeChat(del)', 'invalidateStatus(del)',
    ]
    expect(f.log).toEqual(expectedOrder)
    // M1-03：extension-host 分区清理钩子被调用（壳层实现 emit session-destroyed）
    expect(f.hooks.clearExtensionHost).toHaveBeenCalledWith('del')
    f.dispose()
  })

  it('TC-5 ES1 fallback：删 active 后 selectSession(next) reject → push({view:chat})，不抛', async () => {
    const f = makeFixture()
    seed(f.store, [{ cwd: '/a', sessions: [summary('a'), summary('b')] }])
    f.store.activeId.value = 'a'
    // 回退 selectSession('b') 的 switchSession 失败（网络抖动）
    f.api.switchSession.mockRejectedValue(new Error('net'))

    await expect(f.session.deleteSession('a')).resolves.toBeUndefined()
    // cleanup 后 activeId 回退到 list[0]（removeFromList 语义）
    expect(f.store.activeId.value).toBe('b')
    // selectSession('b') 失败 → ES1 fallback push chat 空态
    expect(f.api.switchSession).toHaveBeenCalledWith('b')
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat' })
    f.dispose()
  })

  it('TC-6 非 active 删除：无回退（selectSession 未调）+ 仍走 cleanup', async () => {
    const f = makeFixture()
    seed(f.store, [{ cwd: '/a', sessions: [summary('a'), summary('b')] }])
    f.store.activeId.value = 'a'

    await f.session.deleteSession('b')
    expect(f.store.activeId.value).toBe('a')
    expect(f.api.switchSession).not.toHaveBeenCalled()
    expect(f.navigation.push).not.toHaveBeenCalled()
    expect(f.hooks.clearFileTree).toHaveBeenCalledWith('b')
    expect(f.hooks.disposeChat).toHaveBeenCalledWith('b')
    f.dispose()
  })
})

describe('deleteFolder', () => {
  it('TC-7 wasActiveInFolder 回退：逐个 cleanup + selectSession(list[0]) + 返回值透传', async () => {
    const f = makeFixture()
    seed(f.store, [
      { cwd: '/a', sessions: [summary('a1'), summary('a2')] },
      { cwd: '/b', sessions: [summary('b1', '/b')] },
    ])
    f.store.activeId.value = 'a1'
    const res: BatchDeleteResult = { cwd: '/a', deleted: ['a1', 'a2'], failed: [] }
    f.api.removeByCwd.mockResolvedValue(res)

    const returned = await f.session.deleteFolder('/a')
    expect(returned).toBe(res)
    // 逐个 cleanup（a1、a2 各一轮）
    expect(f.hooks.clearFileTree).toHaveBeenCalledTimes(2)
    expect(f.hooks.clearFileTree).toHaveBeenCalledWith('a1')
    expect(f.hooks.clearFileTree).toHaveBeenCalledWith('a2')
    expect(f.hooks.disposeChat).toHaveBeenCalledTimes(2)
    // activeId 回退到列表首项 'b1'，selectSession 衔接
    expect(f.store.activeId.value).toBe('b1')
    expect(f.api.switchSession).toHaveBeenCalledWith('b1')
    f.dispose()
  })

  it('active 不在 folder：无回退，仅 cleanup', async () => {
    const f = makeFixture()
    seed(f.store, [
      { cwd: '/a', sessions: [summary('a1')] },
      { cwd: '/b', sessions: [summary('b1', '/b')] },
    ])
    f.store.activeId.value = 'b1'
    f.api.removeByCwd.mockResolvedValue({ cwd: '/a', deleted: ['a1'], failed: [] })

    await f.session.deleteFolder('/a')
    expect(f.store.activeId.value).toBe('b1')
    expect(f.api.switchSession).not.toHaveBeenCalled()
    expect(f.navigation.push).not.toHaveBeenCalled()
    expect(f.hooks.clearFileTree).toHaveBeenCalledWith('a1')
    f.dispose()
  })
})

describe('loadSessions / retryHistory / renameSession / syncSessionToPanel', () => {
  it('TC-8 loadSessions 成功：applySnapshot 整表 + setListLoadError(null)', async () => {
    const f = makeFixture()
    const groups = [{ cwd: '/a', sessions: [summary('s1')] }]
    f.api.list.mockResolvedValue(groups)
    f.store.setListLoadError('stale')
    await f.session.loadSessions()
    expect(f.store.groups.value).toEqual(groups)
    expect(f.store.listLoadError.value).toBeNull()
    f.dispose()
  })

  it('TC-9 loadSessions 失败（ES2/S5）：setListLoadError(msg) + 不抛', async () => {
    const f = makeFixture()
    f.api.list.mockRejectedValue(new Error('conn lost'))
    seed(f.store, [{ cwd: '/a', sessions: [summary('s1')] }])
    await expect(f.session.loadSessions()).resolves.toBeUndefined()
    expect(f.store.listLoadError.value).toBe('conn lost')
    expect(f.store.list.value).toHaveLength(1)
    f.dispose()
  })

  it('TC-11 retryHistory 成功：clearHistoryError→getHistory→hydrate→setHistoryTruncated', async () => {
    const f = makeFixture()
    const msgs = [{ id: 'm1' } as never]
    f.chat.getHistory.mockResolvedValue({ messages: msgs, historyTruncated: false })
    await f.session.retryHistory('s1')
    expect(f.chat.clearHistoryError).toHaveBeenCalledWith('s1')
    expect(f.chat.getHistory).toHaveBeenCalledWith('s1')
    expect(f.chat.reconcileHistory).toHaveBeenCalledWith('s1', msgs)
    expect(f.chat.setHistoryTruncated).toHaveBeenCalledWith('s1', false)
    expect(f.chat.markHistoryFailed).not.toHaveBeenCalled()
    f.dispose()
  })

  it('TC-11 retryHistory 失败：markHistoryFailed + 不抛', async () => {
    const f = makeFixture()
    f.chat.getHistory.mockRejectedValue(new Error('io'))
    await expect(f.session.retryHistory('s1')).resolves.toBeUndefined()
    expect(f.chat.markHistoryFailed).toHaveBeenCalledWith('s1')
    f.dispose()
  })

  it('TC-13 renameSession：api.rename + 乐观更新 applySnapshot(label)', async () => {
    const f = makeFixture()
    seed(f.store, [{ cwd: '/a', sessions: [summary('s1')] }])
    await f.session.renameSession('s1', '新名字')
    expect(f.api.rename).toHaveBeenCalledWith('s1', '新名字')
    expect(f.store.list.value[0]!.label).toBe('新名字')
    f.dispose()
  })

  it('TC-13 syncSessionToPanel：loadSession(activePanelId, sessionId)', () => {
    const f = makeFixture()
    f.panel.activePanelId.mockReturnValue('p9')
    f.session.syncSessionToPanel('s1')
    expect(f.panel.loadSession).toHaveBeenCalledWith('p9', 's1')
    f.dispose()
  })
})

describe('newSession（延迟 create 语义）', () => {
  it('TC-12 currentSession null → push chat + 返回 null（延迟 create 路径）', async () => {
    const f = makeFixture({ withFlow: true })
    const result = await f.session.newSession()
    expect(result).toBeNull()
    expect(f.flow.startFlow).toHaveBeenCalledTimes(1)
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat' })
    expect(f.api.switchSession).not.toHaveBeenCalled()
    f.dispose()
  })

  it('TC-12 flow 产出 session → selectSession(created.id) + 返回 id', async () => {
    const f = makeFixture({ withFlow: true })
    f.flow.currentSession.mockReturnValue(summary('new1'))
    const result = await f.session.newSession('/b')
    expect(result).toBe('new1')
    expect(f.flow.startFlow).toHaveBeenCalledWith('/b')
    expect(f.api.switchSession).toHaveBeenCalledWith('new1')
    expect(f.store.activeId.value).toBe('new1')
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat', sessionId: 'new1' })
    f.dispose()
  })

  it('TC-12 in-flight 守卫：未 resolve 时二次调用直接返回 null', async () => {
    const f = makeFixture({ withFlow: true })
    let release!: () => void
    f.flow.startFlow.mockImplementation(() => new Promise<void>((r) => { release = r }))
    const first = f.session.newSession()
    const second = await f.session.newSession()
    expect(second).toBeNull()
    expect(f.flow.startFlow).toHaveBeenCalledTimes(1)
    release()
    await first
    f.dispose()
  })

  it('flow 未接线（deps.flow 缺省）：返回 null 降级', async () => {
    const f = makeFixture()
    const result = await f.session.newSession()
    expect(result).toBeNull()
    expect(f.navigation.push).not.toHaveBeenCalled()
    f.dispose()
  })
})

describe('bindSessionListBroadcast refCount', () => {
  beforeEach(() => {
    resetSessionListSubForTest()
  })

  it('TC-10 多实例只订阅一次；全销毁后 unsub 一次；handler emit 触发 applySnapshot 整表', async () => {
    const unsub = vi.fn()
    let capturedHandler: ((groups: SessionGroup[]) => void) | null = null
    const scopeA = effectScope(true)
    const scopeB = effectScope(true)
    const storeA = scopeA.run(() => createSessionStore())!
    const storeB = scopeB.run(() => createSessionStore())!
    const apiA = {
      list: vi.fn().mockResolvedValue([]),
      switchSession: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(), rename: vi.fn(), remove: vi.fn(),
      removeByCwd: vi.fn(), migrateImage: vi.fn(),
      onConfigSessions: vi.fn((h: (g: SessionGroup[]) => void) => {
        capturedHandler = h
        return unsub
      }),
    }
    const baseDepsA = { store: storeA, api: apiA, panel: makePanel(), navigation: { push: vi.fn() }, chat: makeChat(), hooks: makeHooks([]) }
    const baseDepsB = { store: storeB, api: apiA, panel: makePanel(), navigation: { push: vi.fn() }, chat: makeChat(), hooks: makeHooks([]) }

    scopeA.run(() => createUseSession(baseDepsA))
    // 实例 B 共用同一 api（订阅只发生一次）
    scopeB.run(() => createUseSession(baseDepsB))
    expect(apiA.onConfigSessions).toHaveBeenCalledTimes(1)

    // handler 主动 emit 分组 → 实例 A 的 store 更新
    capturedHandler?.([{ cwd: '/a', sessions: [summary('s1')] }])
    expect(storeA.groups.value).toHaveLength(1)

    // A 销毁（count 2→1 不退订）
    scopeA.stop()
    expect(unsub).not.toHaveBeenCalled()
    // B 销毁（count 1→0 退订一次）
    scopeB.stop()
    expect(unsub).toHaveBeenCalledTimes(1)

    resetSessionListSubForTest()
  })
})

function makePanel() {
  return {
    focusedSessionId: vi.fn(() => null),
    activePanelId: vi.fn(() => 'p1'),
    findPanelBySession: vi.fn(() => null),
    loadSession: vi.fn(),
    openPanel: vi.fn(),
  }
}

function makeChat(): ChatHydratePort {
  return {
    getHistory: vi.fn().mockResolvedValue({ messages: [], historyTruncated: false }),
    isHydrated: vi.fn(() => false),
    hydrate: vi.fn(),
    reconcileHistory: vi.fn(),
    setHistoryTruncated: vi.fn(),
    clearHistoryError: vi.fn(),
    markHistoryFailed: vi.fn(),
  }
}
