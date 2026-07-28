/**
 * ActiveSessionResolver 行为测试（P7 per-clientId）。
 *
 * 覆盖 spec §六测试计划：resolve per-clientId（Map 命中/多客户端隔离）、
 * lease fallback（第二级）、全局 fallback（第三级，D7 例外）、null（第四级）、
 * per-key TTL cache（命中/过期/隔离/clear）、setActive(null) 边界（ERR2）。
 *
 * mock 策略：sessionService（getSummary/listPersistedSessions）、connectionManager
 * （getActiveSession）、leaseManager（getBusySession）用 inline 对象 mock（resolver
 * 纯逻辑无 IO，手工 mock 最清晰，符合 lease-manager.test.ts 既有风格）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ActiveSessionResolver } from './session-api.js'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'
import type { IPluginServiceDeps } from '../plugin-types.js'

/** 构造一个 SessionSummary（最小字段）。 */
function summary(id: string, status: SessionSummary['status'] = 'idle'): SessionSummary {
  return {
    id,
    label: id,
    cwd: '/cwd',
    status,
    lastActiveAt: 0,
    modelId: 'p/m',
    tokenCount: 0,
  }
}

/** 构造一组 listPersistedSessions 返回值（单 group 含 sessions）。 */
function groups(...sessions: SessionSummary[]): SessionGroup[] {
  return [{ cwd: '/cwd', sessions }]
}

/**
 * 构造 mock IPluginServiceDeps（resolver 只用 sessionService/connectionManager/leaseManager）。
 * 各字段用可变对象，测试用例直接 mutate 控制行为。
 */
function mockDeps(opts: {
  summaries?: Record<string, SessionSummary>
  persistedGroups?: SessionGroup[]
  activeSessionsMap?: Map<string, string | null | undefined>
  busySessionsMap?: Map<string, string>
} = {}): IPluginServiceDeps {
  const summaries: Record<string, SessionSummary> = opts.summaries ?? {}
  const persistedGroups = opts.persistedGroups ?? []
  const activeSessionsMap = opts.activeSessionsMap ?? new Map<string, string | null | undefined>()
  const busySessionsMap = opts.busySessionsMap ?? new Map<string, string>()
  return {
    sessionService: {
      getSummary: (id: string) => summaries[id],
      listPersistedSessions: () => persistedGroups,
    } as unknown as IPluginServiceDeps['sessionService'],
    connectionManager: {
      getActiveSession: (clientId: string) => activeSessionsMap.get(clientId),
    },
    leaseManager: {
      getBusySession: (clientId: string) => {
        const sid = busySessionsMap.get(clientId)
        return sid ? { sessionId: sid } : undefined
      },
    },
  }
}

