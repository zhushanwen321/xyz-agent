/**
 * MermaidRenderer 组件单测（W5，对话流 markdown 渲染增强）。
 *
 * 覆盖：
 *  - U14 mount dark 主题 → mermaid.initialize/render 调用 + SVG 注入 DOM
 *  - U15 暗→亮主题切换 → 重新 initialize + render
 *  - U16 全屏 Dialog 内 zoom-in → zoomLabel 增大
 *  - U17 全屏 Dialog 内 fit → 缩放适配
 *  - 渲染失败 → 显示「渲染失败」+ 源码（U12 的组件级验证）
 *
 * mock 策略：vi.mock('@/composables/logic/mermaid') stub renderMermaid/getCurrentTheme；
 *   happy-dom 无真实 SVG getBBox，useMermaidZoom 的 readSvgNaturalSize 走 getBoundingClientRect 回退。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/composables/mermaid.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

// mermaid 逻辑层 stub：renderMermaid 返回可控 svg，getCurrentTheme 可控主题
const mockRenderMermaid = vi.fn()
const mockGetCurrentTheme = vi.fn()
vi.mock('@/composables/logic/mermaid', () => ({
  renderMermaid: (...args: unknown[]) => mockRenderMermaid(...args),
  getCurrentTheme: () => mockGetCurrentTheme(),
}))

// useCopy 的 navigator.clipboard stub
beforeEach(() => {
  vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
})

import MermaidRenderer from '@/components/panel/message-stream/MermaidRenderer.vue'

const SAMPLE_SVG = '<svg viewBox="0 0 100 50"><rect width="100" height="50"/></svg>'

describe('MermaidRenderer（W5）', () => {
  beforeEach(() => {
    mockRenderMermaid.mockReset()
    mockGetCurrentTheme.mockReset()
    mockGetCurrentTheme.mockReturnValue('dark')
    mockRenderMermaid.mockResolvedValue({ svg: SAMPLE_SVG })
  })

  it('U14: dark 主题挂载 → renderMermaid 调用 + SVG 注入 DOM', async () => {
    const wrapper = mount(MermaidRenderer, { props: { source: 'graph TD;A-->B' } })
    await nextTick()
    await nextTick() // 等 doRender 的 await resolve
    expect(mockRenderMermaid).toHaveBeenCalledWith('graph TD;A-->B', 'dark')
    // SVG 注入 inline 容器（.md-mermaid__inline）
    expect(wrapper.find('.md-mermaid__inline').html()).toContain('<svg')
  })

  it('U15: 主题切换 → 重新 renderMermaid（新主题）', async () => {
    mockGetCurrentTheme.mockReturnValue('dark')
    const wrapper = mount(MermaidRenderer, { props: { source: 'graph TD;A-->B' } })
    await nextTick()
    await nextTick()
    expect(mockRenderMermaid).toHaveBeenLastCalledWith(expect.any(String), 'dark')
    // 模拟主题切到 light：改 mock 返回 + 触发 MutationObserver
    mockGetCurrentTheme.mockReturnValue('light')
    document.documentElement.setAttribute('data-theme', 'light')
    await nextTick()
    await nextTick()
    expect(mockRenderMermaid).toHaveBeenLastCalledWith(expect.any(String), 'light')
    document.documentElement.removeAttribute('data-theme')
  })

  it('U12: 渲染失败 → 显示「渲染失败」+ 源码可复制', async () => {
    mockRenderMermaid.mockRejectedValue(new Error('parse error'))
    const wrapper = mount(MermaidRenderer, { props: { source: 'invalid mermaid' } })
    await nextTick()
    await nextTick()
    expect(wrapper.find('.md-mermaid__error').exists()).toBe(true)
    expect(wrapper.text()).toContain('Mermaid 渲染失败')
    // 「查看源码」按钮存在（默认折叠，源码未展开时不可见）
    const toggleBtn = wrapper.findAll('button').find((b) => b.text().includes('查看源码'))
    expect(toggleBtn).toBeDefined()
    // 点开折叠看源码
    await toggleBtn!.trigger('click')
    await nextTick()
    expect(wrapper.text()).toContain('invalid mermaid')
  })

  it('U16: 全屏 Dialog 打开 + zoom-in → zoomLabel 增大', async () => {
    const wrapper = mount(MermaidRenderer, { props: { source: 'graph TD;A-->B' } })
    await nextTick()
    await nextTick()
    // 点 inline 图打开全屏
    await wrapper.find('.md-mermaid__inline').trigger('click')
    await nextTick()
    await nextTick()
    // Dialog 经 DialogPortal teleport 到 body → 用 document.body 查找
    const body = document.body
    const labelEl = body.querySelector('.font-mono.text-\\[11px\\]') as HTMLElement
    expect(labelEl).toBeTruthy()
    const before = parseInt(labelEl.textContent ?? '0', 10)
    // 点 zoom-in（title="放大"）
    const zoomInBtn = Array.from(body.querySelectorAll('button')).find(
      (b) => b.getAttribute('title') === '放大',
    ) as HTMLButtonElement
    expect(zoomInBtn).toBeTruthy()
    zoomInBtn.click()
    await nextTick()
    const after = parseInt(labelEl.textContent ?? '0', 10)
    expect(after).toBeGreaterThan(before)
  })

  it('U17: 全屏 fit → zoomLabel 回到适配值', async () => {
    const wrapper = mount(MermaidRenderer, { props: { source: 'graph TD;A-->B' } })
    await nextTick()
    await nextTick()
    await wrapper.find('.md-mermaid__inline').trigger('click')
    await nextTick()
    await nextTick()
    const body = document.body
    const labelEl = body.querySelector('.font-mono.text-\\[11px\\]') as HTMLElement
    // 先 zoom-in 放大
    const zoomInBtn = Array.from(body.querySelectorAll('button')).find(
      (b) => b.getAttribute('title') === '放大',
    ) as HTMLButtonElement
    zoomInBtn.click()
    await nextTick()
    const zoomed = parseInt(labelEl.textContent ?? '0', 10)
    // 点 fit 适配
    const fitBtn = Array.from(body.querySelectorAll('button')).find(
      (b) => b.getAttribute('title') === '适应窗口',
    ) as HTMLButtonElement
    fitBtn.click()
    await nextTick()
    const fitVal = parseInt(labelEl.textContent ?? '0', 10)
    expect(fitVal).toBeLessThanOrEqual(zoomed)
  })
})
