/**
 * session.subagents 兜底测试 —— 非活跃/活跃 session 的 subagent 终态推送链路。
 *
 * 锁定根因：subagent/workflow 终态推送（session.subagents / session.workflowUpdate）此前只在
 * per-focus 订阅里处理，用户切走 session 即退订 → dispatchSession 静默丢弃
 * → 分区里 running 记录永不更新 → 侧栏菊花永转。修复：routeInbound 兜底，在 dispatchSession 之后
 * 无条件 applyRecords（仿 session.exited / message.complete）。
 *
 * 验证链路：transport.onMessage 注册的 routeInbound handler 收到 session.subagents →
 *   1. 非活跃 session（focus≠A）：applyRecords(A, [done]) → A 分区更新，hasRunning(A)=false
 *   2. 活跃 session（focus=A）：同样 applyRecords（兜底不判断焦点，幂等/无条件）
 *
 * mock 策略：vi.hoisted 捕获 ws-client.onMessage 注册的 routeInbound handler，测试向其注入
 * ServerMessage。mock ipc/ws-client 避免 init() 真实连接。mock @/api/domains/session.getSubagents
 * 返回 []（store 经 @/api 门面导入 session，需把门面指回 domains 命名空间，同 subagent-push.test.ts）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/session-subagents-fallback.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { ServerMessage, SessionGroup, SubagentRecord } from '@xyz-agent/shared'

// vi.hoisted 保证 mock 工厂在模块加载前就绪；resetModules 后重新加载 useConnection 时
// 仍走同一 mock 工厂（mock 在 hoisted 层注册，不受 resetModules 影响）
const mockHolder = vi.hoisted(() => {
  return {
    // 捕获 transport.on（ws-client.onMessage）注册的 routeInbound handler
    routeHandler: null as ((msg: ServerMessage) => void) | null,
    // ws-client.getState 返回的 ref。vi.hoisted 在 import 前执行，不能调 vue 的 ref，
    // 这里放 null，在 beforeEach 中用真正的 ref 替换。
    stateRef: null as ReturnType<typeof ref<string>> | null,
  }
})

vi.mock('@/lib/ws-client', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
  getState: () => mockHolder.stateRef!,
  setRestarting: vi.fn(),
  setFailed: vi.fn(),
  onMessage: vi.fn((cb: (msg: ServerMessage) => void) => {
    mockHolder.routeHandler = cb
    return () => { mockHolder.routeHandler = null }
  }),
}))

vi.mock('@/lib/ipc', () => ({
  getRuntimePort: vi.fn(async () => undefined),
  getRuntimePortOffset: vi.fn(async () => undefined),
  onRuntimePort: vi.fn(() => () => {}),
  onRuntimeRestarting: vi.fn(() => () => {}),
  onRuntimeFailed: vi.fn(() => () => {}),
  restartRuntime: vi.fn(async () => {}),
}))

// mock sessionApi（subagent store 内部 import；首拉 RPC getSubagents 返回空）
vi.mock('@/api/domains/session', () => ({
  getSubagents: vi.fn(async () => []),
  getSubagentHistory: vi.fn(async () => []),
}))

// subagent store 经 @/api 门面导入 session，需把门面 session 指回上面 mock 的 domains 命名空间，
// 保证 store 与断言用的是同一个 vi.fn()（同 subagent-push.test.ts:21-25）。
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@/api/domains/session')
  return { ...actual, session }
})

// 动态 import 容器：beforeEach resetModules 后重新加载
let useConnection: typeof import('@/composables/useConnection').useConnection
let usePanelStore: typeof import('@/stores/panel').usePanelStore
let useSessionStore: typeof import('@/stores/session').useSessionStore
let useSubagentStore: typeof import('@/stores/subagent').useSubagentStore

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mockHolder.routeHandler = null
  mockHolder.stateRef = ref('disconnected')
  vi.resetModules()

  const conn = await import('@/composables/useConnection')
  useConnection = conn.useConnection
  usePanelStore = (await import('@/stores/panel')).usePanelStore
  useSessionStore = (await import('@/stores/session')).useSessionStore
  useSubagentStore = (await import('@/stores/subagent')).useSubagentStore

  // 初始化 session store 含两个 session（A、B）
  const sessionStore = useSessionStore()
  const group: SessionGroup = {
    cwd: '/repo',
    sessions: [
      { id: 'sess-A', label: 'A', cwd: '/repo', status: 'idle', lastActiveAt: 100, modelId: 'm/x', tokenCount: 0 },
      { id: 'sess-B', label: 'B', cwd: '/repo', status: 'idle', lastActiveAt: 100, modelId: 'm/x', tokenCount: 0 },
    ],
  }
  sessionStore.setGroups([group])
})

async function initAndConnect(): Promise<void> {
  mockHolder.stateRef.value = 'connecting'
  const { init } = useConnection()
  await init()
  mockHolder.stateRef.value = 'connected'
}

/** 构造测试 SubagentRecord */
function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: 'sa-1',
    sessionFile: null,
    agent: 'reviewer',
    slug: 'fix',
    task: 'Fix',
    status: 'running',
    ...overrides,
  }
}

describe('session.subagents routeInbound 兜底', () => {
  it('TC1 非活跃 session 兜底：focus=B 时 A 的终态推送仍更新 A 分区（侧栏不卡 running）', async () => {
    await initAndConnect()
    expect(mockHolder.routeHandler).not.toBeNull()

    const panel = usePanelStore()
    const subagentStore = useSubagentStore()

    // 焦点为 B（A 为非活跃 session）
    panel.loadSession(panel.panels[0].id, 'sess-B')

    // 预填 A 分区一条 running 记录（模拟 subagent 发起后侧栏显示菊花）
    subagentStore.applyRecords('sess-A', [makeRecord({ subagentId: 'sa-1', status: 'running' })])
    expect(subagentStore.hasRunning('sess-A')).toBe(true)

    // 注入 A 的终态推送（status: done）
    const msg: ServerMessage = {
      type: 'session.subagents',
      payload: { sessionId: 'sess-A', subagents: [makeRecord({ subagentId: 'sa-1', status: 'done' })] },
    }
    mockHolder.routeHandler!(msg)

    // A 分区更新为 done
    expect(subagentStore.getRecordsBySession('sess-A')[0].status).toBe('done')
    // 侧栏不再显示 running
    expect(subagentStore.hasRunning('sess-A')).toBe(false)
  })

  it('TC4 活跃 session 兜底（幂等/无条件）：focus=A 时 A 的终态推送同样更新 A 分区', async () => {
    await initAndConnect()

    const panel = usePanelStore()
    const subagentStore = useSubagentStore()

    // 焦点为 A
    panel.loadSession(panel.panels[0].id, 'sess-A')

    // 预填 A 分区 running 记录
    subagentStore.applyRecords('sess-A', [makeRecord({ subagentId: 'sa-1', status: 'running' })])
    expect(subagentStore.hasRunning('sess-A')).toBe(true)

    // 注入 A 的终态推送（status: done）
    const msg: ServerMessage = {
      type: 'session.subagents',
      payload: { sessionId: 'sess-A', subagents: [makeRecord({ subagentId: 'sa-1', status: 'done' })] },
    }
    mockHolder.routeHandler!(msg)

    // 兜底不判断焦点，活跃 session 同样更新
    expect(subagentStore.getRecordsBySession('sess-A')[0].status).toBe('done')
    expect(subagentStore.hasRunning('sess-A')).toBe(false)
  })
})
