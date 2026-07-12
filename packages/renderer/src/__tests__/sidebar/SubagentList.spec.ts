/**
 * SubagentList 组件测试。
 *
 * 覆盖：
 * - 渲染 subagent 卡片列表（agent 名称 + task + turns + 状态点）
 * - 空态展示
 * - 点击卡片触发 select 事件
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/SubagentList.spec.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SubagentList from '@/components/sidebar/SubagentList.vue'
import type { SubagentRecord } from '@xyz-agent/shared'

function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: 'run-test-1',
    sessionFile: '/data/sub.jsonl',
    agent: 'reviewer',
    task: 'Review the code changes',
    mode: 'sync',
    status: 'done',
    turns: 5,
    totalTokens: 10000,
    elapsedSeconds: 60,
    ...overrides,
  }
}

describe('SubagentList', () => {
  it('渲染 subagent 卡片列表', () => {
    const records = [
      makeRecord({ subagentId: 'run-a-1', agent: 'reviewer', task: 'Review code', turns: 5, totalTokens: 10000, elapsedSeconds: 60 }),
      makeRecord({ subagentId: 'run-b-2', agent: 'worker', task: 'Fix bug', turns: 10, totalTokens: 20000, elapsedSeconds: 120 }),
    ]

    const wrapper = mount(SubagentList, {
      props: { subagents: records },
    })

    const cards = wrapper.findAll('[data-testid="subagent-card"]')
    expect(cards).toHaveLength(2)

    // 第一张卡片含 agent 名称
    expect(cards[0].text()).toContain('reviewer')
    // 含 task 文本
    expect(cards[0].text()).toContain('Review code')
    // 含 turns 计数
    expect(cards[0].text()).toContain('5 turns')
  })

  it('空态展示提示文案', () => {
    const wrapper = mount(SubagentList, {
      props: { subagents: [] },
    })

    const empty = wrapper.find('[data-testid="subagent-list-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('暂无后台任务')
  })

  it('点击卡片触发 select 事件', async () => {
    const records = [makeRecord({ subagentId: 'run-click-1' })]

    const wrapper = mount(SubagentList, {
      props: { subagents: records },
    })

    const card = wrapper.find('[data-testid="subagent-card"]')
    await card.trigger('click')

    const emitted = wrapper.emitted('select')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('run-click-1')
  })

  it('running 状态显示 spinner', () => {
    const records = [makeRecord({ status: 'running', subagentId: 'run-spin-1' })]

    const wrapper = mount(SubagentList, {
      props: { subagents: records },
    })

    const spinner = wrapper.find('[data-testid="subagent-card-spinner"]')
    expect(spinner.exists()).toBe(true)
  })

  it('done 状态不显示 spinner，显示绿点', () => {
    const records = [makeRecord({ status: 'done', subagentId: 'run-done-1' })]

    const wrapper = mount(SubagentList, {
      props: { subagents: records },
    })

    const spinner = wrapper.find('[data-testid="subagent-card-spinner"]')
    expect(spinner.exists()).toBe(false)

    // done 状态的圆点含 bg-success class
    const dot = wrapper.find('.bg-success')
    expect(dot.exists()).toBe(true)
  })
})
