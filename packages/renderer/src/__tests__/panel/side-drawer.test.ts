/**
 * SideDrawer 组件级单测。
 *
 * 覆盖点（v2：单 panel 恒 split 模式，移除 overlay）：
 * - split 模式（单 panel）：aside 是 SplitterPanel 的内容容器（flex 列布局 + surface 底色），
 *   尺寸由外层 SplitterPanel flexGrow 管理（aside 不再 flex-1），
 *   左右分隔线由 SplitterResizeHandle 提供（aside 不再 border-l），
 *   不含 absolute/z-30/w-1/2/shadow-2xl 等 overlay 浮层 class
 * - 渲染 gate：isOpen=true + activeTab='git' → DOM 含 GitPanel 容器
 * - close 按钮点击 → emit close
 * - ESC 键 → emit close
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/side-drawer.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SideDrawer from '@/components/panel/SideDrawer.vue'

// useSessionEvents 接 runtime session 事件总线，单测内 stub 成 no-op（避免真实订阅/定时器）
vi.mock('@/composables/features/useSessionEvents', () => ({
  useSessionEvents: () => () => () => {},
}))

// 子组件 inject git/store，单测内 stub 成占位 div（断言容器到达即可）
const stubs = {
  GitPanel: { name: 'GitPanel', template: '<div data-testid="git-panel">git</div>' },
  CommandDocPanel: { template: '<div />' },
  DetailPane: { template: '<div />' },
}

const baseProps = {
  isOpen: true,
  activeTab: 'git' as const,
  docked: false,
  sessionId: 's1',
}

function mountDrawer(overrides: Record<string, unknown> = {}) {
  return mount(SideDrawer, {
    props: { ...baseProps, ...overrides },
    global: { stubs },
  })
}

/** 断言 aside 的 class 字符串包含/不包含目标 token */
function asideClassOf(wrapper: ReturnType<typeof mountDrawer>): string {
  const aside = wrapper.find('aside[aria-label="侧边抽屉"]')
  expect(aside.exists()).toBe(true)
  return aside.classes().join(' ')
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('SideDrawer 单 panel split 布局', () => {
  it('aside 是 SplitterPanel 内容容器：含 flex 列布局 + relative + min-w-0，不含 flex-1（尺寸归 SplitterPanel flexGrow）', () => {
    const cls = asideClassOf(mountDrawer())
    expect(cls).toContain('flex')
    expect(cls).toContain('h-full')
    expect(cls).toContain('flex-col')
    expect(cls).toContain('bg-surface')
    expect(cls).toContain('relative')
    expect(cls).toContain('min-w-0')
    // aside 不再是 flex 子项——尺寸由外层 SplitterPanel flexGrow 接管
    expect(cls).not.toContain('flex-1')
  })

  it('aside 不含 overlay 浮层 class（absolute/z-30/w-1/2/shadow-2xl）', () => {
    const cls = asideClassOf(mountDrawer())
    expect(cls).not.toContain('absolute')
    expect(cls).not.toContain('z-30')
    expect(cls).not.toContain('w-1/2')
    expect(cls).not.toContain('shadow-2xl')
  })

  it('贴右展开：不含 border-l（分隔线归 SplitterResizeHandle），不含 order-first', () => {
    const cls = asideClassOf(mountDrawer())
    // aside 不再自绘 border-l——左右分隔线由 SplitterResizeHandle 提供
    expect(cls).not.toContain('border-l')
    expect(cls).not.toContain('order-first')
  })
})

describe('SideDrawer 渲染 gate + 交互', () => {
  it('首屏渲染 gate：isOpen=true + activeTab=git → DOM 含 GitPanel', () => {
    const wrapper = mountDrawer({ activeTab: 'git' })
    expect(wrapper.find('[data-testid="git-panel"]').exists()).toBe(true)
  })

  it('isOpen=false → aside 不渲染', () => {
    const wrapper = mountDrawer({ isOpen: false })
    expect(wrapper.find('aside[aria-label="侧边抽屉"]').exists()).toBe(false)
  })

  it('close 按钮点击 → emit close', async () => {
    const wrapper = mountDrawer()
    // 关闭按钮是 header 内最后一个 Button（title="关闭"）
    const closeBtn = wrapper.findAll('button').find((b) => b.attributes('title') === '关闭')
    expect(closeBtn).toBeTruthy()
    await closeBtn!.trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('ESC 键 → emit close', async () => {
    const wrapper = mountDrawer()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
