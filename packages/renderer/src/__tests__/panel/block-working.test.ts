/**
 * Block working 态单测 —— message-stream trace 块折叠行为（对齐 draft-message-stream §1/§3）。
 *
 * 覆盖（plan.md U1–U8 + U12/U13）：
 * - thinking：working 态强制展开且不可手动收（设计稿「无背景下划线展开」）
 * - tool：默认 1 行收起（streaming/running 也收起，header 含 toolName+argPath+状态指示），
 *         点击展开详情。仅 failed 强制展开（错误须直视）。
 * - 失败 tool 整块红框 + 强制展开
 * - end_not_received：默认收起，点击可 toggle
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/block-working.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { h } from 'vue'
import Block from '@/components/panel/message-stream/Block.vue'
import type { ToolCall } from '@xyz-agent/shared'

/**
 * thinking 块现在走 MarkdownRenderer（W2），测试环境 stub 掉它避免依赖
 * shiki/markdown-it/useFileSearch 等。stub 渲染 content prop 文本即可验证展开/收起态。
 * tool 块不依赖 MarkdownRenderer，但统一 stub 无副作用。
 */
const mdStub = {
  name: 'MarkdownRenderer',
  props: { content: { type: String, default: '' }, variant: { type: String, default: undefined } },
  setup(props: { content: string }) {
    return () => h('div', { class: 'stub-md-render' }, props.content)
  },
}

const LONG_THINKING = '这是一段很长的推理内容需要展开才能完整阅读'.repeat(3)

function makeTool(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-1',
    toolName: 'edit',
    input: { path: 'src/App.vue' },
    output: 'done',
    status: 'completed',
    startTime: Date.now(),
    ...over,
  }
}

describe('Block working 态 · thinking 块', () => {
  it('U1: working=true → 正文展开（非收起预览）', () => {
    const wrapper = mount(Block, {
      props: { type: 'thinking', content: LONG_THINKING, working: true },
      global: { stubs: { MarkdownRenderer: mdStub } },
    })
    // thinking 展开态容器（.trace-think-body）存在 = 展开
    expect(wrapper.find('.trace-think-body').exists()).toBe(true)
    expect(wrapper.text()).toContain(LONG_THINKING)
    // 收起预览（含 …）不应出现
    expect(wrapper.text()).not.toContain('…')
  })

  it('U2: working=false → 仅预览行（截断 60 字符）', () => {
    const wrapper = mount(Block, {
      props: { type: 'thinking', content: LONG_THINKING, working: false, collapsed: true },
      global: { stubs: { MarkdownRenderer: mdStub } },
    })
    // 展开态容器不存在 = 收起
    expect(wrapper.find('.trace-think-body').exists()).toBe(false)
    // 预览截断标志出现
    expect(wrapper.text()).toContain('…')
  })

  it('U3: working=true 点击 header 不切换折叠态', async () => {
    const wrapper = mount(Block, {
      props: { type: 'thinking', content: LONG_THINKING, working: true },
      global: { stubs: { MarkdownRenderer: mdStub } },
    })
    const header = wrapper.find('.cursor-pointer')
    expect(header.exists()).toBe(true)
    await header.trigger('click')
    // 正文仍展开（working 强制，点击无效）
    expect(wrapper.find('.trace-think-body').exists()).toBe(true)
  })

  it('U4: working=false 点击 header 可 toggle', async () => {
    const wrapper = mount(Block, {
      props: { type: 'thinking', content: '短推理', working: false, collapsed: true },
      global: { stubs: { MarkdownRenderer: mdStub } },
    })
    const header = wrapper.find('.cursor-pointer')
    expect(wrapper.find('.trace-think-body').exists()).toBe(false) // 初始收起
    await header.trigger('click')
    expect(wrapper.find('.trace-think-body').exists()).toBe(true) // 展开后正文出现
    await header.trigger('click')
    expect(wrapper.find('.trace-think-body').exists()).toBe(false) // 再收起
  })
})

