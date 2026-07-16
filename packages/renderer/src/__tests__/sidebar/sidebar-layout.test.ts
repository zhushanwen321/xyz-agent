/**
 * sidebar 布局优化单测（CW topic: sidebar-layout-optimization）。
 * 验证 5 项改动（D1-D5）：宽度缩窄、slug 去除、model 降级、hover 重定位、badge 微调。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/sidebar-layout.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SubagentList from '@/components/sidebar/SubagentList.vue'
import WorkflowDetail from '@/components/sidebar/WorkflowDetail.vue'
import SessionItem from '@/components/sidebar/SessionItem.vue'
import SegmentedTab from '@/components/sidebar/SegmentedTab.vue'
import type { SubagentRecord, WorkflowRunRecord } from '@xyz-agent/shared'

// ── D2: SubagentList 去掉 slug 列 ──────────────────────────
describe('D2: SubagentList slug 降级', () => {
  it('卡片不再渲染独立的 slug span（slug 信息降级为 tooltip）', () => {
    const records: SubagentRecord[] = [{
      subagentId: 'sub-abc123def456',
      agent: 'code-reviewer',
      slug: 'cr-abc123',
      status: 'done',
      task: 'Review the auth module',
    } as SubagentRecord]
    const wrapper = mount(SubagentList, { props: { subagents: records } })
    // slug 曾以独立 span 渲染在 agent name 右侧（font-mono text-[10px] text-muted）
    // 改后 slug 不再独立展示（降级为卡片 title tooltip）
    const allMonoSpans = wrapper.findAll('span.font-mono')
    const slugSpans = allMonoSpans.filter((s) => s.text().includes('cr-abc123'))
    expect(slugSpans.length).toBe(0)
  })

  it('agent name 完整展示（不再被 slug 挤占）', () => {
    const records: SubagentRecord[] = [{
      subagentId: 'sub-abc123def456',
      agent: 'documentation-writer',
      slug: 'dw-abc123',
      status: 'running',
      task: 'Write API docs',
    } as SubagentRecord]
    const wrapper = mount(SubagentList, { props: { subagents: records } })
    expect(wrapper.text()).toContain('documentation-writer')
  })
})

// ── D3: WorkflowDetail model 降级到摘要行 ──────────────────
describe('D3: WorkflowDetail model 降级', () => {
  function makeWorkflow(): WorkflowRunRecord {
    return {
      runId: 'run-1',
      scriptName: 'lint-fix',
      slug: 'lf-001',
      status: 'done',
      reason: 'completed',
      startedAt: '2026-07-15T10:00:00Z',
      completedAt: '2026-07-15T10:05:00Z',
      agentCalls: [{
        id: 'call-1',
        agent: 'coder',
        model: 'claude-sonnet-4-5',
        status: 'completed',
        phase: 'implement',
        inputTokens: 5000,
        outputTokens: 3000,
        turns: 5,
        durationMs: 12000,
        sessionId: 'sess-1',
      }],
    } as unknown as WorkflowRunRecord
  }

  it('model 不在 agent call 主行（主行只含 dot + agent name）', () => {
    const wrapper = mount(WorkflowDetail, { props: { workflow: makeWorkflow() } })
    // agent call 卡片主行：[dot] [agent name flex-1] — model 曾以 shrink-0 span 在主行右侧
    const agentCallCards = wrapper.findAll('[data-testid="workflow-agent-call"]')
    expect(agentCallCards.length).toBe(1)
    // 主行是第一个 flex items-center gap-2 的 div
    const firstRow = agentCallCards[0].find('.flex.items-center.gap-2')
    // model 不应出现在主行文本里（主行只有 agent name）
    const mainRowText = firstRow.text()
    expect(mainRowText).not.toContain('claude-sonnet-4-5')
  })

  it('model 出现在摘要行（与 tokens/turns/duration 并列）', () => {
    const wrapper = mount(WorkflowDetail, { props: { workflow: makeWorkflow() } })
    // 摘要行：pl-[19px] 的 meta 行（font-mono text-[10px] text-subtle）
    const summaryLines = wrapper.findAll('.pl-\\[19px\\]')
    const allSummaryText = summaryLines.map((s) => s.text()).join(' ')
    expect(allSummaryText).toContain('claude-sonnet-4-5')
  })
})

// ── D4: SessionItem hover 按钮 top 定位 ─────────────────────
describe('D4: SessionItem hover 按钮重定位', () => {
  function makeSession() {
    return {
      id: 'sess-1',
      label: 'Test Session',
      cwd: '/Users/test/project',
      lastActiveAt: Date.now(),
    }
  }

  it('hover 按钮容器不再用 bottom-1 定位（改为 top 定位）', () => {
    const wrapper = mount(SessionItem, {
      props: {
        session: makeSession(),
        active: false,
        status: 'done' as never,
      },
    })
    // hover 按钮容器（absolute 定位的 div）
    const hoverContainer = wrapper.find('.absolute.bottom-1')
    expect(hoverContainer.exists()).toBe(false)
  })
})

// ── D5: SegmentedTab badge 位置微调 ─────────────────────────
describe('D5: SegmentedTab badge 微调', () => {
  it('badge 不再用 right-1 top-1（微调到 right-0 top-0 避免与 count 重叠）', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'subagents',
        sessionCount: 3,
        fileCount: 10,
        subagentCount: 2,
        workflowCount: 1,
        subagentRunningCount: 1,
        workflowRunningCount: 0,
      },
    })
    // badge 蓝点（absolute 定位的 span）
    const oldBadge = wrapper.find('.absolute.right-1.top-1')
    expect(oldBadge.exists()).toBe(false)
  })
})
