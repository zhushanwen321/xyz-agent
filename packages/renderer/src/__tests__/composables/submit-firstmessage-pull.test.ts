/**
 * W2 (F2 review fix) 测试：submitFirstMessage 新建 session 后 subagent/workflow 列表数据正确刷新。
 *
 * 核心验证（行为结果，非 spy）：
 * - submitFirstMessage 后 subagentStore 该 sid 分区被填充（不只是 loadSubagents 被调）
 * - submitFirstMessage 后 workflowStore 该 sid 分区被填充
 * - fileTree store 有对应 session 的分桶数据
 *
 * 新建 session 走延迟 create 路径，不走 selectSession，兜底全缺。
 * submitFirstMessage 补了 loadTree/loadSubagents/loadWorkflows 才修复。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/submit-firstmessage-pull.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary } from '@xyz-agent/shared'

vi.mock('@/api/domains/session', () => ({
  create: vi.fn(),
  getCommands: vi.fn().mockResolvedValue({ commands: [] }),
  getSubagents: vi.fn().mockResolvedValue([
    { subagentId: 'sub-new-1', sessionFile: null, agent: 'reviewer', slug: 'r', task: 't', status: 'done' },
  ]),
  getWorkflows: vi.fn().mockResolvedValue([
    { runId: 'wf-new-1', scriptName: 'new-flow', status: 'done', startedAt: '', agentCalls: [], stateFilePath: '' },
  ]),
  getAgentCallHistory: vi.fn().mockResolvedValue([]),
}))

// 门面重定向
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

// file tree 依赖
vi.mock('@/api/domains/file', () => ({ tree: vi.fn().mockResolvedValue({}) }))
vi.mock('@/api/domains/git', () => ({ status: vi.fn().mockResolvedValue({}) }))

// mock useChat（submitFirstMessage 调 chat.send，stub 为 noop 避免触发 WS）
vi.mock('@/composables/features/useChat', () => ({
  useChat: vi.fn(() => ({
    send: vi.fn().mockResolvedValue(undefined),
  })),
}))

// mock useModel（submitFirstMessage 调 switchModel/setThinkingLevel）
vi.mock('@/composables/features/useModel', () => ({
  useModel: vi.fn(() => ({
    switchModel: vi.fn().mockResolvedValue(undefined),
    setThinkingLevel: vi.fn().mockResolvedValue(undefined),
  })),
}))

import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { transition, useNewTaskFlowController } from '@/composables/new-task/useNewTaskFlowState'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useFileTreeStore } from '@/stores/fileTree'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  resetNewTaskFlow()
})

/** 预设 NewTaskFlow 到 landing 态并绑定 fake session（跳过 create 路径） */
function setupLandingWithSession(): SessionSummary {
  const controller = useNewTaskFlowController()
  const fakeSession: SessionSummary = {
    id: 'sess-new-001',
    label: 'test',
    cwd: '/tmp',
    createdAt: '2026-07-15T10:00:00Z',
    lastActivity: '2026-07-15T10:00:00Z',
    piSessionFile: '',
  }
  transition('landing')
  controller.bindCurrentSession(fakeSession)
  return fakeSession
}

describe('W2 (F2): submitFirstMessage 新建 session 后 subagent/workflow 数据刷新', () => {
  it('submitFirstMessage 后 subagentStore sess-new-001 分区被填充', async () => {
    setupLandingWithSession()
    const flow = useNewTaskFlow()
    const subagentStore = useSubagentStore()

    await flow.submitFirstMessage('hello')

    expect(subagentStore.getRecordsBySession('sess-new-001')).toHaveLength(1)
    expect(subagentStore.getRecordsBySession('sess-new-001')[0].subagentId).toBe('sub-new-1')
    expect(subagentStore.getRecordsBySession('sess-new-001')[0].agent).toBe('reviewer')
  })

  it('submitFirstMessage 后 workflowStore sess-new-001 分区被填充', async () => {
    setupLandingWithSession()
    const flow = useNewTaskFlow()
    const workflowStore = useWorkflowStore()

    await flow.submitFirstMessage('hello')

    expect(workflowStore.getRecordsBySession('sess-new-001')).toHaveLength(1)
    expect(workflowStore.getRecordsBySession('sess-new-001')[0].runId).toBe('wf-new-1')
    expect(workflowStore.getRecordsBySession('sess-new-001')[0].scriptName).toBe('new-flow')
  })

  it('submitFirstMessage 后 fileTree store 有对应 session 的分桶', async () => {
    setupLandingWithSession()
    const flow = useNewTaskFlow()
    const fileTreeStore = useFileTreeStore()

    await flow.submitFirstMessage('hello')

    // loadTree 是 fire-and-forget（void），submitFirstMessage resolve 时可能未完成。
    // 用 waitFor 等 microtask flush 后 store 分桶出现。
    await vi.waitFor(() => {
      expect(fileTreeStore.getTree('sess-new-001')).toBeDefined()
    })
  })
})