describe('ActiveSessionResolver (P7 per-clientId)', () => {
  let resolver: ActiveSessionResolver

  beforeEach(() => {
    vi.useFakeTimers()
  })

  // TC-w1-1: resolve per-clientId 命中 activeSessions Map
  it('TC-w1-1: resolve(clientId) 命中 connectionManager.getActiveSession 返回该 session summary', () => {
    const deps = mockDeps({
      summaries: { sessionX: summary('sessionX') },
      activeSessionsMap: new Map([['A', 'sessionX']]),
    })
    resolver = new ActiveSessionResolver(deps)

    const result = resolver.resolve('A')

    expect(result).toBeDefined()
    expect(result?.id).toBe('sessionX')
  })

  // TC-w1-2: resolve per-clientId 多客户端隔离
  it('TC-w1-2: resolve(A) 与 resolve(B) 返回各自 setActive 的 session，互不串扰', () => {
    const deps = mockDeps({
      summaries: { sessionX: summary('sessionX'), sessionY: summary('sessionY') },
      activeSessionsMap: new Map([
        ['A', 'sessionX'],
        ['B', 'sessionY'],
      ]),
    })
    resolver = new ActiveSessionResolver(deps)

    expect(resolver.resolve('A')?.id).toBe('sessionX')
    expect(resolver.resolve('B')?.id).toBe('sessionY')
  })

  // TC-w1-3: resolve lease fallback（第二级）
  it('TC-w1-3: Map miss + lease 命中 → lease fallback 返回 lease session', () => {
    const deps = mockDeps({
      summaries: { sessionZ: summary('sessionZ') },
      activeSessionsMap: new Map(), // A 未 setActive
      busySessionsMap: new Map([['A', 'sessionZ']]), // A 持有 sessionZ lease
    })
    resolver = new ActiveSessionResolver(deps)

    const result = resolver.resolve('A')

    expect(result?.id).toBe('sessionZ')
  })

  // TC-w1-4: resolve(undefined) 全局 fallback（第三级，现状行为）
  it('TC-w1-4: resolve(undefined) 返回全局 isGenerating(status=active) session，与现状一致', () => {
    const deps = mockDeps({
      summaries: { sessionG: summary('sessionG', 'active') },
      persistedGroups: groups(summary('sessionG', 'active'), summary('idle1', 'idle')),
    })
    resolver = new ActiveSessionResolver(deps)

    const result = resolver.resolve(undefined)

    expect(result?.id).toBe('sessionG')
  })

  // TC-w1-5: resolve per-client miss + 全局 fallback（第三级兜底）
  it('TC-w1-5: per-client Map/lease 都 miss 时回退全局 active session', () => {
    const deps = mockDeps({
      summaries: { sessionG: summary('sessionG', 'active') },
      activeSessionsMap: new Map(), // A 未 setActive
      // A 无 lease
      persistedGroups: groups(summary('sessionG', 'active')),
    })
    resolver = new ActiveSessionResolver(deps)

    const result = resolver.resolve('A')

    expect(result?.id).toBe('sessionG')
  })

  // TC-w1-6: resolve 四级全 miss 返回 undefined
  it('TC-w1-6: Map/lease/全局都 miss → 返回 undefined', () => {
    const deps = mockDeps({
      summaries: {},
      activeSessionsMap: new Map(),
      persistedGroups: groups(summary('idle1', 'idle')), // 无 active
    })
    resolver = new ActiveSessionResolver(deps)

    expect(resolver.resolve('D')).toBeUndefined()
  })

  // TC-w1-7: per-key TTL cache 命中与过期
  it('TC-w1-7: 2s 内重复 resolve(clientId) 命中 cache 不重算；advance 2.1s 后重算', () => {
    const activeSessionsMap = new Map([['A', 'sessionX']])
    const summaries: Record<string, SessionSummary> = { sessionX: summary('sessionX') }
    const deps = mockDeps({ summaries, activeSessionsMap })
    resolver = new ActiveSessionResolver(deps)

    // 第一次 resolve：调 getActiveSession
    expect(resolver.resolve('A')?.id).toBe('sessionX')
    // 切换 Map 值（模拟 setActive 切换）——2s 内第二次应命中 cache，看不到新值
    activeSessionsMap.set('A', 'sessionX2')
    summaries.sessionX2 = summary('sessionX2')
    const spy = vi.spyOn(activeSessionsMap, 'get')
    const cached = resolver.resolve('A')
    // 命中 cache：返回旧 sessionX，且未读 Map
    expect(cached?.id).toBe('sessionX')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()

    // advance 2.1s 后 cache 过期，重算读 Map 拿到新值
    vi.advanceTimersByTime(2100)
    const refreshed = resolver.resolve('A')
    expect(refreshed?.id).toBe('sessionX2')
  })

  // TC-w1-8: per-key cache 隔离（clientId key 与 global key 独立）
  it('TC-w1-8: clientId key 与 global key 独立缓存，互不污染', () => {
    const deps = mockDeps({
      summaries: {
        clientSession: summary('clientSession'),
        globalSession: summary('globalSession', 'active'),
      },
      activeSessionsMap: new Map([['A', 'clientSession']]),
      persistedGroups: groups(summary('globalSession', 'active')),
    })
    resolver = new ActiveSessionResolver(deps)

    // resolve('A') 命中 clientSession（Map 路径），缓存 'A' key
    expect(resolver.resolve('A')?.id).toBe('clientSession')
    // 立即 resolve(undefined) 走 global key，独立计算返回 globalSession
    expect(resolver.resolve(undefined)?.id).toBe('globalSession')
    // 再次 resolve('A') 仍命中 'A' key cache（clientSession）
    expect(resolver.resolve('A')?.id).toBe('clientSession')
  })

  // TC-w1-9: clear(clientId?) 清理 cache
  it('TC-w1-9: clear(clientId) 清单 key；clear() 清整个 Map', () => {
    const activeSessionsMap = new Map([
      ['A', 'sessionA'],
      ['B', 'sessionB'],
    ])
    const summaries: Record<string, SessionSummary> = {
      sessionA: summary('sessionA'),
      sessionB: summary('sessionB'),
    }
    const deps = mockDeps({ summaries, activeSessionsMap })
    resolver = new ActiveSessionResolver(deps)

    // 填充 A、B cache
    resolver.resolve('A')
    resolver.resolve('B')
    // 切换 Map 值
    activeSessionsMap.set('A', 'sessionA2')
    activeSessionsMap.set('B', 'sessionB2')
    summaries.sessionA2 = summary('sessionA2')
    summaries.sessionB2 = summary('sessionB2')

    // clear('A') 只清 A key，B 仍命中 cache
    resolver.clear('A')
    expect(resolver.resolve('A')?.id).toBe('sessionA2') // A 重算
    expect(resolver.resolve('B')?.id).toBe('sessionB') // B 命中旧 cache

    // clear() 清整个 Map
    resolver.clear()
    expect(resolver.resolve('B')?.id).toBe('sessionB2') // B 重算
  })

  // TC-w1-10: getActiveSession 返回 null（setActive 到 null）视为 miss 继续 fallback
  it('TC-w1-10: Map 返回 null（主动取消选中）视为 miss，继续 lease fallback', () => {
    const deps = mockDeps({
      summaries: { sessionZ: summary('sessionZ') },
      activeSessionsMap: new Map([['A', null]]), // A setActive(null)
      busySessionsMap: new Map([['A', 'sessionZ']]), // A 持有 sessionZ lease
    })
    resolver = new ActiveSessionResolver(deps)

    const result = resolver.resolve('A')

    expect(result?.id).toBe('sessionZ') // lease fallback 命中
  })

  // TC-w1-11: 组合根注入——resolver 持有 deps 引用，后置 mutate connectionManager/leaseManager 可见
  it('TC-w1-11: deps.connectionManager/leaseManager 后置注入对 resolver 可见（组合根 setter 模式）', () => {
    // 初始 deps 无 connectionManager/leaseManager（模拟 PluginService 构造时 leaseManager 未注入）
    const deps: IPluginServiceDeps = {
      sessionService: {
        getSummary: (id: string) => (id === 'lateSession' ? summary('lateSession') : undefined),
        listPersistedSessions: () => [],
      } as unknown as IPluginServiceDeps['sessionService'],
    }
    resolver = new ActiveSessionResolver(deps)

    // 未注入 leaseManager 时 resolve('A') 走全局 fallback（无 active）→ undefined
    expect(resolver.resolve('A')).toBeUndefined()

    // 后置注入 leaseManager（模拟 pluginService.setLeaseManager）
    deps.leaseManager = {
      getBusySession: (clientId: string) =>
        clientId === 'A' ? { sessionId: 'lateSession' } : undefined,
    }

    // resolver 持有 deps 引用，立刻看到注入的 leaseManager → lease fallback 命中
    expect(resolver.resolve('A')?.id).toBe('lateSession')
  })

  // 额外：无 sessionService 时 resolve 返回 undefined（guard）
  it('无 sessionService 时 resolve 返回 undefined', () => {
    resolver = new ActiveSessionResolver({}) // 无任何依赖
    expect(resolver.resolve('A')).toBeUndefined()
    expect(resolver.resolve(undefined)).toBeUndefined()
  })
})
