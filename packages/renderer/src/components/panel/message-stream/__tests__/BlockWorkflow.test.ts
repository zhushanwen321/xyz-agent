/**
 * W3TC5 —— workflow 块渲染测试（Demo H：list-checks ICON + WORKFLOW. prefix + 状态动词 + 详情 3 态）。
 *
 * 3 态 fixture：
 * - ① details.__gui__={type:'list-tree',items:[...]} → GuiComponentRenderer（stub 验证挂载）
 * - ② output 有文本无 __gui__ → AnsiText/纯文本（stub 验证挂载）
 * - ③ 都无 → 只 header（无详情区）
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/components/panel/message-stream/__tests__/BlockWorkflow.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { h } from 'vue'
import Block from '@/components/panel/message-stream/Block.vue'
import type { ToolCall } from '@xyz-agent/shared'

// stub GuiComponentRenderer / AnsiText，避免依赖 extension-protocol 的复杂组件渲染。
// 各 stub 把自身标记为 data-testid 供断言是否挂载。
const GuiStub = {
  name: 'GuiComponentRenderer',
  props: { component: { type: Object, default: undefined } },
  setup() {
    return () => h('div', { 'data-testid': 'gui-renderer-stub' })
  },
}
const AnsiStub = {
  name: 'AnsiText',
  props: { content: { type: String, default: '' } },
  setup() {
    return () => h('div', { 'data-testid': 'ansi-text-stub' })
  },
}
const MdStub = {
  name: 'MarkdownRenderer',
  props: { content: { type: String, default: '' }, variant: { type: String, default: undefined } },
  setup() {
    return () => h('div', { class: 'stub-md-render' })
  },
}

function makeWorkflow(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-wf-1',
    toolName: 'workflow',
    input: { name: 'email-validation-refactor' },
    status: 'completed',
    startTime: 1000,
    endTime: 5000,
    ...over,
  }
}

describe('W3TC5: workflow 块 3 态详情渲染', () => {
  it('① details.__gui__ 存在 → 渲染 GuiComponentRenderer（list-tree）', async () => {
    const wrapper = mount(
      Block,
      {
        props: {
          type: 'tool',
          tool: makeWorkflow({
            output: 'workflow running',
            details: {
              __gui__: {
                v: 1,
                component: {
                  type: 'list-tree',
                  props: {
                    items: [
                      { label: '扫描 validator', status: 'done' },
                      { label: '替换 regex', status: 'done' },
                      { label: '补充 unit test', status: 'current' },
                    ],
                  },
                },
              },
            },
          }),
        },
        global: {
          stubs: {
            GuiComponentRenderer: GuiStub,
            AnsiText: AnsiStub,
            MarkdownRenderer: MdStub,
          },
        },
      },
    )
    // workflow 块挂载
    expect(wrapper.find('[data-testid="workflow-block"]').exists()).toBe(true)
    // 强制展开（failed 才强制，completed 需点击）—— 点击 header 展开
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    // GuiComponentRenderer 挂载（list-tree），AnsiText 不挂载
    expect(wrapper.find('[data-testid="gui-renderer-stub"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text-stub"]').exists()).toBe(false)
  })

  it('② output 有文本无 __gui__ → 渲染纯文本 output（无 GuiComponentRenderer）', async () => {
    const wrapper = mount(
      Block,
      {
        props: {
          type: 'tool',
          tool: makeWorkflow({
            output: 'workflow completed: 3 steps done',
            // 无 details.__gui__
          }),
        },
        global: {
          stubs: {
            GuiComponentRenderer: GuiStub,
            AnsiText: AnsiStub,
            MarkdownRenderer: MdStub,
          },
        },
      },
    )
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    // 无 GuiComponentRenderer（无 __gui__）
    expect(wrapper.find('[data-testid="gui-renderer-stub"]').exists()).toBe(false)
    // output 文本可见
    expect(wrapper.text()).toContain('workflow completed: 3 steps done')
  })

  it('③ 都无（无 __gui__ 无 output）→ 只渲染 header（无详情区）', () => {
    const wrapper = mount(
      Block,
      {
        props: {
          type: 'tool',
          tool: makeWorkflow({
            output: undefined,
            // 无 details.__gui__
          }),
        },
        global: {
          stubs: {
            GuiComponentRenderer: GuiStub,
            AnsiText: AnsiStub,
            MarkdownRenderer: MdStub,
          },
        },
      },
    )
    // workflow 块 header 在（含 WORKFLOW. prefix + 状态动词 + workflow 名）
    const wfBlock = wrapper.find('[data-testid="workflow-block"]')
    expect(wfBlock.exists()).toBe(true)
    // workflow 名可见
    expect(wrapper.text()).toContain('email-validation-refactor')
    // 无 GuiComponentRenderer / AnsiText（都无数据）
    expect(wrapper.find('[data-testid="gui-renderer-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ansi-text-stub"]').exists()).toBe(false)
  })
})

describe('W3TC4: workflow 块去卡片化视觉（WORKFLOW. prefix + 状态动词）', () => {
  it('header 含 workflow-tag（CSS 大写 WORKFLOW.）+ 状态动词 + workflow 名', () => {
    const wrapper = mount(
      Block,
      {
        props: {
          type: 'tool',
          tool: makeWorkflow({ status: 'completed' }),
        },
        global: {
          stubs: {
            GuiComponentRenderer: GuiStub,
            AnsiText: AnsiStub,
            MarkdownRenderer: MdStub,
          },
        },
      },
    )
    // workflow-tag span 存在（源码小写 workflow，CSS 大写 WORKFLOW.）
    expect(wrapper.find('.workflow-tag').exists()).toBe(true)
    expect(wrapper.text()).toContain('workflow')
    // 状态动词（completed → workflowDone 「已完成」）
    expect(wrapper.text()).toContain('已完成')
    // workflow 名
    expect(wrapper.text()).toContain('email-validation-refactor')
  })

  it('running 态 header 含双环 loader（animate-loader-spin + accent）', () => {
    const wrapper = mount(
      Block,
      {
        props: {
          type: 'tool',
          tool: makeWorkflow({ status: 'running' }),
        },
        global: {
          stubs: {
            GuiComponentRenderer: GuiStub,
            AnsiText: AnsiStub,
            MarkdownRenderer: MdStub,
          },
        },
      },
    )
    // running 态双环 loader
    expect(wrapper.find('.animate-loader-spin').exists()).toBe(true)
    // 状态动词染 accent（running → workflowRunning 「运行中」）
    expect(wrapper.text()).toContain('运行中')
  })
})
