import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { ToolCall } from '@xyz-agent/shared'
import SubagentRenderer from '../SubagentRenderer.vue'

/**
 * 工厂函数：创建 ToolCall fixture
 */
function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
  id: 'tc-1',
  toolName: 'subagent',
  input: { agent: 'code-reviewer', task: 'Review the code' },
  status: 'completed',
  startTime: Date.now(),
  endTime: Date.now() + 1000,
  ...overrides,
  }
}

// ── 1. 从 JSON 字符串解析 agent 名称 ──────────────────────────────

it('should render agent name from input JSON string', () => {
  const toolCall = makeToolCall({
  input: JSON.stringify({ agent: 'code-reviewer', task: 'Review the code' }),
  })

  const wrapper = mount(SubagentRenderer, { props: { toolCall } })

  expect(wrapper.text()).toContain('code-reviewer')
})

// ── 2. 从已解析对象读取 agent 名称 ────────────────────────────────

it('should render agent name from input object (already parsed)', () => {
  const toolCall = makeToolCall({
  input: { agent: 'refactor', task: 'Refactor module X' },
  })

  const wrapper = mount(SubagentRenderer, { props: { toolCall } })

  expect(wrapper.text()).toContain('refactor')
})

// ── 3. 渲染 task 描述 ─────────────────────────────────────────────

it('should render task description', () => {
  const toolCall = makeToolCall({
  input: { agent: 'code-reviewer', task: 'Review authentication module' },
  })

  const wrapper = mount(SubagentRenderer, { props: { toolCall } })

  expect(wrapper.text()).toContain('Review authentication module')
})

// ── 4. status 为 completed 时显示 output ──────────────────────────

it('should show output when status is completed', () => {
  const toolCall = makeToolCall({
  input: { agent: 'code-reviewer', task: 'Review' },
  status: 'completed',
  output: 'No issues found. LGTM.',
  })

  const wrapper = mount(SubagentRenderer, { props: { toolCall } })

  expect(wrapper.text()).toContain('No issues found. LGTM.')
  // output 应在 pre 块中
  const pre = wrapper.find('pre')
  expect(pre.exists()).toBe(true)
  expect(pre.text()).toContain('No issues found. LGTM.')
})

// ── 5. status 为 error 时显示错误样式 ─────────────────────────────

it('should show error styling when status is error', () => {
  const toolCall = makeToolCall({
  input: { agent: 'code-reviewer', task: 'Review' },
  status: 'error',
  output: 'Agent failed: timeout',
  })

  const wrapper = mount(SubagentRenderer, { props: { toolCall } })

  // 错误状态应有错误相关的 CSS 类或标记
  const errorElement = wrapper.find('[data-status="error"]')
  expect(errorElement.exists()).toBe(true)
})

// ── 6. 无效 input 时优雅降级（显示 'unknown'）─────────────────────

it('should handle invalid input gracefully (show unknown)', () => {
  const toolCall = makeToolCall({
  input: 'not-valid-json{{{',
  })

  const wrapper = mount(SubagentRenderer, { props: { toolCall } })

  expect(wrapper.text()).toContain('unknown')
})

// ── 7. 显示 mode 标签（single / parallel / chain）─────────────────

it('should show mode tag as single for basic input', () => {
  const toolCall = makeToolCall({
  input: { agent: 'code-reviewer', task: 'Review', mode: 'single' },
  })

  const wrapper = mount(SubagentRenderer, { props: { toolCall } })

  expect(wrapper.text()).toContain('single')
})

it('should show mode tag as parallel when specified', () => {
  const toolCall = makeToolCall({
  input: { agent: 'batch-runner', task: 'Run all', mode: 'parallel' },
  })

  const wrapper = mount(SubagentRenderer, { props: { toolCall } })

  expect(wrapper.text()).toContain('parallel')
})

it('should show mode tag as chain when specified', () => {
  const toolCall = makeToolCall({
  input: { agent: 'pipeline', task: 'Execute pipeline', mode: 'chain' },
  })

  const wrapper = mount(SubagentRenderer, { props: { toolCall } })

  expect(wrapper.text()).toContain('chain')
})
