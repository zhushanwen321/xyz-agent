/**
 * workflow store 单测 —— state / getters / actions 覆盖。
 *
 * 覆盖：
 * - records 初值空数组 + workflowCount
 * - loadWorkflows 成功写入 records + 失败清空
 * - clearWorkflows 清空 records + 退出侧边栏视图 2 + 清 agentcall 映射
 * - selectWorkflow / getViewingRunId / getCurrentWorkflow 视图 2（sidebar 内，非 overlay）
 * - backToWorkflowList 退出视图 2
 * - registerAgentCall / getAgentCallVirtualIdsByMain / clearAgentCallMapping agentcall 清理映射（U7 MUST_FIX 1）
 *
 * [HISTORICAL] overlay 相关用例（selectAgentCall/backFromAgentCall/isViewing/getViewingAgentCallId/
 * getActiveAgentCallVirtualId）已随 U7 overlay 移除删除。agent call 详情现走 drawer SubagentTab
 * （直接 getAgentCallHistory + setMessages + registerAgentCall），不经 store overlay 状态机。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/workflow.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkflowStore } from '@/stores/workflow'
import { agentCallVirtualId } from '@xyz-agent/shared'
import type { WorkflowRunRecord } from '@xyz-agent/shared'

// mock sessionApi（loadWorkflows 内部调用）
vi.mock('@/api/domains/session', () => ({
  getWorkflows: vi.fn(),
}))

// workflow store 经 @/api 门面导入 session（VITE_MOCK=true 下门面指向 mock），
// 需把门面的 session 也指回上面 mock 的 domains 命名空间，保证 store 与断言用的是同一个 vi.fn()。
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@/api/domains/session')
  return { ...actual, session }
})

import * as sessionApi from '@/api/domains/session'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/** 构造测试 WorkflowRunRecord */
function makeRecord(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId: 'wf-test-001',
    scriptName: 'test-flow',
    status: 'done',
    reason: 'completed',
    startedAt: '2026-07-10T10:00:00Z',
    completedAt: '2026-07-10T10:30:00Z',
    usedTokens: 50000,
    totalCallCount: 2,
    agentCalls: [
      { id: 0, agent: 'dev-W1', status: 'completed', phase: 'Dev', sessionId: 'sess-001' },
      { id: 1, agent: 'dev-W2', status: 'completed', phase: 'Dev', sessionId: 'sess-002' },
    ],
    stateFilePath: '/data/wf-test-001.jsonl',
    ...overrides,
  }
}

