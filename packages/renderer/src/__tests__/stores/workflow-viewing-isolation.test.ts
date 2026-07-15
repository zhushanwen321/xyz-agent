/**
 * W1 红灯测试：workflow viewing 状态拆分后的隔离性。
 *
 * 核心不变量（修复问题 2 + 问题 3）：
 * - selectWorkflow（侧边栏视图2）不影响 Panel overlay（isViewing=false）
 * - selectAgentCall（Panel overlay）不影响侧边栏视图2（getViewingRunId 保留）
 * - backFromAgentCall 只清 overlay，侧边栏视图2 保留（runId 不丢）
 * - 两者可同时 active（侧边栏停在 workflow-detail + Panel 显示 agent call overlay）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/workflow-viewing-isolation.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkflowStore } from '@/stores/workflow'
import type { WorkflowRunRecord } from '@xyz-agent/shared'

vi.mock('@/api/domains/session', () => ({
  getWorkflows: vi.fn(),
  getAgentCallHistory: vi.fn(),
}))

vi.mock('@/api/events', () => ({
  on: vi.fn(() => () => {}),
}))

import * as sessionApi from '@/api/domains/session'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

function makeRecord(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId: 'wf-001',
    scriptName: 'my-flow',
    status: 'done',
    reason: 'completed',
    startedAt: '2026-07-10T10:00:00Z',
    completedAt: '2026-07-10T10:30:00Z',
    usedTokens: 50000,
    totalCallCount: 2,
    agentCalls: [
      { id: 0, agent: 'dev-W1', status: 'completed', phase: 'Dev', sessionId: 'sess-agent-1' },
    ],
    stateFilePath: '/data/wf-001.jsonl',
    ...overrides,
  }
}

describe('W1: workflow viewing 状态拆分 — selectWorkflow 不触发 Panel overlay', () => {
  it('selectWorkflow 后 isViewing=false（侧边栏视图2 ≠ Panel overlay）', () => {
    const store = useWorkflowStore()
    store.records = [makeRecord()]

    store.selectWorkflow('panel-1', 'wf-001')

    // 侧边栏视图2 状态正确
    expect(store.getViewingRunId('panel-1')).toBe('wf-001')
    expect(store.getCurrentWorkflow('panel-1')?.scriptName).toBe('my-flow')
    // Panel overlay 不应被触发
    expect(store.isViewing('panel-1')).toBe(false)
  })
})

describe('W1: selectAgentCall 不覆盖 detailRunId（侧边栏保持停在 workflow-detail）', () => {
  it('先 selectWorkflow 再 selectAgentCall：getViewingRunId 保留', async () => {
    vi.mocked(sessionApi.getAgentCallHistory).mockResolvedValue([])
    const store = useWorkflowStore()
    store.records = [makeRecord()]

    store.selectWorkflow('panel-1', 'wf-001')
    await store.selectAgentCall('panel-1', 'sess-main', 'sess-agent-1', vi.fn())

    // Panel overlay 激活
    expect(store.isViewing('panel-1')).toBe(true)
    expect(store.getViewingAgentCallId('panel-1')).toBe('sess-agent-1')
    // 侧边栏视图2 仍保留（问题 3 核心断言）
    expect(store.getViewingRunId('panel-1')).toBe('wf-001')
  })
})

describe('W1: backFromAgentCall 只清 overlay，保留 detailRunId', () => {
  it('先 workflow-detail 再 agent-call，backFromAgentCall 后 runId 仍在', async () => {
    vi.mocked(sessionApi.getAgentCallHistory).mockResolvedValue([])
    const store = useWorkflowStore()
    store.records = [makeRecord()]

    store.selectWorkflow('panel-1', 'wf-001')
    await store.selectAgentCall('panel-1', 'sess-main', 'sess-agent-1', vi.fn())
    store.backFromAgentCall('panel-1')

    // Panel overlay 已退出
    expect(store.isViewing('panel-1')).toBe(false)
    expect(store.getViewingAgentCallId('panel-1')).toBeNull()
    // 侧边栏视图2 保留（修复问题 3：不再跳回列表）
    expect(store.getViewingRunId('panel-1')).toBe('wf-001')
  })
})

describe('W1: backToWorkflowList 清 detailRunId，不影响 agent-call overlay', () => {
  it('先 agent-call 再 backToWorkflowList：overlay 保留', async () => {
    vi.mocked(sessionApi.getAgentCallHistory).mockResolvedValue([])
    const store = useWorkflowStore()
    store.records = [makeRecord()]

    store.selectWorkflow('panel-1', 'wf-001')
    await store.selectAgentCall('panel-1', 'sess-main', 'sess-agent-1', vi.fn())
    store.backToWorkflowList('panel-1')

    // 侧边栏视图2 已退出
    expect(store.getViewingRunId('panel-1')).toBeNull()
    // Panel overlay 保留
    expect(store.isViewing('panel-1')).toBe(true)
    expect(store.getViewingAgentCallId('panel-1')).toBe('sess-agent-1')
  })
})
