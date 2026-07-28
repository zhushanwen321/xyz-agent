/**
 * BlockSubagent.vue 组件测试。
 *
 * 适配 @zhushanwen/pi-subagent-workflow（重写 fork）的真实数据结构：
 * - input 顶层拍平：action / agent / slug / model / thinkingLevel / task 都在顶层（非 startParam 嵌套）
 * - output 是 JSON 字符串，含 bgResponse: { status, mode, message }
 * - 异步 background 执行：只展示发起参数（input），看不到执行过程（detail 永远 undefined）
 *
 * 标题行：subagent + agent + · + slug + (model · thinking X)
 * 第二行：task 首行预览（截断 60）
 * 展开体：task 完整内容 + background 状态行
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/components/panel/message-stream/__tests__/BlockSubagent.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import BlockSubagent from '@/components/panel/message-stream/BlockSubagent.vue'
import type { ToolCall } from '@xyz-agent/shared'

/** 构造真实形态的 subagent ToolCall（顶层拍平 input） */
function makeSubagent(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-sub-1',
    toolName: 'subagent',
    input: {
      action: 'start',
      agent: 'researcher',
      slug: 'research-trace-ui',
      task: '调研 trace UI 渲染方案',
    },
    status: 'completed',
    startTime: 1000,
    endTime: 2000,
    ...over,
  }
}

describe('BlockSubagent: 标题行渲染（顶层 input 拍平字段）', () => {
  it('渲染 subagent prefix + agent（accent）+ · + slug（accent）', () => {
    const wrapper = mount(BlockSubagent, {
      props: { tool: makeSubagent(), sessionId: 's1' },
    })
    const text = wrapper.text()
    // subagent prefix 文案（CSS 大写 SUBAGENT.）
    expect(text).toContain('subagent')
    // agent 名（顶层 input.agent，非默认值）
    expect(text).toContain('researcher')
    // slug（顶层 input.slug）
    expect(text).toContain('research-trace-ui')
    // agent / slug 走 accent 色
    expect(wrapper.find('.text-accent').exists()).toBe(true)
  })

  it('无 input.agent 时回退默认 general-purpose', () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({ input: { action: 'start', task: 'do something' } }),
      },
    })
    expect(wrapper.text()).toContain('general-purpose')
  })

  it('有 model + thinkingLevel 时渲染括号（model accent，括号/· thinking dim）', () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          input: {
            action: 'start',
            agent: 'researcher',
            slug: 'rs',
            model: 'anthropic/claude-sonnet-4',
            thinkingLevel: 'high',
            task: 'task',
          },
        }),
      },
    })
    const text = wrapper.text()
    expect(text).toContain('anthropic/claude-sonnet-4')
    expect(text).toContain('thinking high')
  })

  it('有 model 无 thinkingLevel 时只渲染括号 + model', () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          input: {
            action: 'start',
            agent: 'researcher',
            model: 'openai/gpt-4o',
            task: 'task',
          },
        }),
      },
    })
    const text = wrapper.text()
    expect(text).toContain('openai/gpt-4o')
    expect(text).not.toContain('thinking')
  })
})

describe('BlockSubagent: task 首行预览（截断 60）', () => {
  it('task 取首个非空行，未超长不截断', () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({ input: { action: 'start', task: '单行短任务' } }),
      },
    })
    expect(wrapper.text()).toContain('单行短任务')
  })

  it('task 含换行时只取首行', () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          input: {
            action: 'start',
            task: '首行任务描述\n第二行不该出现\n第三行也不该',
          },
        }),
      },
    })
    const text = wrapper.text()
    expect(text).toContain('首行任务描述')
    expect(text).not.toContain('第二行不该出现')
    expect(text).not.toContain('第三行也不该')
  })

  it('首行超 60 字符时截断并以 … 结尾', () => {
    const longFirstLine = 'a'.repeat(80)
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({ input: { action: 'start', task: longFirstLine } }),
      },
    })
    const text = wrapper.text()
    expect(text).toContain('…')
    // 截断后首行长度 = 60 + …，不应包含完整 80 字符
    expect(text).not.toContain('a'.repeat(80))
  })

  it('task 首行为空时跳过空行取下一个非空行', () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          input: { action: 'start', task: '\n\n实际首行\n其他' },
        }),
      },
    })
    expect(wrapper.text()).toContain('实际首行')
  })
})

