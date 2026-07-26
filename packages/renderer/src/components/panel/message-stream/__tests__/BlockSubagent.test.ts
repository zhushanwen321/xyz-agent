/**
 * W2TC1-3 —— BlockSubagent.vue 组件测试（subagent 三态渲染）。
 *
 * 验证从 Block.vue 抽离后 subagent 渲染逻辑完整迁移：
 * - W2TC1 completed：Bot 图标 + '子代理' 文案 + agent 名 + Check 图标
 * - W2TC2 running：滚动进度文本 + 脉冲点（animate-working-pulse）
 * - W2TC3 failed：XCircle 图标 + text-danger header 色 + result 左边框（红框由 Block.vue 外层 trace-blk 承载，
 *   不在 BlockSubagent 根 div——保持抽离前 DOM，零视觉变化；红框集成验证见 tool-expand-restructure.test.ts）
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
  it('渲染 Bot 图标 + 子代理文案 + agent 名 + Check 完成图标', () => {
    const wrapper = mount(BlockSubagent, {
      props: { tool: makeSubagent(), sessionId: 's1' },
    })
    const html = wrapper.html()
    // Bot 图标存在（lucide-bot 的 svg，class 含 size-3）
    expect(html).toContain('size-3')
    // '子代理' 文案（panel.message.subagent → 子代理）
    expect(wrapper.text()).toContain('子代理')
    // agent 名 'test-writer'
    expect(wrapper.text()).toContain('test-writer')
    // task 预览 '写测试'（< TASK_PREVIEW_LIMIT 48，不截断）
    expect(wrapper.text()).toContain('写测试')
    // completed 态显 Check 图标（text-success），无 XCircle
    expect(wrapper.find('.text-success').exists()).toBe(true)
    expect(wrapper.find('.text-danger').exists()).toBe(false)
  })
})

describe('W2TC2: BlockSubagent running 态滚动进度', () => {
  it('渲染滚动进度文本（turn + tokens）+ 脉冲点 animate-working-pulse', () => {
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
    // 脉冲点 class 存在（bg-reasoning + animate-working-pulse）
    expect(wrapper.find('.bg-reasoning.animate-working-pulse').exists()).toBe(true)
  })

  it('running 态无 progress 快照时回退到 panel.message.running 文案', () => {
    const wrapper = mount(BlockSubagent, {
      props: { tool: makeSubagent({ status: 'running' }) }, // 无 detail
    })
    // 无 progress → subagentLiveInfo 为空 → 显 '运行中'（panel.message.running）
    expect(wrapper.text()).toContain('运行中')
    // 脉冲点仍在（running 态指示）
    expect(wrapper.find('.bg-reasoning.animate-working-pulse').exists()).toBe(true)
  })
})

describe('W2TC3: BlockSubagent failed 态（内部失败视觉）', () => {
  it('渲染 XCircle 图标 + text-danger header 色 + result 左边框 border-l-2 border-danger', () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          status: 'error',
          output: 'subagent crashed: EBUSY',
        }),
      },
    })
    // failed 态 header 显 XCircle（text-danger），无 Check
    expect(wrapper.find('.text-danger').exists()).toBe(true)
    expect(wrapper.find('.text-success').exists()).toBe(false)
    // failed 强制展开（toolExpanded = isFailed || !toolCollapsed）→ result 区可见
    expect(wrapper.text()).toContain('subagent crashed: EBUSY')
    // result 区左边框（border-l-2 border-danger）——BlockSubagent 承载的失败视觉
    expect(wrapper.find('.border-l-2.border-danger').exists()).toBe(true)
  })

  it('failed 态根 div 是 trace-subagent（红框由 Block.vue 外层 trace-blk 承载，零视觉变化）', () => {
    const wrapper = mount(BlockSubagent, {
      props: { tool: makeSubagent({ status: 'error', output: 'err' }) },
    })
    // BlockSubagent 根 div 是 trace-subagent，不含红框 class（红框归 Block.vue trace-blk）
    const root = wrapper.find('.trace-subagent')
    expect(root.exists()).toBe(true)
    expect(root.classes()).not.toContain('border-danger')
    expect(root.classes()).not.toContain('bg-danger-soft')
  })
})
