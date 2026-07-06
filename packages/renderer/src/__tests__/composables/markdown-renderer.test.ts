/**
 * MarkdownRenderer 组件单测（segments 模式）。
 *
 * 测试设计（修正 W4 的 mock 失败：不再 mock 掉 mermaid 核心假装通过）：
 *  - mock renderMarkdownSegments：返回可控 segments（text/mermaid 交替），验证 MarkdownRenderer
 *    正确分发——text 段渲染为 v-html 内容，mermaid 段渲染为 <MermaidRenderer> 组件。
 *  - MermaidRenderer stub：合理（测的是 MarkdownRenderer 的 segment 分发，不是 mermaid 渲染本身；
 *    mermaid 真实渲染在 happy-dom 必返回空，无法单测——见 mermaid-real 测试已证）。
 *  - 事件委托（复制/外链/文件路径）覆盖。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/composables/markdown-renderer.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, h } from 'vue'
import type { MarkdownSegment } from '@/composables/logic/markdown'

// renderMarkdownSegments stub：每个测试设置返回值，聚焦 MarkdownRenderer 的 segment 分发
const mockRenderSegments = vi.fn()
vi.mock('@/composables/logic/markdown', () => ({
  renderMarkdownSegments: (content: string) => mockRenderSegments(content),
  decodeBase64: (b64: string) => {
    // 真实 base64 解码（测试构造 data-code 用）
    const binary = atob(b64)
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
  },
}))

// MermaidRenderer stub：捕获 source prop（验证 mermaid segment 传递 source）
const mockMermaidSource = vi.fn()
vi.mock('@/components/panel/message-stream/MermaidRenderer.vue', () => ({
  default: {
    name: 'MermaidRenderer',
    props: ['source'],
    setup(props: { source: string }) {
      mockMermaidSource(props.source)
      // 用 render 函数（Vue 3 需 h()），渲染带标识的 div 验证挂载
      return () => h('div', { class: 'stub-mermaid' }, props.source)
    },
  },
}))

// useFileTree / useSideDrawer stub
const mockSelectFile = vi.fn()
const mockDrawerOpen = vi.fn()
vi.mock('@/composables/features/useFileTree', () => ({
  useFileTree: () => ({ selectFile: mockSelectFile }),
}))
vi.mock('@/composables/features/useSideDrawer', () => ({
  useSideDrawer: () => ({ open: mockDrawerOpen }),
}))
const mockOpenExternal = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/ipc', () => ({
  openExternal: (url: string) => mockOpenExternal(url),
}))

// useFileSearch + fileSearchStore stub（裸 basename 识别 + 歧义反查数据源，测 segment 分发时不参与）
const mockLoadFileCandidates = vi.fn().mockResolvedValue([])
vi.mock('@/composables/features/useFileSearch', () => ({
  useFileSearch: () => ({ load: (sid: string) => mockLoadFileCandidates(sid) }),
}))
const mockFileSearchGet = vi.fn().mockReturnValue(undefined)
vi.mock('@/stores/fileSearch', () => ({
  useFileSearchStore: () => ({ get: (sid: string) => mockFileSearchGet(sid) }),
}))

// AmbiguousFilePopover stub（歧义浮层，测 segment 分发时不渲染真实浮层）。
// 返回注释 vnode（不占 .md-render 直接子节点，避免影响 U11 的子节点计数断言）
vi.mock('@/components/panel/message-stream/AmbiguousFilePopover.vue', () => ({
  default: { name: 'AmbiguousFilePopover', render: () => null },
}))

function encodeB64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  bytes.forEach((b) => (binary += String.fromCharCode(b)))
  return btoa(binary)
}

import MarkdownRenderer from '@/components/panel/message-stream/MarkdownRenderer.vue'

describe('MarkdownRenderer（segments 模式）', () => {
  beforeEach(() => {
    mockRenderSegments.mockReset()
    mockMermaidSource.mockReset()
    mockSelectFile.mockReset()
    mockDrawerOpen.mockReset()
    mockOpenExternal.mockClear()
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  })

  it('U9: text segment 渲染为 v-html（代码块语言标签+复制按钮可见，DoD 渲染 gate）', async () => {
    const code = 'const x = 1'
    const textSeg: MarkdownSegment = {
      type: 'text',
      content: `<div class="md-codeblock"><div class="md-codeblock__header"><span class="md-codeblock__lang">typescript</span><button class="md-codeblock__copy" data-code="${encodeB64(code)}" type="button"></button></div><pre class="shiki"><code>${code}</code></pre></div>`,
    }
    mockRenderSegments.mockResolvedValue([textSeg])
    const wrapper = mount(MarkdownRenderer, { props: { content: 'x' } })
    await nextTick()
    await nextTick()
    expect(wrapper.find('.md-codeblock__lang').exists()).toBe(true)
    expect(wrapper.find('.md-codeblock__lang').text()).toBe('typescript')
    expect(wrapper.find('.md-codeblock__copy').exists()).toBe(true)
  })

  it('U10: mermaid segment 渲染为 MermaidRenderer 组件（source 传递）', async () => {
    const mermaidSrc = 'graph TD;A-->B'
    mockRenderSegments.mockResolvedValue([{ type: 'mermaid', content: mermaidSrc }])
    const wrapper = mount(MarkdownRenderer, { props: { content: 'x' } })
    await nextTick()
    await nextTick()
    expect(mockMermaidSource).toHaveBeenCalledWith(mermaidSrc)
    expect(wrapper.find('.stub-mermaid').exists()).toBe(true)
  })

  it('U11: text + mermaid + text 段交替，顺序保留', async () => {
    mockRenderSegments.mockResolvedValue([
      { type: 'text', content: '<p>前文</p>' },
      { type: 'mermaid', content: 'graph TD;A-->B' },
      { type: 'text', content: '<p>后文</p>' },
    ] as MarkdownSegment[])
    const wrapper = mount(MarkdownRenderer, { props: { content: 'x' } })
    await nextTick()
    await nextTick()
    const allBlocks = wrapper.findAll('.md-render > *')
    // text(div v-html) + stub-mermaid + text(div v-html) = 3 个直接子节点
    expect(allBlocks.length).toBe(3)
    expect(mockMermaidSource).toHaveBeenCalledWith('graph TD;A-->B')
  })

  it('U12: 点代码块复制按钮 → clipboard 写入解码内容 + is-copied 反馈', async () => {
    const code = 'hello world'
    mockRenderSegments.mockResolvedValue([
      { type: 'text', content: `<button class="md-codeblock__copy" data-code="${encodeB64(code)}" type="button"></button>` },
    ] as MarkdownSegment[])
    const wrapper = mount(MarkdownRenderer, { props: { content: 'x' } })
    await nextTick()
    await nextTick()
    const btn = wrapper.find('.md-codeblock__copy')
    await btn.trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code)
    expect(btn.classes()).toContain('is-copied')
  })

  it('U13: 点外链 → openExternal', async () => {
    mockRenderSegments.mockResolvedValue([
      { type: 'text', content: '<a href="https://example.com">link</a>' },
    ] as MarkdownSegment[])
    const wrapper = mount(MarkdownRenderer, { props: { content: 'x' } })
    await nextTick()
    await nextTick()
    await wrapper.find('a[href="https://example.com"]').trigger('click')
    expect(mockOpenExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('U14: 点文件路径 → selectFile + drawer.open(detail)', async () => {
    const path = 'src/foo.ts'
    mockRenderSegments.mockResolvedValue([
      { type: 'text', content: `<a class="md-filepath" data-path="${encodeB64(path)}">src/foo.ts</a>` },
    ] as MarkdownSegment[])
    const wrapper = mount(MarkdownRenderer, { props: { content: 'x', sessionId: 's1' } })
    await nextTick()
    await nextTick()
    await wrapper.find('.md-filepath').trigger('click')
    expect(mockSelectFile).toHaveBeenCalledWith(path)
    expect(mockDrawerOpen).toHaveBeenCalledWith('detail')
  })

  it('U15: 空内容 → segments 空，不渲染不挂载', async () => {
    mockRenderSegments.mockResolvedValue([])
    const wrapper = mount(MarkdownRenderer, { props: { content: '' } })
    await nextTick()
    expect(wrapper.find('.md-codeblock').exists()).toBe(false)
    expect(wrapper.find('.stub-mermaid').exists()).toBe(false)
    expect(mockMermaidSource).not.toHaveBeenCalled()
  })
})
