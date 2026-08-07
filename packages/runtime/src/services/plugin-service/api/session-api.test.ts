/**
 * ActiveSessionResolver + session RPC handler 行为测试（P7 per-clientId）。
 *
 * 覆盖 spec §六测试计划：
 * - resolve per-clientId（Map 命中/多客户端隔离）、lease fallback（第二级）、
 *   全局 fallback（第三级，D7 例外）、null（第四级）、per-key TTL cache、setActive(null) 边界。
 * - plugin RPC handler 用 ALS 取 clientId 透传（D6）、sendMessage(undefined) throw（ERR1）、
 *   agent handler ALS 透传（SC2）、协议层不变（D5，review）。
 *
 * P7 长期方案 A 测试（核心缺陷修复）：
 * - resolveClientId：优先 params 显式 clientId（Worker 注入），ALS 作 fallback；
 *   ALS 无 store + params 无 clientId → undefined。
 * - Worker→主线程 RPC dispatch 路径：handler 在 ALS 作用域外被调用（模拟独立 I/O tick），
 *   仅靠 params[CLIENT_ID_PARAM_KEY] 透传 clientId——证明 ALS 断裂已修复。
 *
 * mock 策略：resolver 测试用 inline 对象 mock sessionService/connectionManager/leaseManager；
 * handler 测试用 mock PluginRpcServer（捕获 registerMethod 的 handler）+ mock SessionHandlers（spy）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ActiveSessionResolver, registerSessionRpcHandlers, resolveClientId } from './session-api.js'
import { sessionContext } from '../../../infra/async-context.js'
import { CLIENT_ID_PARAM_KEY } from '../plugin-types.js'
import { PluginRpcServer } from '../plugin-rpc-server.js'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'
import type { IPluginServiceDeps } from '../plugin-types.js'
import type { SessionHandlers } from './session-api.js'

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
  leaseOwnersBySession?: Map<string, string>
} = {}): IPluginServiceDeps {
  const summaries: Record<string, SessionSummary> = opts.summaries ?? {}
  const persistedGroups = opts.persistedGroups ?? []
  const activeSessionsMap = opts.activeSessionsMap ?? new Map<string, string | null | undefined>()
  const busySessionsMap = opts.busySessionsMap ?? new Map<string, string>()
  const leaseOwnersBySession = opts.leaseOwnersBySession ?? new Map<string, string>()
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
      getLeaseOwner: (sessionId: string) => leaseOwnersBySession.get(sessionId),
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
      getLeaseOwner: () => undefined,
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

// ═══════════════════════════════════════════════════════════════
// w2: plugin session RPC handler（ALS 取 clientId 透传 + sendMessage throw）
// ═══════════════════════════════════════════════════════════════

/**
 * mock PluginRpcServer：捕获 registerMethod 注册的 handler，供测试直接调用。
 * 避开真实 PluginRpcServer 的 Worker/dispatch 机制（handler 测试只需验 handler 行为）。
 */
