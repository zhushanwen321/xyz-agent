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

describe('SubagentList 布局结构（滚动修复）', () => {
  // 回归防护：根 div 缺 h-full 会导致 flex 高度传递链断裂，
  // 列表超长时 ScrollArea 不出现滚动条（CW topic: fix-sidebar-subagent-workflow-scroll）
  it('根 div 含 h-full + min-h-0 + flex-col（确保撑满父容器，ScrollArea flex-1 才能正确约束高度）', () => {
    const records = [makeRecord()]
    const wrapper = mount(SubagentList, { props: { subagents: records } })
    const root = wrapper.find('[data-testid="subagent-list"]')
    expect(root.exists()).toBe(true)
    expect(root.classes()).toContain('h-full')
    expect(root.classes()).toContain('min-h-0')
    expect(root.classes()).toContain('flex-col')
  })
})

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

  it('crashed 状态显示 danger 色点（与 failed 同为异常终态，不落 default bg-accent）', () => {
    const records = [makeRecord({ status: 'crashed', subagentId: 'run-crash-1' })]

    const wrapper = mount(SubagentList, {
      props: { subagents: records },
    })

    // crashed 不等于 running，不显示 spinner
    const spinner = wrapper.find('[data-testid="subagent-card-spinner"]')
    expect(spinner.exists()).toBe(false)

    // crashed 圆点含 bg-danger class（历史 bug：crashed 落 default 分支显示 bg-accent，与 done 视觉混淆）
    const dot = wrapper.find('.bg-danger')
    expect(dot.exists()).toBe(true)
  })

  // ── v4 B-1 closed 统一终态：按 closedReason/error 派生状态点颜色 ──

  it('closed + closedReason=gc + error → danger 色点（v4 真实失败终态）', () => {
    const records = [makeRecord({ status: 'closed', closedReason: 'gc', error: 'Model timeout', subagentId: 'run-closed-fail' })]
    const wrapper = mount(SubagentList, { props: { subagents: records } })

    expect(wrapper.find('[data-testid="subagent-card-spinner"]').exists()).toBe(false)
    expect(wrapper.find('.bg-danger').exists()).toBe(true)
  })

  it('closed + closedReason=cancelled → 中性色点（不落 danger/success）', () => {
    const records = [makeRecord({ status: 'closed', closedReason: 'cancelled', subagentId: 'run-closed-cancel' })]
    const wrapper = mount(SubagentList, { props: { subagents: records } })

    expect(wrapper.find('.bg-danger').exists()).toBe(false)
    expect(wrapper.find('.bg-success').exists()).toBe(false)
    expect(wrapper.find('.bg-neutral-dim').exists()).toBe(true)
  })

  it('closed 自然完成（parent-new 级联关闭等）→ success 色点', () => {
    const records = [makeRecord({ status: 'closed', closedReason: 'parent-new', subagentId: 'run-closed-ok' })]
    const wrapper = mount(SubagentList, { props: { subagents: records } })

    expect(wrapper.find('.bg-success').exists()).toBe(true)
    // 历史 bug 回归防护：closed 不落 default bg-accent（成功/失败语义丢失）
    expect(wrapper.find('.bg-accent').exists()).toBe(false)
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

  it('第一行 agent 名称右侧显示 slug（可见文本，非仅 hover title）', () => {
    const records = [makeRecord({ subagentId: 'bg-abc-1-1234567890', slug: 'review-changes', agent: 'reviewer' })]
    const wrapper = mount(SubagentList, { props: { subagents: records } })
    const card = wrapper.find('[data-testid="subagent-card"]')
    // slug 渲染为第一行可见元素（agent 名右侧，与 WorkflowList 对齐）
    const slugEl = wrapper.find('[data-testid="subagent-card-slug"]')
    expect(slugEl.exists()).toBe(true)
    expect(slugEl.text()).toBe('review-changes')
    // title 保留 agent + slug 全称
    expect(card.attributes('title')).toBe('reviewer · review-changes')
    // 完整 hash 不显示在卡片可见区域
    expect(card.text()).not.toContain('bg-abc-1-1234567890')
  })

  it('slug 空串（旧 session 无 slug 兜底）不渲染 slug 元素', () => {
    const records = [makeRecord({ slug: '' })]
    const wrapper = mount(SubagentList, { props: { subagents: records } })
    expect(wrapper.find('[data-testid="subagent-card-slug"]').exists()).toBe(false)
  })
})

