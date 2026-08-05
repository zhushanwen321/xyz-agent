/**
 * useBackgroundWork 谓词测试（CW wave `completion-sound-bg-guard`）。
 *
 * 覆盖 TC1-TC5（hasBackgroundWork 谓词各场景）+ TC9（deriveStatus working 态回归，
 * 走真实 useSessionDerivations 集成路径，验证重构后行为不变）。
 *
 * 用真实 store（setActivePinia + applyRecords 注入数据），不 mock store 方法：
 * - TC1-TC5 直测 useBackgroundWork().hasBackgroundWork
 * - TC9 经 useSessionDerivations().derivedStatus 验证 working 态（谓词接入 deriveStatus 回归）
 *
 * 运行：cd packages/renderer && npx vitest run composables/__tests__/useBackgroundWork.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SubagentRecord, WorkflowRunRecord } from '@xyz-agent/shared'
import { useBackgroundWork } from '../features/chat/useBackgroundWork'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'

/** 构造最小合法 SubagentRecord（仅必填字段）。 */
function makeSubagent(overrides: Partial<SubagentRecord>): SubagentRecord {
  return {
    subagentId: 'sub-1',
    sessionFile: null,
    agent: 'general-purpose',
    slug: 'worker',
    task: 'do something',
    status: 'running',
    ...overrides,
  }
}

/** 构造最小合法 WorkflowRunRecord（仅必填字段）。 */
function makeWorkflow(overrides: Partial<WorkflowRunRecord>): WorkflowRunRecord {
  return {
    runId: 'wf-1',
    scriptName: 'review',
    status: 'running',
    startedAt: '2026-07-01T00:00:00.000Z',
    agentCalls: [],
    stateFilePath: '/tmp/state.json',
    ...overrides,
  }
}

describe('useBackgroundWork', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('TC1: subagent running → true', () => {
    const sub = useSubagentStore()
    sub.applyRecords('s1', [makeSubagent({ status: 'running' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })

  it('TC2: workflow running → true', () => {
    const wf = useWorkflowStore()
    wf.applyRecords('s1', [makeWorkflow({ status: 'running' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })

  it('TC3: workflow paused → true（paused 不续跑主 agent，仍算未完成）', () => {
    const wf = useWorkflowStore()
    wf.applyRecords('s1', [makeWorkflow({ status: 'paused' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })

  it('TC4: 全 done（subagent done + workflow done）→ false', () => {
    const sub = useSubagentStore()
    const wf = useWorkflowStore()
    sub.applyRecords('s1', [makeSubagent({ status: 'done' })])
    wf.applyRecords('s1', [makeWorkflow({ status: 'done' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(false)
  })

  it('TC5: subagent 其它终态（failed/cancelled/crashed）+ workflow done → false', () => {
    const sub = useSubagentStore()
    const wf = useWorkflowStore()
    sub.applyRecords('s1', [makeSubagent({ status: 'failed' })])
    wf.applyRecords('s1', [makeWorkflow({ status: 'done' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(false)
  })

  it('TC5b: 无任何 records（未访问 session）→ false', () => {
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('never-seen')).toBe(false)
  })

  it('TC5c: 混合 —— subagent done 但 workflow running → true（聚合 OR 语义）', () => {
    const sub = useSubagentStore()
    const wf = useWorkflowStore()
    sub.applyRecords('s1', [makeSubagent({ status: 'done' })])
    wf.applyRecords('s1', [makeWorkflow({ status: 'running' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })
})

/**
 * TC9：deriveStatus working 态回归（集成）。
 * 验证 useSessionDerivations 重构后（内联判定 → useBackgroundWork）derivedStatus 行为不变：
 * subagent running → working；全部回落 done 后 → done。
 *
 * 用真实 subagent store + applyRecords 注入数据；invalidateStatusCache 清模块级缓存，
 * 避免 computed 持有上个 pinia 实例的旧 store 闭包（对齐 derive-status-ask-user.test.ts 模式）。
 */
describe('TC9: useSessionDerivations.derivedStatus working 态回归（useBackgroundWork 接入）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('subagent running → derivedStatus = working；subagent done 后回落 done', async () => {
    const { useSessionDerivations, invalidateStatusCache } = await import(
      '@/composables/features/chat/useSessionDerivations'
    )
    invalidateStatusCache()

    const { derivedStatus } = useSessionDerivations()
    const sub = useSubagentStore()
    const sessionId = 's-tc9'

    // 初始：未 hydrate + 非活跃 + 无 background → done
    expect(derivedStatus(sessionId).value).toBe('done')

    // 注入 subagent running → working（hasBackgroundWork=true）
    sub.applyRecords(sessionId, [makeSubagent({ subagentId: 'sub-tc9', status: 'running' })])
    expect(derivedStatus(sessionId).value).toBe('working')

    // subagent 全 done → 回落 done（响应式：computed 重算）
    sub.applyRecords(sessionId, [makeSubagent({ subagentId: 'sub-tc9', status: 'done' })])
    expect(derivedStatus(sessionId).value).toBe('done')
  })

  it('workflow paused → derivedStatus = working（paused 也算 background work）', async () => {
    const { useSessionDerivations, invalidateStatusCache } = await import(
      '@/composables/features/chat/useSessionDerivations'
    )
    invalidateStatusCache()

    const { derivedStatus } = useSessionDerivations()
    const wf = useWorkflowStore()
    const sessionId = 's-tc9b'

    // workflow paused → working（hasBackgroundWork=true，paused 视为未完成）
    wf.applyRecords(sessionId, [makeWorkflow({ runId: 'wf-tc9b', status: 'paused' })])
    expect(derivedStatus(sessionId).value).toBe('working')

    // workflow done → 回落 done
    wf.applyRecords(sessionId, [makeWorkflow({ runId: 'wf-tc9b', status: 'done' })])
    expect(derivedStatus(sessionId).value).toBe('done')
  })
})
