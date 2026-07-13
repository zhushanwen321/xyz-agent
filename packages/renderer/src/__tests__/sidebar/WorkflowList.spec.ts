/**
 * WorkflowList 组件测试。
 *
 * 覆盖：
 * - 渲染 workflow 卡片列表（scriptName + slug + 进度条 + 摘要 + 状态点）
 * - running 态显示 spinner
 * - 空态展示
 * - 点击卡片触发 select 事件
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/WorkflowList.spec.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import WorkflowList from '@/components/sidebar/WorkflowList.vue'
import type { WorkflowRunRecord } from '@xyz-agent/shared'

function makeRecord(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId: 'wf-test-001',
    scriptName: 'test-flow',
    slug: 'deploy',
    status: 'done',
    reason: 'completed',
    startedAt: '2026-07-10T10:00:00Z',
    completedAt: '2026-07-10T10:30:00Z',
    usedTokens: 50000,
    totalCallCount: 2,
    agentCalls: [
      { id: 0, agent: 'dev-W1', status: 'completed', phase: 'Dev' },
      { id: 1, agent: 'dev-W2', status: 'completed', phase: 'Dev' },
    ],
    stateFilePath: '/data/wf-test-001.jsonl',
    ...overrides,
  }
}

describe('WorkflowList', () => {
  it('渲染 workflow 卡片列表（含 scriptName + slug + 进度）', () => {
    const records = [
      makeRecord({ runId: 'wf-a', scriptName: 'deploy-flow', slug: 'prod' }),
      makeRecord({ runId: 'wf-b', scriptName: 'test-flow', slug: 'ci' }),
    ]

    const wrapper = mount(WorkflowList, {
      props: { workflows: records },
    })

    const cards = wrapper.findAll('[data-testid="workflow-card"]')
    expect(cards).toHaveLength(2)

    // 第一张卡片含 scriptName + slug
    expect(cards[0].text()).toContain('deploy-flow')
    expect(cards[0].text()).toContain('prod')
    // 含 agent 完成比例
    expect(cards[0].text()).toContain('2/2 agents')
  })

  it('running 态显示 spinner', () => {
    const records = [makeRecord({ runId: 'wf-run', status: 'running' })]
    const wrapper = mount(WorkflowList, { props: { workflows: records } })

    expect(wrapper.find('[data-testid="workflow-card-spinner"]').exists()).toBe(true)
  })

  it('空态展示提示文案', () => {
    const wrapper = mount(WorkflowList, { props: { workflows: [] } })

    expect(wrapper.find('[data-testid="workflow-list-empty"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('暂无工作流')
  })

  it('点击卡片触发 select 事件', () => {
    const records = [makeRecord({ runId: 'wf-click' })]
    const wrapper = mount(WorkflowList, { props: { workflows: records } })

    wrapper.find('[data-testid="workflow-card"]').trigger('click')

    expect(wrapper.emitted('select')).toBeTruthy()
    expect(wrapper.emitted('select')![0]).toEqual(['wf-click'])
  })

  it('running 态渲染 Pause + Abort 按钮，点击触发 action 事件', () => {
    const records = [makeRecord({ runId: 'wf-run', status: 'running' })]
    const wrapper = mount(WorkflowList, { props: { workflows: records } })

    // running 态有 pause + abort 按钮
    expect(wrapper.find('[data-testid="workflow-action-pause"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workflow-action-abort"]').exists()).toBe(true)

    // 点击 abort 按钮
    wrapper.find('[data-testid="workflow-action-abort"]').trigger('click')

    expect(wrapper.emitted('action')).toBeTruthy()
    expect(wrapper.emitted('action')![0]).toEqual([{ action: 'abort', runId: 'wf-run' }])
  })

  it('done 态不渲染操作按钮', () => {
    const records = [makeRecord({ runId: 'wf-done', status: 'done' })]
    const wrapper = mount(WorkflowList, { props: { workflows: records } })

    expect(wrapper.find('[data-testid="workflow-action-abort"]').exists()).toBe(false)
  })
})
