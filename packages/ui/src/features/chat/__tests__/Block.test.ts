/**
 * Block.vue text 分支样式测试（block-rendering M0，TC-M0-4）。
 *
 * [block-rendering M0] 文字样式模型统一：所有 text 全 inline 统一正文级
 * （text-base/leading-7），颜色跟随所属 assistant streaming 态（streaming→neutral-mid，
 * complete/缺省→neutral-fg，单调不随兄弟 message 翻转）。旧「过程文字暗色小字」两级
 * 视觉层级已取消（text-sm/leading-relaxed/恒 neutral-mid 移除）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/Block.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { h } from 'vue'
import { Block } from '@xyz-agent/ui'
import type { ToolCall } from '@xyz-agent/shared'

function mountTextBlock(over: { streaming?: boolean; status?: string; error?: string; content?: string } = {}) {
  return mount(Block, {
    props: {
      type: 'text',
      content: 'hello',
      ...over,
    },
    global: {
      // 渲染 content 的 stub：wrapper.text() 才能断言正文/错误文本（stubs: true 会吞掉 content）
      stubs: {
        MarkdownRenderer: {
          props: ['content', 'variant'],
          template: '<div class="stub-md">{{ content }}</div>',
        },
      },
    },
  })
}

describe('block-rendering M0: Block text 分支正文样式（TC-M0-4）', () => {
  it('text 分支统一正文级样式：text-base/leading-7，不含 text-sm/leading-relaxed', () => {
    const wrapper = mountTextBlock({})
    const textEl = wrapper.find('.trace-blk > div')
    expect(textEl.classes()).toContain('text-[length:var(--text-base)]')
    expect(textEl.classes()).toContain('leading-7')
    expect(textEl.classes()).not.toContain('text-[length:var(--text-sm)]')
    expect(textEl.classes()).not.toContain('leading-relaxed')
  })

  it('streaming=true → text-neutral-mid（流式暗色）', () => {
    const wrapper = mountTextBlock({ streaming: true })
    expect(wrapper.find('.trace-blk > div').classes()).toContain('text-neutral-mid')
  })

  it('streaming=false/缺省 → text-neutral-fg（完成全色）', async () => {
    const wrapper = mountTextBlock({ streaming: false })
    expect(wrapper.find('.trace-blk > div').classes()).toContain('text-neutral-fg')
    // 缺省（undefined）同样 fallback 到 fg
    const defaultWrapper = mountTextBlock({})
    expect(defaultWrapper.find('.trace-blk > div').classes()).toContain('text-neutral-fg')
    // streaming 布尔切换驱动颜色（单调，不随兄弟 message 翻转）
    // .vue shim 下 VTU setProps 的 $props 类型解析为 attrs-only（Block.vue 自定义 props 不可见），
    // 运行时 setProps 走 Record<string, unknown>，cast 仅为满足 tsc（同 search-modal.test.ts:86 模式）。
    await wrapper.setProps({ streaming: true } as never)
    expect(wrapper.find('.trace-blk > div').classes()).toContain('text-neutral-mid')
  })
})

/* ── error-visibility M2：text 分支 error 形态判定（TC1 纯 error / TC3 追加形态）──
 * SSOT: docs/architecture/conversation-error-visibility.md §3.3.2
 * - 纯 error（status==='error' 无 msg.error）：整条 danger（AlertCircle + text-danger）
 * - 追加形态（status==='error' 且 msg.error 有值）：content 正常正文保持原色，error 独立 danger 行 */
