/**
 * ContextCapacityPopover 订阅测试（W6 · Q1 修复）。
 *
 * 锁定：模型切换后 session.state_changed 广播驱动用量刷新（无需等 agent_end）。
 * 组件订阅 session 通道的 context.update + session.state_changed，按 sessionId 过滤。
 *
 * mock 策略：mount 组件（HoverCard 子组件默认渲染），events.dispatchSession 模拟推送，
 * 断言按钮文案（「万·%」格式）反映最新用量。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/context-capacity-popover.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import * as events from '@/api/events'
import type { ServerMessage } from '@xyz-agent/shared'

import ContextCapacityPopover from '@/components/panel/ContextCapacityPopover.vue'

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 模拟 runtime 推送 session 通道消息 */
function pushSessionMsg(sid: string, msg: ServerMessage): void {
  events.dispatchSession(sid, msg)
}

describe('ContextCapacityPopover 订阅 session.state_changed', () => {
  it('U29: 收到 state_changed（含用量）→ 按钮显示新用量', async () => {
    const wrapper = mount(ContextCapacityPopover, {
      props: { sessionId: 's1' },
    })
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'session.state_changed',
      id: 'push-1',
      payload: {
        sessionId: 's1',
        modelId: 'anthropic/claude-4',
        thinkingLevel: 'high',
        usagePercent: 6,
        inputTokens: 12000,
        contextLimit: 200000,
      },
    })
    await flushPromises()

    // 按钮文案格式「{used}K · {percent}%」—— 12000 → 12K
    const text = wrapper.find('[title="上下文容量"]').text()
    expect(text).toContain('12K')
    expect(text).toContain('6%')
  })

  it('U30: 其他 session 的 state_changed 不影响当前组件', async () => {
    const wrapper = mount(ContextCapacityPopover, {
      props: { sessionId: 's1' },
    })
    await flushPromises()

    pushSessionMsg('other-session', {
      type: 'session.state_changed',
      id: 'push-2',
      payload: {
        sessionId: 'other-session',
        modelId: 'x/y',
        usagePercent: 99,
        inputTokens: 99000,
        contextLimit: 100000,
      },
    })
    await flushPromises()

    // 未收到目标 session 的推送，hasUsage=false → 按钮始终显示，用量显「—」
    const btn = wrapper.find('[title="上下文容量"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('—')
  })

  it('U31: contextLimit=0 且 inputTokens=0（未跑过 agent）→ 按钮显示「—」占位', async () => {
    const wrapper = mount(ContextCapacityPopover, {
      props: { sessionId: 's2' },
    })
    await flushPromises()

    pushSessionMsg('s2', {
      type: 'session.state_changed',
      id: 'push-3',
      payload: {
        sessionId: 's2',
        modelId: 'p/m',
        usagePercent: 0,
        inputTokens: 0,
        contextLimit: 0,
      },
    })
    await flushPromises()

    // 未跑过 agent（used=0）→ 按钮始终显示，用量显「—」
    const btn = wrapper.find('[title="上下文容量"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('—')
  })

  it('contextLimit=0 但 inputTokens>0（provider 未配 contextWindow）→ 按钮显示已用量，不显百分比', async () => {
    const wrapper = mount(ContextCapacityPopover, {
      props: { sessionId: 's4' },
    })
    await flushPromises()

    pushSessionMsg('s4', {
      type: 'context.update',
      id: 'ctx-no-window',
      payload: { sessionId: 's4', usagePercent: 0, inputTokens: 69000, contextLimit: 0 },
    })
    await flushPromises()

    // hasUsage=true → 按钮显示；但 hasPercent=false → 只显用量无百分比
    const btn = wrapper.find('[title="上下文容量"]')
    expect(btn.element.style.display).not.toBe('none')
    const text = btn.text()
    expect(text).toContain('69K')
    // 无百分比：按钮文字不含 % 号
    expect(text).not.toContain('%')
  })

  it('context.update 仍正常工作（不回归）', async () => {
    const wrapper = mount(ContextCapacityPopover, {
      props: { sessionId: 's3' },
    })
    await flushPromises()

    pushSessionMsg('s3', {
      type: 'context.update',
      id: 'ctx-1',
      payload: { sessionId: 's3', usagePercent: 50, inputTokens: 50000, contextLimit: 100000 },
    })
    await flushPromises()

    const text = wrapper.find('[title="上下文容量"]').text()
    expect(text).toContain('50K')
    expect(text).toContain('50%')
  })

  it('大数显 M（≥100万 token）', async () => {
    const wrapper = mount(ContextCapacityPopover, {
      props: { sessionId: 's5' },
    })
    await flushPromises()

    pushSessionMsg('s5', {
      type: 'context.update',
      id: 'ctx-big',
      payload: { sessionId: 's5', usagePercent: 80, inputTokens: 1630000, contextLimit: 2000000 },
    })
    await flushPromises()

    // 1630000 → 1.6M
    const text = wrapper.find('[title="上下文容量"]').text()
    expect(text).toContain('1.6M')
    expect(text).toContain('80%')
  })
})
