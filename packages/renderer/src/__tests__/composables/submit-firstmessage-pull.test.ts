/**
 * wave:remove-bandaids 测试：submitFirstMessage 不再主动拉 subagent/workflow/commands 列表。
 *
 * 历史：W2 (F2) 测试验证 submitFirstMessage 新建 session 后 subagent/workflow 分区被填充
 * （submitFirstMessage 主动调 loadSubagents/loadWorkflows/getCommands，因延迟 create 路径不走 selectSession）。
 * wave:remove-bandaids 删除该兜底——与 useSidebar.selectSession 同源 bandaid，统一删除。
 * subagents/commands 由 useChat.ensureStreamSubscription → subscribeSession → applySnapshot 的 stateSnapshot
 * dispatch 提供；workflows 经 streamRing session.workflowUpdate 增量信号 → triggerWorkflowReload → loadWorkflows RPC。
 *
 * 本测试反转原断言：验证 submitFirstMessage 不再调 getSubagents/getWorkflows/getCommands。
 * loadTree 保留（文件树无 bus state type）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/submit-firstmessage-pull.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@xyz-agent/shared'
import type { SessionSummary } from '@xyz-agent/shared'

vi.mock('@/api/domains/session', () => ({
  create: vi.fn(),
  // getCommands/getSubagents/getWorkflows RPC 客户端保留（被 store 方法/sync composables/独立场景用），
  // submitFirstMessage 不应直接调它们——用 spy 断言 not called。
  getCommands: vi.fn().mockResolvedValue({ commands: [] }),
  getSubagents: vi.fn().mockResolvedValue([]),
  getWorkflows: vi.fn().mockResolvedValue([]),
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

// file tree 依赖（loadTree 保留）
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

import { session as sessionApi } from '@/api'
import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { transition, useNewTaskFlowController } from '@/composables/new-task/useNewTaskFlowState'

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

describe('wave:remove-bandaids: submitFirstMessage 不再主动拉 subagent/workflow/commands', () => {
  it('submitFirstMessage 不调 getSubagents（subagents 经 subscribe stateSnapshot 提供）', async () => {
    setupLandingWithSession()
    const flow = useNewTaskFlow()

    await flow.submitFirstMessage(textToSegments('hello'))

    expect(sessionApi.getSubagents).not.toHaveBeenCalled()
  })

  it('submitFirstMessage 不调 getWorkflows（workflows 经 streamRing workflowUpdate 增量信号→RPC 闭环）', async () => {
    setupLandingWithSession()
    const flow = useNewTaskFlow()

    await flow.submitFirstMessage(textToSegments('hello'))

    expect(sessionApi.getWorkflows).not.toHaveBeenCalled()
  })

  it('submitFirstMessage 不调 getCommands（commands 经 subscribe stateSnapshot 提供）', async () => {
    setupLandingWithSession()
    const flow = useNewTaskFlow()

    await flow.submitFirstMessage(textToSegments('hello'))

    expect(sessionApi.getCommands).not.toHaveBeenCalled()
  })
})
