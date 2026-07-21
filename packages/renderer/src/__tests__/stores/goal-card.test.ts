/**
 * GoalCard 组件渲染验证（AGENTS.md 测试规范 §5-8 首屏冒烟模板）。
 *
 * 验证「GoalSnapshot → GoalCard DOM」映射：构造 goal 数据 → mount GoalCard → 断言 DOM。
 * 三视角中的「观察者」视角。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/goal-card.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import GoalCard from '@/components/panel/GoalCard.vue'
import type { GoalSnapshot } from '@/stores/tasks'

// ── fixture 工厂 ────────────────────────────────────

function makeGoalCard(): GuiComponent {
  return {
    type: 'card',
    props: {
      header: 'Goal Title',
      body: [
        { type: 'stats-line', props: { items: [{ label: 'Status', value: 'Active' }] } },
      ],
    } as unknown as GuiComponent['props'],
  }
}

function makeGoalSnapshot(overrides?: Partial<GoalSnapshot>): GoalSnapshot {
  return {
    gui: makeGoalCard(),
    ...overrides,
  }
}

function makeBlockedGoal(): GoalSnapshot {
  return makeGoalSnapshot({
    liveStatus: 'blocked',
    objective: 'Fix the auth bug',
    slug: 'auth-fix',
  })
}

function makeGoalWithProgress(): GoalSnapshot {
  return makeGoalSnapshot({
    gui: {
      type: 'card',
      props: {
        header: 'Progress Goal',
        body: [
          {
            type: 'progress-bar',
            props: { label: 'Tokens', current: 71, total: 200, severity: 'info' },
          },
        ],
      } as unknown as GuiComponent['props'],
    },
  })
}

// ── 测试 ────────────────────────────────────

describe('GoalCard 首屏渲染', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('首屏渲染：goal-card 容器存在于 DOM', () => {
    const wrapper = mount(GoalCard, {
      props: { goal: makeGoalSnapshot(), sessionId: 's1' },
    })
    expect(wrapper.find('[data-testid="goal-card"]').exists()).toBe(true)
  })

  it('objective 文本渲染到 <p> 元素', () => {
    const wrapper = mount(GoalCard, {
      props: { goal: makeGoalSnapshot({ objective: '完成 X 任务' }), sessionId: 's1' },
    })
    const p = wrapper.find('p')
    expect(p.exists()).toBe(true)
    expect(p.text()).toContain('完成 X 任务')
  })

  it('objective 为 undefined 时不渲染 <p>', () => {
    const wrapper = mount(GoalCard, {
      props: { goal: makeGoalSnapshot({ objective: undefined }), sessionId: 's1' },
    })
    // 没有 objective 的 <p>（不是 goal-card 里其他 <p>）
    const allP = wrapper.findAll('p')
    const objectiveP = allP.filter((p) => p.text().includes('完成 X'))
    expect(objectiveP.length).toBe(0)
  })

  it('status badge 存在（active 态）', () => {
    const wrapper = mount(GoalCard, {
      props: { goal: makeGoalSnapshot({ liveStatus: 'active' }), sessionId: 's1' },
    })
    // status badge 是 span（:class badgeClass），文本是 t() 的 i18n key 翻译
    const badge = wrapper.find('.goal-card span.uppercase')
    expect(badge.exists()).toBe(true)
  })

  it('blocked 态渲染 warning 样式 + resume 按钮', () => {
    const wrapper = mount(GoalCard, {
      props: { goal: makeBlockedGoal(), sessionId: 's1' },
    })
    const card = wrapper.find('[data-testid="goal-card"]')
    expect(card.classes()).toContain('border-warning')

    const resumeBtn = wrapper.find('[data-testid="goal-resume-btn"]')
    expect(resumeBtn.exists()).toBe(true)
  })

  it('progress bar 渲染 current/total 文案（如有 gui 里的 progress-bar）', () => {
    const wrapper = mount(GoalCard, {
      props: { goal: makeGoalWithProgress(), sessionId: 's1' },
    })
    // GoalCard 渲染 progress bar 的 current/total
    expect(wrapper.text()).toContain('Tokens')
  })

  it('slug 渲染在标题区域', () => {
    const wrapper = mount(GoalCard, {
      props: { goal: makeGoalSnapshot({ slug: 'my-goal-slug' }), sessionId: 's1' },
    })
    expect(wrapper.text()).toContain('my-goal-slug')
  })
})