// ── statusDotClass 六态映射（CRAP 37.1 定向：执行态四形态判据 × 终态色，用户可见 DOM 断言）──
//
// 六态（residual-fixes §5.4 等价公式 + v4 两态色板）：
//   1. running 真在跑          → spinner（Loader2 动画，无静态圆点）
//   2. running one-shot 轮终投影 → bg-success 绿点（result 有值且 chatMode 显式 false）
//   3. running 等续聊/孤儿兜底   → bg-accent opacity-60 半透明 accent 点
//   4. done（one-shot 终态）    → bg-success 绿点
//   5. failed/crashed          → bg-danger 红点
//   6. cancelled（含 closed+cancelled）→ bg-neutral-dim opacity-50 中性点
describe('SubagentList statusDotClass 六态映射', () => {
  /** 单卡片挂载，返回 dot 元素与 spinner 探测（隔离断言，防多卡片 class 串扰） */
  function mountDot(overrides: Partial<SubagentRecord>) {
    const wrapper = mount(SubagentList, { props: { subagents: [makeRecord(overrides)] } })
    return {
      dot: wrapper.find('span.rounded-full'),
      spinner: wrapper.find('[data-testid="subagent-card-spinner"]'),
    }
  }

  it('态1 running 真在跑（无 result、resumable 缺省）→ spinner，无静态圆点', () => {
    const { dot, spinner } = mountDot({ status: 'running', subagentId: 'dot-run-1' })
    expect(spinner.exists()).toBe(true)
    expect(dot.exists()).toBe(false)
  })

  it('态2 running one-shot 轮终投影（result 有值 + chatMode 显式 false）→ bg-success 绿点（非 spinner 非 accent）', () => {
    const { dot, spinner } = mountDot({
      status: 'running',
      result: '本轮产出正文',
      chatMode: false,
      subagentId: 'dot-done-proj-1',
    })
    expect(spinner.exists()).toBe(false)
    expect(dot.exists()).toBe(true)
    expect(dot.classes()).toContain('bg-success')
    expect(dot.classes()).not.toContain('bg-accent')
  })

  it('态3a running 等续聊（result 有值 + chatMode true）→ bg-accent opacity-60 半透明点（区别于 done 绿点）', () => {
    const { dot, spinner } = mountDot({
      status: 'running',
      result: '本轮产出正文',
      chatMode: true,
      subagentId: 'dot-wait-chat-1',
    })
    expect(spinner.exists()).toBe(false)
    expect(dot.exists()).toBe(true)
    expect(dot.classes()).toContain('bg-accent')
    expect(dot.classes()).toContain('opacity-60')
    expect(dot.classes()).not.toContain('bg-success')
  })

  it('态3b running + resumable=true（无活进程驱动的 running）→ 半透明 accent 点，不算真在跑', () => {
    const { dot, spinner } = mountDot({ status: 'running', resumable: true, subagentId: 'dot-wait-resumable-1' })
    expect(spinner.exists()).toBe(false)
    expect(dot.classes()).toContain('bg-accent')
    expect(dot.classes()).toContain('opacity-60')
  })

  it('态3c running + result 有值但 chatMode 缺省（无法确认非 chat）→ 保守落等待态半透明点，不宣告 done', () => {
    const { dot, spinner } = mountDot({ status: 'running', result: '产出', subagentId: 'dot-wait-default-1' })
    expect(spinner.exists()).toBe(false)
    expect(dot.classes()).toContain('bg-accent')
    expect(dot.classes()).toContain('opacity-60')
  })

  it('态4 done → bg-success 绿点', () => {
    const { dot, spinner } = mountDot({ status: 'done', subagentId: 'dot-done-1' })
    expect(spinner.exists()).toBe(false)
    expect(dot.classes()).toContain('bg-success')
  })

  it('态5 failed → bg-danger 红点（与 crashed 同异常终态色）', () => {
    const { dot } = mountDot({ status: 'failed', error: 'boom', subagentId: 'dot-failed-1' })
    expect(dot.classes()).toContain('bg-danger')
    expect(dot.classes()).not.toContain('bg-success')
  })

  it('态6 cancelled → bg-neutral-dim opacity-50 中性点（非 accent 非绿非红）', () => {
    const { dot } = mountDot({ status: 'cancelled', subagentId: 'dot-cancel-1' })
    expect(dot.classes()).toContain('bg-neutral-dim')
    expect(dot.classes()).toContain('opacity-50')
    expect(dot.classes()).not.toContain('bg-accent')
    expect(dot.classes()).not.toContain('bg-success')
    expect(dot.classes()).not.toContain('bg-danger')
  })
})

