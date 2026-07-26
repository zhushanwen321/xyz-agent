/**
 * BlockSubagent.vue 组件测试（subagent 三态渲染）。
 *
 * W3 Demo H 视觉更新：去卡片化（users ICON + SUBAGENT. prefix + 左缩进/dashed）+
 * running 双环 loader（去 reasoning 紫）+ failed hover warn（去鲜红）。
 * - completed：users ICON + 'subagent' prefix + agent 名 + Check 图标（中性灰）
 * - running：滚动进度文本 + 双环 loader（animate-loader-spin）
 * - failed：错误摘要进 body（中性灰 border-l），hover 染 warn（不再鲜红）
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/components/panel/message-stream/__tests__/BlockSubagent.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import BlockSubagent from '@/components/panel/message-stream/BlockSubagent.vue'
import type { ToolCall } from '@xyz-agent/shared'

function makeSubagent(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-sub-1',
    toolName: 'subagent',
    input: { agent: 'test-writer', task: '写测试' },
    status: 'completed',
    startTime: 1000,
    endTime: 2000,
    ...over,
  }
}

describe('W2TC1: BlockSubagent completed 态渲染', () => {
  it('渲染 users ICON + subagent prefix + agent 名 + Check 完成图标（中性灰）', () => {
    const wrapper = mount(BlockSubagent, {
      props: { tool: makeSubagent(), sessionId: 's1' },
    })
    const html = wrapper.html()
    // users ICON 存在（lucide-users 的 svg，size-[13px]）
    expect(html).toContain('size-[13px]')
    // 'subagent' prefix 文案（CSS 大写 SUBAGENT.）
    expect(wrapper.text()).toContain('subagent')
    // agent 名 'test-writer'
    expect(wrapper.text()).toContain('test-writer')
    // task 预览 '写测试'（< TASK_PREVIEW_LIMIT 48，不截断）
    expect(wrapper.text()).toContain('写测试')
    // completed 态显 Check 图标（中性灰 text-neutral-mid），无鲜红/鲜绿
    expect(wrapper.find('.text-neutral-mid').exists()).toBe(true)
    expect(wrapper.find('.text-danger').exists()).toBe(false)
    expect(wrapper.find('.text-success').exists()).toBe(false)
    // Check 图标（lucide-check svg）存在
    expect(wrapper.find('svg.lucide-check').exists()).toBe(true)
  })
})

describe('W2TC2: BlockSubagent running 态滚动进度', () => {
  it('渲染滚动进度文本（turn + tokens）+ 双环 loader（animate-loader-spin）', () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          status: 'running',
          detail: { progress: [{ currentTool: 'bash', turnCount: 3, tokens: 1200 }] },
        }),
      },
    })
    const text = wrapper.text()
    // running 态滚动进度：subagentLiveInfo = 'bash · turn 3 · 1.2k tokens'
    expect(text).toContain('turn 3')
    expect(text).toContain('1.2k tokens')
    expect(text).toContain('bash')
    // 双环 loader class 存在（animate-loader-spin + text-accent），无旧的脉冲点/reasoning 紫
    expect(wrapper.find('.animate-loader-spin.text-accent').exists()).toBe(true)
    expect(wrapper.find('.animate-working-pulse').exists()).toBe(false)
    expect(wrapper.find('.bg-reasoning').exists()).toBe(false)
  })

  it('running 态无 progress 快照时回退到 panel.message.running 文案', () => {
    const wrapper = mount(BlockSubagent, {
      props: { tool: makeSubagent({ status: 'running' }) }, // 无 detail
    })
    // 无 progress → subagentLiveInfo 为空 → 显 '运行中'（panel.message.running）
    expect(wrapper.text()).toContain('运行中')
    // loader 仍在（running 态指示）
    expect(wrapper.find('.animate-loader-spin').exists()).toBe(true)
  })
})

describe('W2TC3: BlockSubagent failed 态（Demo H hover warn）', () => {
  it('渲染 AlertTriangle ICON + 中性灰 header + result 左边框（border-neutral-faint，hover warn）', () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          status: 'error',
          output: 'subagent crashed: EBUSY',
        }),
      },
    })
    // failed 态 header 中性灰（text-neutral-mid），无鲜红 text-danger
    expect(wrapper.find('.text-neutral-mid').exists()).toBe(true)
    expect(wrapper.find('.text-danger').exists()).toBe(false)
    // 无 Check（failed 不显完成图标）
    expect(wrapper.find('svg.lucide-check').exists()).toBe(false)
    // failed 强制展开（toolExpanded = isFailed || !toolCollapsed）→ result 区可见
    expect(wrapper.text()).toContain('subagent crashed: EBUSY')
    // result 区左边框（border-neutral-faint，Demo H 去鲜红 + hover warn）
    expect(wrapper.find('.border-l-2.border-neutral-faint').exists()).toBe(true)
    expect(wrapper.find('.border-l-2.border-danger').exists()).toBe(false)
    // hover warn 类存在（hover:border-warn 在 class 列表中，用 html 字符串检查）
    expect(wrapper.html()).toContain('hover:border-warn')
  })

  it('failed 态根 div 是 trace-subagent（无鲜红框，Demo H 去卡片化）', () => {
    const wrapper = mount(BlockSubagent, {
      props: { tool: makeSubagent({ status: 'error', output: 'err' }) },
    })
    // BlockSubagent 根 div 是 trace-subagent，不含鲜红框 class（Demo H 去卡片化）
    const root = wrapper.find('.trace-subagent')
    expect(root.exists()).toBe(true)
    expect(root.classes()).not.toContain('border-danger')
    expect(root.classes()).not.toContain('bg-danger-soft')
    // Demo H 去卡片化：左缩进 + 底部 dashed（Tailwind classes）
    expect(root.classes()).toContain('pl-[14px]')
    expect(root.classes()).toContain('border-b')
  })
})
