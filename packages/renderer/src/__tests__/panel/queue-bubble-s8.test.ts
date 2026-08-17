/**
 * QueueBubble S8 组件单测 —— v6 内嵌队列气泡（只读展示，无折叠）。
 *
 * v6 §8.5 视觉重构后行为（组件注释为准）：去独立卡片/去标签/去 chevron（不支持收起）、
 * 多条显前 3 条 + 「+N」溢出计数。本文件为 v6 重构后 stale 断言的同步修复
 * （对应 commit 5d46b9234 同类工作），断言对齐组件现状。
 *
 * 三视角覆盖：
 * - 观察者（形态）：单条/多条渲染结构、类型 icon（Zap=steer / Clock=followUp）、溢出计数
 * - 使用者（黑盒）：队列内容只读（无破坏性按钮）、点击无副作用
 * - 构建者（白盒）：state undefined/空时不渲染
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/queue-bubble-s8.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import QueueBubble from '@/components/panel/QueueBubble.vue'
import type { QueueState } from '@/stores/chat'

describe('QueueBubble S8', () => {
  it('state undefined → 不渲染', () => {
    const wrapper = mount(QueueBubble, { props: { state: undefined } })
    expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(false)
  })

  it('state 空（无 steering/followUp）→ 不渲染', () => {
    const wrapper = mount(QueueBubble, { props: { state: {} } })
    expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(false)
  })

  it('首屏冒烟：单条 steering → Zap icon + 内容渲染', () => {
    const state: QueueState = { steering: ['补充注册页校验'] }
    const wrapper = mount(QueueBubble, { props: { state } })
    expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(true)
    // v6：无「待发送」标签，直接渲染内容行
    expect(wrapper.text()).not.toContain('待发送')
    expect(wrapper.text()).toContain('补充注册页校验')
    // 类型 icon：steering → Zap（lucide class 含 zap）
    expect(wrapper.find('svg.lucide-zap').exists()).toBe(true)
    expect(wrapper.find('svg.lucide-clock').exists()).toBe(false)
  })

  it('单条 followUp → Clock icon + 内容渲染', () => {
    const state: QueueState = { followUp: ['下轮加 refresh token'] }
    const wrapper = mount(QueueBubble, { props: { state } })
    expect(wrapper.text()).toContain('下轮加 refresh token')
    expect(wrapper.find('svg.lucide-clock').exists()).toBe(true)
    expect(wrapper.find('svg.lucide-zap').exists()).toBe(false)
  })

  it('无 chevron（v6 去折叠，不支持收起）', () => {
    const state: QueueState = { steering: ['x'] }
    const wrapper = mount(QueueBubble, { props: { state } })
    expect(wrapper.find('svg.lucide-chevron-right').exists()).toBe(false)
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('多条 → steering 优先（pi 消费顺序），显前 3 条 + 溢出计数', () => {
    const state: QueueState = {
      steering: ['steer1', 'steer2'],
      followUp: ['fu1'],
    }
    const wrapper = mount(QueueBubble, { props: { state } })
    // 展平顺序：steering 全在前（3 条 ≤ VISIBLE_MAX，无溢出）
    expect(wrapper.text()).toContain('steer1')
    expect(wrapper.text()).toContain('steer2')
    expect(wrapper.text()).toContain('fu1')
    expect(wrapper.text()).not.toContain('+1')
  })

  it('超过 3 条 → 只显前 3 条 + 「+N」溢出计数', () => {
    const state: QueueState = {
      steering: ['s1', 's2', 's3', 's4'],
      followUp: ['f1', 'f2'],
    }
    const wrapper = mount(QueueBubble, { props: { state } })
    // 前 3 条：s1/s2/s3；f1/f2 与 s4 被截断，溢出 +3
    expect(wrapper.text()).toContain('s1')
    expect(wrapper.text()).toContain('s2')
    expect(wrapper.text()).toContain('s3')
    expect(wrapper.text()).toContain('+3')
    expect(wrapper.text()).not.toContain('s4')
  })

  it('只读：不渲染删除/dequeue/编辑/撤回等破坏性按钮', () => {
    const state: QueueState = { steering: ['x', 'y'], followUp: ['z'] }
    const wrapper = mount(QueueBubble, { props: { state } })
    // 语义断言：不存在任何带删除/移除/撤回 title 的按钮（而非脆弱的计数）
    for (const keyword of ['删除', '移除', '撤回', 'dequeue', 'remove', 'cancel', '编辑']) {
      expect(wrapper.find(`button[title*="${keyword}"]`).exists()).toBe(false)
    }
  })

  it('点击 item 文本无副作用（只读契约）', async () => {
    const state: QueueState = { steering: ['a', 'b'] }
    const wrapper = mount(QueueBubble, { props: { state } })
    // item 是 span（非按钮）。QueueBubble 无 defineEmits，不 emit 任何自定义事件。
    // 点击 item 文本不应触发移除/状态变化——队列内容不变即只读契约。
    const itemTextsBefore = wrapper.findAll('.qb-item-text').map((w) => w.text())
    const item = wrapper.findAll('.qb-item-text')[0]
    if (item?.exists()) {
      await item.trigger('click')
    }
    await nextTick()
    const itemTextsAfter = wrapper.findAll('.qb-item-text').map((w) => w.text())
    expect(itemTextsAfter).toEqual(itemTextsBefore) // 内容不变 = 无副作用
  })

  it('state 变化 → 列表内容跟随更新', async () => {
    const wrapper = mount(QueueBubble, { props: { state: { steering: ['a', 'b'] } } })
    expect(wrapper.text()).toContain('a')
    expect(wrapper.text()).toContain('b')
    // state 变化（新队列）→ 内容即时替换
    await wrapper.setProps({ state: { steering: ['c', 'd'] } })
    await nextTick()
    expect(wrapper.text()).toContain('c')
    expect(wrapper.text()).toContain('d')
    expect(wrapper.text()).not.toContain('a')
  })
})
