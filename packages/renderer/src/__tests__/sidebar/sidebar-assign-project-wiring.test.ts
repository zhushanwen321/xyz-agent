/**
 * Sidebar.vue 归入项目接线测试（review MF-1：Sidebar L85 @set-project 模板绑定 + toast 分支）。
 *
 * 链下游：SessionList emit setProject → Sidebar.vue `@set-project="onAssignProject"`（L85）→
 * useSidebarSessionActions.onAssignProject（真实，注入的 assignSessionToProject mock）→
 * 失败 toastError(sidebar.assignProjectFailed)。useSidebarNew 的 RPC + 乐观更新内部在
 * sidebar-assign-project.test.ts 直测（本文件 mock useSidebarNew）。
 *
 * 降级说明：Sidebar.vue 整体 mount 依赖 10+ store/composable（同 sidebar-ondeletefolder.test.ts
 * 范式），完整真实 mount 成本过高且偏离本测试目标（验证 @set-project 接线 + toast 分支）。
 * 参照该范式：mock useSidebarNew（注入可控 assignSessionToProject）+ useToast（捕获 error）
 * + 各 store，shallowMount Sidebar 后经 SessionList 子组件 emit setProject 触发 onAssignProject，
 * 覆盖真实模板绑定 + 事件编排路径。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/sidebar-assign-project-wiring.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { shallowMount } from '@vue/test-utils'

vi.stubGlobal('__APP_VERSION__', '0.0.0-test')

// ── mock useToast：捕获 toastError ──
const toastErrorMock = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastErrorMock }),
}))

// ── mock useSidebarNew：注入可控 assignSessionToProject ──
// focusedSessionId / focusedSession 必须是真实 Vue ref（非裸 { value } 对象），
// 否则 Sidebar 模板 `:active-id="focusedSessionId"` 传对象给 String|Null 子组件触发
// "Invalid prop" 警告。真实 ref 模板自动解包为 null（同 sidebar-ondeletefolder 注释）。
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
import SessionList from '@/components/sidebar/SessionList.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('Sidebar 归入项目接线（review MF-1）', () => {
  it('SessionList emit setProject → onAssignProject → assignSessionToProject(sessionId, projectId)，成功无 toast', async () => {
    sidebarMocks.assignSessionToProject.mockResolvedValue(undefined)
    const wrapper = shallowMount(Sidebar)

    // 经子组件 SessionList emit setProject 触发 onAssignProject（覆盖模板 @set-project 绑定 L85）
    wrapper.findComponent(SessionList).vm.$emit('setProject', { sessionId: 's1', projectId: 'p1' })
    await vi.dynamicImportSettled()

    expect(sidebarMocks.assignSessionToProject).toHaveBeenCalledWith('s1', 'p1')
    expect(toastErrorMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('assignSessionToProject reject → toastError(assignProjectFailed)，失败不静默', async () => {
    sidebarMocks.assignSessionToProject.mockRejectedValueOnce(new Error('rpc-fail'))
    const wrapper = shallowMount(Sidebar)

    wrapper.findComponent(SessionList).vm.$emit('setProject', { sessionId: 's1', projectId: 'p1' })
    await vi.dynamicImportSettled()

    expect(sidebarMocks.assignSessionToProject).toHaveBeenCalledWith('s1', 'p1')
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    // 文案来自 zh-CN locale（vitest-i18n-setup 注入真实 t）：assignProjectFailed = '归入项目失败'
    // （locale 无 {msg} 占位符，失败详情不进 toast——与 renameFailed 带 {msg} 的写法不同，此处按真实文案断言）
    expect(toastErrorMock).toHaveBeenCalledWith('归入项目失败')
    wrapper.unmount()
  })
})