function mockRpcServer(): {
  server: { registerMethod: (method: string, handler: (p: Record<string, unknown>) => Promise<unknown>) => void }
  handlers: Map<string, (p: Record<string, unknown>) => Promise<unknown>>
} {
  const handlers = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>()
  const server = {
    registerMethod: (method: string, handler: (p: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(method, handler)
    },
  }
  return { server, handlers }
}

/** 构造 mock SessionHandlers（spy getActiveSession/sendMessage 返回值可控）。 */
function mockHandlers(opts: {
  active?: SessionInfoLike | undefined
  sendMessage?: Mock
  getActive?: Mock
} = {}): { handlers: SessionHandlers; spies: { getActive: Mock; sendMessage: Mock } } {
  const getActive = opts.getActive ?? vi.fn(() => opts.active)
  const sendMessage = opts.sendMessage ?? vi.fn(async () => {})
  return {
    handlers: {
      listSessions: async () => [],
      getSession: async () => undefined,
      getActiveSession: getActive,
      sendMessage,
    },
    spies: { getActive, sendMessage },
  }
}

/** SessionInfo 最小形状（handler 测试用）。 */
type SessionInfoLike = { id: string; label: string; cwd: string; status: string; createdAt: number; lastActiveAt: number }

describe('plugin.sessions RPC handler (P7 ALS clientId 透传)', () => {
  // TC-w2-1: getActive handler 用 ALS 取 clientId 透传
  it('TC-w2-1: sessionContext.run({clientId}) 内 getActive handler 透传 clientId 给 deps', async () => {
    const { server, handlers } = mockRpcServer()
    const { handlers: sessionHandlers } = mockHandlers({ active: undefined })
    registerSessionRpcHandlers(server as unknown as Parameters<typeof registerSessionRpcHandlers>[0], sessionHandlers)
    const getActiveSpy = (sessionHandlers.getActiveSession as unknown as Mock)

    await sessionContext.run({ clientId: 'A' }, async () => {
      await handlers.get('plugin.sessions.getActive')!({ pluginId: 'p' })
    })

    expect(getActiveSpy).toHaveBeenCalledWith('A')
  })

  // TC-w2-2: 无 ALS store 时透传 undefined（全局 fallback，D7 例外）
  it('TC-w2-2: 不在 sessionContext.run 内 getActive handler 透传 undefined（走全局 fallback）', async () => {
    const { server, handlers } = mockRpcServer()
    const { handlers: sessionHandlers } = mockHandlers({ active: undefined })
    registerSessionRpcHandlers(server as unknown as Parameters<typeof registerSessionRpcHandlers>[0], sessionHandlers)
    const getActiveSpy = (sessionHandlers.getActiveSession as unknown as Mock)

    // 不在 run 内（ALS 无 store）
    await handlers.get('plugin.sessions.getActive')!({ pluginId: 'p' })

    expect(getActiveSpy).toHaveBeenCalledWith(undefined)
  })

  // TC-w2-3: sendMessage(undefined) 无 active session 时 throw
  it('TC-w2-3: sendMessage(sessionId 缺失) + resolver 返回 undefined → throw no_active_session，未调 sendMessage', async () => {
    const { server, handlers } = mockRpcServer()
    const { handlers: sessionHandlers, spies } = mockHandlers({ active: undefined })
    registerSessionRpcHandlers(server as unknown as Parameters<typeof registerSessionRpcHandlers>[0], sessionHandlers)

    await expect(
      sessionContext.run({ clientId: 'A' }, async () => {
        await handlers.get('plugin.sessions.sendMessage')!({ pluginId: 'p', role: 'user', content: 'hi' })
      }),
    ).rejects.toThrow('no_active_session')

    expect(spies.getActive).toHaveBeenCalledWith('A')
    expect(spies.sendMessage).not.toHaveBeenCalled()
  })

  // TC-w2-4: sendMessage(undefined) 解析 active session 后用该 sessionId
  it('TC-w2-4: sendMessage(sessionId 缺失) + resolver 返回 session → 用解析的 sessionId 调 sendMessage', async () => {
    const active: SessionInfoLike = { id: 'sessionX', label: 'X', cwd: '/c', status: 'idle', createdAt: 0, lastActiveAt: 0 }
    const { server, handlers } = mockRpcServer()
    const { handlers: sessionHandlers, spies } = mockHandlers({ active })
    registerSessionRpcHandlers(server as unknown as Parameters<typeof registerSessionRpcHandlers>[0], sessionHandlers)

    await sessionContext.run({ clientId: 'A' }, async () => {
      await handlers.get('plugin.sessions.sendMessage')!({ pluginId: 'p', role: 'user', content: 'hi' })
    })

    expect(spies.getActive).toHaveBeenCalledWith('A')
    expect(spies.sendMessage).toHaveBeenCalledWith('sessionX', 'user', 'hi')
  })

  // TC-w2-5: sendMessage 明确传 sessionId 时不调 resolver
  it('TC-w2-5: sendMessage(sessionId 明确) → 不调 getActiveSession，直接用传入 sessionId', async () => {
    const { server, handlers } = mockRpcServer()
    const { handlers: sessionHandlers, spies } = mockHandlers({ active: undefined })
    registerSessionRpcHandlers(server as unknown as Parameters<typeof registerSessionRpcHandlers>[0], sessionHandlers)

    await handlers.get('plugin.sessions.sendMessage')!({ pluginId: 'p', sessionId: 'explicit-session', role: 'system', content: 'go' })

    expect(spies.getActive).not.toHaveBeenCalled()
    expect(spies.sendMessage).toHaveBeenCalledWith('explicit-session', 'system', 'go')
  })

  // TC-w2-6: ALS 透传在 run 外重置（验证 ALS 边界——run 外 getStore 为 undefined）
  it('TC-w2-6: sessionContext.run 外 getStore 返回 undefined（ALS 边界，验证透传不泄漏）', () => {
    expect(sessionContext.getStore()).toBeUndefined()
    let insideStore: string | undefined
    sessionContext.run({ clientId: 'B' }, () => {
      insideStore = sessionContext.getStore()?.clientId
    })
    expect(insideStore).toBe('B')
    // run 结束后 store 重置
    expect(sessionContext.getStore()).toBeUndefined()
  })

  // TC-w2-7: 协议层不变——sendMessage handler 接受 {sessionId?, role, content}，getActive 无参（createSessionApi 代理签名 review）
  it('TC-w2-7: handler 协议层不变——sendMessage 接受 {sessionId?,role,content}，getActive 不需 sessionId 参数（D5 协议透明）', async () => {
    const { server, handlers } = mockRpcServer()
    const { handlers: sessionHandlers } = mockHandlers({ active: undefined })
    registerSessionRpcHandlers(server as unknown as Parameters<typeof registerSessionRpcHandlers>[0], sessionHandlers)

    // getActive handler 不需任何业务参数（只读 ALS clientId）
    await handlers.get('plugin.sessions.getActive')!({ pluginId: 'p' })
    // sendMessage handler 接收可选 sessionId + role + content（协议层与改造前一致）
    await handlers.get('plugin.sessions.sendMessage')!({ pluginId: 'p', sessionId: 's', role: 'user', content: 'c' })

    // 协议契约：handler 不要求客户端传 clientId（clientId 从 ALS 隐式取，对插件透明）
    expect(handlers.has('plugin.sessions.getActive')).toBe(true)
    expect(handlers.has('plugin.sessions.sendMessage')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
// w3: resolveClientId + Worker→主线程 RPC dispatch 路径（P7 长期方案 A）
//
// 这组测试证明 ALS 跨独立 I/O tick 断裂的核心缺陷已修复：
// plugin 工具执行经 pi bridge_request 事件触发（独立 tick，不在任何 WS 请求的 ALS 作用域内），
// clientId 经 bridge invoke params → Worker 执行上下文 → RPC params[CLIENT_ID_PARAM_KEY]
// 显式透传回主线程 handler，handler 据此 per-client resolve——不再依赖 ALS。
// ═══════════════════════════════════════════════════════════════

describe('resolveClientId (P7 长期方案 A: params 优先, ALS fallback)', () => {
  // TC-w3-1: params 显式 clientId 优先（即使 ALS 无 store）
  it('TC-w3-1: params[CLIENT_ID_PARAM_KEY] 命中时返回该 clientId，无视 ALS（独立 I/O tick 场景）', () => {
    // 不在 sessionContext.run 内（ALS 无 store）——模拟 pi 事件回调的独立 tick
    expect(sessionContext.getStore()).toBeUndefined()

    const clientId = resolveClientId({ [CLIENT_ID_PARAM_KEY]: 'client-from-worker' })

    expect(clientId).toBe('client-from-worker')
  })

  // TC-w3-2: params 无显式 clientId 时 fallback 到 ALS
  it('TC-w3-2: params 无 CLIENT_ID_PARAM_KEY 时 fallback 到 ALS getStore', () => {
    let resolved: string | undefined
    sessionContext.run({ clientId: 'als-client' }, () => {
      resolved = resolveClientId({ pluginId: 'p' })
    })
    expect(resolved).toBe('als-client')
  })

  // TC-w3-3: params 无 + ALS 无 → undefined（hook/定时器/生命周期，D7 例外）
  it('TC-w3-3: params 无 + ALS 无 store → undefined（全局 fallback）', () => {
    expect(sessionContext.getStore()).toBeUndefined()
    expect(resolveClientId({ pluginId: 'p' })).toBeUndefined()
    expect(resolveClientId(undefined)).toBeUndefined()
  })

  // TC-w3-4: params 显式 clientId 优先于 ALS（两者都有时 params 胜出）
  it('TC-w3-4: params clientId 与 ALS clientId 同时存在时 params 优先', () => {
    let resolved: string | undefined
    sessionContext.run({ clientId: 'als-client' }, () => {
      resolved = resolveClientId({ [CLIENT_ID_PARAM_KEY]: 'explicit-client' })
    })
    expect(resolved).toBe('explicit-client')
  })

  // TC-w3-5: params clientId 为空字符串时忽略（fallback ALS）
  it('TC-w3-5: params[CLIENT_ID_PARAM_KEY] 为空字符串时视为无，fallback ALS', () => {
    let resolved: string | undefined
    sessionContext.run({ clientId: 'als-client' }, () => {
      resolved = resolveClientId({ [CLIENT_ID_PARAM_KEY]: '' })
    })
    expect(resolved).toBe('als-client')
  })
})

// ═══════════════════════════════════════════════════════════════
// w4: Worker→主线程 RPC dispatch 真实路径（PluginRpcServer.dispatch，非 mock 同步直调）
//
// 模拟真实链路：Worker postMessage RPC 请求 → plugin-host worker.on('message') →
// rpcServer.dispatch → handler。关键：dispatch 在独立 tick（setTimeout/postMessage 回调）
// 触发，不在任何 sessionContext.run 作用域内——这正是 ALS 断裂的场景。clientId 必须靠
// params[CLIENT_ID_PARAM_KEY] 透传。
// ═══════════════════════════════════════════════════════════════

describe('Worker→主线程 RPC dispatch 真实路径 (P7 长期方案 A: ALS 断裂修复)', () => {
  beforeEach(() => {
    // 上面 ActiveSessionResolver block 的 beforeEach 调了 vi.useFakeTimers() 但未恢复，
    // 此处显式切回 real timers——本 block 不依赖定时器，但需保证不受 fake timers 污染。
    vi.useRealTimers()
  })

  /**
   * 用真实 PluginRpcServer + 模拟 Worker port。
   *
   * 关键属性：dispatch 在「不在任何 sessionContext.run 内」的调用栈执行——这正是 ALS 断裂
   * 的场景（pi 事件回调的独立 tick）。若 handler 依赖 ALS，clientId 会是 undefined。
   * clientId 必须靠 params[CLIENT_ID_PARAM_KEY] 显式透传——本组测试验证此修复。
   */
  function setupRealDispatch(handlers: SessionHandlers): {
    rpcServer: PluginRpcServer
    /** 模拟 Worker 发 RPC 请求（dispatch 在 sessionContext.run 作用域外调用） */
    sendWorkerRpc: (method: string, params: Record<string, unknown>) => Promise<unknown>
    lastResponse: () => unknown
  } {
    const rpcServer = new PluginRpcServer()
    registerSessionRpcHandlers(rpcServer, handlers)

    let capturedResponse: unknown = undefined
    // Worker port：捕获 dispatch 回复给 Worker 的 RPC 响应。
    const workerPort = {
      postMessage(message: unknown) {
        const m = message as { type: string; response?: unknown }
        if (m.type === 'rpc' && m.response) {
          capturedResponse = m.response
        }
      },
    }
    rpcServer.registerWorker('w1', workerPort)

    const sendWorkerRpc = (method: string, params: Record<string, unknown>): Promise<unknown> => {
      // 模拟 Worker 发来的 RPC 请求（扁平格式，与 PluginRpcClient.request 一致）。
      // 直接调 dispatch——它是一个普通 async 方法调用，调用栈不在任何 sessionContext.run 内，
      // 真实复现「pi 事件回调独立 tick 触发 worker.on('message') → dispatch」的 ALS 断裂场景。
      const workerRequest = { type: 'rpc', jsonrpc: '2.0', id: 1, method, params }
      return rpcServer.dispatch('w1', workerRequest as never).then(() => capturedResponse)
    }

    return { rpcServer, sendWorkerRpc, lastResponse: () => capturedResponse }
  }

  // TC-w4-1: getActive handler 在独立 tick（无 ALS）经 dispatch 调用，
  // 仅靠 params[CLIENT_ID_PARAM_KEY] 透传 clientId——证明 ALS 断裂已修复。
  it('TC-w4-1: dispatch 在独立 tick（无 ALS）+ params 含 CLIENT_ID_PARAM_KEY → handler 收到正确 clientId', async () => {
    const getActive = vi.fn(() => undefined)
    const handlers: SessionHandlers = {
      listSessions: async () => [],
      getSession: async () => undefined,
      getActiveSession: getActive,
      sendMessage: async () => {},
    }
    const { sendWorkerRpc } = setupRealDispatch(handlers)

    // 不在 sessionContext.run 内（ALS 无 store）——模拟 pi 事件回调独立 tick
    expect(sessionContext.getStore()).toBeUndefined()
    await sendWorkerRpc('plugin.sessions.getActive', { pluginId: 'p', [CLIENT_ID_PARAM_KEY]: 'client-A' })

    expect(getActive).toHaveBeenCalledWith('client-A')
  })

  // TC-w4-2: 多客户端隔离——A/B 各自的 Worker RPC 携带各自 clientId，
  // handler 分别 resolve（A→sessionX, B→sessionY）。
  it('TC-w4-2: A/B 各自 dispatch（独立 tick）→ handler 分别收到 client-A / client-B（per-client 隔离）', async () => {
    const seenClientIds: (string | undefined)[] = []
    const handlers: SessionHandlers = {
      listSessions: async () => [],
      getSession: async () => undefined,
      getActiveSession: (clientId?) => {
        seenClientIds.push(clientId)
        return undefined
      },
      sendMessage: async () => {},
    }
    const { sendWorkerRpc } = setupRealDispatch(handlers)

    await sendWorkerRpc('plugin.sessions.getActive', { pluginId: 'p', [CLIENT_ID_PARAM_KEY]: 'client-A' })
    await sendWorkerRpc('plugin.sessions.getActive', { pluginId: 'p', [CLIENT_ID_PARAM_KEY]: 'client-B' })

    expect(seenClientIds).toEqual(['client-A', 'client-B'])
  })

  // TC-w4-3: dispatch 在独立 tick + params 无 clientId + ALS 无 store → handler 收到 undefined（全局 fallback）
  it('TC-w4-3: dispatch 在独立 tick + 无 clientId 透传 → handler 收到 undefined（全局 fallback，零回归）', async () => {
    const getActive = vi.fn(() => undefined)
    const handlers: SessionHandlers = {
      listSessions: async () => [],
      getSession: async () => undefined,
      getActiveSession: getActive,
      sendMessage: async () => {},
    }
    const { sendWorkerRpc } = setupRealDispatch(handlers)

    // ALS 无 store + params 无 CLIENT_ID_PARAM_KEY（模拟 hook/定时器触发的 plugin 操作）
    expect(sessionContext.getStore()).toBeUndefined()
    await sendWorkerRpc('plugin.sessions.getActive', { pluginId: 'p' })

    expect(getActive).toHaveBeenCalledWith(undefined)
  })

  // TC-w4-4: sendMessage(undefined) 在独立 tick 经 dispatch + params clientId 解析 active session
  it('TC-w4-4: sendMessage(sessionId 缺失) 在独立 tick + params clientId → 用解析的 sessionId 调 sendMessage', async () => {
    const active: SessionInfoLike = { id: 'sessionX', label: 'X', cwd: '/c', status: 'idle', createdAt: 0, lastActiveAt: 0 }
    const sendMessage = vi.fn(async () => {})
    const getActive = vi.fn(() => active)
    const handlers: SessionHandlers = {
      listSessions: async () => [],
      getSession: async () => undefined,
      getActiveSession: getActive as SessionHandlers['getActiveSession'],
      sendMessage,
    }
    const { sendWorkerRpc } = setupRealDispatch(handlers)

    await sendWorkerRpc('plugin.sessions.sendMessage', {
      pluginId: 'p', role: 'user', content: 'hi', [CLIENT_ID_PARAM_KEY]: 'client-A',
    })

    expect(getActive).toHaveBeenCalledWith('client-A')
    expect(sendMessage).toHaveBeenCalledWith('sessionX', 'user', 'hi')
  })
})

