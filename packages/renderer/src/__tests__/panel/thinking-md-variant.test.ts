/**
 * W1 + W2 红灯测试 - MarkdownRenderer thinking variant + thinking 块/BgNotifyCard 走 markdown。
 *
 * 防的 bug：
 * - thinking 块内容用纯文本插值，bold/列表/标题等 md 语法不渲染（W2）
 * - MarkdownRenderer 无 variant 机制，thinking 内的 md 元素颜色/字号与正文撞色（W1）
 * - BgNotifyCard fullContent 用 pre-wrap 纯文本，subagent 返回的 md 不渲染（W2）
 *
 * 三视角：
 * - 观察者（形态）：thinking variant root 有 .md-render--thinking class；标题颜色是 reasoning 而非 fg
 * - 使用者（黑盒）：thinking 内容里的 bold 被渲染为 strong，列表被渲染为 ul/ol
 * - 构建者（白盒）：variant prop 默认 undefined 时不加 thinking class（向后兼容）
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/thinking-md-variant.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, h } from 'vue'

// renderMarkdownSegments stub：同步返回 markdown 结构（绕过 shiki 异步加载）
const mockRenderSegments = vi.fn()
vi.mock('@/composables/logic/markdown', () => ({
  renderMarkdownSegments: (content: string, opts?: { localFiles?: Set<string> }) =>
    mockRenderSegments(content, opts),
}))

// MermaidRenderer stub
vi.mock('@/components/panel/message-stream/MermaidRenderer.vue', () => ({
  default: {
    name: 'MermaidRenderer',
    props: ['source'],
    setup(props: { source: string }) {
      return () => h('div', { class: 'stub-mermaid' }, props.source)
    },
  },
}))

// 依赖 stub（与 markdown-renderer-fallback.test.ts 一致）
vi.mock('@/composables/features/useFileTree', () => ({ useFileTree: () => ({ selectFile: vi.fn() }) }))
vi.mock('@/composables/features/useSideDrawer', () => ({ useSideDrawer: () => ({ open: vi.fn() }) }))
vi.mock('@/lib/ipc', () => ({ openExternal: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/composables/features/useFileSearch', () => ({ useFileSearch: () => ({ load: vi.fn().mockResolvedValue([]) }) }))
vi.mock('@/stores/fileSearch', () => ({ useFileSearchStore: () => ({ get: vi.fn().mockReturnValue(undefined) }) }))
vi.mock('@/components/panel/message-stream/AmbiguousFilePopover.vue', () => ({
  default: { name: 'AmbiguousFilePopover', render: () => null },
}))

import MarkdownRenderer from '@/components/panel/message-stream/MarkdownRenderer.vue'

// H2 后 MarkdownRenderer watch 改用 rAF 调度渲染。这些用例不验证节流时序，
// 只需 rAF 回调同步执行（mount 后 nextTick 即渲染完成）。
const _originalRAF = globalThis.requestAnimationFrame
const _originalCAF = globalThis.cancelAnimationFrame
beforeAll(() => {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0)
    return 0
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
})
afterAll(() => {
  globalThis.requestAnimationFrame = _originalRAF
  globalThis.cancelAnimationFrame = _originalCAF
})

/** 让 mockRenderSegments 返回 markdown 结构段（模拟 markdown-it 解析结果） */
function mockMarkdownSegments(html: string): void {
  mockRenderSegments.mockReturnValue([{ type: 'text', content: html }])
}

describe('W1: MarkdownRenderer variant="thinking" 降级样式', () => {
  it('variant="thinking" → root div 含 .md-render--thinking class', async () => {
    mockMarkdownSegments('<p>test</p>')
    const wrapper = mount(MarkdownRenderer, { props: { content: 'test', variant: 'thinking' } })
    await nextTick()
    await nextTick()
    // 关键断言：thinking 变体在 root 加 class（当前无 variant prop，红灯）
    expect(wrapper.find('.md-render--thinking').exists()).toBe(true)
  })

  it('默认（无 variant）→ root 不含 .md-render--thinking class（向后兼容）', async () => {
    mockMarkdownSegments('<p>test</p>')
    const wrapper = mount(MarkdownRenderer, { props: { content: 'test' } })
    await nextTick()
    await nextTick()
    // 无 variant 时不应加 thinking class（现有 7 处调用零影响）
    expect(wrapper.find('.md-render--thinking').exists()).toBe(false)
  })
})

describe('W2: Block thinking 块走 MarkdownRenderer（不再纯文本插值）', () => {
  it('thinking 内容 **粗体** → 渲染为 <strong> 元素（非字面星号）', async () => {
    mockMarkdownSegments('<p>这是<strong>粗体</strong>内容</p>')
    const { default: Block } = await import('@/components/panel/message-stream/Block.vue')
    const wrapper = mount(Block, {
      props: { type: 'thinking', content: '这是**粗体**内容', working: true },
    })
    await nextTick()
    await nextTick()
    // 关键断言：thinking 内容走 markdown 渲染后，<strong> 元素存在于 DOM
    // 当前实现是 <p>{{content}}</p> 纯文本插值，** 是字面字符，无 <strong>（红灯）
    expect(wrapper.find('strong').exists()).toBe(true)
    expect(wrapper.text()).toContain('粗体')
    // 字面 ** 不应出现在渲染后的文本中
    expect(wrapper.text()).not.toContain('**')
  })

  it('thinking 内容无全局 italic（md 结构 + italic 可读性差）', async () => {
    mockMarkdownSegments('<p>test</p>')
    const { default: Block } = await import('@/components/panel/message-stream/Block.vue')
    const wrapper = mount(Block, {
      props: { type: 'thinking', content: 'test', working: true },
    })
    await nextTick()
    await nextTick()
    // 当前实现有 italic class（红灯——改后应移除）
    const italicEls = wrapper.findAll('.italic')
    expect(italicEls.length).toBe(0)
  })
})

describe('W2: BgNotifyCard fullContent 走 MarkdownRenderer', () => {
  it('展开后 fullContent 的 **粗体** → 渲染为 <strong>（非字面星号）', async () => {
    mockMarkdownSegments('<p>已完成<strong>3 个方案</strong></p>')
    const { default: BgNotifyCard } = await import('@/components/panel/message-stream/BgNotifyCard.vue')
    const message = {
      id: 'm1',
      role: 'system' as const,
      content: '已完成 **3 个方案**',
      status: 'complete' as const,
      customType: 'subagent-bg-notify',
      bgNotify: {
        id: 'job-1',
        status: 'done' as const,
        agent: 'coder',
        startedAt: 1000,
        endedAt: 2000,
      },
      timestamp: 2000,
    }
    const wrapper = mount(BgNotifyCard, { props: { message } })
    // 点击展开
    await wrapper.find('.cursor-pointer').trigger('click')
    await nextTick()
    await nextTick()
    // 关键断言：fullContent 走 markdown，<strong> 存在（当前 pre-wrap 纯文本，红灯）
    expect(wrapper.find('strong').exists()).toBe(true)
    // 字面 ** 不应出现
    expect(wrapper.text()).not.toContain('**')
  })
})
