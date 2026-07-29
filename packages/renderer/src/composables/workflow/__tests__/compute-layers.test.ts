/**
 * compute-layers 单测（workflow DAG 可视化 W1 wave）。
 *
 * 覆盖时间戳区间重叠分层算法的 6 个场景：
 * 1. 纯顺序无并发
 * 2. 有并发簇
 * 3. failed 节点 durationMs 缺失降级（用 completedAt）
 * 4. pending 节点排除
 * 5. 全 pending
 * 6. 非法 ISO 守卫
 *
 * 运行：npx vitest run src/composables/workflow/__tests__/compute-layers.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect } from 'vitest'
import { parseT, computeLayers } from '../compute-layers'
import type { WorkflowAgentCall } from '@xyz-agent/shared'

/** 构造 WorkflowAgentCall 的 helper（必填字段 + 可选覆盖）。 */
function makeCall(overrides: Partial<WorkflowAgentCall> & { id: number; agent: string }): WorkflowAgentCall {
  return {
    status: 'completed',
    ...overrides,
  }
}

describe('W1 compute-layers: 时间戳区间重叠分层', () => {
  it('场景1 纯顺序无并发：3 个 completed 节点严格串行（B.start >= A.end）→ 3 层各 1 节点', () => {
    // A: 10:00:00 起，duration 60s → end 10:01:00
    // B: 10:01:00 起（== A.end，首尾相接不算重叠）→ 新层
    // C: 10:02:00 起 → 新层
    const nodes: WorkflowAgentCall[] = [
      makeCall({ id: 1, agent: 'dev-A', startedAt: '2026-07-29T10:00:00Z', durationMs: 60_000 }),
      makeCall({ id: 2, agent: 'dev-B', startedAt: '2026-07-29T10:01:00Z', durationMs: 60_000 }),
      makeCall({ id: 3, agent: 'dev-C', startedAt: '2026-07-29T10:02:00Z', durationMs: 60_000 }),
    ]

    const { layers, pendingNodes } = computeLayers(nodes)

    expect(pendingNodes).toEqual([])
    expect(layers).toHaveLength(3)
    // 每层 1 节点，isParallel 全 false
    layers.forEach((layer) => {
      expect(layer.nodes).toHaveLength(1)
      expect(layer.isParallel).toBe(false)
    })
    // index 0/1/2，无 phase → label 「层0/层1/层2」
    expect(layers[0].index).toBe(0)
    expect(layers[0].label).toBe('层0')
    expect(layers[1].label).toBe('层1')
    expect(layers[2].label).toBe('层2')
    // 顺序保持 A→B→C
    expect(layers[0].nodes[0].agent).toBe('dev-A')
    expect(layers[1].nodes[0].agent).toBe('dev-B')
    expect(layers[2].nodes[0].agent).toBe('dev-C')
  })

  it('场景2 有并发簇：2 节点时间重叠（B.start < A.end）→ 1 层 2 节点 isParallel=true', () => {
    // A: 10:00:00 起，duration 120s → end 10:02:00
    // B: 10:01:00 起（< A.end 10:02:00）→ 重叠，归入同层
    const nodes: WorkflowAgentCall[] = [
      makeCall({ id: 1, agent: 'dev-A', phase: 'Dev-w0', startedAt: '2026-07-29T10:00:00Z', durationMs: 120_000 }),
      makeCall({ id: 2, agent: 'dev-B', phase: 'Dev-w0', startedAt: '2026-07-29T10:01:00Z', durationMs: 30_000 }),
    ]

    const { layers, pendingNodes } = computeLayers(nodes)

    expect(pendingNodes).toEqual([])
    expect(layers).toHaveLength(1)
    expect(layers[0].nodes).toHaveLength(2)
    expect(layers[0].isParallel).toBe(true)
    // label 取该层第一个节点的 phase
    expect(layers[0].label).toBe('Dev-w0')
    expect(layers[0].index).toBe(0)
  })

  it('场景3 failed 节点 durationMs 缺失降级：用 completedAt 算区间', () => {
    // failed: 10:00:00 起，无 durationMs，completedAt 10:00:30 → end 10:00:30
    // next: 10:00:30 起（== failed.end，首尾相接不重叠）→ 新层
    const nodes: WorkflowAgentCall[] = [
      makeCall({
        id: 1,
        agent: 'reviewer',
        status: 'failed',
        startedAt: '2026-07-29T10:00:00Z',
        completedAt: '2026-07-29T10:00:30Z',
        // 故意不传 durationMs，验证降级到 completedAt
      }),
      makeCall({
        id: 2,
        agent: 'dev-next',
        status: 'completed',
        startedAt: '2026-07-29T10:00:30Z',
        durationMs: 60_000,
      }),
    ]

    const { layers, pendingNodes } = computeLayers(nodes)

    expect(pendingNodes).toEqual([])
    // failed（end 10:00:30）与 next（start 10:00:30）首尾相接不重叠 → 2 层
    expect(layers).toHaveLength(2)
    expect(layers[0].nodes[0].agent).toBe('reviewer')
    expect(layers[0].nodes).toHaveLength(1)
    expect(layers[1].nodes[0].agent).toBe('dev-next')
  })

  it('场景4 pending 节点排除：pending 无 startedAt 不进 layers，在 pendingNodes', () => {
    // 1 completed + 1 pending：pending 不参与分层
    const nodes: WorkflowAgentCall[] = [
      makeCall({ id: 1, agent: 'dev-A', startedAt: '2026-07-29T10:00:00Z', durationMs: 60_000 }),
      makeCall({ id: 2, agent: 'dev-pending', status: 'pending' }), // 无 startedAt
    ]

    const { layers, pendingNodes } = computeLayers(nodes)

    // pending 进 pendingNodes
    expect(pendingNodes).toHaveLength(1)
    expect(pendingNodes[0].agent).toBe('dev-pending')
    // layers 只有 1 层（completed 节点）
    expect(layers).toHaveLength(1)
    expect(layers[0].nodes).toHaveLength(1)
    expect(layers[0].nodes[0].agent).toBe('dev-A')
  })

  it('场景5 全 pending：layers=[]，pendingNodes 含全部', () => {
    const nodes: WorkflowAgentCall[] = [
      makeCall({ id: 1, agent: 'a', status: 'pending' }),
      makeCall({ id: 2, agent: 'b', status: 'pending' }),
    ]

    const { layers, pendingNodes } = computeLayers(nodes)

    expect(layers).toEqual([])
    expect(pendingNodes).toHaveLength(2)
    expect(pendingNodes.map((n) => n.agent)).toEqual(['a', 'b'])
  })

  it('场景6 非法 ISO 守卫：startedAt="invalid" 不抛异常，独占一层', () => {
    // 非法 ISO 节点 + 1 个合法节点。非法节点 parseT 返回 -1，排序沉底。
    const nodes: WorkflowAgentCall[] = [
      makeCall({ id: 1, agent: 'legal', startedAt: '2026-07-29T10:00:00Z', durationMs: 60_000 }),
      makeCall({ id: 2, agent: 'bad-time', startedAt: 'invalid' }),
    ]

    // 不应抛异常
    const { layers, pendingNodes } = computeLayers(nodes)

    expect(pendingNodes).toEqual([])
    // 2 层：合法节点一层，非法节点独占一层（排序沉底）
    expect(layers).toHaveLength(2)
    expect(layers[0].nodes[0].agent).toBe('legal')
    expect(layers[1].nodes[0].agent).toBe('bad-time')
    expect(layers[1].nodes).toHaveLength(1)
  })

  it('边界：空输入 → { layers: [], pendingNodes: [] }', () => {
    const { layers, pendingNodes } = computeLayers([])
    expect(layers).toEqual([])
    expect(pendingNodes).toEqual([])
  })
})

describe('W1 parseT: 时间解析', () => {
  it('合法 ISO → 毫秒时间戳', () => {
    const t = parseT('2026-07-29T10:00:00Z')
    expect(t).toBe(Date.UTC(2026, 6, 29, 10, 0, 0))
    expect(t).toBeGreaterThan(0)
  })

  it('空字符串/undefined → -1', () => {
    expect(parseT(undefined)).toBe(-1)
    expect(parseT('')).toBe(-1)
  })

  it('非法 ISO → -1（NaN 守卫）', () => {
    expect(parseT('invalid')).toBe(-1)
    expect(parseT('not-a-date')).toBe(-1)
  })
})
