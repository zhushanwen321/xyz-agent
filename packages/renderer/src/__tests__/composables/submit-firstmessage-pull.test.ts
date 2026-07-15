/**
 * W2 (F2 review fix) 测试：submitFirstMessage 新建 session 后主动拉取 subagent/workflow 列表。
 *
 * 核心不变量（修复问题 1 的新建 session 路径）：
 * - submitFirstMessage 后 loadSubagents 被调用（新建 session 走延迟 create，不走 selectSession，
 *   兜底全缺。submitFirstMessage 补 loadTree/loadSubagents/loadWorkflows）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/submit-firstmessage-pull.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// mock @/api 门面
vi.mock('@/api', () => ({
  session: {
    create: vi.fn(),
    getCommands: vi.fn().mockResolvedValue({ commands: [] }),
    getSubagents: vi.fn().mockResolvedValue([]),
    getWorkflows: vi.fn().mockResolvedValue([]),
  },
  chat: {
    getHistory: vi.fn().mockResolvedValue([]),
  },
  file: {
    tree: vi.fn().mockResolvedValue({}),
  },
  git: {
    status: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock('@/api/events', () => ({
  on: vi.fn(() => () => {}),
  onGlobalType: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
}))

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

// mock useFileTree（每次返回同一实例的 loadTree spy，否则 composable 每调返回新闭包）
const loadTreeSpy = vi.fn().mockResolvedValue(undefined)
vi.mock('@/composables/features/useFileTree', () => ({
  useFileTree: vi.fn(() => ({ loadTree: loadTreeSpy })),
}))

import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { transition, useNewTaskFlowController } from '@/composables/new-task/useNewTaskFlowState'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import type { SessionSummary } from '@xyz-agent/shared'

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

describe('W2 (F2): submitFirstMessage 新建 session 后主动拉取 subagent/workflow', () => {
  it('submitFirstMessage 后 loadSubagents 被调用', async () => {
    const fakeSession = setupLandingWithSession()
    const flow = useNewTaskFlow()
    const subagentStore = useSubagentStore()
    const spy = vi.spyOn(subagentStore, 'loadSubagents')

    await flow.submitFirstMessage('hello')

    expect(spy).toHaveBeenCalledWith(fakeSession.id)
  })

  it('submitFirstMessage 后 loadWorkflows 被调用', async () => {
    const fakeSession = setupLandingWithSession()
    const flow = useNewTaskFlow()
    const workflowStore = useWorkflowStore()
    const spy = vi.spyOn(workflowStore, 'loadWorkflows')

    await flow.submitFirstMessage('hello')

    expect(spy).toHaveBeenCalledWith(fakeSession.id)
  })

  it('submitFirstMessage 后 loadTree 被调用', async () => {
    setupLandingWithSession()
    const flow = useNewTaskFlow()

    await flow.submitFirstMessage('hello')

    expect(loadTreeSpy).toHaveBeenCalledWith('sess-new-001')
  })
})
