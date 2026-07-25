/**
 * PanelContainer 首屏冒烟测试（AGENTS.md 测试规范 §8 [MANDATORY]：每功能必含 1 条首屏冒烟）。
 *
 * 对应 wave-plan TC1：drawerOpen=true 时 DOM 存在 [data-resize-handle]（reka-ui Splitter 改造）。
 * 功能 commit 6b57c2d2：PanelContainer.vue 用 reka-ui Splitter（SplitterGroup / SplitterPanel /
 * SplitterResizeHandle）替换原 flex 布局，drawer 作为可拖动 SplitterPanel 子项，关闭时连同
 * ResizeHandle 一起卸载（v-if），Splitter 自动回单 panel。
 *
 * mount 策略（完整 mount PanelContainer，验证 reka-ui Splitter 真实 DOM 输出）：
 *   - Panel / SideDrawer stub 成占位（避免其内部 chat/session/widget 副作用）
 *   - useGitStatus / useSessionDerivations 在 setup 阶段执行，mock 掉避免真实 WS/git 副作用
 *   - drawer 开关由 useSideDrawer 控制（per-session 分区，分区键 = panel store 的 focusedSessionId）
 *
 * 关键：reka-ui Splitter 在 happy-dom 下渲染 [data-resize-handle] / [data-panel] 真实属性
 * （见 reka-ui/dist/Splitter/*.js），故直接断言 Splitter 集成正确，非降级。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/workspace/PanelContainer.test.ts
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

// SideDrawer stub：透传 sessionId 到 data 属性，便于断言 PanelContainer 派发的值
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

describe('PanelContainer 首屏冒烟：reka-ui Splitter 渲染（TC1）', () => {
  it('drawerOpen=true：DOM 含 [data-resize-handle] + 2 个 [data-panel]（main-panel + drawer-panel）', async () => {
    // 在 mount 前把 drawer 打开（useSideDrawer per-session 分区，分区键=focusedSessionId）
    // 先 loadSession 让 panel store 有 focusedSessionId，再 open（否则分区键为 null，
    // open 写入的 isOpen 不会落到 mount 后 active panel 对应的分区）
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-tc1')
    const drawer = useSideDrawer()
    drawer.open('git') // 打开 drawer（git tab）

    const wrapper = await mountContainer()

    // TC1 核心：resize-handle 存在（drawer 打开时 SplitterResizeHandle 渲染）
    expect(wrapper.find('[data-resize-handle]').exists()).toBe(true)
    // main-panel + drawer-panel 两个 SplitterPanel
    expect(wrapper.findAll('[data-panel]').length).toBe(2)
  }, 10_000)

  it('drawerOpen=false：无 [data-resize-handle]，退化为单 [data-panel]（仅 main-panel）', async () => {
    // drawer 保持默认关闭（beforeEach 已 reset），不调 open
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-tc2')

    const wrapper = await mountContainer()

    // drawer 关闭时连同 ResizeHandle 一起卸载（v-if），Splitter 自动回单 panel
    expect(wrapper.find('[data-resize-handle]').exists()).toBe(false)
    expect(wrapper.findAll('[data-panel]').length).toBe(1)
  }, 10_000)
})
