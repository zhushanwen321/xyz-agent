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
    subagentId: 'bg-test-1-111',
    sessionFile: '/data/sub.jsonl',
    agent: 'reviewer',
    slug: 'review-changes',
    task: 'Review the code changes',
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

  // ── cancel 两段式确认（W3 新增）──

  it('running 态渲染 cancel 按钮，done 态不渲染', () => {
    const running = mount(SubagentList, { props: { subagents: [makeRecord({ status: 'running', subagentId: 'run-cancel-1' })] } })
    expect(running.findAll('[data-testid="subagent-action-cancel"]')).toHaveLength(1)

    const done = mount(SubagentList, { props: { subagents: [makeRecord({ status: 'done', subagentId: 'run-cancel-2' })] } })
    expect(done.findAll('[data-testid="subagent-action-cancel"]')).toHaveLength(0)
  })

  it('cancel 两段式：首次点击进入确认态（不 emit），再次点击才 emit cancel', async () => {
    const records = [makeRecord({ status: 'running', subagentId: 'bg-cancel-1' })]
    const wrapper = mount(SubagentList, { props: { subagents: records } })

    const btn = wrapper.find('[data-testid="subagent-action-cancel"]')
    // 第一次点击：进入确认态，不 emit
    await btn.trigger('click')
    expect(wrapper.emitted('cancel')).toBeFalsy()

    // 确认态出现确认按钮
    const confirmBtn = wrapper.find('[data-testid="subagent-action-cancel-confirm"]')
    expect(confirmBtn.exists()).toBe(true)

    // 第二次点击确认 → emit cancel
    await confirmBtn.trigger('click')
    const emitted = wrapper.emitted('cancel')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('bg-cancel-1')
  })

  // ── slug 替换 hash（W3 新增）──

  it('卡片右侧显示 slug 而非 subagentId hash', () => {
    const records = [makeRecord({ subagentId: 'bg-abc-1-1234567890', slug: 'review-changes', agent: 'reviewer' })]
    const wrapper = mount(SubagentList, { props: { subagents: records } })
    const card = wrapper.find('[data-testid="subagent-card"]')
    // slug 显示在卡片中
    expect(card.text()).toContain('review-changes')
    // 完整 hash 不显示在卡片可见区域（已截断或移到 title）
    expect(card.text()).not.toContain('bg-abc-1-1234567890')
  })
})
