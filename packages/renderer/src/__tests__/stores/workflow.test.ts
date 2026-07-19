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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkflowStore } from '@/stores/workflow'
import type { WorkflowRunRecord } from '@xyz-agent/shared'

// mock sessionApi（loadWorkflows / selectAgentCall 内部调用）
vi.mock('@/api/domains/session', () => ({
  getWorkflows: vi.fn(),
  getAgentCallHistory: vi.fn(),
}))

// workflow store 经 @/api 门面导入 session（VITE_MOCK=true 下门面指向 mock），
// 需把门面的 session 也指回上面 mock 的 domains 命名空间，保证 store 与断言用的是同一个 vi.fn()。
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@/api/domains/session')
  return { ...actual, session }
})

// mock events（subscribeWorkflowPush 内部订阅）
let eventHandlers: Array<(msg: { type: string; payload?: unknown }) => void> = []
vi.mock('@/api/events', () => ({
  on: vi.fn((_sessionId: string, handler: (msg: { type: string; payload?: unknown }) => void) => {
    eventHandlers.push(handler)
    return () => { eventHandlers = eventHandlers.filter((h) => h !== handler) }
  }),
}))

import * as sessionApi from '@/api/domains/session'

beforeEach(() => {
  eventHandlers = []
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
    // selectWorkflow 只设侧边栏视图2，不触发 Panel overlay（isViewing 只认 agent-call）
    expect(store.getViewingRunId('panel-1')).toBe('wf-001')

    store.clearWorkflows()

    expect(store.records).toEqual([])
    expect(store.getViewingRunId('panel-1')).toBeNull()
  })

  it('selectWorkflow + getViewingRunId + getCurrentWorkflow 视图 2', () => {
    const store = useWorkflowStore()
    store.records = [makeRecord({ runId: 'wf-001', scriptName: 'my-flow' })]

    store.selectWorkflow('panel-1', 'wf-001')

    expect(store.getViewingRunId('panel-1')).toBe('wf-001')
    expect(store.getCurrentWorkflow('panel-1')?.scriptName).toBe('my-flow')
    // selectWorkflow 是侧边栏视图2，不触发 Panel overlay
    expect(store.isViewing('panel-1')).toBe(false)
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
    expect(store.getViewingRunId('panel-1')).toBe('wf-001')

    store.backToWorkflowList('panel-1')

    // isViewing 本就 false（侧边栏视图2 不触发 overlay）
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

  it('isViewing per-panel 隔离（agent-call overlay 维度）', async () => {
    vi.mocked(sessionApi.getAgentCallHistory).mockResolvedValue([])
    const store = useWorkflowStore()
    // isViewing 只认 agent-call overlay（不是侧边栏视图2）
    await store.selectAgentCall('panel-1', 'sess-main', 'sess-agent-1', vi.fn())

    expect(store.isViewing('panel-1')).toBe(true)
    expect(store.isViewing('panel-2')).toBe(false)
  })

  it('Fail-fast：getAgentCallHistory 失败 → selectAgentCall throw（不静默 setMessages([])）', async () => {
    vi.mocked(sessionApi.getAgentCallHistory).mockRejectedValue(new Error('文件不存在'))
    const store = useWorkflowStore()
    const setMessages = vi.fn()

    // selectAgentCall 不 catch，错误传播给调用方
    await expect(
      store.selectAgentCall('panel-1', 'sess-main', 'sess-agent-1', setMessages),
    ).rejects.toThrow('文件不存在')

    // setViewing 已执行（fetchAndInject 之前），调用方负责回滚
    expect(store.isViewing('panel-1')).toBe(true)
    // setMessages 不应被调用（fetchAndInject 失败）
    expect(setMessages).not.toHaveBeenCalled()
  })

  it('[B3] backFromAgentCall 传给 chatEvict 的是带前缀的 virtualId（防 raw sessionId 致 no-op 泄漏）', async () => {
    // 回归 B3：selectAgentCall 写入 messages 用的 key 是 `agentcall:<acsId>`，
    // backFromAgentCall 调 chatEvict 时必须传带前缀的 virtualId，与写入时 key 对齐。
    // 否则 chat.evictVirtualKey(rawId) → deleteMessageKey(rawId) 删一个从未存在过的 key（no-op），
    // agentcall 虚拟 session 消息永久残留（内存泄漏）。
    vi.mocked(sessionApi.getAgentCallHistory).mockResolvedValue([])
    const store = useWorkflowStore()

    // 1. selectAgentCall 写入消息到 'agentcall:sess-agent-1'
    await store.selectAgentCall('panel-1', 'sess-main', 'sess-agent-1', vi.fn())
    expect(store.getViewingAgentCallId('panel-1')).toBe('sess-agent-1')

    // 2. backFromAgentCall：chatEvict mock 捕获实际传入的参数
    const chatEvict = vi.fn()
    store.backFromAgentCall('panel-1', chatEvict, 'sess-main')

    // 3. 断言：chatEvict 收到的是带前缀的 'agentcall:sess-agent-1'，不是 raw 'sess-agent-1'
    expect(chatEvict).toHaveBeenCalledTimes(1)
    expect(chatEvict).toHaveBeenCalledWith('agentcall:sess-agent-1')
    expect(chatEvict).not.toHaveBeenCalledWith('sess-agent-1')
    // Panel overlay 已退出
    expect(store.isViewing('panel-1')).toBe(false)
    expect(store.getViewingAgentCallId('panel-1')).toBeNull()
  })

  it('[B3] backFromAgentCall 不传 chatEvict 时 messages 残留（仅清 viewing 状态）', async () => {
    // 边界：调用方未注入 chatEvict（如非 Panel 组件的轻量回退）时只清 viewing，
    // 不抛错——messages 清理由调用方负责（与 subagent backToMain 行为一致）。
    vi.mocked(sessionApi.getAgentCallHistory).mockResolvedValue([])
    const store = useWorkflowStore()
    await store.selectAgentCall('panel-1', 'sess-main', 'sess-agent-1', vi.fn())

    expect(() => store.backFromAgentCall('panel-1')).not.toThrow()
    expect(store.isViewing('panel-1')).toBe(false)
  })
})

