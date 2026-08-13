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

/* ── error-visibility M3：thinking 可收起 + 完成态回落（TC1-3）──
 * SSOT: docs/architecture/conversation-error-visibility.md §3.3.3
 * - T1: thinkingExpanded 去 props.working 短路（working 默认展开改由 collapsed 初值承担）
 *   ——working 挂载 collapsed 初值 false（展开）、非 working 挂载 true（收起，G3 骨架）
 * - T2: 删禁 toggle（working 中也可手动收起/展开）；watch working true→false 回落收起
 * - CQ1: 手动操作过（userToggled）→ working→false 不回落（显式意图优先） */
const THINK_HEADER_SEL = '.group\\/think'
const THINK_EXPANDED_SEL = '.group\\/result'

describe('error-visibility M3: thinking 可收起 + 完成态回落（TC1-3）', () => {
  function mountThinking(over: Record<string, unknown> = {}) {
    return mount(Block, {
      // collapsed 显式传 undefined（Vue Boolean prop 键缺失时缺省 false，会吃掉 `?? true` 的
      // fallback 导致误展开；显式 undefined 才等价「未提供」，`?? true` 正常生效）
      props: { type: 'thinking', content: 'deep reasoning content', thinkingId: 't-1', collapsed: undefined, ...over },
      global: {
        stubs: { MarkdownRenderer: MdStub },
      },
    })
  }

  it('TC1: working=true 挂载默认折叠（60 字符预览；streaming-trace-window 验收修正：收编理念要求 thinking 折叠减体积）', () => {
    const wrapper = mountThinking({ working: true })
    // 展开内容区不渲染（折叠态，60 字符预览）
    expect(wrapper.find(THINK_EXPANDED_SEL).exists()).toBe(false)
  })

  it('TC2: 非 working 挂载默认收起（1 行摘要），点击可展开', async () => {
    const wrapper = mountThinking({})
    // 默认收起：展开内容区不渲染
    expect(wrapper.find(THINK_EXPANDED_SEL).exists()).toBe(false)
    // 点击 header 展开（toggle 对非 working 可用）
    await wrapper.find(THINK_HEADER_SEL).trigger('click')
    expect(wrapper.find(THINK_EXPANDED_SEL).exists()).toBe(true)
  })

  it('TC3: working 态折叠；手动展开后保持（用户意图优先，不因 working 变化回落）', async () => {
    // 场景 A：working=true 挂载默认折叠，working→false 仍折叠（默认折叠态不因 working 变化）
    const autoWrapper = mountThinking({ working: true })
    expect(autoWrapper.find(THINK_EXPANDED_SEL).exists()).toBe(false)
    // VTU setProps 的 $props 类型解析为 attrs-only（Block.vue 自定义 props 不可见），
    // cast 仅为满足 tsc（同 search-modal.test.ts:86 模式，见本文件 text 测试注释）
    await autoWrapper.setProps({ working: false } as never)
    expect(autoWrapper.find(THINK_EXPANDED_SEL).exists()).toBe(false)

    // 场景 B：手动展开 → working→false 保持展开（用户意图优先）
    const manualWrapper = mountThinking({ working: true })
    await manualWrapper.find(THINK_HEADER_SEL).trigger('click') // 手动展开
    expect(manualWrapper.find(THINK_EXPANDED_SEL).exists()).toBe(true)
    await manualWrapper.setProps({ working: false } as never)
    // 保持用户意图不回滚
    expect(manualWrapper.find(THINK_EXPANDED_SEL).exists()).toBe(true)
  })
})

/* ── JSON output 格式化：cw 命令等结构化输出的可读性 ──
 * 背景：subagent（cw 递归编排）常用 bash 执行 `cw ...` 命令，stdout 是 JSON
 * （cw execute/design/review 等结构化输出）。原样 whitespace-pre-wrap 渲染时
 * 单行压缩 JSON 不可读，展开工具卡片看到一整坨。修复：检测到合法 JSON 时
 * 用 <pre> 缩进格式化 + 限高滚动；非 JSON（普通命令输出/文本）回退原样 span。
 * 通用：非 bash 工具的 JSON output 同样适用（不绑定 cw）。 */
describe('Block tool output: JSON 格式化（cw 等命令的结构化输出）', () => {
  it('JSON 对象 output 渲染为 <pre> 格式化缩进（非原样压缩单行）', async () => {
    const wrapper = mountTool({
      toolName: 'bash',
      input: { command: 'cw execute feat-x' },
      output: '{"status":"ok","nextAction":"design","unitId":"feat-x"}',
    })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    const pre = wrapper.find('.tool-result pre')
    expect(pre.exists()).toBe(true)
    // 格式化后键值间有空格、换行缩进（原样压缩单行无换行）
    expect(pre.text()).toContain('"status": "ok"')
    expect(pre.text()).toContain('\n')
  })

  it('JSON 数组 output 同样格式化', async () => {
    const wrapper = mountTool({
      toolName: 'bash',
      output: '[{"id":1,"name":"a"},{"id":2,"name":"b"}]',
    })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    const pre = wrapper.find('.tool-result pre')
    expect(pre.exists()).toBe(true)
    expect(pre.text()).toContain('"id": 1')
  })

  it('非 JSON output（普通命令文本）回退原样 span，无 <pre>', async () => {
    const wrapper = mountTool({
      toolName: 'bash',
      input: { command: 'ls -la' },
      output: 'total 0\ndrwxr-xr-x  3 user staff  96',
    })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(wrapper.find('.tool-result pre').exists()).toBe(false)
    expect(wrapper.find('.tool-result').text()).toContain('total 0')
  })

  it('首字符为 { 但非法 JSON 回退原样（不误判）', async () => {
    const wrapper = mountTool({
      toolName: 'bash',
      output: '{ not valid json at all',
    })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(wrapper.find('.tool-result pre').exists()).toBe(false)
    expect(wrapper.find('.tool-result').text()).toContain('{ not valid json')
  })

  it('空 output 不触发 JSON 渲染（无 <pre>，无异常）', async () => {
    const wrapper = mountTool({ toolName: 'bash', output: '' })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(wrapper.find('.tool-result pre').exists()).toBe(false)
  })

  it('非 bash 工具的 JSON output 同样格式化（通用，不限于 bash）', async () => {
    const wrapper = mountTool({
      toolName: 'cw_planning',
      output: '{"layer":"wave","status":"created","waves":3}',
    })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    const pre = wrapper.find('.tool-result pre')
    expect(pre.exists()).toBe(true)
    expect(pre.text()).toContain('"layer": "wave"')
  })
})
