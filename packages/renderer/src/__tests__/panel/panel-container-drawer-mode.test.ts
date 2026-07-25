/**
 * PanelContainer 集成测试 —— SideDrawer mode 路由（split/overlay）。
 *
 * 验证 PanelContainer 按 panel.isDual 正确派发 mode prop 给 SideDrawer：
 * - 单 panel（isDual=false）→ mode='split'（drawer 与 panel flex 分栏各占一半）
 * - 双 panel（isDual=true） → mode='overlay'（drawer absolute 覆盖对侧 standby panel）
 *
 * mount 入口是 PanelContainer（test-strategy 集成章节要求）。Panel/SideDrawer stub 成占位组件，
 * SideDrawer stub 把接收到的 mode 透传到 data-mode 属性便于断言。
 * useGitStatus/useSidebar/useSessionDerivations mock 掉避免真实 WS/session 副作用。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/panel-container-drawer-mode.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore } from '@/stores/panel'

// 三个 composable 在 PanelContainer setup 阶段执行，mock 掉避免真实副作用
vi.mock('@/composables/features/useGitStatus', () => ({
  GIT_STATUS_KEY: Symbol('git-status'),
  provideGitStatus: () => ({ indicator: { value: undefined }, state: { value: 'clean' }, lines: { value: [] } }),
}))
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({ newSessionToStandby: vi.fn() }),
}))
vi.mock('@/composables/features/useSessionDerivations', () => ({
  useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
}))

// 顶部静态 import：vitest 会把上面的 vi.mock 调用 hoist 到所有 import 之前，
// 所以这里吃到的就是被 mock 后的 composable。
// 用静态 import 的目的是把 PanelContainer 的重型 module graph 冷加载成本
// 从「第一个 test 内执行（计入 5s testTimeout）」移到「文件 setup 阶段（不计入任何 test timeout）」，
// 避免并发争用 CPU 时首个 test 偶发 timeout。
import PanelContainer from '@/components/workspace/PanelContainer.vue'

// SideDrawer stub：透传 mode 到 data-mode 属性，便于断言 PanelContainer 派发的值
const SideDrawerStub = defineComponent({
  name: 'SideDrawer',
  props: {
    isOpen: Boolean,
    activeTab: String,
    docked: Boolean,
    direction: String,
    mode: String,
    sessionId: { type: String, default: null },
  },
  template: '<div data-testid="side-drawer" :data-mode="mode" :data-is-open="isOpen" :data-direction="direction" />',
})

// Panel stub：占位，避免 Panel 内部的 chat/session 依赖
const PanelStub = defineComponent({
  name: 'Panel',
  props: { panelId: String, sessionId: { type: String, default: null }, active: Boolean, isDual: Boolean },
  template: '<div data-testid="panel" :data-panel-id="panelId" />',
})

function mountContainer() {
  return mount(PanelContainer, {
    global: {
      stubs: { Panel: PanelStub, SideDrawer: SideDrawerStub },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('PanelContainer → SideDrawer mode 路由', () => {
  it('单 panel（isDual=false）→ SideDrawer 收到 mode="split"', () => {
    const panel = usePanelStore()
    // 初始态即单 panel（layout.type==='panel'）
    expect(panel.isDual).toBe(false)

    const wrapper = mountContainer()
    const drawer = wrapper.find('[data-testid="side-drawer"]')
    expect(drawer.exists()).toBe(true)
    expect(drawer.attributes('data-mode')).toBe('split')
  })

  it('双 panel（isDual=true）→ SideDrawer 收到 mode="overlay"', () => {
    const panel = usePanelStore()
    panel.split()
    expect(panel.isDual).toBe(true)

    const wrapper = mountContainer()
    const drawer = wrapper.find('[data-testid="side-drawer"]')
    expect(drawer.exists()).toBe(true)
    expect(drawer.attributes('data-mode')).toBe('overlay')
  })

  it('split → overlay 随 panel split() 切换响应', async () => {
    const panel = usePanelStore()
    const wrapper = mountContainer()
    expect(wrapper.find('[data-testid="side-drawer"]').attributes('data-mode')).toBe('split')

    panel.split()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="side-drawer"]').attributes('data-mode')).toBe('overlay')
  })

  it('渲染 gate：单 panel mount 后 DOM 含 1 个 panel + 1 个 side-drawer', () => {
    const wrapper = mountContainer()
    expect(wrapper.findAll('[data-testid="panel"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="side-drawer"]')).toHaveLength(1)
  })

  it('渲染 gate：dual panel mount 后 DOM 含 2 个 panel + 1 个 side-drawer', () => {
    const panel = usePanelStore()
    panel.split()
    const wrapper = mountContainer()
    expect(wrapper.findAll('[data-testid="panel"]')).toHaveLength(2)
    expect(wrapper.findAll('[data-testid="side-drawer"]')).toHaveLength(1)
  })
})
