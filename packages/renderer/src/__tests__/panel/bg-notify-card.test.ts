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
import { h } from 'vue'
import BgNotifyCard from '@/components/panel/message-stream/BgNotifyCard.vue'
import type { Message, BgNotifyRecord } from '@xyz-agent/shared'

/** fullContent 现在走 MarkdownRenderer（W2），stub 掉避免依赖 shiki/useFileSearch 等。
 *  stub 渲染 content prop 文本即可验证展开/收起态内容可见性。 */
const mdStub = {
  name: 'MarkdownRenderer',
  props: { content: { type: String, default: '' }, variant: { type: String, default: undefined } },
  setup(props: { content: string }) {
    return () => h('div', { class: 'stub-md-render' }, props.content)
  },
}

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
    const wrapper = mount(BgNotifyCard, { props: { message }, global: { stubs: { MarkdownRenderer: mdStub } } })
    // 收起态：patchHint 不可见
    expect(wrapper.text()).not.toContain('git apply')
    // 点击展开
    await wrapper.find('.cursor-pointer').trigger('click')
    expect(wrapper.text()).toContain('git apply')
    expect(wrapper.text()).toContain('/tmp/changes.patch')
  })

  it('展开后可见完整 content（LLM 看到的全文）', async () => {
    const wrapper = mount(BgNotifyCard, { props: { message: singleMessage() }, global: { stubs: { MarkdownRenderer: mdStub } } })
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

  // ── v4 B-1 两态契约：closed（closedReason 派生）+ running（轮次完成）──

  it('v4 closed + closedReason=gc + error → failed 样式（XCircle + danger 着色 + error 优先于 result 显示）', () => {
    const wrapper = mount(BgNotifyCard, {
      props: {
        message: singleMessage({
          status: 'closed',
          closedReason: 'gc',
          error: 'Model timeout',
          result: 'partial result',
        }),
      },
    })
    // error 优先于 result 显示在摘要首行（历史 bug：closed+error 渲染为成功卡显示 result）
    expect(wrapper.text()).toContain('Model timeout')
    expect(wrapper.find('p').text()).not.toContain('partial result')
    // danger 着色（卡片边框或图标文字色）
    expect(wrapper.find('.border-danger\\/40').exists() || wrapper.html().includes('text-danger')).toBe(true)
  })

  it('v4 closed + closedReason=cancelled → cancelled 样式（已取消文案 + 中性边框）', () => {
    const wrapper = mount(BgNotifyCard, {
      props: {
        message: singleMessage({ status: 'closed', closedReason: 'cancelled', result: undefined }),
      },
    })
    expect(wrapper.text()).toContain('已取消')
    expect(wrapper.find('.border-neutral-mid\\/30').exists()).toBe(true)
  })

  it('v4 closed 自然完成（无 closedReason/error）→ 成功样式（CheckCircle2 + 默认边框 + result 显示）', () => {
    const wrapper = mount(BgNotifyCard, {
      props: {
        message: singleMessage({ status: 'closed', closedReason: 'parent-new', error: undefined }),
      },
    })
    // 非失败非取消 → 默认边框（不落 danger/cancelled 边框）
    expect(wrapper.find('.border-danger\\/40').exists()).toBe(false)
    expect(wrapper.find('.border-neutral-mid\\/30').exists()).toBe(false)
    expect(wrapper.text()).toContain('Refactored auth module')
  })

  it('v4 running（轮次完成）→ 轮次文案 + accent 着色（非终态，等待续聊）', () => {
    const wrapper = mount(BgNotifyCard, {
      props: {
        message: singleMessage({ status: 'running', round: 2, result: 'round 2 output', error: undefined }),
      },
    })
    // 轮次文案（finished a round 语义，含轮次号）
    expect(wrapper.text()).toContain('第 2 轮完成')
    // accent 着色（区别于终态成功的 neutral-fg）
    expect(wrapper.html()).toContain('text-accent')
    // 本轮结果仍显示
    expect(wrapper.text()).toContain('round 2 output')
  })

  it('v4 running 无 round → 退「完成一轮」文案', () => {
    const wrapper = mount(BgNotifyCard, {
      props: { message: singleMessage({ status: 'running', result: undefined, error: undefined }) },
    })
    expect(wrapper.text()).toContain('完成一轮')
  })
})
