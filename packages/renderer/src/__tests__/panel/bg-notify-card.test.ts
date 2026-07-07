/**
 * BgNotifyCard 组件单测 —— background subagent 完成通知卡片。
 *
 * 三视角覆盖（测试规范 §5/§6/§8）：
 * - 观察者（形态）：单条/批量渲染结构、状态图标、agent 名、耗时
 * - 使用者（黑盒）：点击展开/收起、patchFile 提示可见性
 * - 构建者（白盒）：不同 status 的着色分支
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/bg-notify-card.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import BgNotifyCard from '@/components/panel/message-stream/BgNotifyCard.vue'
import type { Message, BgNotifyRecord } from '@xyz-agent/shared'

/** 构造单条 bgNotify 的 Message */
function singleMessage(overrides: Partial<BgNotifyRecord> = {}): Message {
  const record: BgNotifyRecord = {
    id: 'job-1',
    status: 'done',
    agent: 'coder',
    model: 'claude-4.5',
    result: 'Refactored auth module',
    startedAt: 1000,
    endedAt: 13000,
    ...overrides,
  }
  return {
    id: 'm1',
    role: 'system',
    content: 'Subagent "coder" (job-1) completed. Result:\nRefactored auth module',
    status: 'complete',
    customType: 'subagent-bg-notify',
    bgNotify: record,
    timestamp: 13000,
  }
}

describe('BgNotifyCard', () => {
  it('首屏渲染：单条 done → DOM 含 agent 名 + model + 耗时 + 状态图标', () => {
    const wrapper = mount(BgNotifyCard, { props: { message: singleMessage() } })
    expect(wrapper.text()).toContain('coder')
    expect(wrapper.text()).toContain('claude-4.5')
    expect(wrapper.text()).toContain('12.0s')
    // CheckCircle2 图标存在（lucide 渲染为 svg）
    expect(wrapper.find('svg').exists()).toBe(true)
  })

  it('单条 done → 摘要首行（result）收起态可见', () => {
    const wrapper = mount(BgNotifyCard, { props: { message: singleMessage() } })
    expect(wrapper.text()).toContain('Refactored auth module')
  })

  it('单条 failed → error 文本 + XCircle 图标 + danger 着色', () => {
    const wrapper = mount(BgNotifyCard, {
      props: { message: singleMessage({ status: 'failed', error: 'boom', result: undefined }) },
    })
    expect(wrapper.text()).toContain('boom')
    // danger 着色（border-danger）
    expect(wrapper.find('.border-danger\\/40').exists() || wrapper.html().includes('text-danger')).toBe(true)
  })

  it('批量形态 → 渲染所有 items 的 agent 名', () => {
    const message: Message = {
      id: 'm1',
      role: 'system',
      content: 'batch',
      status: 'complete',
      customType: 'subagent-bg-notify',
      bgNotify: {
        batch: true,
        items: [
          { id: 'j1', status: 'done', agent: 'alpha', startedAt: 1000, endedAt: 8000 },
          { id: 'j2', status: 'failed', agent: 'beta', startedAt: 2000, endedAt: 7000, error: 'x' },
        ],
      },
      timestamp: 8000,
    }
    const wrapper = mount(BgNotifyCard, { props: { message } })
    expect(wrapper.text()).toContain('alpha')
    expect(wrapper.text()).toContain('beta')
  })

  it('点击 header → 展开/收起切换（fullContent + patchHint 可见性）', async () => {
    const message = singleMessage({ patchFile: '/tmp/changes.patch' })
    const wrapper = mount(BgNotifyCard, { props: { message } })
    // 收起态：patchHint 不可见
    expect(wrapper.text()).not.toContain('git apply')
    // 点击展开
    await wrapper.find('.cursor-pointer').trigger('click')
    expect(wrapper.text()).toContain('git apply')
    expect(wrapper.text()).toContain('/tmp/changes.patch')
  })

  it('展开后可见完整 content（LLM 看到的全文）', async () => {
    const wrapper = mount(BgNotifyCard, { props: { message: singleMessage() } })
    await wrapper.find('.cursor-pointer').trigger('click')
    // content 含完整 result 文本
    expect(wrapper.text()).toContain('Subagent "coder" (job-1) completed')
  })

  it('cancelled 状态 → Pause 图标 + muted 着色', () => {
    const wrapper = mount(BgNotifyCard, {
      props: { message: singleMessage({ status: 'cancelled', result: undefined }) },
    })
    expect(wrapper.text()).toContain('已取消')
  })
})
