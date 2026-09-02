/**
 * Sidebar「导入会话」入口接线测试（import-session u6）。
 *
 * 验证（impl-plan §2 u6 验收条款）：
 *  - TC1: 「导入会话」ghost 按钮渲染在「新建任务」之后、「搜索」之前（nav 顺序断言）
 *  - TC2: ⌘I（meta+i）经 useGlobalShortcuts（真实执行，未 mock）触发 → ImportSessionDialog
 *         props open=true；无 mod 修饰的裸 i 不触发
 *  - TC3: 点击入口按钮 → ImportSessionDialog props open=true
 *
 * mock 策略对齐 sidebar-assign-project-wiring.test.ts 范式（Sidebar.vue 整体 mount 依赖
 * 10+ store/composable，shallowMount + store/composable mock）。差异点：Button 用显式
 * slot stub（默认 shallow stub 不渲染 slot 文本，无法断言 nav 内按钮顺序/文案）；ImportSessionDialog
 * 保持默认 stub（不执行其内部 RPC 链路，只断言 props 接线）。
 *
 * 监听器泄漏防护：useGlobalShortcuts 的 window keydown 监听挂 effect scope（unmount 才解绑），
 * 且命中后 stopImmediatePropagation 截胡后续实例——断言中途失败必须 unmount，否则泄漏实例
 * 截胡下一用例的按键。所有用例 try/finally 包裹 unmount。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/sidebar-import-entry.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { shallowMount } from '@vue/test-utils'
import { nextTick } from 'vue'

// ── mock useToast（Sidebar setup 期读取 error）──
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

// ── mock useSidebarNew（focusedSessionId/focusedSession 必须真实 Vue ref，
//    否则模板传对象给 String|Null 子组件触发 Invalid prop 警告，同既有范式注释）──
const sidebarMocks = vi.hoisted(() => ({
  selectSession: vi.fn(),
  deleteSession: vi.fn(),
  deleteFolder: vi.fn(),
  renameSession: vi.fn(),
  newSession: vi.fn(),
  goOverview: vi.fn(),
  loadSessions: vi.fn(() => Promise.resolve()),
  syncSessionToPanel: vi.fn(),
  assignSessionToProject: vi.fn(),
}))
vi.mock('@/composables/features/sidebar/useSidebarNew', async () => {
  const { ref } = await import('vue')
  return {
    useSidebarNew: () => ({
      ...sidebarMocks,
      focusedSessionId: ref<string | null>(null),
      focusedSession: ref(null),
    }),
  }
})

// ── mock stores（Sidebar setup 期读取）──
vi.mock('@/stores/sidebar', () => ({
  useSidebarStore: () => ({ collapsed: false, activeTab: 'sessions', toggleCollapsed: vi.fn() }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ groups: [], list: [], activeId: null, applySnapshot: vi.fn(), listLoadError: null }),
}))
vi.mock('@/stores/fileTree', () => ({
  useFileTreeStore: () => ({ fileCount: 0, getTree: () => null }),
}))
vi.mock('@/stores/panel', async () => {
  const { ref } = await import('vue')
  return {
    usePanelStore: () => ({
      currentLeaf: { type: 'panel', id: 'panel-root', sessionId: null },
      activePanelId: 'panel-root',
      focusedSessionId: ref<string | null>(null),
      findPanelBySession: () => null,
      loadSession: vi.fn(),
    }),
  }
})
vi.mock('@/stores/subagent', () => ({
  useSubagentStore: () => ({
    recordsOf: () => ({ value: [] }),
    getRecordsBySession: () => [],
    isLoading: false,
    loadError: null,
  }),
}))
vi.mock('@/stores/workflow', () => ({
  useWorkflowStore: () => ({
    recordsOf: () => ({ value: [] }),
    getRecordsBySession: () => [],
    isLoading: false,
    loadError: null,
    workflowCount: () => 0,
    getCurrentWorkflow: () => null,
    selectWorkflow: vi.fn(),
    backToWorkflowList: vi.fn(),
    loadWorkflows: vi.fn(() => Promise.resolve()),
    selectAgentCall: vi.fn(() => Promise.resolve()),
    backFromAgentCall: vi.fn(),
  }),
}))
vi.mock('@/stores/navigation', () => ({
  useNavigationStore: () => ({ push: vi.fn(), current: { value: { view: 'chat' } }, stack: [] }),
}))
vi.mock('@/composables/features/command/useCommandStore', () => ({
  useCommandStore: () => ({
    appCommands: { value: [] },
    shortcutOverrides: { value: {} },
    pendingSlash: { value: null },
    clearPendingSlash: vi.fn(),
  }),
}))

// ── mock composables ──
vi.mock('@/composables/features/chat/useChat', () => ({ useChat: () => ({ abort: vi.fn() }) }))
vi.mock('@/composables/features/chat/useSessionDerivations', () => ({
  useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
}))
vi.mock('@/composables/features/chat/useSubagentListSync', () => ({ useSubagentListSync: vi.fn() }))
vi.mock('@/composables/features/chat/useWorkflowListSync', () => ({ useWorkflowListSync: vi.fn() }))
vi.mock('@/composables/features/sidebar/useSidebarSubagentActions', () => ({
  useSidebarSubagentActions: () => ({ onSelectSubagent: vi.fn(), onCancelSubagent: vi.fn(), onRetrySubagents: vi.fn() }),
}))
vi.mock('@/composables/usePlatformShortcut', () => ({ usePlatformShortcut: () => ({ formatKbd: () => '⌘K' }) }))

// ── mock api/events（onMounted 的 loadSessions / app.info 订阅）──
vi.mock('@/api/events', () => ({
  onGlobalType: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
}))

import Sidebar from '@/components/sidebar/Sidebar.vue'
import ImportSessionDialog from '@/components/sidebar/ImportSessionDialog.vue'

/** shallowMount Sidebar，Button 用显式 slot stub（真实 <button> 元素 + slot 文本可见） */
function mountSidebar() {
  return shallowMount(Sidebar, {
    global: {
      stubs: {
        Button: { template: '<button><slot /></button>' },
      },
    },
  })
}

