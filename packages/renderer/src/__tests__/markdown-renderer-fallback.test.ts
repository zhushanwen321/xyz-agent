/**
 * MarkdownRenderer 渲染失败降级回归测试（W1）。
 *
 * 锁定 W1 改动：当 renderMarkdownSegments 抛错（shiki 加载失败 / markdown-it 解析异常 /
 * mermaid 占位解码失败等）时，MarkdownRenderer 不能把消息气泡渲染成空白——
 * 必须降级为纯文本 segment（[{type:'text', content: escapeHtml(原文)}]），
 * 保证消息内容对用户可读（用户能看到原始文字，而不是一个空气泡）。
 *
 * 当前实现问题：MarkdownRenderer 的 watch 回调直接 await renderMarkdownSegments，
 * reject 时整个 async 回调抛错，segments 保持 []（或上次值）——消息气泡空白，
 * 用户完全看不到这条消息的内容。
 *
 * 预期（W1 后）：watch 回调用 try/catch 包裹 renderMarkdownSegments，
 * catch 时降级 segments = [{type:'text', content: escapeHtml(content)}]。
 * 以下断言在 W1 未实现前应全部红灯。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/markdown-renderer-fallback.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, h } from 'vue'

// renderMarkdownSegments stub：reject 模拟渲染失败（shiki/markdown-it 异常）
const mockRenderSegments = vi.fn()
vi.mock('@/composables/logic/markdown', () => ({
  renderMarkdownSegments: (content: string) => mockRenderSegments(content),
}))

// MermaidRenderer stub（fallback 测试不渲染真实 mermaid）
vi.mock('@/components/panel/message-stream/MermaidRenderer.vue', () => ({
  default: {
    name: 'MermaidRenderer',
    props: ['source'],
    setup(props: { source: string }) {
      return () => h('div', { class: 'stub-mermaid' }, props.source)
    },
  },
}))

// useFileTree / useSideDrawer stub
vi.mock('@/composables/features/useFileTree', () => ({
  useFileTree: () => ({ selectFile: vi.fn() }),
}))
vi.mock('@/composables/features/useSideDrawer', () => ({
  useSideDrawer: () => ({ open: vi.fn() }),
}))
vi.mock('@/lib/ipc', () => ({
  openExternal: vi.fn().mockResolvedValue(undefined),
}))

// useFileSearch + fileSearchStore stub
vi.mock('@/composables/features/useFileSearch', () => ({
  useFileSearch: () => ({ load: vi.fn().mockResolvedValue([]) }),
}))
vi.mock('@/stores/fileSearch', () => ({
  useFileSearchStore: () => ({ get: vi.fn().mockReturnValue(undefined) }),
}))

// AmbiguousFilePopover stub
vi.mock('@/components/panel/message-stream/AmbiguousFilePopover.vue', () => ({
  default: { name: 'AmbiguousFilePopover', render: () => null },
}))

import MarkdownRenderer from '@/components/panel/message-stream/MarkdownRenderer.vue'

describe('MarkdownRenderer 渲染失败降级为纯文本（W1）', () => {
  beforeEach(() => {
    mockRenderSegments.mockReset()
  })

  it('renderMarkdownSegments reject 时 → 降级为纯文本 segment，内容可见', async () => {
    // 模拟渲染失败（shiki 加载异常等）
    mockRenderSegments.mockRejectedValue(new Error('shiki load failed'))
    const content = '这是一条普通消息内容'

    const wrapper = mount(MarkdownRenderer, { props: { content } })
    // watch 是 async（await renderMarkdownSegments），多 tick 等 reject 落定
    await nextTick()
    await nextTick()
    await nextTick()

    // 关键断言：降级后消息内容应在 DOM 中可见（当前 reject 后 segments=[]，DOM 空白，红灯）
    expect(wrapper.text()).toContain('这是一条普通消息内容')
  })

  it('降级 segment 是 text 类型（非 mermaid），走 v-html 安全渲染', async () => {
    mockRenderSegments.mockRejectedValue(new Error('parse error'))
    const content = 'hello world'

    const wrapper = mount(MarkdownRenderer, { props: { content } })
    await nextTick()
    await nextTick()
    await nextTick()

    // 关键断言：降级应产出 text segment（非 mermaid），无 stub-mermaid 节点
    expect(wrapper.find('.stub-mermaid').exists()).toBe(false)
    // 内容可见（当前空白，红灯）
    expect(wrapper.text()).toContain('hello world')
  })

  it('降级时 HTML 特殊字符被转义（XSS 安全 + 可读）', async () => {
    mockRenderSegments.mockRejectedValue(new Error('boom'))
    // 内容含 HTML 特殊字符（模拟恶意 / 含代码尖括号的内容）
    const content = '<script>alert(1)</script> & <b>bold</b>'

    const wrapper = mount(MarkdownRenderer, { props: { content } })
    await nextTick()
    await nextTick()
    await nextTick()

    // 关键断言 1：原文文本可见（转义后仍是这些字符，只是不再被当 HTML 执行）
    expect(wrapper.text()).toContain('<script>alert(1)</script>')
    expect(wrapper.text()).toContain('<b>bold</b>')
    // 关键断言 2：降级 segment 走 v-html 但内容已转义，不会真的注入 <script> 元素
    // （若未转义，DOM 里会有一个真的 <script> 节点）
    expect(wrapper.find('script').exists()).toBe(false)
  })

  it('空内容不触发降级（空内容 segments=[] 是正常行为，非渲染失败）', async () => {
    // 空内容走早期 return（segments=[]），不应进入 catch 降级
    mockRenderSegments.mockRejectedValue(new Error('should not reach'))
    const wrapper = mount(MarkdownRenderer, { props: { content: '' } })
    await nextTick()
    await nextTick()

    // 空内容 → segments 空，DOM 无内容（正常行为，非降级路径，应通过）
    expect(wrapper.findAll('.md-render > *')).toHaveLength(0)
  })
})
