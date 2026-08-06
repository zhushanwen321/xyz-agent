/**
 * useSidebarSessionActions —— Sidebar session 操作 handler 集合（从 Sidebar.vue 提取，减行用）。
 *
 * 职责：session 选择/新建/重命名/删除 + folder 删除 + branch 停止 + 列表重试 + SearchModal
 * 接线（searchDeps/onOpenSearchDrawer，复用 selectSession/newSession/goOverview 注入）的事件处理。
 * 对称于 useSidebarSubagentActions。跨 store 编排（chat abort / subagent / workflow load）在此层完成。
 *
 * 依赖注入说明：useSidebarNew 的方法（selectSession/newSession/goOverview/loadSessions/renameSession/
 * deleteSession/deleteFolder/focusedSessionId）由调用方注入——useSidebarNew 非单例（每次调用
 * createSessionStore + createUseSession 新建实例），不能在本 composable 内重复调用。
 * renameOpen/targetSessionId 是 RenameSessionDialog 的本地 UI ref，由 Sidebar.vue 创建并注入，
 * onRenameSession 设置这两个 ref 打开 dialog。useChat/useToast/useI18n/useSearchModalDeps/
 * useSideDrawer 为单例/无状态 composable，内部安全调用。
 */
import type { Ref } from 'vue'
import { useChat } from '@/composables/features/chat/useChat'
import { useSearchModalDeps } from '@/composables/features/search/useSearchModalDeps'
import { useSideDrawer } from '@/composables/features/drawer/useSideDrawer'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useToast } from '@/composables/useToast'
import { useI18n } from 'vue-i18n'

/** useSidebarSessionActions 所需的注入依赖（来自 useSidebarNew + Sidebar.vue 本地 UI ref） */
export interface UseSidebarSessionActionsOptions {
  focusedSessionId: Ref<string | null>
  selectSession: (id: string) => Promise<void>
  newSession: (cwd?: string) => Promise<string | null>
  goOverview: () => void
  loadSessions: () => void
  renameSession: (id: string, label: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  deleteFolder: (cwd: string) => Promise<{ failed: Array<{ error?: string }> }>
  /** 归入项目（D14 语义修正，2026-08-04）：RPC + 乐观更新编排在 useSidebarNew。 */
  assignSessionToProject: (sessionId: string, projectId: string) => Promise<void>
  /** RenameSessionDialog 开关 ref（Sidebar.vue 本地 UI 状态） */
  renameOpen: Ref<boolean>
  /** RenameSessionDialog 目标 session ref（Sidebar.vue 本地 UI 状态） */
  targetSessionId: Ref<string>
}

export function useSidebarSessionActions(options: UseSidebarSessionActionsOptions) {
  const {
    focusedSessionId,
    selectSession,
    newSession,
    goOverview,
    loadSessions,
    renameSession,
    deleteSession,
    deleteFolder,
    assignSessionToProject,
    renameOpen,
    targetSessionId,
  } = options
  const { t } = useI18n()
  const { error: toastError } = useToast()
  const subagentStore = useSubagentStore()
  const workflowStore = useWorkflowStore()
  const { abort: abortSession } = useChat()

  async function onSelectSession(id: string): Promise<void> {
    try {
      await selectSession(id)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.switchSessionFailed', { msg }))
    }
  }

  async function onNewSession(): Promise<void> {
    try {
      await newSession()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.newTaskFailed', { msg }))
    }
  }

  async function onRenameSession(id: string): Promise<void> {
    targetSessionId.value = id
    renameOpen.value = true
  }

  async function onDeleteSession(id: string): Promise<void> {
    try {
      await deleteSession(id)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.deleteSessionFailed', { msg }))
    }
  }

  /** 删除指定 cwd 下所有 session（folder 批量删除）。部分失败 toast 带 error；全成功不提示。 */
  async function onDeleteFolder(cwd: string): Promise<void> {
    try {
      const res = await deleteFolder(cwd)
      if (res.failed.length > 0) {
        const firstError = res.failed[0]?.error ?? ''
        toastError(
          t('sidebar.deleteFolderPartialFailed', res.failed.length, {
            named: { count: res.failed.length, error: firstError },
          }),
        )
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.deleteFolderFailed', { msg }))
    }
  }

  /** 停止后台分支 session（ForkGroup 两段式确认后 emit stopBranch）。 */
  function onStopBranch(id: string): void {
    void abortSession(id)
  }

  async function onConfirmRename(payload: { sessionId: string; label: string }): Promise<void> {
    try {
      await renameSession(payload.sessionId, payload.label)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.renameFailed', { msg }))
    }
  }

  /** 归入项目（D14 语义修正）：SessionItem 菜单选择后 RPC + 乐观更新；失败 toast。 */
  async function onAssignProject(payload: { sessionId: string; projectId: string }): Promise<void> {
    try {
      await assignSessionToProject(payload.sessionId, payload.projectId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.assignProjectFailed', { msg }))
    }
  }

  /** S5：重试加载会话列表（loadSessions 失败后用户点击重试） */
  function onRetryLoadSessions(): void {
    void loadSessions()
  }

  /** M1：重试加载 workflow 列表 */
  function onRetryWorkflows(): void {
    const sid = focusedSessionId.value
    if (sid) void workflowStore.loadWorkflows(sid)
  }

  /** M1：重试加载 subagent 列表 */
  function onRetrySubagents(): void {
    const sid = focusedSessionId.value
    if (sid) void subagentStore.loadSubagents(sid)
  }

  /** [w5] SearchModal deps 组装（SearchDeps 壳适配）+ drawer/toast 接线（C-NT-3/C-W4-5）：file 跳转开 detail tab；confirm 失败 toast（复用顶部 toastError）。 */
  const searchDeps = useSearchModalDeps({
    selectSession,
    newSession: () => { void newSession() },
    goOverview,
  })
  function onOpenSearchDrawer(tab: string): void {
    const { open } = useSideDrawer()
    // SearchModal drawerTab（'tasks'|'sideDrawer'|'detail'）→ SideDrawerTab；实际 file 跳转恒 'detail'，'sideDrawer' 历史抽象值映射 undefined。
    open(tab === 'sideDrawer' ? undefined : (tab as Parameters<typeof open>[0]))
  }

  return {
    onSelectSession,
    onNewSession,
    onRenameSession,
    onDeleteSession,
    onDeleteFolder,
    onStopBranch,
    onConfirmRename,
    onAssignProject,
    onRetryLoadSessions,
    onRetryWorkflows,
    onRetrySubagents,
    searchDeps,
    onOpenSearchDrawer,
  }
}