describe('error-visibility M2: Block text 分支 error 形态判定（TC1/TC3）', () => {
  it('TC1: 纯 error 消息整条 danger（AlertCircle 图标 + text-danger，无 msg.error）', () => {
    const wrapper = mountTextBlock({ content: '压缩失败', status: 'error' })
    const textEl = wrapper.find('[data-testid="block-text"]')
    expect(textEl.classes()).toContain('text-danger') // 整条染 danger
    expect(textEl.classes()).not.toContain('text-neutral-fg') // 不再是正常正文色
    expect(wrapper.find('[data-testid="block-text-error-icon"]').exists()).toBe(true) // AlertCircle 图标
    expect(wrapper.text()).toContain('压缩失败') // errorText 即全文
    // 追加形态专属的独立 error 行不应出现
    expect(wrapper.find('[data-testid="block-text-error"]').exists()).toBe(false)
  })

  it('TC3: 追加形态——正常正文（content）保持原色，msg.error 渲染独立 danger 行', () => {
    const wrapper = mountTextBlock({ content: '正常回复', status: 'error', error: '崩溃前追加的错误' })
    const textEl = wrapper.find('[data-testid="block-text"]')
    // content 正常正文不染 danger（text-neutral-fg，不误染崩溃前产出）
    expect(textEl.classes()).toContain('text-neutral-fg')
    expect(textEl.classes()).not.toContain('text-danger')
    // 独立 error 行：text-danger + AlertCircle + 错误文本
    const errorRow = wrapper.find('[data-testid="block-text-error"]')
    expect(errorRow.exists()).toBe(true)
    expect(errorRow.classes()).toContain('text-danger')
    expect(errorRow.find('svg').exists()).toBe(true) // AlertCircle 图标
    expect(wrapper.text()).toContain('崩溃前追加的错误')
    expect(wrapper.text()).toContain('正常回复')
    // 纯 error 专属的整条图标行不应出现（追加形态 content 前无图标）
    expect(wrapper.find('[data-testid="block-text-error-icon"]').exists()).toBe(false)
  })
})

/* ── error-visibility M1：failed tool header danger 色 + 终态默认展开（TC1-3）──
 * SSOT: docs/architecture/conversation-error-visibility.md §3.3.1
 * - T1: toolStatusClass failed 分支 text-neutral-mid → text-danger（unfinished 保持中性）
 * - T2: toolCollapsed 终态分化——failed(error) 初值 false（展开），其余 true（收起）
 * - CQ1: streaming 中失败不展开（mount 快照，running→error 不 remount），本测试覆盖终态挂载分支 */
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

function makeTool(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-1',
    toolName: 'read',
    input: { path: '/tmp/foo.txt' },
    status: 'completed',
    startTime: 1000,
    endTime: 5000,
    ...over,
  }
}

function mountTool(toolOver: Partial<ToolCall>) {
  return mount(Block, {
    props: {
      type: 'tool',
      tool: makeTool(toolOver),
    },
    global: {
      stubs: {
        GuiComponentRenderer: GuiStub,
        AnsiText: AnsiStub,
        MarkdownRenderer: MdStub,
      },
    },
  })
}

describe('error-visibility M1: failed tool header danger + 终态展开（TC1-3）', () => {
  it('TC1: failed(error) tool header 染 text-danger（非中性灰）', () => {
    const wrapper = mountTool({ status: 'error', output: 'ENOENT: no such file' })
    const header = wrapper.find('[data-testid="tool-block-header"]')
    expect(header.classes()).toContain('text-danger')
    // 不再是中性灰
    expect(header.classes()).not.toContain('text-neutral-mid')
  })

  it('TC2: failed(error) tool 终态挂载默认展开（错误输出可见，无需点击）', () => {
    const wrapper = mountTool({ status: 'error', output: 'ENOENT: no such file' })
    // toolCollapsed 初值 false → toolExpanded true → 详情区默认渲染（无需点击 header）
    expect(wrapper.find('.tool-result').exists()).toBe(true)
    // 错误输出文本可见
    expect(wrapper.text()).toContain('ENOENT: no such file')
  })

  it('TC3: unfinished(end_not_received) tool header 保持中性灰（abort/中断非失败，不标红）', () => {
    const wrapper = mountTool({ status: 'end_not_received' })
    const header = wrapper.find('[data-testid="tool-block-header"]')
    expect(header.classes()).toContain('text-neutral-mid')
    // unfinished 不标红（区别于 failed）
    expect(header.classes()).not.toContain('text-danger')
  })
})
