/**
 * useSidebarCounts badge 口径单测（设计 subagent-sidebar-filter D8 / T3）。
 *
 * subagentRunningCount 判据 = 「进行中」桶 SSOT（subagentBucket(r) === 'active'，
 * D6 #5 收敛——曾为本地重复实现 `status === 'running' && !isDoneProjection(r)`，
 * 与分桶判据同义但两处维护）：done 投影（one-shot 轮终等 GC，renderer 侧永久态）
 * 不计入、waiting（可复活非终态）计入——badge 语义与列表 active 桶恒同源，
 * 消除 badge 永久虚亮 / 口径漂移分叉。
 *
 * 运行：cd packages/renderer && pnpm test src/__tests__/composables/useSidebarCounts.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { useSidebarCounts } from '@/composables/features/sidebar/useSidebarCounts'
import { useSubagentStore } from '@/stores/subagent'
import { countSubagents } from '@/lib/subagent-bucket'
import type { SubagentRecord } from '@xyz-agent/shared'

function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: 'bg-badge-1-111',
    sessionFile: '/data/sub.jsonl',
    agent: 'reviewer',
    slug: 'review',
    task: 'Review the code changes',
    status: 'done',
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useSidebarCounts D8 badge 口径（subagentRunningCount）', () => {
  it('done 投影（running + result + chatMode false）不计入，真 running 计入', () => {
    const sid = ref<string | null>('sess-badge')
    const store = useSubagentStore()
    store.applyRecords('sess-badge', [
      makeRecord({ subagentId: 'bg-live-1', status: 'running' }),
      makeRecord({ subagentId: 'bg-done-proj-1', status: 'running', result: '本轮产出', chatMode: false }),
      makeRecord({ subagentId: 'bg-terminal-1', status: 'done' }),
    ])

    const counts = useSidebarCounts(sid)
    // 3 条记录里仅 bg-live-1 真在跑：done 投影（绿点滞留）与显式终态都不点亮 badge
    expect(counts.subagentRunningCount.value).toBe(1)
  })

  it('waiting（resumable 等续聊）仍计入（与「进行中」桶口径一致：可复活非终态）', () => {
    const sid = ref<string | null>('sess-wait')
    const store = useSubagentStore()
    store.applyRecords('sess-wait', [
      makeRecord({ subagentId: 'bg-wait-1', status: 'running', resumable: true }),
    ])

    const counts = useSidebarCounts(sid)
    expect(counts.subagentRunningCount.value).toBe(1)
  })

  // H2 W1（record-unification D1②）：workflow 脚本派发的 record（origin='workflow'）
  // 不点亮 subagent badge——workflow 进度由 workflow tab 承载。用户可见行为 = 徽标
  // 数字只数手动派发的进行中 subagent。
  it('origin=workflow 的 record 不计入 badge（tool record 正常计入）', () => {
    const sid = ref<string | null>('sess-wf')
    const store = useSubagentStore()
    store.applyRecords('sess-wf', [
      makeRecord({ subagentId: 'bg-tool-live', status: 'running' }),
      makeRecord({ subagentId: 'bg-wf-live', status: 'running', origin: 'workflow' }),
      makeRecord({ subagentId: 'bg-wf-wait', status: 'running', resumable: true, origin: 'workflow' }),
    ])

    const counts = useSidebarCounts(sid)
    // 3 条记录里仅手动派发的 bg-tool-live 点亮 badge；workflow 来源（含 waiting 形态）全被滤除
    expect(counts.subagentRunningCount.value).toBe(1)
  })

  it('origin 缺省（存量 record，undefined = tool 语义）不受过滤影响（W1 零迁移保障）', () => {
    const sid = ref<string | null>('sess-legacy')
    const store = useSubagentStore()
    store.applyRecords('sess-legacy', [
      makeRecord({ subagentId: 'bg-legacy-1', status: 'running' }),
    ])

    const counts = useSidebarCounts(sid)
    expect(counts.subagentRunningCount.value).toBe(1)
  })

  it('无焦点 session（null）→ 0；空分区 → 0', () => {
    const sid = ref<string | null>('sess-empty')
    const counts = useSidebarCounts(sid)
    expect(counts.subagentRunningCount.value).toBe(0)

    sid.value = null
    expect(counts.subagentRunningCount.value).toBe(0)
  })

  it('与「进行中」桶计数恒一致（D6 #5：判据直接引用 subagentBucket SSOT，混合 fixture 下 badge = countSubagents.active）', () => {
    const sid = ref<string | null>('sess-mix')
    const store = useSubagentStore()
    const records = [
      makeRecord({ subagentId: 'm1', status: 'running' }),
      makeRecord({ subagentId: 'm2', status: 'running', resumable: true }),
      makeRecord({ subagentId: 'm3', status: 'running', result: '本轮产出', chatMode: false }),
      makeRecord({ subagentId: 'm4', status: 'done' }),
      makeRecord({ subagentId: 'm5', status: 'failed', error: 'boom' }),
    ]
    store.applyRecords('sess-mix', records)

    const counts = useSidebarCounts(sid)
    // badge（D8 收窄）= 2（m1 streaming + m2 waiting；m3 done 投影排除）
    expect(counts.subagentRunningCount.value).toBe(2)
    // 与分桶 SSOT 的 active 桶计数恒等（同源判据，badge ↔ 桶不再分叉）
    expect(counts.subagentRunningCount.value).toBe(countSubagents(records).active)
  })
})
