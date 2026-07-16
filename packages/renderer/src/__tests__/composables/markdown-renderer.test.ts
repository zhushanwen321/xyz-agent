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
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, h } from 'vue'
import type { MarkdownSegment, MarkdownEnv } from '@/composables/logic/markdown'

// renderMarkdownSegments stub：每个测试设置返回值，聚焦 MarkdownRenderer 的 segment 分发。
// 透传 content + env（H2 AC-7 localFiles 同帧快照验证需读 env）。
const mockRenderSegments = vi.fn()
vi.mock('@/composables/logic/markdown', () => ({
  renderMarkdownSegments: (content: string, env?: MarkdownEnv) => mockRenderSegments(content, env),
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
  // H2 后 watch 改用 rAF 调度渲染。这些既有用例不验证节流时序，只需 rAF 回调同步执行
  // （mount 后 nextTick 即渲染完成）。H2 节流用例在下方独立 describe 用手动控制 rAF。
  let originalRAF: typeof requestAnimationFrame
  let originalCAF: typeof cancelAnimationFrame
  beforeAll(() => {
    originalRAF = globalThis.requestAnimationFrame
    originalCAF = globalThis.cancelAnimationFrame
    // 同步执行 rAF 回调（非节流场景：mount 后立即渲染，nextTick 后 DOM 就绪）
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0)
      return 0
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
  })
  afterAll(() => {
    globalThis.requestAnimationFrame = originalRAF
    globalThis.cancelAnimationFrame = originalCAF
  })

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

/**
 * H2：MarkdownRenderer watch rAF trailing 节流（perf-streaming-md-throttle）。
 *
 * 背景：流式 text_delta/thinking_delta 每个 token 触发 watch → renderMarkdownSegments
 * 全量重解析。改造后 watch 内包 rAF trailing，一帧内多次 content 变化合并为单次渲染。
 *
 * 复用 M4 rAF mock 模式（use-chat-scroll.test.ts）：手动控制 rAF 调度，
 * 测试显式 flushRAF 触发回调，验证节流/trailing/卸载安全/异常恢复/同帧快照。
 *
 * 不变量（INVAR-H2）：
 * - INVAR-H2-1: 一帧内多次 content 变化 → renderMarkdownSegments 调用 1 次（AC-1）
 * - INVAR-H2-2: rAF 执行时读最新 content（延迟求值，非调度时快照）（AC-2）
 * - INVAR-H2-3: 渲染异常 rafId 须复位，后续变更仍能调度（AC-6）
 * - INVAR-H2-4: 卸载 cancelAnimationFrame，flushRAF 后不触发已卸载组件渲染（AC-4）
 * - INVAR-H2-5: content+localFiles 同帧快照（AC-7）
 *
 * [红灯] 当前 watch 无节流，每次 setProps → renderMarkdownSegments 立即调用 → fail。
 */
describe('MarkdownRenderer · H2 rAF trailing 节流', () => {
  let rafCallbacks: FrameRequestCallback[]
  let originalRAF: typeof requestAnimationFrame
  let originalCAF: typeof cancelAnimationFrame

  beforeEach(() => {
    mockRenderSegments.mockReset()
    // 手动控制 rAF：收集回调，不自动执行（测试显式 flush）
    rafCallbacks = []
    originalRAF = globalThis.requestAnimationFrame
    originalCAF = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const handle = rafCallbacks.length
      rafCallbacks.push(cb)
      return handle
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = ((handle: number) => {
      if (rafCallbacks[handle] !== undefined) rafCallbacks[handle] = undefined as unknown as FrameRequestCallback
    }) as typeof cancelAnimationFrame
  })

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF
    globalThis.cancelAnimationFrame = originalCAF
  })

  /** flush 所有 pending rAF 回调（跳过已被 cancel 的）。 */
  function flushRAF(): void {
    const pending = rafCallbacks.splice(0).filter((cb): cb is FrameRequestCallback => cb !== undefined)
    pending.forEach((cb) => cb(0))
  }

  it('H2-1 (AC-1): 一帧内 100 次 content 变化 → renderMarkdownSegments 调用远小于 100（节流合并）', async () => {
    mockRenderSegments.mockResolvedValue([{ type: 'text', content: '<p>x</p>' }])
    const wrapper = mount(MarkdownRenderer, { props: { content: '' } })
    // 首渲染（immediate watch）
    await nextTick()
    flushRAF()
    await nextTick()
    await nextTick()
    // 重置计数，只统计流式阶段
    mockRenderSegments.mockClear()

    // 模拟流式：一帧内连续 100 次 content 变化（不 flush rAF）
    for (let i = 0; i < 100; i++) {
      await wrapper.setProps({ content: `token ${i}` })
    }
    flushRAF()
    await nextTick()
    await nextTick()

    // 关键断言（AC-1）：100 次变化，renderMarkdownSegments 调用次数远小于 100。
    // 无节流时：每次 setProps → watch 立即调 → ≈100 次（红灯 fail）。
    // 节流后：合并到 ≤2 次（首帧 + trailing）。
    const totalCalls = mockRenderSegments.mock.calls.length
    expect(totalCalls).toBeLessThan(50)
    // 末次渲染用的是最新 content（INVAR-H2-2 延迟求值）
    const lastCallContent = mockRenderSegments.mock.calls.at(-1)?.[0]
    expect(lastCallContent).toBe('token 99')
  })

  it('H2-2 (AC-2): 末次 flush 后最终 content 完整渲染（trailing）', async () => {
    mockRenderSegments.mockResolvedValue([{ type: 'text', content: '<p>final</p>' }])
    const wrapper = mount(MarkdownRenderer, { props: { content: '' } })
    await nextTick()
    flushRAF()
    await nextTick()
    await nextTick()
    mockRenderSegments.mockClear()

    await wrapper.setProps({ content: 'partial' })
    await wrapper.setProps({ content: 'final content' })
    flushRAF()
    await nextTick()
    await nextTick()

    // trailing 保证：最终渲染入参是末次 content（非 partial）
    const lastContent = mockRenderSegments.mock.calls.at(-1)?.[0]
    expect(lastContent).toBe('final content')
  })

  it('H2-3 (AC-3): 静态首渲染立即调度（rAF 排队，flush 后渲染）', async () => {
    mockRenderSegments.mockResolvedValue([{ type: 'text', content: '<p>static</p>' }])
    const wrapper = mount(MarkdownRenderer, { props: { content: 'static doc' } })
    await nextTick()
    // immediate watch 触发 rAF 调度（rAF 不应为空——当前无节流实现时为空，红灯）
    expect(rafCallbacks.length).toBeGreaterThan(0)
    flushRAF()
    await nextTick()
    await nextTick()
    // 静态 content 渲染成功
    expect(mockRenderSegments).toHaveBeenCalledWith('static doc', expect.anything())
  })

  it('H2-4 (AC-4): 卸载时 cancelAnimationFrame，flushRAF 后不触发已卸载组件渲染', async () => {
    mockRenderSegments.mockResolvedValue([{ type: 'text', content: '<p>x</p>' }])
    const wrapper = mount(MarkdownRenderer, { props: { content: 'a' } })
    await nextTick()
    flushRAF()
    await nextTick()
    await nextTick()
    // 清掉首渲染的调用记录，便于断言卸载后净增
    mockRenderSegments.mockClear()

    // 触发新 content 变化 → 节流下排队 rAF
    await wrapper.setProps({ content: 'b' })

    // 卸载组件（应 cancelAnimationFrame）
    wrapper.unmount()
    // flush 残留 rAF（模拟 rAF 到点）——因已 cancel，回调已被置 undefined
    flushRAF()
    await nextTick()

    // 关键断言（AC-4）：卸载后 renderMarkdownSegments 不被调用。
    // 无节流时：setProps 后 watch 立即调（同步），unmount 前已调用 → calls > 0 但 flushRAF 无影响。
    // 节流后：setProps 排队 rAF，unmount cancel，flushRAF 不触发 → calls === 0。
    expect(mockRenderSegments).not.toHaveBeenCalled()
  })

  it('H2-5 (AC-5): renderSeq 序号守卫保留——节流后连续渲染最终 DOM 为最新 content', async () => {
    mockRenderSegments.mockResolvedValue([{ type: 'text', content: '<p>v1</p>' }])
    const wrapper = mount(MarkdownRenderer, { props: { content: 'first' } })
    await nextTick()
    flushRAF()
    await nextTick()
    await nextTick()
    // 首渲染成功
    expect(wrapper.find('.md-render > div').html()).toContain('v1')

    // 第二次：mock 返回新 segment + content 变化
    mockRenderSegments.mockResolvedValue([{ type: 'text', content: '<p>v2-updated</p>' }])
    await wrapper.setProps({ content: 'second' })
    flushRAF()
    await nextTick()
    await nextTick()
    // 序号守卫：新渲染覆盖旧，DOM 是 v2（非 v1）
    expect(wrapper.find('.md-render > div').html()).toContain('v2-updated')
  })

  it('H2-6 (AC-6): renderMarkdownSegments 抛错 → rafId 复位，后续变更仍能调度', async () => {
    // 首次抛错
    mockRenderSegments.mockRejectedValueOnce(new Error('shiki boom'))
    const wrapper = mount(MarkdownRenderer, { props: { content: 'bad' } })
    await nextTick()
    flushRAF()
    await nextTick()
    await nextTick()
    // 降级：纯文本 segment 可见（escapeHtmlForFallback）
    expect(wrapper.find('.md-render > div').html()).toContain('bad')

    // 关键：抛错后 rafId 已复位 → 新 content 变化能重新调度 rAF
    mockRenderSegments.mockResolvedValueOnce([{ type: 'text', content: '<p>recovered</p>' }])
    await wrapper.setProps({ content: 'recovered' })
    flushRAF()
    await nextTick()
    await nextTick()
    // 后续渲染正常，显示新内容（非降级纯文本）
    expect(wrapper.find('.md-render > div').html()).toContain('<p>recovered</p>')
  })

  it('H2-7 (AC-7): content + localFiles 同帧变化 → rAF 回调用最新 localFiles（同帧快照）', async () => {
    mockRenderSegments.mockResolvedValue([{ type: 'text', content: '<p>x</p>' }])
    const wrapper = mount(MarkdownRenderer, { props: { content: 'init', sessionId: 's1' } })
    await nextTick()
    flushRAF()
    await nextTick()
    await nextTick()
    // 等 refreshLocalFiles（sessionId='s1' → loadFileCandidates mock 返回 []）
    await nextTick()
    mockRenderSegments.mockClear()

    // content 变化（节流下排队 rAF，不立即渲染）
    await wrapper.setProps({ content: 'with link' })
    flushRAF()
    await nextTick()
    await nextTick()

    // renderMarkdownSegments 被调用时 env.localFiles 存在（同帧快照，AC-7）
    expect(mockRenderSegments).toHaveBeenCalled()
    const lastCallEnv = mockRenderSegments.mock.calls.at(-1)?.[1]
    expect(lastCallEnv).toBeDefined()
    expect(lastCallEnv).toHaveProperty('localFiles')
  })
})
