/**
 * WorkflowDagView.vue 组件集成测试（W2 wave · TC1-6, TC8）。
 *
 * 覆盖纵向分层流程图（视图 A）：
 * - TC1 首屏冒烟：根容器存在 + 层标签可见 + 节点卡片数量
 * - TC2 状态配色：4 种状态节点的 callDotClass
 * - TC3 点击 emit：点 completed 节点 → emit select-agent-call 且载荷正确
 * - TC4 pending 不可点：点 pending 节点不 emit
 * - TC5 pending 区：pendingNodes 渲染 workflow-dag-pending
 * - TC6 空态：空 layers+空 pending → 空态提示
 * - TC8 并发横向：isParallel 层节点容器含 flex-row
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow/__tests__/WorkflowDagView.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import WorkflowDagView from '@/components/panel/workflow/WorkflowDagView.vue'
import type { ExecutionLayer } from '@/composables/workflow/compute-layers'
import type { WorkflowAgentCall } from '@xyz-agent/shared'

/** 构造 WorkflowAgentCall 的 helper（必填字段 + 可选覆盖）。 */
function makeCall(overrides: Partial<WorkflowAgentCall> & { id: number; agent: string }): WorkflowAgentCall {
  return {
    status: 'completed',
    ...overrides,
  }
}

/** 标准测试 mock：2 层，第 2 层并发含 running 节点。 */
const mockLayers: ExecutionLayer[] = [
  {
    index: 0,
    label: 'analyze',
    isParallel: false,
    nodes: [makeCall({ id: 0, agent: 'explorer', status: 'completed', sessionId: 'sess-0', durationMs: 5000 })],
  },
  {
    index: 1,
    label: 'dev',
    isParallel: true,
    nodes: [
      makeCall({ id: 1, agent: 'worker', status: 'completed', sessionId: 'sess-1', durationMs: 3000 }),
      makeCall({ id: 2, agent: 'worker', status: 'running', sessionId: 'sess-2' }),
    ],
  },
]

function mountView(props?: Partial<{ layers: ExecutionLayer[]; pendingNodes: WorkflowAgentCall[] }>) {
  return mount(WorkflowDagView, {
    props: {
      layers: props?.layers ?? mockLayers,
      pendingNodes: props?.pendingNodes ?? [],
    },
  })
}

// ── TC1: 首屏冒烟 ──────────────────────────────────────────
describe('W2 TC1: 首屏冒烟', () => {
  it('根容器 [data-testid="workflow-dag-view"] 存在', () => {
    const wrapper = mountView()
    expect(wrapper.find('[data-testid="workflow-dag-view"]').exists()).toBe(true)
  })

  it('层标签可见（analyze / dev 渲染出来）', () => {
    const wrapper = mountView()
    const text = wrapper.text()
    expect(text).toContain('analyze')
    expect(text).toContain('dev')
  })

  it('节点卡片数量 = mockLayers 所有节点数（3）', () => {
    const wrapper = mountView()
    const nodes = wrapper.findAll('[data-testid="workflow-dag-node"]')
    expect(nodes.length).toBe(3)
  })
})

// ── TC2: 状态配色 ──────────────────────────────────────────
describe('W2 TC2: 状态配色（4 种状态）', () => {
  it('completed 节点状态点含 bg-success', () => {
    const wrapper = mountView()
    const completedNode = wrapper.findAll('[data-testid="workflow-dag-node"]')[0]
    const dot = completedNode.find('.size-1\\.5')
    expect(dot.classes()).toContain('bg-success')
  })

  it('running 节点状态点含 bg-accent', () => {
    const wrapper = mountView()
    const nodes = wrapper.findAll('[data-testid="workflow-dag-node"]')
    // 第 3 个节点（index 2）是 running
    const runningNode = nodes[2]
    const dot = runningNode.find('.size-1\\.5')
    expect(dot.classes()).toContain('bg-accent')
  })

  it('failed 状态点含 bg-danger', () => {
    const layers: ExecutionLayer[] = [{
      index: 0,
      label: 'fix',
      isParallel: false,
      nodes: [makeCall({ id: 1, agent: 'worker', status: 'failed', sessionId: 'sess-fail' })],
    }]
    const wrapper = mountView({ layers })
    const dot = wrapper.find('[data-testid="workflow-dag-node"] .size-1\\.5')
    expect(dot.classes()).toContain('bg-danger')
  })

  it('pending 状态点含 bg-neutral-dim（在 pending 区渲染）', () => {
    const pendingNodes = [makeCall({ id: 9, agent: 'reviewer', status: 'pending' })]
    const wrapper = mountView({ layers: [], pendingNodes })
    const pendingDot = wrapper.find('[data-testid="workflow-dag-pending"] .size-1\\.5')
    expect(pendingDot.classes()).toContain('bg-neutral-dim')
  })
})

