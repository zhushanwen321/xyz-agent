/**
 * QueueBubble S8 组件单测 —— 双队列分栏 + 折叠/展开 + 只读展示。
 *
 * 三视角覆盖：
 * - 观察者（形态）：单条/多条渲染结构、分组标签、计数摘要、FIFO 序号
 * - 使用者（黑盒）：点击 head 折叠/展开切换、单条不可折叠
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
    expect(wrapper.find('.rounded-md').exists()).toBe(false)
  })

  it('state 空（无 steering/followUp）→ 不渲染', () => {
    const wrapper = mount(QueueBubble, { props: { state: {} } })
    expect(wrapper.find('.rounded-md').exists()).toBe(false)
  })

  it('首屏冒烟：单条 steering → 渲染待发送标签 + STEER 追加 + 内容', () => {
    const state: QueueState = { steering: ['补充注册页校验'] }
    const wrapper = mount(QueueBubble, { props: { state } })
    expect(wrapper.text()).toContain('待发送')
    expect(wrapper.text()).toContain('STEER 追加')
    expect(wrapper.text()).toContain('补充注册页校验')
  })

  it('单条 followUp → 渲染 FOLLOWUP 新轮 标签 + 内容', () => {
    const state: QueueState = { followUp: ['下轮加 refresh token'] }
    const wrapper = mount(QueueBubble, { props: { state } })
    expect(wrapper.text()).toContain('FOLLOWUP 新轮')
    expect(wrapper.text()).toContain('下轮加 refresh token')
  })

  it('单条 → 无 chevron（不可折叠，直接展开）', () => {
    const state: QueueState = { steering: ['x'] }
    const wrapper = mount(QueueBubble, { props: { state } })
    // 单条不渲染 chevron（canToggle=false）
    expect(wrapper.find('svg.lucide-chevron-right').exists()).toBe(false)
  })

  it('多条 → 默认折叠，head 显计数摘要（steering N · followUp M）', () => {
    const state: QueueState = {
      steering: ['steer1', 'steer2'],
      followUp: ['fu1'],
    }
    const wrapper = mount(QueueBubble, { props: { state } })
    // head 摘要
    expect(wrapper.text()).toContain('3 条')
    expect(wrapper.text()).toContain('steering 2')
    expect(wrapper.text()).toContain('followUp 1')
    // 折叠态：不显示逐条列表的序号（展开才有）
    expect(wrapper.text()).not.toContain('STEERING')
    expect(wrapper.text()).not.toContain('先生效')
  })

  it('多条 → 点击 head 展开，显双组逐条列表 + FIFO 序号', async () => {
    const state: QueueState = {
      steering: ['steer1', 'steer2'],
      followUp: ['fu1'],
    }
    const wrapper = mount(QueueBubble, { props: { state } })
    // 点击 head button
    await wrapper.find('button').trigger('click')
    await nextTick()
    // 展开后显示分组标签 + 副文案 + 序号
    expect(wrapper.text()).toContain('STEERING')
    expect(wrapper.text()).toContain('先生效')
    expect(wrapper.text()).toContain('FOLLOWUP')
    expect(wrapper.text()).toContain('后生效')
    expect(wrapper.text()).toContain('生效顺序')
    // FIFO 序号 1、2
    expect(wrapper.text()).toContain('1')
    expect(wrapper.text()).toContain('2')
  })

  it('多条 → 再次点击 head 收起', async () => {
    const state: QueueState = { steering: ['a', 'b'] }
    const wrapper = mount(QueueBubble, { props: { state } })
    const head = wrapper.find('button')
    await head.trigger('click')
    await nextTick()
    expect(wrapper.text()).toContain('STEERING')
    await head.trigger('click')
    await nextTick()
    expect(wrapper.text()).not.toContain('STEERING')
  })

  it('只读：不渲染任何删除/dequeue/编辑按钮', () => {
    const state: QueueState = { steering: ['x', 'y'], followUp: ['z'] }
    const wrapper = mount(QueueBubble, { props: { state } })
    // 只有 1 个 button（head toggle），无其他操作按钮
    expect(wrapper.findAll('button')).toHaveLength(1)
  })

  it('state 变化重置折叠态', async () => {
    const state1: QueueState = { steering: ['a', 'b'] }
    const wrapper = mount(QueueBubble, { props: { state: state1 } })
    await wrapper.find('button').trigger('click')
    await nextTick()
    expect(wrapper.text()).toContain('STEERING')
    // state 变化（新队列）→ 重置折叠
    await wrapper.setProps({ state: { steering: ['c', 'd'] } })
    await nextTick()
    expect(wrapper.text()).not.toContain('STEERING')
  })
})
