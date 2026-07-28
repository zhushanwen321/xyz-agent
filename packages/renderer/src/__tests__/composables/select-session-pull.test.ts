/**
 * wave:remove-bandaids 测试：selectSession 不再主动拉 subagent/workflow 列表。
 *
 * 历史：W2 测试验证 selectSession 切换 session 后 subagentStore/workflowStore 该 sid 分区被填充
 * （selectSession 主动调 loadSubagents/loadWorkflows）。wave:remove-bandaids 删除该兜底——
 * subagents 由 useChat.ensureStreamSubscription → subscribeSession → applySnapshot 的 stateSnapshot
 * dispatch 提供（routeInbound 兜底 applyRecords）；workflows 经 streamRing 内 session.workflowUpdate
 * 增量信号 → triggerWorkflowReload → loadWorkflows RPC（store 方法保留）。
 *
 * 本测试反转原断言：验证 selectSession 不再调 getSubagents/getWorkflows（由 useSubagentListSync/
 * useWorkflowListSync 的 focusedSessionId watch + tab 激活首拉，以及 subscribe reconcile 提供）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/select-session-pull.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/domains/session', () => ({
  switchSession: vi.fn().mockResolvedValue(undefined),
  getCommands: vi.fn().mockResolvedValue({ commands: [] }),
  getContext: vi.fn().mockResolvedValue({}),
  getHistory: vi.fn().mockResolvedValue([]),
  // getSubagents/getWorkflows 仍被 store 方法和 sync composables 调用——保留 mock，
  // 但 selectSession 不应直接调它们（用 spy 断言 call count 在 selectSession 前后不变）。
  getSubagents: vi.fn().mockResolvedValue([]),
  getWorkflows: vi.fn().mockResolvedValue([]),
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

vi.mock('@/composables/useMessageBusSubscription', () => ({
  subscribeSession: vi.fn().mockResolvedValue(undefined),
  getSubscriptionState: vi.fn(),
  clearSubscription: vi.fn(),
  updateLastSeenSeq: vi.fn(),
  resetSubscriptionStates: vi.fn(),
}))

// file tree 依赖（selectSession 会调 loadTree——保留，文件树不在 stateSnapshot 覆盖范围）
vi.mock('@/api/domains/file', () => ({ tree: vi.fn().mockResolvedValue({}) }))
vi.mock('@/api/domains/git', () => ({ status: vi.fn().mockResolvedValue({}) }))

import { session as sessionApi } from '@/api'
import { subscribeSession } from '@/composables/useMessageBusSubscription'
import { useSidebar } from '@/composables/features/useSidebar'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('wave:remove-bandaids: selectSession 不再主动拉 subagent/workflow 列表', () => {
  it('selectSession(sess-A) 不调 getSubagents（subagents 经 subscribe stateSnapshot 提供）', async () => {
    const sidebar = useSidebar()
    await sidebar.selectSession('sess-A')

    // selectSession 不再主动调 getSubagents（store 方法保留，由 useSubagentListSync
    // focusedSessionId watch + subscribe reconcile 提供）
    expect(sessionApi.getSubagents).not.toHaveBeenCalled()
  })

  it('selectSession(sess-A) 不调 getWorkflows（workflows 经 streamRing workflowUpdate 增量信号→RPC 闭环）', async () => {
    const sidebar = useSidebar()
    await sidebar.selectSession('sess-A')

    // selectSession 不再主动调 getWorkflows（store 方法保留，由 useWorkflowListSync
    // focusedSessionId watch + session.workflowUpdate 增量信号触发）
    expect(sessionApi.getWorkflows).not.toHaveBeenCalled()
  })

  it('切到 session B 也不主动拉（多次切换一致性）', async () => {
    const sidebar = useSidebar()
    await sidebar.selectSession('sess-A')
    await sidebar.selectSession('sess-B')

    expect(sessionApi.getSubagents).not.toHaveBeenCalled()
    expect(sessionApi.getWorkflows).not.toHaveBeenCalled()
  })

  it('selectSession 调 subscribeSession 回流 commands/context', async () => {
    const sidebar = useSidebar()
    await sidebar.selectSession('sess-A')

    // selectSession 切会话后应调 subscribeSession，触发 stateSnapshot dispatch 回流 stores
    expect(subscribeSession).toHaveBeenCalledWith('sess-A')
  })

  it('多次切会话每次都调 subscribeSession（幂等，不产生额外 RPC）', async () => {
    const sidebar = useSidebar()
    await sidebar.selectSession('sess-A')
    await sidebar.selectSession('sess-B')
    await sidebar.selectSession('sess-A')

    // 三次切换各调一次 subscribeSession（内部幂等守卫：已 subscribed 且 fromSeq 未指定时跳过 RPC）
    expect(subscribeSession).toHaveBeenCalledTimes(3)
    expect(subscribeSession).toHaveBeenCalledWith('sess-A')
    expect(subscribeSession).toHaveBeenCalledWith('sess-B')
  })

  it('subscribeSession 失败不阻塞切会话', async () => {
    vi.mocked(subscribeSession).mockRejectedValueOnce(new Error('subscribe failed'))
    const sidebar = useSidebar()
    // 不应抛出——subscribeSession 失败被 catch 消化
    await expect(sidebar.selectSession('sess-A')).resolves.toBeUndefined()
    // switchSession 仍应被调用（切会话逻辑完成）
    expect(sessionApi.switchSession).toHaveBeenCalledWith('sess-A')
  })
})
