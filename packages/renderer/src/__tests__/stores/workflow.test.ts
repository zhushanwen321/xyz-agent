/**
 * workflow store 单测 —— state / getters / actions 覆盖。
 *
 * 覆盖：
 * - records 初值空数组 + workflowCount
 * - loadWorkflows 成功写入 records + 失败清空
 * - clearWorkflows 清空 records + 退出所有 panel viewing
 * - selectWorkflow / getViewingRunId / getCurrentWorkflow 视图 2 进入
 * - selectAgentCall / getViewingAgentCallId / getActiveAgentCallVirtualId Panel overlay
 * - backToWorkflowList / backFromAgentCall 退出 viewing
 * - isViewing per-panel 隔离
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/workflow.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkflowStore } from '@/stores/workflow'
import type { WorkflowRunRecord } from '@xyz-agent/shared'

// mock sessionApi（loadWorkflows / selectAgentCall 内部调用）
vi.mock('@/api/domains/session', () => ({
  getWorkflows: vi.fn(),
  getAgentCallHistory: vi.fn(),
}))

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
  it('初始状态：records 空数组 + workflowCount=0', () => {
    const store = useWorkflowStore()
    expect(store.records).toEqual([])
    expect(store.workflowCount()).toBe(0)
  })

  it('loadWorkflows 成功写入 records', async () => {
    const records = [makeRecord(), makeRecord({ runId: 'wf-test-002' })]
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue(records)

    const store = useWorkflowStore()
    await store.loadWorkflows('sess-1')

    expect(store.records).toHaveLength(2)
    expect(store.workflowCount()).toBe(2)
  })

  it('loadWorkflows 失败时 records 清空', async () => {
    vi.mocked(sessionApi.getWorkflows).mockRejectedValue(new Error('rpc error'))

    const store = useWorkflowStore()
    await store.loadWorkflows('sess-1')

    expect(store.records).toEqual([])
  })

  it('clearWorkflows 清空 records + 退出 viewing', () => {
    const store = useWorkflowStore()
    store.selectWorkflow('panel-1', 'wf-001')
    expect(store.isViewing('panel-1')).toBe(true)

    store.clearWorkflows()

    expect(store.records).toEqual([])
    expect(store.isViewing('panel-1')).toBe(false)
  })

  it('selectWorkflow + getViewingRunId + getCurrentWorkflow 视图 2', () => {
    const store = useWorkflowStore()
    store.records = [makeRecord({ runId: 'wf-001', scriptName: 'my-flow' })]

    store.selectWorkflow('panel-1', 'wf-001')

    expect(store.getViewingRunId('panel-1')).toBe('wf-001')
    expect(store.getCurrentWorkflow('panel-1')?.scriptName).toBe('my-flow')
    expect(store.isViewing('panel-1')).toBe(true)
  })

  it('selectAgentCall + getViewingAgentCallId Panel overlay', async () => {
    vi.mocked(sessionApi.getAgentCallHistory).mockResolvedValue([])
    const store = useWorkflowStore()
    const setMessages = vi.fn()

    await store.selectAgentCall('panel-1', 'sess-main', 'sess-agent-1', setMessages)

    expect(store.getViewingAgentCallId('panel-1')).toBe('sess-agent-1')
    expect(store.getActiveAgentCallVirtualId('panel-1')).toBe('agentcall:sess-agent-1')
    expect(setMessages).toHaveBeenCalledWith('agentcall:sess-agent-1', [])
  })

  it('backToWorkflowList 退出视图 2', () => {
    const store = useWorkflowStore()
    store.selectWorkflow('panel-1', 'wf-001')
    expect(store.isViewing('panel-1')).toBe(true)

    store.backToWorkflowList('panel-1')

    expect(store.isViewing('panel-1')).toBe(false)
    expect(store.getViewingRunId('panel-1')).toBeNull()
  })

  it('backFromAgentCall 退出 Panel overlay', async () => {
    vi.mocked(sessionApi.getAgentCallHistory).mockResolvedValue([])
    const store = useWorkflowStore()
    await store.selectAgentCall('panel-1', 'sess-main', 'sess-agent-1', vi.fn())
    expect(store.isViewing('panel-1')).toBe(true)

    store.backFromAgentCall('panel-1')

    expect(store.isViewing('panel-1')).toBe(false)
    expect(store.getViewingAgentCallId('panel-1')).toBeNull()
  })

  it('isViewing per-panel 隔离', () => {
    const store = useWorkflowStore()
    store.selectWorkflow('panel-1', 'wf-001')

    expect(store.isViewing('panel-1')).toBe(true)
    expect(store.isViewing('panel-2')).toBe(false)
  })
})