// ── TC3: 点击 emit ─────────────────────────────────────────
describe('W2 TC3: 点击 completed 节点 emit select-agent-call', () => {
  it('点 completed 节点 emit select-agent-call，载荷为对象 { agentCallSessionId }', async () => {
    const wrapper = mountView()
    const completedNode = wrapper.findAll('[data-testid="workflow-dag-node"]')[0]
    await completedNode.trigger('click')
    const emitted = wrapper.emitted('select-agent-call')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual([{ agentCallSessionId: 'sess-0' }])
  })
})

// ── TC4: pending 不可点 ───────────────────────────────────
describe('W2 TC4: pending 节点不可点', () => {
  it('点 pending 节点不 emit select-agent-call', async () => {
    const pendingNodes = [makeCall({ id: 9, agent: 'reviewer', status: 'pending' })]
    const wrapper = mountView({ layers: [], pendingNodes })
    const pendingNode = wrapper.find('[data-testid="workflow-dag-pending"] [data-testid="workflow-dag-node"]')
    await pendingNode.trigger('click')
    expect(wrapper.emitted('select-agent-call')).toBeUndefined()
  })
})

// ── TC5: pending 区 ───────────────────────────────────────
describe('W2 TC5: pending 区渲染', () => {
  it('传 pendingNodes 时 [data-testid="workflow-dag-pending"] 存在', () => {
    const pendingNodes = [makeCall({ id: 9, agent: 'reviewer', status: 'pending' })]
    const wrapper = mountView({ layers: [], pendingNodes })
    expect(wrapper.find('[data-testid="workflow-dag-pending"]').exists()).toBe(true)
  })

  it('无 pendingNodes 时不渲染 pending 区', () => {
    const wrapper = mountView()
    expect(wrapper.find('[data-testid="workflow-dag-pending"]').exists()).toBe(false)
  })
})

// ── TC6: 空态 ─────────────────────────────────────────────
describe('W2 TC6: 空态提示', () => {
  it('空 layers + 空 pending → [data-testid="workflow-dag-empty"] 存在', () => {
    const wrapper = mountView({ layers: [], pendingNodes: [] })
    expect(wrapper.find('[data-testid="workflow-dag-empty"]').exists()).toBe(true)
  })

  it('空态文案渲染', () => {
    const wrapper = mountView({ layers: [], pendingNodes: [] })
    expect(wrapper.find('[data-testid="workflow-dag-empty"]').text()).toContain('暂无执行节点')
  })
})

// ── TC8: 并发横向 ─────────────────────────────────────────
describe('W2 TC8: 并发层横向并排', () => {
  it('isParallel 层的节点容器含 flex-row', () => {
    const wrapper = mountView()
    // 第 2 层（index 1）是并发层，其节点容器应在 layer-1 内
    const layer1 = wrapper.find('[data-testid="workflow-dag-layer-1"]')
    expect(layer1.exists()).toBe(true)
    // layer1 下直接子 div 中应有含 flex-row 的（节点容器）
    const nodeContainer = layer1.findAll(':scope > div')
    const hasFlexRow = nodeContainer.some((el) => el.classes().includes('flex-row'))
    expect(hasFlexRow).toBe(true)
  })

  it('非并发层（isParallel=false）的节点容器用 flex-col 非 flex-row', () => {
    const wrapper = mountView()
    const layer0 = wrapper.find('[data-testid="workflow-dag-layer-0"]')
    const nodeContainer = layer0.findAll(':scope > div')
    const container = nodeContainer.find((el) => el.classes().includes('flex-col') && el.classes().includes('gap-2'))
    expect(container).toBeTruthy()
    expect(container!.classes()).not.toContain('flex-row')
  })

  it('并发层显示 ×N 标记', () => {
    const wrapper = mountView()
    const flag = wrapper.find('[data-testid="workflow-dag-parallel-flag"]')
    expect(flag.exists()).toBe(true)
    expect(flag.text()).toBe('×2')
  })
})
