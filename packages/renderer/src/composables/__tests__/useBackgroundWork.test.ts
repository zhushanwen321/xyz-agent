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

  // [review findings-confirmation #8] TC1b：running-resumable（轮终回写 running + result）
  // 不是后台真在跑——v4 轮终迁移故意回写 running（可冷路径 resume），result 有值即轮终信号。
  // 不排除会致 derivedStatus 恒 working → 末位 turn 永久「工作中」。
  it('TC1b: subagent running + result（轮终 running-resumable）→ false', () => {
    const sub = useSubagentStore()
    sub.applyRecords('s1', [makeSubagent({ status: 'running', result: '本轮产出' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(false)
  })

  // TC1c：混跑场景——一个轮终 resumable + 一个真在跑（首轮无 result）→ 仍算 working
  it('TC1c: 轮终 resumable + 首轮真在跑混合 → true（任一真在跑即 working）', () => {
    const sub = useSubagentStore()
    sub.applyRecords('s1', [
      makeSubagent({ subagentId: 'sub-idle', status: 'running', result: 'done text' }),
      makeSubagent({ subagentId: 'sub-live', status: 'running' }),
    ])
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

  // [review findings-confirmation #8] TC9b：subagent 轮终（record 有 result 仍 running，
  // v4 running-resumable 设计）→ derivedStatus 不再 working（回 done）→ sessionActive
  // false → isWorkingTurn false。这是「完成注入后末位 turn 永久工作中」的核心回归：
  // live 期行为对齐重开后（record=closed → done）。
  it('subagent 轮终（running + result）→ derivedStatus = done（非 working）；真在跑（无 result）→ working', async () => {
    const { useSessionDerivations, invalidateStatusCache } = await import(
      '@/composables/features/chat/useSessionDerivations'
    )
    invalidateStatusCache()

    const { derivedStatus } = useSessionDerivations()
    const sub = useSubagentStore()
    const sessionId = 's-tc9c'

    // 真在跑（首轮，无轮终信号）→ working
    sub.applyRecords(sessionId, [makeSubagent({ subagentId: 'sub-tc9c', status: 'running' })])
    expect(derivedStatus(sessionId).value).toBe('working')

    // 轮终回写 running + result（resumable）→ 不算 working，回落 done
    sub.applyRecords(sessionId, [makeSubagent({ subagentId: 'sub-tc9c', status: 'running', result: '本轮产出' })])
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
