/**
 * session.workflowUpdate 兜底测试 —— 非活跃 session workflow 终态 + running 延迟重试链路。
 *
 * 锁定根因：workflow 终态增量信号（session.workflowUpdate）此前只在 per-focus 订阅
 * 里处理，用户切走 session 即退订 → dispatchSession 静默丢弃
 * → 分区里 running 记录永不更新 → 侧栏菊花永转。修复：routeInbound 兜底调
 * workflowStore.triggerWorkflowReload（loadWorkflows + running 信号延迟重试），仿 session.exited。
 *
 * 验证链路：transport.onMessage 注册的 routeInbound handler 收到 session.workflowUpdate →
 *   1. TC2 非活跃 session：终态信号触发 loadWorkflows → 分区更新为 done，hasRunningOrPaused=false
 *   2. TC3 running 信号：立即拉一次（分区为空），500ms 后延迟重试再拉（含 running 记录）
 *
 * mock 策略：vi.hoisted 捕获 routeInbound handler；mock getWorkflows 用 vi.fn() 并在用例内
 * mockResolvedValueOnce 控制返回值。store 经 @/api 门面导入 session，门面指回 domains 命名空间。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/session-workflow-update-fallback.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { ServerMessage, SessionGroup, WorkflowRunRecord } from '@xyz-agent/shared'

const mockHolder = vi.hoisted(() => {
  return {
    routeHandler: null as ((msg: ServerMessage) => void) | null,
    stateRef: null as ReturnType<typeof ref<string>> | null,
  }
})

// §10.2 D-1 后 useConnection 迁 core：dispatcher 经 core ws-client onMessage 注册。
// u1 实证：shim/桥不转发 mock，必须 mock core ws-client 叶子模块本身（按相对路径
// 直指 core 源文件解析到同一模块 ID）；u4 已删除 renderer lib/ws-client deprecated shim。
vi.mock('../../../core/src/transport/ws-client', () => ({
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
  onQueueDrop: vi.fn(() => () => {}),
}))

vi.mock('@/lib/ipc', () => ({
  getRuntimePort: vi.fn(async () => undefined),
  getRuntimePortOffset: vi.fn(async () => undefined),
  getRuntimeToken: vi.fn(async () => undefined),
  onRuntimePort: vi.fn(() => () => {}),
  onRuntimeRestarting: vi.fn(() => () => {}),
  onRuntimeFailed: vi.fn(() => () => {}),
  restartRuntime: vi.fn(async () => {}),
}))

// mock sessionApi：getWorkflows 用 vi.fn()，用例内 mockResolvedValueOnce 控制返回值
vi.mock('@xyz-agent/core/transport/api/domains/session', () => ({
  getWorkflows: vi.fn(),
  getAgentCallHistory: vi.fn(),
  // useConnection.ensureDispatcher 经 sessionApi.subscribe 注入 ports（T2 后）
  subscribe: vi.fn(async () => {}),
  unsubscribe: vi.fn(async () => {}),
}))

// workflow store 经 @/api 门面导入 session，门面指回 domains 命名空间，保证 store 与断言用同一 vi.fn()。
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@xyz-agent/core/transport/api/domains/session')
  return { ...actual, session }
})

let useConnection: typeof import('@/composables/useConnection').useConnection
let usePanelStore: typeof import('@/stores/panel').usePanelStore
let useSessionStore: typeof import('@/stores/session').useSessionStore
let useWorkflowStore: typeof import('@/stores/workflow').useWorkflowStore
let sessionApi: typeof import('@xyz-agent/core/transport/api/domains/session')

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
  useWorkflowStore = (await import('@/stores/workflow')).useWorkflowStore
  sessionApi = await import('@xyz-agent/core/transport/api/domains/session')

  // 初始化 session store 含 session A + 另一个 session B
  const sessionStore = useSessionStore()
  const group: SessionGroup = {
    cwd: '/repo',
    sessions: [
      { id: 'sess-A', label: 'A', cwd: '/repo', status: 'idle', lastActiveAt: 100, modelId: 'm/x', tokenCount: 0 },
      { id: 'sess-B', label: 'B', cwd: '/repo', status: 'idle', lastActiveAt: 100, modelId: 'm/x', tokenCount: 0 },
    ],
  }
  sessionStore.applySnapshot({ groups: [group] })
})

async function initAndConnect(): Promise<void> {
  mockHolder.stateRef.value = 'connecting'
  const { init } = useConnection()
  await init()
  mockHolder.stateRef.value = 'connected'
}

/** 构造测试 WorkflowRunRecord（最小字段集，覆盖 status 断言） */
function makeWorkflow(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId: 'w1',
    scriptName: 'flow',
    status: 'done',
    reason: 'completed',
    startedAt: '2026-07-10T10:00:00Z',
    completedAt: '2026-07-10T10:30:00Z',
    usedTokens: 0,
    totalCallCount: 0,
    agentCalls: [],
    stateFilePath: '/data/w1.jsonl',
    ...overrides,
  }
}