describe('workflow store · subscribeWorkflowPush', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('running 信号：立即 loadWorkflows + 延迟 500ms 重试（workflow-state-link 延迟写入兜底）', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([])
    const store = useWorkflowStore()

    store.subscribeWorkflowPush('sess-1')
    // 模拟 runtime 推送 running 信号
    for (const h of eventHandlers) {
      h({ type: 'session.workflowUpdate', payload: { update: { runId: 'wf-1', status: 'running' } } })
    }
    // 立即拉取一次
    await vi.advanceTimersByTimeAsync(0)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)

    // 500ms 后重试一次
    await vi.advanceTimersByTimeAsync(500)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2)
  })

  it('done 信号：只拉取一次（不延迟重试）', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([])
    const store = useWorkflowStore()

    store.subscribeWorkflowPush('sess-1')
    for (const h of eventHandlers) {
      h({ type: 'session.workflowUpdate', payload: { update: { runId: 'wf-1', status: 'done', reason: 'completed' } } })
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)

    // 500ms 后不应再拉
    await vi.advanceTimersByTimeAsync(500)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
  })

  it('切会话后旧 session 的延迟重试独立触发（W-S5：局部 sid 解耦单例耦合）', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([])
    const store = useWorkflowStore()

    store.subscribeWorkflowPush('sess-1')
    // 推 running 信号
    for (const h of eventHandlers) {
      h({ type: 'session.workflowUpdate', payload: { update: { runId: 'wf-1', status: 'running' } } })
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)

    // 切会话（subscribeWorkflowPush 再次调用）。
    // [W-S5] 旧实现用 store 级单例 let focusedSessionId，第二次调用会覆盖它，
    // 使 sess-1 已调度的 500ms 重试 `if (focusedSessionId === sid)` 守卫误判为 false 而被吞——
    // 这是单例耦合 bug（A→B 切换时 A 的重试不应受 B 影响）。改为函数内局部 const sid 后，
    // sess-1 的重试绑定自己的 sid，独立触发，不再被 sess-2 覆盖。
    store.subscribeWorkflowPush('sess-2')
    eventHandlers = [] // 新 session 的订阅 handler

    // 500ms 后 sess-1 的重试独立触发（不再被单例变量吞掉）
    await vi.advanceTimersByTimeAsync(500)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2)
  })
})