/**
 * 引擎 icon 三分支（U3 D8/D9）：record.engine → item 最左 icon。
 * 三视角：使用者 DOM 断言（icon 存在 + viewBox/形状区分三分支 + title 引擎名）。
 */
describe('SubagentList 引擎 icon（U3 D8 三分支 / D9 最左位置）', () => {
  function mountIcon(overrides: Partial<SubagentRecord> = {}) {
    const wrapper = mount(SubagentList, { props: { subagents: [makeRecord(overrides)] } })
    return wrapper.find('[data-testid="subagent-engine-icon"]')
  }

  it('分支1 engine 缺省 → pi icon（viewBox 0 0 800 800 像素几何块），title 显示 pi', () => {
    const icon = mountIcon()
    expect(icon.exists()).toBe(true)
    expect(icon.attributes('viewBox')).toBe('0 0 800 800')
    expect(icon.attributes('title')).toBe('pi')
  })

  it('分支1 engine 空串 → 同样落 pi 缺省映射', () => {
    const icon = mountIcon({ engine: '' })
    expect(icon.attributes('viewBox')).toBe('0 0 800 800')
    expect(icon.attributes('title')).toBe('pi')
  })

  it('分支2 engine=zcode → zcode icon（viewBox 0 0 24 24 path），title 显示 zcode', () => {
    const icon = mountIcon({ engine: 'zcode' })
    expect(icon.exists()).toBe(true)
    expect(icon.attributes('viewBox')).toBe('0 0 24 24')
    expect(icon.find('path').exists()).toBe(true)
    expect(icon.attributes('title')).toBe('zcode')
  })

  it('分支3 engine=未知 id → 中性圆点（Circle，防御分支），title 原样透出 id', () => {
    const icon = mountIcon({ engine: 'unknown-x' })
    expect(icon.exists()).toBe(true)
    expect(icon.find('circle').exists()).toBe(true)
    expect(icon.find('path').exists()).toBe(false)
    expect(icon.attributes('title')).toBe('unknown-x')
  })

  it('icon 是 item 第一元素（状态指示 spinner/statusDot 之前，D9）', () => {
    const wrapper = mount(SubagentList, {
      props: { subagents: [makeRecord({ status: 'running' })] },
    })
    const card = wrapper.find('[data-testid="subagent-card"]')
    const first = card.find('.flex.items-center > *')
    expect(first.attributes('data-testid')).toBe('subagent-engine-icon')
    // 状态指示（spinner）紧随其后
    expect(card.find('[data-testid="subagent-card-spinner"]').exists()).toBe(true)
  })
})