describe('workflow store', () => {
  it('初始状态：records 分区空 + workflowCount=0', () => {
    const store = useWorkflowStore()
    expect(store.getRecordsBySession('sess-1')).toEqual([])
    expect(store.workflowCount('sess-1')).toBe(0)
  })

  it('loadWorkflows 成功写入该 sid 分区', async () => {
    const records = [makeRecord(), makeRecord({ runId: 'wf-test-002' })]
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue(records)

    const store = useWorkflowStore()
    await store.loadWorkflows('sess-1')

    expect(store.getRecordsBySession('sess-1')).toHaveLength(2)
    expect(store.workflowCount('sess-1')).toBe(2)
  })

  it('loadWorkflows 失败时不覆盖现有分区', async () => {
    vi.mocked(sessionApi.getWorkflows).mockRejectedValue(new Error('rpc error'))

    const store = useWorkflowStore()
    store.applyRecords('sess-1', [makeRecord()])
    await store.loadWorkflows('sess-1')

    // M1 契约：失败不覆盖现有分区数据，设 loadError
    expect(store.getRecordsBySession('sess-1')).toHaveLength(1)
    expect(store.loadError).toBe('rpc error')
  })

  it('clearWorkflows 清空所有分区 + 退出侧边栏视图 2 + 清 agentcall 映射', () => {
    const store = useWorkflowStore()
    store.selectWorkflow('panel-1', 'wf-001')
    // 登记 agentcall 映射（U7 MUST_FIX 1）
    store.registerAgentCall('sess-1', agentCallVirtualId('ac-1'))
    expect(store.getViewingRunId('panel-1')).toBe('wf-001')
    expect(store.getAgentCallVirtualIdsByMain('sess-1')).toContain(agentCallVirtualId('ac-1'))

    store.clearWorkflows()

    expect(store.getRecordsBySession('sess-1')).toEqual([])
    expect(store.getViewingRunId('panel-1')).toBeNull()
    expect(store.getAgentCallVirtualIdsByMain('sess-1')).toEqual([])
  })

  it('selectWorkflow + getViewingRunId + getCurrentWorkflow 视图 2（sidebar 内，非 overlay）', () => {
    const store = useWorkflowStore()
    store.applyRecords('sess-1', [makeRecord({ runId: 'wf-001', scriptName: 'my-flow' })])

    store.selectWorkflow('panel-1', 'wf-001')

    expect(store.getViewingRunId('panel-1')).toBe('wf-001')
    expect(store.getCurrentWorkflow('panel-1', 'sess-1')?.scriptName).toBe('my-flow')
  })

  it('backToWorkflowList 退出视图 2', () => {
    const store = useWorkflowStore()
    store.selectWorkflow('panel-1', 'wf-001')
    expect(store.getViewingRunId('panel-1')).toBe('wf-001')

    store.backToWorkflowList('panel-1')

    expect(store.getViewingRunId('panel-1')).toBeNull()
  })
})

// ── 空结果守卫（sidebar-sync-plan P1）：RPC 成功返回 [] 且分区非空 → 不覆盖 ──
// runtime getWorkflows 读盘失败时 catch 降级返回 []，瞬时读失败不得清掉 renderer 分区历史。

describe('workflow store — loadWorkflows 空结果守卫', () => {
  let warnSpy: MockInstance

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('RPC 返回 [] 且分区已有数据 → 不覆盖分区 + warn 含 sessionId', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([])

    const store = useWorkflowStore()
    store.applyRecords('sess-1', [makeRecord({ runId: 'wf-keep' })])
    await store.loadWorkflows('sess-1')

    // 守卫契约：保留旧分区，warn 说明保留行为并携带 sessionId
    expect(store.getRecordsBySession('sess-1')).toHaveLength(1)
    expect(store.getRecordsBySession('sess-1')[0].runId).toBe('wf-keep')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('keeping existing records'), 'sess-1')
    // 守卫不是错误态：不设 loadError，isLoading 正常复位
    expect(store.loadError).toBeNull()
    expect(store.isLoading).toBe(false)
  })

  it('RPC 返回 [] 且分区为空 → 分区保持为空，不告警', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([])

    const store = useWorkflowStore()
    await store.loadWorkflows('sess-1')

    // 分区本就为空 → [] 是合法结果，正常写入（仍为空），无守卫告警
    expect(store.getRecordsBySession('sess-1')).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
    expect(store.loadError).toBeNull()
  })

  it('RPC 返回非空且分区已有数据 → 正常覆盖为新数据（守卫不生效）', async () => {
    const fresh = [makeRecord({ runId: 'wf-fresh' })]
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue(fresh)

    const store = useWorkflowStore()
    store.applyRecords('sess-1', [makeRecord({ runId: 'wf-old' })])
    await store.loadWorkflows('sess-1')

    expect(store.getRecordsBySession('sess-1')).toHaveLength(1)
    expect(store.getRecordsBySession('sess-1')[0].runId).toBe('wf-fresh')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  // ── R1 business-logic S3：连续空命中（strike）区分「瞬时读失败降级 []」与「真实删空」──

  it('连续第 2 次 RPC 空 → 判真实删空，清分区 + warn 说明放行', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([])

    const store = useWorkflowStore()
    store.applyRecords('sess-1', [makeRecord({ runId: 'wf-keep' })])
    await store.loadWorkflows('sess-1') // strike 1/2：保留
    await store.loadWorkflows('sess-1') // strike 2/2：真实删空判定，放行覆盖

    expect(store.getRecordsBySession('sess-1')).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('clearing partition'),
      'sess-1',
    )
    expect(store.loadError).toBeNull()
  })

  it('空结果被非空结果打断 → strike 重置，再遇单次空仍保留（不累计误清）', async () => {
    const store = useWorkflowStore()
    store.applyRecords('sess-1', [makeRecord({ runId: 'wf-keep' })])

    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([]) // strike 1/2
    await store.loadWorkflows('sess-1')
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([makeRecord({ runId: 'wf-keep' })])
    await store.loadWorkflows('sess-1') // 非空 → strike 清零
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([]) // 重新 strike 1/2
    await store.loadWorkflows('sess-1')

    expect(store.getRecordsBySession('sess-1')).toHaveLength(1)
    expect(store.getRecordsBySession('sess-1')[0].runId).toBe('wf-keep')
  })

  it('RPC 失败（catch）→ strike 重置，不让连接故障累计出误清分区', async () => {
    const store = useWorkflowStore()
    store.applyRecords('sess-1', [makeRecord({ runId: 'wf-keep' })])

    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([]) // strike 1/2
    await store.loadWorkflows('sess-1')
    vi.mocked(sessionApi.getWorkflows).mockRejectedValue(new Error('network'))
    await store.loadWorkflows('sess-1') // catch → strike 重置
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([]) // 重新 strike 1/2，仍保留
    await store.loadWorkflows('sess-1')

    expect(store.getRecordsBySession('sess-1')).toHaveLength(1)
    expect(store.getRecordsBySession('sess-1')[0].runId).toBe('wf-keep')
  })
})

