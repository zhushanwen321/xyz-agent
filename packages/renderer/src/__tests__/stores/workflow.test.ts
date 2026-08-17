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
import { describe, it, expect, beforeEach, vi } from 'vitest'
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
