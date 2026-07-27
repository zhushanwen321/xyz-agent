/**
 * W3TC5 —— workflow 块渲染测试（Demo H：action + name + slug + runId + list-tree GUI 详情 3 态）。
 *
 * workflow 顶层 input 拍平 schema：action / name / slug / args / runId 都在顶层。
 * 标题行字段顺序：workflow prefix · action(muted) · name(accent) · · slug(accent) · runId[0:8](dim)。
 * 第二行：args.task 首行预览（run action，截断 60 字符）。
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
    input: {
      action: 'run',
      name: 'email-validation-refactor',
      slug: 'email-refactor',
      args: { task: '扫描 validator 并替换 regex' },
    },
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
    // workflow 块 header 在（含 workflow prefix + action + name + slug + runId）
    const wfBlock = wrapper.find('[data-testid="workflow-block"]')
    expect(wfBlock.exists()).toBe(true)
    // workflow 名可见
    expect(wrapper.text()).toContain('email-validation-refactor')
    // 无 GuiComponentRenderer / AnsiText（都无数据）
    expect(wrapper.find('[data-testid="gui-renderer-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ansi-text-stub"]').exists()).toBe(false)
  })
})

describe('W3TC4: workflow 块标题行字段（action + name + slug + runId + args.task 预览）', () => {
  it('run action：header 含 workflow prefix + action + name + · + slug（runId 无则不显示）', () => {
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
    // workflow-tag span 存在（源码小写 workflow，CSS 大写）
    expect(wrapper.find('.workflow-tag').exists()).toBe(true)
    expect(wrapper.text()).toContain('workflow')
    // action（muted）
    expect(wrapper.text()).toContain('run')
    // name（accent）
    expect(wrapper.text()).toContain('email-validation-refactor')
    // slug（accent，· 分隔）
    expect(wrapper.text()).toContain('email-refactor')
    // run action 无顶层 runId，不显示
    expect(wrapper.text()).not.toContain('wf-')
    // args.task 首行预览
    expect(wrapper.text()).toContain('扫描 validator 并替换 regex')
  })

  it('status action：header 含 action + runId[0:8]（dim）', () => {
    const wrapper = mount(
      Block,
      {
        props: {
          type: 'tool',
          tool: makeWorkflow({
            status: 'completed',
            input: { action: 'status' },
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
    // action（muted）
    expect(wrapper.text()).toContain('status')
    // status action 无 name（不显示 name）
    expect(wrapper.text()).not.toContain('email-validation-refactor')
  })

  it('pause action 带 runId：runId 前 8 位显示', () => {
    const wrapper = mount(
      Block,
      {
        props: {
          type: 'tool',
          tool: makeWorkflow({
            status: 'completed',
            input: { action: 'pause', runId: 'wf-abcd1234-efgh-5678' },
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
    // action
    expect(wrapper.text()).toContain('pause')
    // runId 前 8 位
    expect(wrapper.text()).toContain('wf-abcd1')
    // 完整 runId 不显示（只显前 8）
    expect(wrapper.text()).not.toContain('wf-abcd1234-efgh-5678')
  })

  it('args.task 超 60 字符截断 + 末尾 …', () => {
    const longTask = '扫描'.repeat(40) // 80 字符
    const wrapper = mount(
      Block,
      {
        props: {
          type: 'tool',
          tool: makeWorkflow({
            status: 'completed',
            input: { action: 'run', name: 'wf-x', args: { task: longTask } },
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
    // 截断后含末尾 …
    expect(wrapper.text()).toContain('…')
    // 完整长 task 不显示（已截断）
    expect(wrapper.text()).not.toContain(longTask)
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
    // 字段仍可见（name）
    expect(wrapper.text()).toContain('email-validation-refactor')
  })

  it('不再渲染旧的状态动词（已完成/运行中/失败）', () => {
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
    // 旧 workflowStatusText 已删除，不再出现状态动词
    expect(wrapper.text()).not.toContain('已完成')
    expect(wrapper.text()).not.toContain('运行中')
  })
})