// ── U7 MUST_FIX 1: agentcall 清理映射（deleteSession 清 agentcall 虚拟 key 唯一通路）──

describe('U7 MUST_FIX 1: agentcall 虚拟 key 清理映射', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('registerAgentCall 登记 virtualId，getAgentCallVirtualIdsByMain 反查', () => {
    const store = useWorkflowStore()
    const vid = agentCallVirtualId('ac-sess-1')

    store.registerAgentCall('main-1', vid)

    expect(store.getAgentCallVirtualIdsByMain('main-1')).toEqual([vid])
  })

  it('同一 mainSession 多个 agentcall virtualId 都登记', () => {
    const store = useWorkflowStore()
    const vid1 = agentCallVirtualId('ac-1')
    const vid2 = agentCallVirtualId('ac-2')

    store.registerAgentCall('main-1', vid1)
    store.registerAgentCall('main-1', vid2)

    expect(store.getAgentCallVirtualIdsByMain('main-1').sort()).toEqual([vid1, vid2].sort())
  })

  it('不同 mainSession 独立分区，互不干扰', () => {
    const store = useWorkflowStore()
    store.registerAgentCall('main-1', agentCallVirtualId('ac-1'))
    store.registerAgentCall('main-2', agentCallVirtualId('ac-2'))

    expect(store.getAgentCallVirtualIdsByMain('main-1')).toEqual([agentCallVirtualId('ac-1')])
    expect(store.getAgentCallVirtualIdsByMain('main-2')).toEqual([agentCallVirtualId('ac-2')])
  })

  it('clearAgentCallMapping 清指定 mainSession 的映射（deleteSession 路径）', () => {
    const store = useWorkflowStore()
    store.registerAgentCall('main-1', agentCallVirtualId('ac-1'))
    store.registerAgentCall('main-2', agentCallVirtualId('ac-2'))

    store.clearAgentCallMapping('main-1')

    expect(store.getAgentCallVirtualIdsByMain('main-1')).toEqual([])
    // main-2 不受影响
    expect(store.getAgentCallVirtualIdsByMain('main-2')).toHaveLength(1)
  })

  it('registerAgentCall 幂等：同 virtualId 重复登记不重复', () => {
    const store = useWorkflowStore()
    const vid = agentCallVirtualId('ac-1')

    store.registerAgentCall('main-1', vid)
    store.registerAgentCall('main-1', vid)

    expect(store.getAgentCallVirtualIdsByMain('main-1')).toEqual([vid])
  })

  it('未登记的 mainSession 反查返回空数组（deleteSession 安全 no-op）', () => {
    const store = useWorkflowStore()
    expect(store.getAgentCallVirtualIdsByMain('never')).toEqual([])
    // 清不存在的映射不抛错
    expect(() => store.clearAgentCallMapping('never')).not.toThrow()
  })
})