describe('Block working 态 · tool 块', () => {
  it('U5: working=true completed 默认 1 行收起（header 含 toolName+argPath，详情点击展开）', () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool({ status: 'completed' }), working: true },
    })
    // header 行含工具名 + 参数路径（1 行摘要可见）
    expect(wrapper.text()).toContain('edit')
    expect(wrapper.text()).toContain('src/App.vue')
    // 详情区 output 默认收起（不在 DOM）
    expect(wrapper.text()).not.toContain('done')
    // 点击展开
    const header = wrapper.find('.cursor-pointer')
    return header.trigger('click').then(() => {
      expect(wrapper.text()).toContain('done')
    })
  })

  it('U6: working=false completed 默认收起，点击展开', async () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool({ status: 'completed' }), working: false },
    })
    // 初始收起：output 不在 DOM
    expect(wrapper.text()).not.toContain('done')
    const header = wrapper.find('.cursor-pointer')
    await header.trigger('click')
    // 展开后 output 出现
    expect(wrapper.text()).toContain('done')
  })

  it('U7: working=false running 默认 1 行收起，header 含「进行中」脉冲指示', () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool({ status: 'running', output: undefined }), working: false },
    })
    // header 行含工具名 + 参数 + 进行中指示（1 行即可观察进度）
    expect(wrapper.text()).toContain('edit')
    expect(wrapper.text()).toContain('src/App.vue')
    expect(wrapper.text()).toContain('进行中')
    // 详情区默认收起（running 不再强制展开）
    // output undefined 不会渲染 result 区，验证 argPath 详情行不在 DOM（mt-1.font-mono 是展开体）
    const detailLines = wrapper.findAll('.mt-1.font-mono')
    expect(detailLines.length).toBe(0)
  })

  it('U8: 失败 tool 整块红框 + 强制展开（header XCircle 图标 + error output 直显）', () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool({ status: 'error', output: 'command failed' }), working: false },
    })
    // 红框容器（danger 边框 class，blockClass 给整块加红框）
    const failedBlock = wrapper.find('.border-danger')
    expect(failedBlock.exists()).toBe(true)
    // header 含 XCircle 图标（失败指示，lucide 渲染为 svg）
    const xcircleIcon = wrapper.find('[data-lucide="x-circle"], svg')
    expect(xcircleIcon.exists()).toBe(true)
    // error output 强制展开（失败态强制可见，不可收起）
    expect(wrapper.text()).toContain('command failed')
  })
})

describe('Block working 态 · end_not_received（未收到结果）', () => {
  it('U12: end_not_received header 显工具名（subtle 色），不走红框，不强制展开', () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool({ status: 'end_not_received', output: undefined }), working: false },
    })
    // header 含工具名 + 参数路径（1 行摘要）
    expect(wrapper.text()).toContain('edit')
    expect(wrapper.text()).toContain('src/App.vue')
    // 不走红框（border-danger 不存在）
    expect(wrapper.find('.border-danger').exists()).toBe(false)
    // 详情区默认收起（mt-1.font-mono 是展开体，end_not_received 不强制展开）
    const detailLines = wrapper.findAll('.mt-1.font-mono')
    expect(detailLines.length).toBe(0)
  })

  it('U13: end_not_received 初始收起，点击 header 可 toggle（不像 running 锁死）', async () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool({ status: 'end_not_received', output: undefined }), working: false },
    })
    const header = wrapper.find('.cursor-pointer')
    // 初始收起：工具名+参数路径在 header 行可见，但详情区（argPath 行 mt-1）不渲染
    expect(header.exists()).toBe(true)
    await header.trigger('click')
    // 展开后 argPath 区出现（mt-1 div 含 toolName）
    const detailLines = wrapper.findAll('.mt-1.font-mono')
    expect(detailLines.length).toBeGreaterThan(0)
    await header.trigger('click')
    // 收起后详情区消失
    const afterCollapse = wrapper.findAll('.mt-1.font-mono')
    // 注：result 区因 output undefined 不渲染，只剩 argPath 行，收起后应消失
    expect(afterCollapse.length).toBeLessThan(detailLines.length)
  })
})
