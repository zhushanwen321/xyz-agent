/**
 * Block working 态单测 —— message-stream trace 块折叠行为（对齐 draft-message-stream §1/§3）。
 *
 * 覆盖（plan.md U1–U8）：
 * - working 态：thinking/tool 强制全展开且不可手动收（设计稿「无背景下划线展开」）
 * - 非 working 态：默认收起，点击 header 可 toggle
 * - running tool 在非 working 态仍强制展开（回归保护）
 * - 失败 tool 整块红框
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/block-working.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Block from '@/components/panel/message-stream/Block.vue'
import type { ToolCall } from '@xyz-agent/shared'

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
    })
    // 正文 <p> 存在 = 展开
    expect(wrapper.find('p').exists()).toBe(true)
    expect(wrapper.text()).toContain(LONG_THINKING)
    // 收起预览（含 …）不应出现
    expect(wrapper.text()).not.toContain('…')
  })

  it('U2: working=false → 仅预览行（截断 60 字符）', () => {
    const wrapper = mount(Block, {
      props: { type: 'thinking', content: LONG_THINKING, working: false, collapsed: true },
    })
    // 正文不存在 = 收起
    expect(wrapper.find('p').exists()).toBe(false)
    // 预览截断标志出现
    expect(wrapper.text()).toContain('…')
  })

  it('U3: working=true 点击 header 不切换折叠态', async () => {
    const wrapper = mount(Block, {
      props: { type: 'thinking', content: LONG_THINKING, working: true },
    })
    const header = wrapper.find('.cursor-pointer')
    expect(header.exists()).toBe(true)
    await header.trigger('click')
    // 正文仍展开（working 强制，点击无效）
    expect(wrapper.find('p').exists()).toBe(true)
  })

  it('U4: working=false 点击 header 可 toggle', async () => {
    const wrapper = mount(Block, {
      props: { type: 'thinking', content: '短推理', working: false, collapsed: true },
    })
    const header = wrapper.find('.cursor-pointer')
    expect(wrapper.find('p').exists()).toBe(false) // 初始收起
    await header.trigger('click')
    expect(wrapper.find('p').exists()).toBe(true) // 展开后正文出现
    await header.trigger('click')
    expect(wrapper.find('p').exists()).toBe(false) // 再收起
  })
})

describe('Block working 态 · tool 块', () => {
  it('U5: working=true 即使 completed 也展开详情', () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool({ status: 'completed' }), working: true },
    })
    // 详情区含 result（output 内容）= 展开
    expect(wrapper.text()).toContain('done')
    // 工具名 + 参数路径可见
    expect(wrapper.text()).toContain('edit')
    expect(wrapper.text()).toContain('src/App.vue')
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

  it('U7: working=false running 仍强制展开（回归保护）', () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool({ status: 'running', output: undefined }), working: false },
    })
    // running 即使非 working 也展开：工具名 + 参数可见
    expect(wrapper.text()).toContain('edit')
    expect(wrapper.text()).toContain('src/App.vue')
    // header 显示「进行中」
    expect(wrapper.text()).toContain('进行中')
  })

  it('U8: 失败 tool 整块红框 + header 显「失败」', () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool({ status: 'error', output: 'command failed' }), working: false },
    })
    // 红框容器（danger 边框 class）
    const failedBlock = wrapper.find('.border-danger')
    expect(failedBlock.exists()).toBe(true)
    // header 显失败文案
    expect(wrapper.text()).toContain('失败')
    // error output 默认展开（失败态强制可见）
    expect(wrapper.text()).toContain('command failed')
  })
})

describe('Block working 态 · end_not_received（未收到结果）', () => {
  it('U12: end_not_received header 显「未收到结果」，不走红框，不强制展开', () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool({ status: 'end_not_received', output: undefined }), working: false },
    })
    // header 含「未收到结果」文案
    expect(wrapper.text()).toContain('未收到结果')
    // 不走红框（border-danger 不存在）
    expect(wrapper.find('.border-danger').exists()).toBe(false)
    // 工具名仍可见
    expect(wrapper.text()).toContain('edit')
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
