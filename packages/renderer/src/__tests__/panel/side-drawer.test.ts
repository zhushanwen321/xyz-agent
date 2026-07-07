/**
 * SideDrawer 组件级单测。
 *
 * 覆盖点（对应本次 split/overlay 双模式改造）：
 * - split 模式（单 panel）：aside 是 flex 子项（flex-1），不含 absolute/z-30/w-1/2/shadow-2xl
 * - overlay 模式（双 panel）：aside 保留 absolute 浮层 class（z-30、w-1/2、shadow-2xl）——回归防护，确保 dual 行为零变化
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
  direction: 'right' as const,
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

describe('SideDrawer 双模式布局（split/overlay）', () => {
  describe('split 模式（单 panel）', () => {
    it('aside 是 flex 子项：含 flex-1 + relative + min-w-0', () => {
      const cls = asideClassOf(mountDrawer({ mode: 'split' }))
      expect(cls).toContain('flex-1')
      expect(cls).toContain('relative')
      expect(cls).toContain('min-w-0')
    })

    it('aside 不含 overlay 专属 class（absolute/z-30/w-1/2/shadow-2xl）', () => {
      const cls = asideClassOf(mountDrawer({ mode: 'split' }))
      expect(cls).not.toContain('absolute')
      expect(cls).not.toContain('z-30')
      expect(cls).not.toContain('w-1/2')
      expect(cls).not.toContain('shadow-2xl')
    })

    it('direction=right → 右侧边框（border-l），不加 order', () => {
      const cls = asideClassOf(mountDrawer({ mode: 'split', direction: 'right' }))
      expect(cls).toContain('border-l')
      expect(cls).not.toContain('order-first')
    })
  })

  describe('overlay 模式（双 panel）—— 回归防护，class 与 v2 逐字一致', () => {
    it('aside 含 absolute 浮层 class（absolute top-0 z-30 w-1/2 shadow-2xl）', () => {
      const cls = asideClassOf(mountDrawer({ mode: 'overlay' }))
      expect(cls).toContain('absolute')
      expect(cls).toContain('top-0')
      expect(cls).toContain('z-30')
      expect(cls).toContain('w-1/2')
      expect(cls).toContain('shadow-2xl')
    })

    it('overlay 不含 flex 子项 class（flex-1/min-w-0）', () => {
      const cls = asideClassOf(mountDrawer({ mode: 'overlay' }))
      expect(cls).not.toContain('flex-1')
      expect(cls).not.toContain('min-w-0')
    })

    it('direction=right → 贴右（right-0 + border-l）', () => {
      const cls = asideClassOf(mountDrawer({ mode: 'overlay', direction: 'right' }))
      expect(cls).toContain('right-0')
      expect(cls).toContain('border-l')
    })

    it('direction=left → 贴左（left-0 + border-r）', () => {
      const cls = asideClassOf(mountDrawer({ mode: 'overlay', direction: 'left' }))
      expect(cls).toContain('left-0')
      expect(cls).toContain('border-r')
    })
  })
})

describe('SideDrawer 渲染 gate + 交互', () => {
  it('首屏渲染 gate：isOpen=true + activeTab=git → DOM 含 GitPanel', () => {
    const wrapper = mountDrawer({ mode: 'split', activeTab: 'git' })
    expect(wrapper.find('[data-testid="git-panel"]').exists()).toBe(true)
  })

  it('isOpen=false → aside 不渲染', () => {
    const wrapper = mountDrawer({ isOpen: false, mode: 'split' })
    expect(wrapper.find('aside[aria-label="侧边抽屉"]').exists()).toBe(false)
  })

  it('close 按钮点击 → emit close', async () => {
    const wrapper = mountDrawer({ mode: 'split' })
    // 关闭按钮是 header 内最后一个 Button（title="关闭"）
    const closeBtn = wrapper.findAll('button').find((b) => b.attributes('title') === '关闭')
    expect(closeBtn).toBeTruthy()
    await closeBtn!.trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('ESC 键 → emit close', async () => {
    const wrapper = mountDrawer({ mode: 'split' })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
