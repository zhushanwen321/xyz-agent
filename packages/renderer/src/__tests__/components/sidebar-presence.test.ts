/**
 * Sidebar 在线设备区域首屏冒烟（P5 plan DoD 第 2 条 / T6 首屏冒烟）。
 *
 * 验收：mount Sidebar，断言「在线设备」区域（PresenceList）DOM 存在。
 *
 * PresenceList 自身 DOM 行为由 presence-list.test.ts 覆盖（多设备/单设备/空/isOperating 标记），
 * 此处聚焦 Sidebar 层级集成：Sidebar 是否挂载 PresenceList + 多设备时区域可见。
 *
 * 策略：mount Sidebar（stubs 屏蔽重组件 SegmentedTab/SessionList 等，保留 PresenceList 真实渲染），
 * 预置 presence store 多设备 connections，断言 [data-testid="presence-list"] + 在线设备标题 DOM。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/sidebar-presence.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import type { PresenceConnection } from '@xyz-agent/shared'

vi.stubGlobal('__APP_VERSION__', '0.0.0-test')

// ── mock 重 composables / stores（参照 sidebar-list-error-state.test.ts 已验证模式）──
const sidebarMocks = vi.hoisted(() => ({
  selectSession: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  newSession: vi.fn(),
  focusedSessionId: { value: null },
  focusedSession: { value: null },
  goOverview: vi.fn(),
  loadSessions: vi.fn(() => Promise.resolve()),
  syncSessionToPanel: vi.fn(),
}))
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => sidebarMocks,
  deriveStatus: () => ({ value: 'done' }),
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    groups: [],
    list: [],
    activeId: null,
    listLoadError: null,
    setGroups: vi.fn(),
    setListLoadError: vi.fn(),
  }),
}))
vi.mock('@/stores/sidebar', () => ({
  useSidebarStore: () => ({ collapsed: false, activeTab: 'sessions', toggleCollapsed: vi.fn() }),
}))
vi.mock('@/stores/fileTree', () => ({
  useFileTreeStore: () => ({ getTree: () => null, getNodeState: () => 'idle', setNodeState: vi.fn() }),
}))
vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({
    currentLeaf: { type: 'panel', id: 'panel-root', sessionId: null },
    activePanelId: 'panel-root',
    focusedSessionId: { value: null },
    layout: { value: { type: 'panel', id: 'panel-root', sessionId: null } },
    findPanelBySession: () => null,
    loadSession: vi.fn(),
  }),
}))
vi.mock('@/stores/subagent', () => ({
  useSubagentStore: () => ({
    recordsOf: () => ({ value: [] }), getRecordsBySession: () => [], hasRunning: () => false,
    isLoading: false, loadError: null,
  }),
}))
vi.mock('@/stores/workflow', () => ({
  useWorkflowStore: () => ({
    recordsOf: () => ({ value: [] }), getRecordsBySession: () => [], hasRunningOrPaused: () => false,
    isLoading: false, loadError: null,
    workflowCount: () => 0, getCurrentWorkflow: () => null,
    selectWorkflow: vi.fn(), backToWorkflowList: vi.fn(),
    loadWorkflows: vi.fn(() => Promise.resolve()),
    selectAgentCall: vi.fn(() => Promise.resolve()), backFromAgentCall: vi.fn(),
  }),
}))
vi.mock('@/stores/navigation', () => ({
  useNavigationStore: () => ({ push: vi.fn(), current: { value: { view: 'chat' } }, stack: [] }),
}))
vi.mock('@/stores/command', () => ({
  useCommandStore: () => ({ appCommands: [] }),
}))
vi.mock('@/composables/features/useSessionDerivations', () => ({
  useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
}))
vi.mock('@/composables/features/useSubagentListSync', () => ({ useSubagentListSync: vi.fn() }))
vi.mock('@/composables/features/useWorkflowListSync', () => ({ useWorkflowListSync: vi.fn() }))
vi.mock('@/composables/features/useSidebarSubagentActions', () => ({
  useSidebarSubagentActions: () => ({
    onSelectSubagent: vi.fn(), onCancelSubagent: vi.fn(),
    onSelectWorkflow: vi.fn(), onWorkflowBack: vi.fn(),
    onSelectAgentCall: vi.fn(), onWorkflowAction: vi.fn(),
  }),
}))
vi.mock('@/composables/features/useSearchModal', () => ({
  useSearchModal: () => ({
    open: vi.fn(), toggle: vi.fn(), close: vi.fn(), isOpen: { value: false }, formatKbd: () => '',
  }),
}))
vi.mock('@/api/events', () => ({
  onGlobalType: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
}))
vi.mock('@/api/domains/session', () => ({
  sessionApi: { workflowAction: vi.fn(() => Promise.resolve()) },
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn() }),
}))
vi.mock('@/composables/usePlatformShortcut', () => ({
  usePlatformShortcut: () => ({ formatKbd: () => '' }),
}))
vi.mock('@vueuse/core', () => ({
  useEventListener: vi.fn(),
}))

import Sidebar from '@/components/sidebar/Sidebar.vue'
import { usePresenceStore } from '@/stores/presence'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

function mountSidebar() {
  return mount(Sidebar, {
    global: {
      // stub 重组件（避免其内部依赖未 mock 报错），保留 PresenceList 真实渲染。
      // SessionList/SearchModal 用无 prop 校验的 template stub（focusedSessionId mock 是
      // {value} 对象非真 ref，真组件会 prop type warn；template stub 不校验 props，静默）。
      stubs: {
        SegmentedTab: { template: '<div />' },
        SessionList: { template: '<div />' },
        FileView: { template: '<div />' },
        SubagentList: { template: '<div />' },
        WorkflowList: { template: '<div />' },
        WorkflowDetail: { template: '<div />' },
        RenameSessionDialog: { template: '<div />' },
        SearchModal: { template: '<div />' },
      },
    },
  })
}

describe('P5 Sidebar 在线设备区域首屏冒烟（DoD #2）', () => {
  it('多设备在线时，Sidebar 渲染「在线设备」区域（presence-list DOM 存在）', async () => {
    const presenceStore = usePresenceStore()
    const conns: PresenceConnection[] = [
      { clientId: 'A', deviceName: 'Mac', activeSessionId: 's1', isOperating: true },
      { clientId: 'B', deviceName: 'Phone', activeSessionId: null, isOperating: false },
    ]
    presenceStore.setConnections(conns)

    const wrapper = mountSidebar()
    await wrapper.vm.$nextTick()

    // presence-list 区域 DOM 存在（P5 plan DoD 第 2 条：mount sidebar 断言在线设备区域存在）
    expect(wrapper.find('[data-testid="presence-list"]').exists()).toBe(true)
    // 标题文案（i18n sidebar.onlineDevices = 「在线设备」）
    expect(wrapper.text()).toContain('在线设备')
  })

  it('Sidebar 挂载 PresenceList 组件（集成契约：未误删/漏挂）', async () => {
    // 不预置 connections（空）—— 仍验证 Sidebar 模板挂了 PresenceList 组件
    const wrapper = mountSidebar()
    await wrapper.vm.$nextTick()

    // PresenceList 组件被挂载（即使空态不渲染 DOM，组件实例存在）
    const presenceList = wrapper.findComponent({ name: 'PresenceList' })
    expect(presenceList.exists()).toBe(true)
  })

  it('单设备/空时 presence-list 区域不渲染（v-if showList 守卫，避免单设备占空间）', async () => {
    const presenceStore = usePresenceStore()
    presenceStore.setConnections([
      { clientId: 'A', deviceName: 'Mac', activeSessionId: null, isOperating: false },
    ])

    const wrapper = mountSidebar()
    await wrapper.vm.$nextTick()

    // 单设备（只有自己）时不渲染区域（showList=false，spec §4.2 最小实现）
    expect(wrapper.find('[data-testid="presence-list"]').exists()).toBe(false)
  })
})
