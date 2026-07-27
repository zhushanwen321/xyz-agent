/**
 * Sidebar.vue onDeleteFolder 测试（W2TC6）。
 *
 * 验证 folder 删除后的提示分支（toast 决策）：
 * - 全成功（failed=[]）→ 不 toast
 * - 部分失败（failed.length>0）→ toastError(deleteFolderPartialFailed, count)
 * - 网络异常（deleteFolder reject）→ toastError(deleteFolderFailed, msg)
 *
 * 降级说明：Sidebar.vue 整体 mount 依赖 10+ store/composable（useSidebar / useChat /
 *   useSessionDerivations / 7 个 store / useSearchModal / SearchModal / __APP_VERSION__），
 *   完整真实 mount 成本过高且偏离本测试目标（验证 onDeleteFolder 的 toast 分支）。
 *   这里参照 sidebar-crud-error-handling.test.ts 范式：mock useSidebar（注入 deleteFolder mock）
 *   + useToast（捕获 error）+ 各 store，shallowMount Sidebar 后经 SessionList 子组件
 *   emit deleteFolder 触发 onDeleteFolder，覆盖真实模板绑定 + 事件编排路径。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/sidebar-ondeletefolder.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { shallowMount } from '@vue/test-utils'

// __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之
vi.stubGlobal('__APP_VERSION__', '0.0.0-test')

// ── mock useToast：捕获 toastError ──
const toastErrorMock = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastErrorMock }),
}))

// ── mock useSidebar：注入可控 deleteFolder ──
const sidebarMocks = vi.hoisted(() => ({
  selectSession: vi.fn(),
  deleteSession: vi.fn(),
  deleteFolder: vi.fn(),
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
}))

// ── mock stores（Sidebar setup 期读取）──
vi.mock('@/stores/sidebar', () => ({
  useSidebarStore: () => ({ collapsed: false, activeTab: 'sessions', toggleCollapsed: vi.fn() }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ groups: [], list: [], activeId: null, setGroups: vi.fn(), listLoadError: null }),
}))
vi.mock('@/stores/fileTree', () => ({
  useFileTreeStore: () => ({ fileCount: 0, getTree: () => null }),
}))
vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({
    currentLeaf: { type: 'panel', id: 'panel-root', sessionId: null },
    activePanelId: 'panel-root',
    focusedSessionId: { value: null },
    findPanelBySession: () => null,
    loadSession: vi.fn(),
  }),
}))
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
vi.mock('@/stores/command', () => ({
  useCommandStore: () => ({ appCommands: [] }),
}))

// ── mock composables ──
vi.mock('@/composables/features/useChat', () => ({ useChat: () => ({ abort: vi.fn() }) }))
vi.mock('@/composables/features/useSessionDerivations', () => ({
  useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
}))
vi.mock('@/composables/features/useSubagentListSync', () => ({ useSubagentListSync: vi.fn() }))
vi.mock('@/composables/features/useWorkflowListSync', () => ({ useWorkflowListSync: vi.fn() }))
vi.mock('@/composables/features/useSidebarSubagentActions', () => ({
  useSidebarSubagentActions: () => ({ onSelectSubagent: vi.fn(), onCancelSubagent: vi.fn(), onRetrySubagents: vi.fn() }),
}))
vi.mock('@/composables/features/useSearchModal', () => ({
  useSearchModal: () => ({ isOpen: { value: false }, open: vi.fn(), close: vi.fn() }),
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

describe('Sidebar onDeleteFolder（W2TC6）', () => {
  it('全成功（failed=[]）→ deleteFolder 调用但不 toast', async () => {
    sidebarMocks.deleteFolder.mockResolvedValueOnce({ cwd: '/p', deleted: ['s1', 's2'], failed: [] })
    const wrapper = shallowMount(Sidebar)

    // 经子组件 SessionList emit deleteFolder 触发 onDeleteFolder（覆盖模板 @delete-folder 绑定）
    wrapper.findComponent(SessionList).vm.$emit('deleteFolder', '/p')
    await vi.dynamicImportSettled()

    expect(sidebarMocks.deleteFolder).toHaveBeenCalledWith('/p')
    expect(toastErrorMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('部分失败（failed.length=1）→ toastError(deleteFolderPartialFailed, count:1)', async () => {
    sidebarMocks.deleteFolder.mockResolvedValueOnce({
      cwd: '/p',
      deleted: ['s1'],
      failed: [{ sessionId: 's2', error: 'EPERM' }],
    })
    const wrapper = shallowMount(Sidebar)

    wrapper.findComponent(SessionList).vm.$emit('deleteFolder', '/p')
    await vi.dynamicImportSettled()

    expect(sidebarMocks.deleteFolder).toHaveBeenCalledWith('/p')
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    // 文案来自 zh-CN locale（vitest-i18n-setup 注入真实 t）：deleteFolderPartialFailed = '{count} 个会话删除失败'
    expect(toastErrorMock).toHaveBeenCalledWith('1 个会话删除失败')
    wrapper.unmount()
  })

  it('网络异常（deleteFolder reject）→ toastError(deleteFolderFailed, msg)', async () => {
    sidebarMocks.deleteFolder.mockRejectedValueOnce(new Error('network'))
    const wrapper = shallowMount(Sidebar)

    wrapper.findComponent(SessionList).vm.$emit('deleteFolder', '/p')
    await vi.dynamicImportSettled()

    expect(sidebarMocks.deleteFolder).toHaveBeenCalledWith('/p')
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    // deleteFolderFailed = '删除文件夹会话失败：{msg}'
    expect(toastErrorMock).toHaveBeenCalledWith('删除文件夹会话失败：network')
    wrapper.unmount()
  })
})
