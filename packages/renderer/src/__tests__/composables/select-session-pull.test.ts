/**
 * W2 测试：selectSession 切换 session 后 subagent/workflow 列表数据正确刷新。
 *
 * 核心验证（行为结果，非 spy）：
 * - selectSession 后 subagentStore.records 被填充（不只是 loadSubagents 被调）
 * - selectSession 后 workflowStore.records 被填充
 * - 切到不同 session 后 records 内容变化（验证不是残留旧数据）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/select-session-pull.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SubagentRecord, WorkflowRunRecord } from '@xyz-agent/shared'

// session A / session B 返回不同的 fixture，验证切 session 后数据确实变化
const subagentsA: SubagentRecord[] = [
  { subagentId: 'sub-A1', sessionFile: null, agent: 'reviewer', slug: 'review-a', task: 'A', status: 'done' },
]
const subagentsB: SubagentRecord[] = [
  { subagentId: 'sub-B1', sessionFile: null, agent: 'worker', slug: 'work-b', task: 'B', status: 'running' },
]
const workflowsA: WorkflowRunRecord[] = [
  { runId: 'wf-A', scriptName: 'flow-a', status: 'done', startedAt: '', agentCalls: [], stateFilePath: '' },
]
const workflowsB: WorkflowRunRecord[] = [
  { runId: 'wf-B', scriptName: 'flow-b', status: 'running', startedAt: '', agentCalls: [], stateFilePath: '' },
]

vi.mock('@/api/domains/session', () => ({
  switchSession: vi.fn().mockResolvedValue(undefined),
  getCommands: vi.fn().mockResolvedValue({ commands: [] }),
  getContext: vi.fn().mockResolvedValue({}),
  getHistory: vi.fn().mockResolvedValue([]),
  getSubagents: vi.fn(async (sid: string) => (sid === 'sess-A' ? subagentsA : subagentsB)),
  getWorkflows: vi.fn(async (sid: string) => (sid === 'sess-A' ? workflowsA : workflowsB)),
  getAgentCallHistory: vi.fn().mockResolvedValue([]),
}))

// 门面重定向：store 经 @/api 导入 session，需指向上面 mock 的命名空间
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@/api/domains/session')
  return { ...actual, session }
})

vi.mock('@/api/events', () => ({
  on: vi.fn(() => () => {}),
  onGlobalType: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
}))

// file tree 依赖（selectSession 会调 loadTree）
vi.mock('@/api/domains/file', () => ({ tree: vi.fn().mockResolvedValue({}) }))
vi.mock('@/api/domains/git', () => ({ status: vi.fn().mockResolvedValue({}) }))

import { useSidebar } from '@/composables/features/useSidebar'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('W2: selectSession 后 subagent/workflow 列表数据正确刷新', () => {
  it('selectSession(sess-A) 后 subagentStore.records 含 session A 的数据', async () => {
    const sidebar = useSidebar()
    const subagentStore = useSubagentStore()

    await sidebar.selectSession('sess-A')

    expect(subagentStore.records).toHaveLength(1)
    expect(subagentStore.records[0].subagentId).toBe('sub-A1')
    expect(subagentStore.records[0].agent).toBe('reviewer')
  })

  it('selectSession(sess-A) 后 workflowStore.records 含 session A 的数据', async () => {
    const sidebar = useSidebar()
    const workflowStore = useWorkflowStore()

    await sidebar.selectSession('sess-A')

    expect(workflowStore.records).toHaveLength(1)
    expect(workflowStore.records[0].runId).toBe('wf-A')
    expect(workflowStore.records[0].scriptName).toBe('flow-a')
  })

  it('切到 session B 后 records 内容变化（非残留旧数据）', async () => {
    const sidebar = useSidebar()
    const subagentStore = useSubagentStore()
    const workflowStore = useWorkflowStore()

    await sidebar.selectSession('sess-A')
    expect(subagentStore.records[0].subagentId).toBe('sub-A1')
    expect(workflowStore.records[0].runId).toBe('wf-A')

    await sidebar.selectSession('sess-B')
    // subagent 数据已切换为 session B 的
    expect(subagentStore.records[0].subagentId).toBe('sub-B1')
    expect(subagentStore.records[0].agent).toBe('worker')
    // workflow 数据已切换为 session B 的
    expect(workflowStore.records[0].runId).toBe('wf-B')
    expect(workflowStore.records[0].scriptName).toBe('flow-b')
  })
})