describe('session.workflowUpdate routeInbound 兜底', () => {
  it('TC2 非活跃 session workflow 终态兜底：focus≠A 时 A 的终态信号触发 loadWorkflows 更新分区', async () => {
    await initAndConnect()
    expect(mockHolder.routeHandler).not.toBeNull()

    const panel = usePanelStore()
    const workflowStore = useWorkflowStore()

    // 焦点为 B（A 非活跃）
    panel.loadSession(panel.panels[0].id, 'sess-B')

    // 预填 A 分区 running workflow（模拟侧栏菊花）
    workflowStore.applyRecords('sess-A', [makeWorkflow({ runId: 'w1', status: 'running' })])
    expect(workflowStore.hasRunningOrPaused('sess-A')).toBe(true)

    // getWorkflows 返回 done（终态）
    vi.mocked(sessionApi.getWorkflows).mockResolvedValueOnce([makeWorkflow({ runId: 'w1', status: 'done' })])

    // 注入 A 的 workflowUpdate 终态信号
    const msg: ServerMessage = {
      type: 'session.workflowUpdate',
      payload: { sessionId: 'sess-A', update: { runId: 'w1', status: 'done' } },
    }
    mockHolder.routeHandler!(msg)

    // 等 loadWorkflows RPC flush
    await vi.waitFor(() => {
      expect(workflowStore.getRecordsBySession('sess-A')[0].status).toBe('done')
    })

    expect(workflowStore.hasRunningOrPaused('sess-A')).toBe(false)
    expect(sessionApi.getWorkflows).toHaveBeenCalledWith('sess-A')
  })

  describe('TC3 running 信号延迟重试', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('running 信号：立即拉一次（分区为空），500ms 后延迟重试再拉（含 running 记录）', async () => {
      await initAndConnect()
      const workflowStore = useWorkflowStore()

      // 第一次拉取为空（workflow-state-link 尚未 flush），延迟重试返回 running 记录
      vi.mocked(sessionApi.getWorkflows)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeWorkflow({ runId: 'w1', status: 'running' })])

      // 注入 running 信号
      const msg: ServerMessage = {
        type: 'session.workflowUpdate',
        payload: { sessionId: 'sess-A', update: { runId: 'w1', status: 'running' } },
      }
      mockHolder.routeHandler!(msg)

      // 立即拉取一次：分区为空
      await vi.advanceTimersByTimeAsync(0)
      expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
      expect(workflowStore.getRecordsBySession('sess-A')).toEqual([])

      // 500ms 后延迟重试：分区含 running 记录
      await vi.advanceTimersByTimeAsync(500)
      expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2)
      expect(workflowStore.getRecordsBySession('sess-A')).toHaveLength(1)
      expect(workflowStore.getRecordsBySession('sess-A')[0].status).toBe('running')
    })
  })
})
