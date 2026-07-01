/**
 * MarkdownRenderer 组件单测（W4，对话流 markdown 渲染增强）。
 *
 * 覆盖：
 *  - U9 代码块语言标签 + 复制按钮存在于 DOM（DoD 渲染 gate）
 *  - U10 点复制按钮 → clipboard 写入解码后内容 + is-copied 反馈态
 *  - U11 mermaid 占位 → MermaidRenderer 挂载（mock 子组件）
 *  - U13（全屏 Dialog 在 MermaidRenderer.test 已覆盖，此处聚焦 MarkdownRenderer 的挂载/事件委托）
 *
 * mock 策略：
 *  - vi.mock('@/composables/logic/markdown')：renderMarkdown 返回可控 HTML（含 .md-codeblock / .md-mermaid）
 *  - vi.mock MermaidRenderer：stub 成带 source prop 的简单 div（验证挂载 + source 传递，不跑真实渲染）
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/composables/markdown-renderer.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

// renderMarkdown stub：返回可控 HTML，聚焦 MarkdownRenderer 的后处理（事件委托/挂载）
const mockRenderMarkdown = vi.fn()
vi.mock('@/composables/logic/markdown', () => ({
  renderMarkdown: (content: string) => mockRenderMarkdown(content),
}))

// base64 helper（与 markdown.ts encodeBase64 对称，测试构造 data-code）
function encodeB64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  bytes.forEach((b) => (binary += String.fromCharCode(b)))
  return btoa(binary)
}

// MermaidRenderer stub：捕获 source prop，渲染带标识的 div（验证挂载 + source 解码传递）
const mockMermaidMount = vi.fn()
vi.mock('@/components/panel/message-stream/MermaidRenderer.vue', () => ({
  default: {
    name: 'MermaidRenderer',
    props: ['source'],
    setup(props: { source: string }) {
      mockMermaidMount(props.source)
      return () => ({ tag: 'div', class: 'stub-mermaid', textContent: props.source })
    },
  },
}))

import MarkdownRenderer from '@/components/panel/message-stream/MarkdownRenderer.vue'

describe('MarkdownRenderer（W4）', () => {
  beforeEach(() => {
    mockRenderMarkdown.mockReset()
    mockMermaidMount.mockReset()
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  })

  it('U9: 代码块含语言标签 + 复制按钮（DOM 可见，DoD 渲染 gate）', async () => {
    const code = 'const x = 1'
    mockRenderMarkdown.mockResolvedValue(
      `<div class="md-codeblock"><div class="md-codeblock__header">` +
        `<span class="md-codeblock__lang">typescript</span>` +
        `<button class="md-codeblock__copy" data-code="${encodeB64(code)}" type="button"></button>` +
        `</div><pre class="shiki"><code>${code}</code></pre></div>`,
    )
    const wrapper = mount(MarkdownRenderer, { props: { content: '```ts\nconst x=1\n```' } })
    await nextTick()
    await nextTick()
    expect(wrapper.find('.md-codeblock__lang').exists()).toBe(true)
    expect(wrapper.find('.md-codeblock__lang').text()).toBe('typescript')
    expect(wrapper.find('.md-codeblock__copy').exists()).toBe(true)
  })

  it('U10: 点复制按钮 → clipboard 写入解码内容 + is-copied 反馈态', async () => {
    const code = 'hello world'
    mockRenderMarkdown.mockResolvedValue(
      `<div class="md-codeblock"><div class="md-codeblock__header">` +
        `<span class="md-codeblock__lang">ts</span>` +
        `<button class="md-codeblock__copy" data-code="${encodeB64(code)}" type="button"></button>` +
        `</div></div>`,
    )
    const wrapper = mount(MarkdownRenderer, { props: { content: 'x' } })
    await nextTick()
    await nextTick()
    const btn = wrapper.find('.md-codeblock__copy')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code)
    // is-copied 反馈态 class
    expect(btn.classes()).toContain('is-copied')
  })

  it('U11: mermaid 占位 → MermaidRenderer 挂载（source 解码传递）', async () => {
    const mermaidSrc = 'graph TD;A-->B'
    mockRenderMarkdown.mockResolvedValue(
      `<div class="md-mermaid" data-source="${encodeB64(mermaidSrc)}"></div>`,
    )
    const wrapper = mount(MarkdownRenderer, { props: { content: '```mermaid\ngraph TD;A-->B\n```' } })
    await nextTick()
    await nextTick()
    // MermaidRenderer stub 被挂载，收到解码后的 source
    expect(mockMermaidMount).toHaveBeenCalledWith(mermaidSrc)
    // 占位被标记为已挂载
    const placeholder = wrapper.find('.md-mermaid')
    expect(placeholder.exists()).toBe(true)
    expect(placeholder.attributes('data-mounted')).toBe('1')
  })

  it('U8回归: 空内容不渲染不挂载', async () => {
    mockRenderMarkdown.mockResolvedValue('')
    const wrapper = mount(MarkdownRenderer, { props: { content: '' } })
    await nextTick()
    expect(wrapper.find('.md-codeblock').exists()).toBe(false)
    expect(mockMermaidMount).not.toHaveBeenCalled()
  })
})
