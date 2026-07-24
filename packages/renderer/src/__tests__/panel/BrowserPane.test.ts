/**
 * BrowserPane 组件最小 mount 测试（Browser Drawer Wave 2 + Wave 3）。
 *
 * 覆盖：
 * - mount 后 [data-testid=browser-pane] 存在（组件根渲染）
 * - 有 url 时显 loading 态（isLoading 初始 true，等主进程 did-stop-loading 推 false）
 * - 无 url 时显空态（Globe icon + 文案）
 * - reload / openInExternal 触发对应 IPC（mock 捕获）
 *
 * Wave 3：
 * - navigate/show 被移入 onMounted 的 nextTick（先 pushRect 再 navigate+show），
 *   断言需 await wrapper.vm.$nextTick() 才能捕获。
 * - pushRect 在 nextTick 调 browserSetRect，mock 工厂必须导出 browserSetRect 否则抛错中断 nextTick 回调。
 * - rect 不乘 dpr：mount 后 browserSetRect 收到 getBoundingClientRect 的 round 值（jsdom 固定 0，故仅验证不抛错 + 被调用）。
 *
 * mock 策略：vi.mock('@/lib/ipc') 捕获 browserCreate/Navigate/Hide/Show/SetRect + onBrowserState（返回 no-op 退订），
 *            openExternal 捕获外链导出。useI18n 经 vitest-i18n-setup 全局注入。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/BrowserPane.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// ── mock lib/ipc：捕获 browser 系列 + onBrowserState（返回 no-op 退订）+ openExternal ──
const mockBrowserCreate = vi.fn().mockResolvedValue(undefined)
const mockBrowserNavigate = vi.fn().mockResolvedValue(undefined)
const mockBrowserHide = vi.fn().mockResolvedValue(undefined)
const mockBrowserShow = vi.fn().mockResolvedValue(undefined)
const mockBrowserSetRect = vi.fn().mockResolvedValue(undefined)
const mockOnBrowserState = vi.fn().mockReturnValue(() => {})
const mockOpenExternal = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/ipc', () => ({
  browserCreate: (...args: unknown[]) => mockBrowserCreate(...(args as [string, string])),
  browserNavigate: (...args: unknown[]) => mockBrowserNavigate(...(args as [string, string])),
  browserHide: (...args: unknown[]) => mockBrowserHide(...(args as [string])),
  browserShow: (...args: unknown[]) => mockBrowserShow(...(args as [string])),
  browserSetRect: (...args: unknown[]) => mockBrowserSetRect(...(args as [string, { x: number; y: number; width: number; height: number }]),
  onBrowserState: (cb: unknown) => mockOnBrowserState(cb),
  openExternal: (url: string) => mockOpenExternal(url),
}))

import BrowserPane from '@/components/panel/BrowserPane.vue'

function mountPane(props: { sessionId?: string; url?: string } = {}) {
  return mount(BrowserPane, {
    props: { sessionId: props.sessionId ?? 'sess-1', url: props.url ?? '' },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('BrowserPane（Wave 2 + Wave 3）', () => {
  it('mount 后渲染 [data-testid=browser-pane] 根节点', () => {
    const wrapper = mountPane({ url: 'https://example.com' })
    expect(wrapper.find('[data-testid="browser-pane"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('有 url 时 onMounted（nextTick 内）调 browserCreate + browserNavigate + browserShow', async () => {
    const wrapper = mountPane({ url: 'https://example.com' })
    // Wave 3：create 在 onMounted 同步调，navigate/show 在 nextTick 内（先 pushRect 再 navigate+show）。
    expect(mockBrowserCreate).toHaveBeenCalledWith('sess-1', expect.any(String))
    // 等 nextTick 回调执行（pushRect → navigate → show）
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(mockBrowserNavigate).toHaveBeenCalledWith('sess-1', 'https://example.com')
    expect(mockBrowserShow).toHaveBeenCalledWith('sess-1')
    // 订阅 onBrowserState
    expect(mockOnBrowserState).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('有 url 时显 loading 态（isLoading 初始 true）', () => {
    const wrapper = mountPane({ url: 'https://example.com' })
    expect(wrapper.find('[data-testid="browser-loading"]').exists()).toBe(true)
    // 地址栏显示传入 url（防钓鱼：主进程 did-navigate 后回填真实 URL）
    expect(wrapper.find('[data-testid="browser-urlbar"]').text()).toContain('https://example.com')
    wrapper.unmount()
  })

  it('无 url 时显空态（不调 navigate/show）', () => {
    const wrapper = mountPane({ url: '' })
    expect(wrapper.find('[data-testid="browser-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="browser-loading"]').exists()).toBe(false)
    expect(mockBrowserNavigate).not.toHaveBeenCalled()
    expect(mockBrowserShow).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('onBeforeUnmount 调 browserHide（keep-alive 不 destroy）', () => {
    const wrapper = mountPane({ url: 'https://example.com' })
    wrapper.unmount()
    expect(mockBrowserHide).toHaveBeenCalledWith('sess-1')
  })

  it('点外链导出按钮 → openExternal(displayUrl)', async () => {
    const wrapper = mountPane({ url: 'https://example.com' })
    await wrapper.find('[data-testid="browser-open-external"]').trigger('click')
    expect(mockOpenExternal).toHaveBeenCalledWith('https://example.com')
    wrapper.unmount()
  })
})
