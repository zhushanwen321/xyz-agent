/**
 * ContextCapacityPopover 订阅测试（W6 · Q1 修复）。
 *
 * 锁定：模型切换后 session.state_changed 广播驱动用量刷新（无需等 agent_end）。
 * 组件订阅 session 通道的 context.update + session.state_changed，按 sessionId 过滤。
 *
 * mock 策略：mount 组件（HoverCard 子组件默认渲染），events.dispatchSession 模拟推送，
 * 断言按钮文案（「万·%」格式）反映最新用量。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/panel/context-capacity-popover.test.ts
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

    // 按钮文案格式「{used}万 · {percent}%」—— 12000 → 1.2万
    const text = wrapper.find('[title="上下文容量"]').text()
    expect(text).toContain('1.2万')
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

    // 未收到目标 session 的推送，hasData=false → 按钮隐藏（v-show 设 display:none）
    const btn = wrapper.find('[title="上下文容量"]')
    expect(btn.element.style.display).toBe('none')
  })

  it('U31: 切换后 contextLimit=0（模型未配 contextWindow）→ hasData=false，按钮隐藏', async () => {
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

    // contextLimit=0 → hasData=false → 按钮隐藏
    const btn = wrapper.find('[title="上下文容量"]')
    expect(btn.element.style.display).toBe('none')
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
    expect(text).toContain('5万')
    expect(text).toContain('50%')
  })
})
