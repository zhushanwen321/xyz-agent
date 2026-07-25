/**
 * PanelContainer 集成测试 —— 单 panel + SideDrawer split 布局（v2：移除 split/overlay 双模式）。
 *
 * 验证 PanelContainer（恒单 panel）渲染 + SideDrawer 的 v-if 门控行为（wave drawer-panel-splitter
 * 决策 2：v-if 卸载）：
 * - drawerOpen=true：SideDrawer 作 SplitterPanel 子项挂载（split 布局），DOM 含 side-drawer
 * - drawerOpen=false：SideDrawer 连同 ResizeHandle 一起卸载，退化为单 panel
 *
 * mount 入口是 PanelContainer（test-strategy 集成章节要求）。Panel/SideDrawer stub 成占位组件，
 * SideDrawer stub 透传 sessionId 便于断言。useGitStatus/useSidebar/useSessionDerivations mock 掉避免
 * 真实 WS/session 副作用。
 *
 * drawer 开关由 useSideDrawer 控制（per-session 分区，分区键 = panel store 的 focusedSessionId），
 * 测试需先 loadSession（让 focusedSessionId 有值）再 open（否则分区键为 null，open 写入的 isOpen
 * 不会落到 mount 后 active panel 对应的分区）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/panel-container-drawer-mode.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useSideDrawer, resetSideDrawer } from '@/composables/features/useSideDrawer'

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
  // 清 useSideDrawer per-session 分区 + 瞬时参数（测试隔离）
  resetSideDrawer()
})

describe('PanelContainer 单 panel + SideDrawer split 布局', () => {
  it('单 panel（恒 activePanelId=ROOT_PANEL_ID）', () => {
    const panel = usePanelStore()
    expect(panel.activePanelId).toBe(ROOT_PANEL_ID)
  })

  it('drawerOpen=true 时 DOM 含 1 个 panel + 1 个 side-drawer（drawerOpen=true 时作为 SplitterPanel 子项挂载）', async () => {
    // 先 loadSession 让 panel store 有 focusedSessionId，再 open（否则分区键为 null，
    // open 写入的 isOpen 不会落到 mount 后 active panel 对应的分区）
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-init')
    const drawer = useSideDrawer()
    drawer.open('git') // 打开 drawer，让 SideDrawer 进 DOM（v-if 门控）

    const wrapper = await mountContainer()
    expect(wrapper.findAll('[data-testid="panel"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="side-drawer"]')).toHaveLength(1)
  }, 10_000)

  it('SideDrawer 收到当前 panel 的 sessionId（drawerOpen=true 时作为 SplitterPanel 子项挂载）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's1')
    const drawer = useSideDrawer()
    drawer.open('git') // 打开 drawer，让 SideDrawer 挂载（v-if 门控）

    const wrapper = await mountContainer()
    const sideDrawer = wrapper.find('[data-testid="side-drawer"]')
    expect(sideDrawer.exists()).toBe(true)
    expect(sideDrawer.attributes('data-session-id')).toBe('s1')
  }, 10_000)

  it('drawer 关闭时：无 side-drawer，退化为单 panel（TC7：v-if 门控）', async () => {
    // drawer 保持默认关闭（beforeEach 已 reset），不调 open
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-closed')

    const wrapper = await mountContainer()
    // v-if 卸载：drawerOpen=false 时 SideDrawer 不挂载
    expect(wrapper.findAll('[data-testid="side-drawer"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-testid="panel"]')).toHaveLength(1)
  }, 10_000)
})