describe('BlockSubagent: 展开体（task 完整 + background 状态行）', () => {
  it('completed 态默认收起，点击后展开 task 完整内容', async () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          input: { action: 'start', task: '完整 task 内容' },
        }),
      },
    })
    // 默认收起：展开体不可见
    expect(wrapper.find('.subagent-task-full').exists()).toBe(false)
    // 点击 header 展开
    await wrapper.find('[data-testid="subagent-block"] > div').trigger('click')
    expect(wrapper.find('.subagent-task-full').exists()).toBe(true)
    expect(wrapper.find('.subagent-task-full').text()).toContain('完整 task 内容')
  })

  it('展开体渲染 background 状态行（output.bgResponse.message）', async () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          input: { action: 'start', task: 'task' },
          output: JSON.stringify({
            action: 'start',
            subagentId: '1338dda5',
            sessionFile: null,
            slug: 'rs',
            bgResponse: {
              status: 'running',
              mode: 'background',
              message: 'detached, will notify on completion (auto-injected message, do not poll)',
            },
          }),
        }),
      },
    })
    await wrapper.find('[data-testid="subagent-block"] > div').trigger('click')
    const text = wrapper.text()
    expect(text).toContain('background ·')
    expect(text).toContain('detached, will notify on completion')
    // 状态点 blink 动画：当前用 Tailwind 内置 animate-blink（非自定义 .subagent-status-dot class）
    expect(wrapper.find('.animate-blink').exists()).toBe(true)
  })

  it('output.bgResponse 无 message 但 status=running 时回退默认文案', async () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          input: { action: 'start', task: 'task' },
          output: JSON.stringify({
            action: 'start',
            bgResponse: { status: 'running', mode: 'background' },
          }),
        }),
      },
    })
    await wrapper.find('[data-testid="subagent-block"] > div').trigger('click')
    expect(wrapper.text()).toContain('running detached · will notify on completion')
  })

  it('output 非合法 JSON 时无 background 状态行', async () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          input: { action: 'start', task: 'task' },
          output: 'plain text not json',
        }),
      },
    })
    await wrapper.find('[data-testid="subagent-block"] > div').trigger('click')
    expect(wrapper.text()).not.toContain('background ·')
  })
})

describe('BlockSubagent: running / failed / unfinished 态', () => {
  it('running 态渲染双环 loader（animate-loader-spin + text-accent）', () => {
    const wrapper = mount(BlockSubagent, {
      props: { tool: makeSubagent({ status: 'running' }) },
    })
    expect(wrapper.find('.animate-loader-spin.text-accent').exists()).toBe(true)
    // 不再有旧的脉冲点 / reasoning 紫
    expect(wrapper.find('.animate-working-pulse').exists()).toBe(false)
    expect(wrapper.find('.bg-reasoning').exists()).toBe(false)
  })

  it('running 态无 progress 快照字段（detail 永远 undefined，异步 background）', () => {
    const wrapper = mount(BlockSubagent, {
      props: { tool: makeSubagent({ status: 'running', detail: undefined }) },
    })
    const text = wrapper.text()
    // 不应渲染旧的进度字段
    expect(text).not.toContain('turn ')
    expect(text).not.toContain('tokens')
    // loader 仍在
    expect(wrapper.find('.animate-loader-spin').exists()).toBe(true)
  })

  it('failed 态强制展开（错误须直视）', () => {
    const wrapper = mount(BlockSubagent, {
      props: {
        tool: makeSubagent({
          status: 'error',
          input: { action: 'start', task: 'failed task' },
        }),
      },
    })
    // failed 强制展开：task 完整体直接可见
    expect(wrapper.find('.subagent-task-full').exists()).toBe(true)
    // header 中性灰
    expect(wrapper.find('.text-neutral-mid').exists()).toBe(true)
  })

  it('unfinished 态不渲染终态指示（终态 icon 已移除）', () => {
    const wrapper = mount(BlockSubagent, {
      props: { tool: makeSubagent({ status: 'end_not_received' }) },
    })
    // 终态指示（Check/CircleDashed/未收到结果文字）已移除，unfinished 态不再显示额外文案
    expect(wrapper.text()).not.toContain('未收到结果')
    expect(wrapper.find('.trace-subagent').exists()).toBe(true)
  })

  it('根 div 是 trace-subagent（纯缩进无边框）', () => {
    const wrapper = mount(BlockSubagent, {
      props: { tool: makeSubagent() },
    })
    const root = wrapper.find('.trace-subagent')
    expect(root.exists()).toBe(true)
    expect(root.classes()).not.toContain('border-b')
    expect(root.classes()).not.toContain('border-dashed')
    expect(root.classes()).not.toContain('border-danger')
    expect(root.classes()).not.toContain('bg-danger-soft')
  })
})