// ── clearSession per-session 分区释放 + W15 定时器防御性清理（fake timers）──

describe('workflow store — clearSession（per-session 分区释放，ADR-0049 AC-8）', () => {
  it('清除指定 sid 分区，不影响其他 sid', () => {
    const store = useWorkflowStore()
    store.applyRecords('session-1', [makeRecord({ runId: 'wf-a' })])
    store.applyRecords('session-2', [makeRecord({ runId: 'wf-b' })])

    store.clearSession('session-1')

    expect(store.getRecordsBySession('session-1')).toEqual([])
    expect(store.getRecordsBySession('session-2')).toHaveLength(1)
  })

  it('清除不存在的 sid 分区是 no-op（不抛错）', () => {
    const store = useWorkflowStore()
    expect(() => store.clearSession('never')).not.toThrow()
  })

  it('strike 簿记随分区清除：clearSession 后单次空结果重新从 strike 1 计（不残留旧计数）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = useWorkflowStore()
    store.applyRecords('session-1', [makeRecord()])

    // strike 1/2：空结果保留
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([])
    await store.loadWorkflows('session-1')
    expect(store.getRecordsBySession('session-1')).toHaveLength(1)

    // clearSession 清分区 + strike 计数 → 此时空结果直接正常写入（分区已空，守卫本就不触发）
    store.clearSession('session-1')
    await store.loadWorkflows('session-1')
    expect(store.getRecordsBySession('session-1')).toEqual([])
    warnSpy.mockRestore()
  })
})

describe('workflow store — triggerWorkflowReload / W15 定时器防御性清理', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('running 信号：立即拉一次 + 500ms 延迟重试一次（workflow-state-link 延迟 flush 兜底）', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([makeRecord()])
    const store = useWorkflowStore()

    store.triggerWorkflowReload('session-1', 'running')
    // 立即拉取（微任务 flush）
    await vi.advanceTimersByTimeAsync(0)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)

    // 延迟重试在 RUNNING_RETRY_MS=500 后触发
    await vi.advanceTimersByTimeAsync(500)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2)
    expect(sessionApi.getWorkflows).toHaveBeenNthCalledWith(2, 'session-1')
  })

  it('非 running 信号：只立即拉一次，不安排延迟重试', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([makeRecord()])
    const store = useWorkflowStore()

    store.triggerWorkflowReload('session-1', 'done')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(600)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
  })

  it('同 sid 连续 running 信号去重：只保留最后一次重试 timer', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([makeRecord()])
    const store = useWorkflowStore()

    store.triggerWorkflowReload('session-1', 'running')
    store.triggerWorkflowReload('session-1', 'running')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(600)
    // 2 次立即拉取 + 1 次去重后的延迟重试（旧 timer 被 clearTimeout）
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(3)
  })

  it('W15 兜底：store $dispose → 在途重试 timer 被清，不再触发 loadWorkflows', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([makeRecord()])
    const store = useWorkflowStore()

    store.triggerWorkflowReload('session-1', 'running')
    await vi.advanceTimersByTimeAsync(0)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)

    // 作用域销毁（HMR / store dispose）→ 定时器防御性清理
    store.$dispose()
    await vi.advanceTimersByTimeAsync(600)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
  })
})
