/**
 * PanelContainer 集成测试 —— 单 panel + SideDrawer split 布局（v2：移除 split/overlay 双模式）。
 *
 * 验证 PanelContainer（恒单 panel）渲染：
 * - DOM 含 1 个 panel + 1 个 side-drawer（单实例）
 * - SideDrawer 始终作 flex 子项（split 布局），不再有 overlay 浮层模式
 *
 * mount 入口是 PanelContainer（test-strategy 集成章节要求）。Panel/SideDrawer stub 成占位组件，
 * SideDrawer stub 透传 sessionId 便于断言。useGitStatus/useSidebar/useSessionDerivations mock 掉避免
 * 真实 WS/session 副作用。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/panel-container-drawer-mode.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'

// 三个 composable 在 PanelContainer setup 阶段执行，mock 掉避免真实副作用
vi.mock('@/composables/features/useGitStatus', () => ({
  GIT_STATUS_KEY: Symbol('git-status'),
  provideGitStatus: () => ({ indicator: { value: undefined }, state: { value: 'clean' }, lines: { value: [] } }),
}))
vi.mock('@/composables/features/useSessionDerivations', () => ({
  useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
}))

// SideDrawer stub：透传 sessionId 到 data-session-id 属性，便于断言 PanelContainer 派发的值
const SideDrawerStub = defineComponent({
  name: 'SideDrawer',
  props: {
    isOpen: Boolean,
    activeTab: String,
    docked: Boolean,
    sessionId: { type: String, default: null },
  },
  template: '<div data-testid="side-drawer" :data-is-open="isOpen" :data-session-id="sessionId" />',
})

// Panel stub：占位，避免 Panel 内部的 chat/session 依赖
const PanelStub = defineComponent({
  name: 'Panel',
  props: { panelId: String, sessionId: { type: String, default: null } },
  template: '<div data-testid="panel" :data-panel-id="panelId" />',
})

async function mountContainer() {
  // 动态 import 让 vi.mock 先生效
  const PanelContainer = (await import('@/components/workspace/PanelContainer.vue')).default
  return mount(PanelContainer, {
    global: {
      stubs: { Panel: PanelStub, SideDrawer: SideDrawerStub },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('PanelContainer 单 panel + SideDrawer split 布局', () => {
  it('单 panel（恒 activePanelId=ROOT_PANEL_ID）', () => {
    const panel = usePanelStore()
    expect(panel.activePanelId).toBe(ROOT_PANEL_ID)
  })

  it('mount 后 DOM 含 1 个 panel + 1 个 side-drawer（单实例）', async () => {
    const wrapper = await mountContainer()
    expect(wrapper.findAll('[data-testid="panel"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="side-drawer"]')).toHaveLength(1)
  }, 10_000)

  it('SideDrawer 收到当前 panel 的 sessionId（split 模式恒挂载）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's1')

    const wrapper = await mountContainer()
    const drawer = wrapper.find('[data-testid="side-drawer"]')
    expect(drawer.exists()).toBe(true)
    expect(drawer.attributes('data-session-id')).toBe('s1')
  }, 10_000)
})