/** 构造 keydown 事件派发到 window（useGlobalShortcuts 的 useEventListener 挂点） */
function fireKey(options: { key: string; metaKey?: boolean }): void {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: options.key,
    metaKey: options.metaKey ?? false,
    bubbles: true,
    cancelable: true,
  }))
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('Sidebar 导入会话入口接线（import-session u6）', () => {
  it('TC1: 「导入会话」按钮渲染在「新建任务」之后、「搜索」之前，带定位 testid', () => {
    const wrapper = mountSidebar()
    try {
      const navTexts = wrapper.find('nav').findAll('button').map((b) => b.text())
      expect(navTexts.length).toBe(3)
      expect(navTexts[0]).toContain('新建任务')
      expect(navTexts[1]).toContain('导入会话')
      expect(navTexts[2]).toContain('搜索')
      // 入口按钮 testid（E2E 走查 V1 定位锚点）
      expect(wrapper.find('[data-testid="sidebar-import-session-btn"]').exists()).toBe(true)
    } finally {
      wrapper.unmount()
    }
  })

  it('TC2: ⌘I 经 useGlobalShortcuts 打开 ImportSessionDialog；裸 i（无 mod）不触发', async () => {
    const wrapper = mountSidebar()
    try {
      expect(wrapper.getComponent(ImportSessionDialog).props('open')).toBe(false)

      fireKey({ key: 'i', metaKey: true })
      await nextTick()
      expect(wrapper.getComponent(ImportSessionDialog).props('open')).toBe(true)

      // 回归：无 mod 修饰不触发（keymap 默认匹配要求 meta/ctrl）
      wrapper.getComponent(ImportSessionDialog).vm.$emit('update:open', false)
      await nextTick()
      expect(wrapper.getComponent(ImportSessionDialog).props('open')).toBe(false)
      fireKey({ key: 'i' })
      await nextTick()
      expect(wrapper.getComponent(ImportSessionDialog).props('open')).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('TC3: 点击入口按钮打开 ImportSessionDialog', async () => {
    const wrapper = mountSidebar()
    try {
      const importBtn = wrapper.find('[data-testid="sidebar-import-session-btn"]')
      expect(importBtn.exists()).toBe(true)

      await importBtn.trigger('click')
      expect(wrapper.getComponent(ImportSessionDialog).props('open')).toBe(true)
    } finally {
      wrapper.unmount()
    }
  })
})
